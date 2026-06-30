// Supabase configuration
const SUPABASE_URL = 'https://azjtejdxfqjwyxquszzm.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF6anRlamR4ZnFqd3l4cXVzenptIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxMzgwMDAsImV4cCI6MjA4ODcxNDAwMH0.n4hYFOCHKJLL0IVcGHMjjCJZxfKyaKf0NKC4zyb9Gno';

if (!window.supabase) {
    console.error('Supabase library not loaded');
    document.body.innerHTML = '<div style="color:white; text-align:center; margin-top:20%; font-family:sans-serif; background:#0F172A; height:100vh; display:flex; align-items:center; justify-content:center;"><p>Failed to load Supabase client. Please refresh the page.</p></div>';
    throw new Error('Supabase not loaded');
}

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// State variables
let sessionId = '';
let localQueue = [];
let currentIndex = -1;
let player = null;
let isPlayerReady = false;
let progressInterval = null;
let isUnloading = false;
let retryCount = 0;
const MAX_RETRIES = 5;
let isMuted = true;
let pendingSongToPlay = null;
let audioUnlocked = false;

let sessionChannel = null;
let queueChannel = null;
let retryTimeout = null;
let previewTimeout = null;

let apiLoadTimeout = setTimeout(() => {
    if (!player) {
        console.error('YouTube API failed to load');
        document.getElementById('youtube-fallback').style.display = 'block';
        updateStatusBadge('disconnected', 'YouTube unavailable');
    }
}, 15000);

function formatSessionId(code) {
    if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
    return code;
}
function generateSessionId() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

async function initSession() {
    if (retryCount >= MAX_RETRIES) {
        console.error('Max retries reached. Refresh page.');
        updateStatusBadge('disconnected', 'Connection failed. Refresh.');
        return;
    }
    if (retryTimeout) clearTimeout(retryTimeout);

    sessionId = generateSessionId();
    console.log(`Registering session ID: ${sessionId}`);

    try {
        const { data, error } = await supabaseClient
            .from('remote_sessions')
            .insert([{ session_id: sessionId, command: null, player_state: 'IDLE' }])
            .select();

        if (error) {
            console.error('Error creating session, retrying...', error);
            retryCount++;
            retryTimeout = setTimeout(initSession, 2000);
            return;
        }

        console.log('Session registered:', data);
        document.getElementById('pairing-code').textContent = formatSessionId(sessionId);
        const headerCode = document.getElementById('header-code');
        if (headerCode) headerCode.textContent = formatSessionId(sessionId);
        updateStatusBadge('waiting', `Code: ${formatSessionId(sessionId)}`);

        if (sessionChannel) { supabaseClient.removeChannel(sessionChannel); sessionChannel = null; }
        if (queueChannel) { supabaseClient.removeChannel(queueChannel); queueChannel = null; }

        subscribeToSessionUpdates();
        subscribeToQueueInserts();
        setupCleanupOnExit();
        retryCount = 0;
    } catch (err) {
        console.error('Unexpected error:', err);
        retryCount++;
        retryTimeout = setTimeout(initSession, 2000);
    }
}

function subscribeToSessionUpdates() {
    if (!sessionId) return;
    if (sessionChannel) { supabaseClient.removeChannel(sessionChannel); sessionChannel = null; }

    sessionChannel = supabaseClient
        .channel(`session-${sessionId}`)
        .on('postgres_changes', {
            event: 'UPDATE',
            schema: 'public',
            table: 'remote_sessions',
            filter: `session_id=eq.${sessionId}`
        }, (payload) => {
            console.log('Session command update:', payload.new);
            if (payload.new) handleSessionCommand(payload.new);
        })
        .subscribe((status) => {
            console.log(`Session realtime status: ${status}`);
            if (status === 'SUBSCRIBED') {
                updateStatusBadge('waiting', `Code: ${formatSessionId(sessionId)}`);
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                updateStatusBadge('disconnected', 'Reconnecting...');
                setTimeout(subscribeToSessionUpdates, 5000);
            }
        });
}

function subscribeToQueueInserts() {
    if (!sessionId) return;
    if (queueChannel) { supabaseClient.removeChannel(queueChannel); queueChannel = null; }

    queueChannel = supabaseClient
        .channel(`queue-${sessionId}`)
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'remote_queue',
            filter: `session_id=eq.${sessionId}`
        }, (payload) => {
            console.log('Queue item added:', payload.new);
            if (payload.new) handleQueueInsert(payload.new);
        })
        .subscribe((status) => {
            console.log(`Queue realtime status: ${status}`);
        });
}

async function handleSessionCommand(row) {
    if (!row || !row.command) return;
    const cmd = row.command.toLowerCase().trim();
    console.log(`Executing command: ${cmd}`);

    switch (cmd) {
        case 'play': playVideo(); break;
        case 'pause': pauseVideo(); break;
        case 'skip_next': skipNext(); break;
        case 'skip_previous': skipPrevious(); break;
        case 'toggle_mute': toggleMute(); break;
        default: console.log(`Unknown command: ${cmd}`);
    }

    showCommandFeedback(cmd);

    try {
        await supabaseClient.from('remote_sessions').update({ command: null }).eq('session_id', sessionId);
    } catch (err) {
        console.error('Failed to clear command:', err);
    }
}

function handleQueueInsert(item) {
    if (!item || !item.video_id) return;
    if (localQueue.some(q => q.id === item.id)) return;

    localQueue.push(item);
    showToast("Song Added", `"${item.title}" added to queue by remote.`);

    if (currentIndex === -1) {
        playSongAtIndex(localQueue.length - 1);
    } else {
        updateNextPreview();
    }
}

window.onYouTubeIframeAPIReady = function() {
    clearTimeout(apiLoadTimeout);
    console.log('YouTube IFrame API script loaded. Initializing player...');
    const playerElement = document.getElementById('player');
    if (!playerElement) {
        console.error('Player element not found!');
        return;
    }

    player = new YT.Player('player', {
        height: '100%',
        width: '100%',
        playerVars: {
            'autoplay': 1,
            'controls': 0,
            'disablekb': 1,
            'fs': 0,
            'modestbranding': 1,
            'rel': 0,
            'showinfo': 0,
            'iv_load_policy': 3,
            'origin': window.location.origin,
            'mute': 1,
            'playsinline': 1
        },
        events: {
            'onReady': onPlayerReady,
            'onStateChange': onPlayerStateChange,
            'onError': onPlayerError
        }
    });
};

function onPlayerReady(event) {
    console.log('YouTube Player is ready.');
    isPlayerReady = true;

    if (player.mute) player.mute();
    isMuted = true;
    audioUnlocked = false;

    resizePlayer();   // ensure cover after player loads

    if (pendingSongToPlay !== null) {
        const songIndex = pendingSongToPlay;
        pendingSongToPlay = null;
        setTimeout(() => playSongAtIndex(songIndex), 500);
    } else if (localQueue.length > 0 && currentIndex === -1) {
        setTimeout(() => playSongAtIndex(0), 500);
    }
}

function onPlayerStateChange(event) {
    let dbState = 'IDLE';
    switch (event.data) {
        case YT.PlayerState.UNSTARTED: dbState = 'IDLE'; break;
        case YT.PlayerState.ENDED: dbState = 'IDLE'; handleVideoEnded(); break;
        case YT.PlayerState.PLAYING:
            dbState = 'PLAYING';
            startProgressTracking();
            updateStatusBadge('connected', 'Playing');
            if (!audioUnlocked) showOneTimeUnlockOverlay();
            break;
        case YT.PlayerState.PAUSED: dbState = 'PAUSED'; stopProgressTracking(); updateStatusBadge('connected', 'Paused'); break;
        case YT.PlayerState.BUFFERING: dbState = 'BUFFERING'; updateStatusBadge('connected', 'Buffering...'); break;
        case YT.PlayerState.CUED: dbState = 'IDLE'; break;
        default: dbState = 'IDLE';
    }
    updatePlayerStateInDb(dbState);
}

function onPlayerError(event) {
    console.error('YouTube Player error:', event.data);
    showToast("Playback Error", "This video could not be played. Skipping to next...");
    setTimeout(() => skipNext(), 3000);
}

function showOneTimeUnlockOverlay() {
    if (audioUnlocked || document.getElementById('audio-unlock-overlay')) return;

    const overlay = document.createElement('button');
    overlay.id = 'audio-unlock-overlay';
    overlay.setAttribute('autofocus', '');
    overlay.style.cssText = `
        position: fixed;
        bottom: 140px; left: 50%;
        transform: translateX(-50%);
        background: rgba(39,174,96,0.9);
        color: white;
        border: none;
        padding: 18px 36px;
        border-radius: 50px;
        font-size: 1.4rem;
        font-weight: 700;
        cursor: pointer;
        z-index: 200;
        box-shadow: 0 12px 30px rgba(0,0,0,0.4);
        backdrop-filter: blur(12px);
        animation: pulse 1.5s infinite;
        outline: none;
    `;

    const focusStyle = document.createElement('style');
    focusStyle.textContent = `
        #audio-unlock-overlay:focus {
            outline: 4px solid white;
            outline-offset: 4px;
            box-shadow: 0 0 0 8px rgba(39,174,96,0.6), 0 12px 30px rgba(0,0,0,0.4);
        }
    `;
    document.head.appendChild(focusStyle);

    overlay.textContent = '🔊 Press OK to Unmute';

    const unlockAudio = () => {
        audioUnlocked = true;
        if (player.unMute) player.unMute();
        if (player.setVolume) player.setVolume(100);
        isMuted = false;
        overlay.remove();
        showToast("🔊 Sound Enabled", "Remote mute controls now active.");
    };

    overlay.addEventListener('click', unlockAudio);
    overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'OK') {
            e.preventDefault();
            unlockAudio();
        }
    });

    document.body.appendChild(overlay);
    setTimeout(() => overlay.focus(), 100);

    setTimeout(() => {
        if (document.getElementById('audio-unlock-overlay')) {
            document.getElementById('audio-unlock-overlay').remove();
        }
    }, 20000);
}

function playVideo() {
    if (player && isPlayerReady) {
        try { player.playVideo(); } catch (err) { console.error('Error playing video:', err); }
    }
}
function pauseVideo() {
    if (player && isPlayerReady && player.pauseVideo) player.pauseVideo();
}

function toggleMute() {
    if (!player || !isPlayerReady) return;
    if (!audioUnlocked) {
        showToast("🔇 Audio locked", "Press OK on TV to enable sound first.");
        return;
    }
    try {
        if (isMuted) {
            player.unMute();
            player.setVolume(100);
            isMuted = false;
            showToast("🔊 Unmuted", "Volume restored");
        } else {
            player.mute();
            isMuted = true;
            showToast("🔇 Muted", "Volume muted");
        }
    } catch (err) {
        console.error('Error toggling mute:', err);
    }
}

function playSongAtIndex(index) {
    if (index < 0 || index >= localQueue.length) {
        currentIndex = -1;
        showWaitingScreen();
        if (player && isPlayerReady && player.stopVideo) player.stopVideo();
        updateCurrentVideoId(null);
        return;
    }

    currentIndex = index;
    const song = localQueue[currentIndex];
    if (!song.video_id) {
        console.error('Song missing video_id, skipping:', song);
        showToast("Error", "Video ID missing, removing song.");
        localQueue.splice(index, 1);
        if (localQueue.length === 0) playSongAtIndex(-1);
        else if (index >= localQueue.length) playSongAtIndex(0);
        else playSongAtIndex(index);
        return;
    }

    console.log(`Loading song at index ${index}: ${song.title}`);
    showPlayingScreen(song);
    updateCurrentVideoId(song.video_id);

    if (player && isPlayerReady) {
        try {
            player.loadVideoById({
                videoId: song.video_id,
                startSeconds: 0,
                suggestedQuality: 'hd720'
            });
        } catch (err) { console.error('Error loading video:', err); }
    } else {
        pendingSongToPlay = index;
        console.log('Player not ready, storing song for later');
    }
    updateNextPreview();
}

async function updateCurrentVideoId(videoId) {
    if (!sessionId) return;
    try {
        await supabaseClient.from('remote_sessions').update({ current_video_id: videoId }).eq('session_id', sessionId);
    } catch (err) { console.error('Failed to update current video ID:', err); }
}

function skipNext() {
    if (localQueue.length === 0) return;
    if (currentIndex < localQueue.length - 1) playSongAtIndex(currentIndex + 1);
    else playSongAtIndex(-1);
}

function skipPrevious() {
    if (localQueue.length === 0) return;
    if (player && isPlayerReady && player.getCurrentTime) {
        const elapsed = player.getCurrentTime() || 0;
        if (elapsed > 3) { player.seekTo(0, true); return; }
    }
    if (currentIndex > 0) playSongAtIndex(currentIndex - 1);
    else if (player && isPlayerReady && player.seekTo) player.seekTo(0, true);
}

function handleVideoEnded() {
    console.log('Video ended. Advancing...');
    stopProgressTracking();
    if (currentIndex < localQueue.length - 1) skipNext();
    else {
        currentIndex = -1;
        showWaitingScreen();
        if (player && isPlayerReady && player.stopVideo) player.stopVideo();
        updateCurrentVideoId(null);
    }
}

async function updatePlayerStateInDb(state) {
    if (!sessionId || isUnloading) return;
    try {
        await supabaseClient.from('remote_sessions').update({ player_state: state }).eq('session_id', sessionId);
    } catch (err) { console.error('Failed to sync player state:', err); }
}

function showIdleScreen() {
    document.getElementById('idle-screen').classList.add('active');
    document.getElementById('waiting-screen').classList.remove('active');
    document.getElementById('video-section').classList.remove('active');
    document.getElementById('now-playing-overlay').classList.remove('active');
}
function showWaitingScreen() {
    document.getElementById('idle-screen').classList.remove('active');
    document.getElementById('waiting-screen').classList.add('active');
    document.getElementById('video-section').classList.remove('active');
    document.getElementById('now-playing-overlay').classList.remove('active');
    updateStatusBadge('connected', 'Ready to sing');
}
function showPlayingScreen(song) {
    document.getElementById('idle-screen').classList.remove('active');
    document.getElementById('waiting-screen').classList.remove('active');
    document.getElementById('video-section').classList.add('active');
    document.getElementById('now-playing-overlay').classList.add('active');
    document.getElementById('song-title').textContent = song.title || 'Unknown Title';
    document.getElementById('song-artist').textContent = song.artist || 'Unknown Artist';
    const thumb = document.getElementById('song-thumbnail');
    if (thumb) thumb.src = song.thumbnail || `https://img.youtube.com/vi/${song.video_id}/0.jpg`;
}

function updateNextPreview() {
    const nextPreview = document.getElementById('next-preview');
    const previewTitle = document.getElementById('preview-title');
    if (previewTimeout) { clearTimeout(previewTimeout); previewTimeout = null; }

    const nextIndex = currentIndex + 1;
    if (nextPreview && previewTitle && nextIndex < localQueue.length) {
        const nextSong = localQueue[nextIndex];
        previewTitle.textContent = `${nextSong.title} by ${nextSong.artist || 'Artist'}`;
        nextPreview.classList.add('active');
        previewTimeout = setTimeout(() => nextPreview.classList.remove('active'), 6000);
    } else if (nextPreview) {
        nextPreview.classList.remove('active');
    }
}

function startProgressTracking() {
    stopProgressTracking();
    progressInterval = setInterval(() => {
        if (player && isPlayerReady && player.getCurrentTime && player.getDuration) {
            const current = player.getCurrentTime();
            const duration = player.getDuration();
            if (duration > 0 && current >= 0) {
                document.getElementById('progress-bar-fill').style.width = `${(current/duration)*100}%`;
                document.getElementById('current-time').textContent = formatTime(current);
                document.getElementById('total-time').textContent = formatTime(duration);
            }
        }
    }, 500);
}
function stopProgressTracking() {
    if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
}
function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function showToast(title, description) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<i class="fa-solid fa-compact-disc fa-spin toast-icon"></i><div class="toast-content"><span class="toast-title">${title}</span><span class="toast-desc">${description}</span></div>`;
    container.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 50);
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 600); }, 4000);
}

function showCommandFeedback(command) {
    const iconMap = {
        'play': '▶️',
        'pause': '⏸️',
        'skip_next': '⏭️',
        'skip_previous': '⏮️',
        'toggle_mute': isMuted ? '🔇' : '🔊'
    };
    const icon = iconMap[command] || '📡';
    const feedbackEl = document.getElementById('cmd-feedback');
    if (!feedbackEl) return;
    feedbackEl.textContent = icon;
    feedbackEl.classList.add('show');
    setTimeout(() => feedbackEl.classList.remove('show'), 1500);
}

function updateStatusBadge(status, text) {
    const dot = document.getElementById('status-dot');
    const textEl = document.getElementById('status-text');
    if (!dot || !textEl) return;
    textEl.textContent = text;
    dot.className = 'pulse-indicator ' + (
        status === 'waiting' ? 'status-waiting' :
        status === 'connected' ? 'status-connected' : 'status-waiting'
    );
    const headerCode = document.getElementById('header-code');
    if (headerCode && sessionId && headerCode.textContent === '------') {
        headerCode.textContent = formatSessionId(sessionId);
    }
}

function generateParticles() {
    const container = document.getElementById('particles');
    if (!container) return;
    for (let i = 0; i < 10; i++) {
        const particle = document.createElement('div');
        particle.className = 'particle';
        const size = Math.random() * 60 + 20;
        particle.style.width = `${size}px`;
        particle.style.height = `${size}px`;
        particle.style.left = `${Math.random() * 100}%`;
        particle.style.animationDelay = `${Math.random() * 15}s`;
        particle.style.animationDuration = `${Math.random() * 12 + 10}s`;
        particle.style.willChange = 'transform, opacity';
        container.appendChild(particle);
    }
}

function setupCleanupOnExit() {
    window.addEventListener('beforeunload', () => {
        isUnloading = true;
        if (sessionId) {
            try { navigator.sendBeacon(`${SUPABASE_URL}/rest/v1/remote_sessions?session_id=eq.${sessionId}`, new Blob([], { type: 'application/json' })); } catch(e){}
            supabaseClient.from('remote_sessions').delete().eq('session_id', sessionId).then();
        }
    });
}

// ──────────────────────────────────────
// Dynamic player resize (cover 16:9)
// ──────────────────────────────────────
function resizePlayer() {
    const container = document.getElementById('player-container');
    const iframe = document.querySelector('#player-container iframe') || document.getElementById('player');
    if (!container || !iframe) return;

    const containerW = container.clientWidth;
    const containerH = container.clientHeight;
    const targetRatio = 16 / 9;
    const containerRatio = containerW / containerH;

    let newWidth, newHeight;
    if (containerRatio > targetRatio) {
        newHeight = containerH;
        newWidth = containerH * targetRatio;
    } else {
        newWidth = containerW;
        newHeight = containerW / targetRatio;
    }

    iframe.style.width = newWidth + 'px';
    iframe.style.height = newHeight + 'px';
}

// Fullscreen toggle (with icon update)
function initFullscreenToggle() {
    const btn = document.getElementById('fullscreen-toggle');
    if (!btn) return;

    btn.addEventListener('click', () => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(err => console.warn(err));
        } else {
            document.exitFullscreen();
        }
    });
}
function updateFullscreenIcon() {
    const btn = document.getElementById('fullscreen-toggle');
    if (!btn) return;
    const icon = btn.querySelector('i');
    if (!icon) return;
    if (document.fullscreenElement) {
        icon.classList.remove('fa-expand');
        icon.classList.add('fa-compress');
    } else {
        icon.classList.remove('fa-compress');
        icon.classList.add('fa-expand');
    }
}

// ──────────────────────────────────────
// Startup
// ──────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    generateParticles();
    initSession();
    initFullscreenToggle();

    // Resize player when window changes or enters fullscreen
    window.addEventListener('resize', resizePlayer);
    document.addEventListener('fullscreenchange', () => {
        resizePlayer();
        updateFullscreenIcon();
    });
    document.addEventListener('webkitfullscreenchange', () => {
        resizePlayer();
        updateFullscreenIcon();
    });

    // Run once after layout stabilises
    setTimeout(resizePlayer, 200);
});