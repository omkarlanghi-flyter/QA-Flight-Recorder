/**
 * popup.js - Extension popup UI logic
 */

let timerInterval = null;
let startedAt = null;

// ── Toast ──────────────────────────────────────────────────────────────────
function showToast(msg, ms = 2500) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), ms);
}

// ── Timer ──────────────────────────────────────────────────────────────────
function startTimer(sinceMs) {
    startedAt = sinceMs;
    const timerEl = document.getElementById('timer-value');
    const update = () => {
        const elapsed = Date.now() - startedAt;
        const s = Math.floor(elapsed / 1000) % 60;
        const m = Math.floor(elapsed / 60000) % 60;
        const h = Math.floor(elapsed / 3600000);
        timerEl.textContent = h > 0
            ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
            : `${m}:${String(s).padStart(2, '0')}`;
    };
    update();
    timerInterval = setInterval(update, 500);
}

function stopTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// ── UI state ──────────────────────────────────────────────────────────────────
function setRecordingUI(recording, sessionId, startedAtMs) {
    const pill = document.getElementById('status-pill');
    const btnStart = document.getElementById('btn-start');
    const btnStop = document.getElementById('btn-stop');
    const btnMarker = document.getElementById('btn-marker');
    const timerRow = document.getElementById('timer-row');
    const sessionInfo = document.getElementById('session-info');
    const toggleSection = document.getElementById('toggle-section');

    if (recording) {
        pill.textContent = 'Recording';
        pill.className = 'status-pill status-recording';
        btnStart.style.display = 'none';
        btnStop.style.display = 'flex';
        btnMarker.disabled = false;
        timerRow.classList.add('visible');
        toggleSection.style.display = 'none';
        sessionInfo.classList.add('visible');
        document.getElementById('session-id-value').textContent = sessionId || '—';
        if (!timerInterval && startedAtMs) startTimer(startedAtMs);
    } else {
        pill.textContent = 'Idle';
        pill.className = 'status-pill status-idle';
        btnStart.style.display = 'flex';
        btnStop.style.display = 'none';
        btnMarker.disabled = true;
        timerRow.classList.remove('visible');
        toggleSection.style.display = '';
        sessionInfo.classList.remove('visible');
        stopTimer();
        // Hide marker row
        document.getElementById('marker-row').classList.remove('visible');
    }
}

// ── Load state on open ────────────────────────────────────────────────────────
async function init() {
    const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    setRecordingUI(status.recording, status.sessionId, status.startedAt);

    // Load settings
    const settings = await chrome.storage.local.get(['videoEnabled', 'captureFailedBodies']);
    if (settings.videoEnabled !== undefined) {
        document.getElementById('toggle-video').checked = settings.videoEnabled;
    }
    if (settings.captureFailedBodies !== undefined) {
        document.getElementById('toggle-bodies').checked = settings.captureFailedBodies;
    }

    // Save on toggle change
    document.getElementById('toggle-video').addEventListener('change', e => {
        chrome.storage.local.set({ videoEnabled: e.target.checked });
    });
    document.getElementById('toggle-bodies').addEventListener('change', e => {
        chrome.storage.local.set({ captureFailedBodies: e.target.checked });
    });
}

// ── Start ─────────────────────────────────────────────────────────────────────
async function startRecording() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { showToast('No active tab found'); return; }

    const btn = document.getElementById('btn-start');
    btn.disabled = true;
    btn.textContent = '…Starting';

    try {
        const res = await chrome.runtime.sendMessage({ type: 'START_RECORDING', tabId: tab.id });
        if (res.error) {
            showToast(`Error: ${res.error}`);
            btn.disabled = false;
            btn.textContent = '● Start Recording';
        } else {
            setRecordingUI(true, res.session_id, res.started_at);
        }
    } catch (e) {
        showToast(`Failed: ${e.message}`);
        btn.disabled = false;
        btn.textContent = '● Start Recording';
    }
}

// ── Stop ──────────────────────────────────────────────────────────────────────
async function stopRecording() {
    const btn = document.getElementById('btn-stop');
    btn.disabled = true;
    btn.textContent = '…Stopping';

    try {
        const res = await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
        if (res.error) {
            showToast(`Error: ${res.error}`);
        } else {
            setRecordingUI(false);
            showToast('Session saved ✓ Open Viewer to browse');
        }
    } catch (e) {
        showToast(`Failed: ${e.message}`);
    }

    btn.disabled = false;
    btn.textContent = '■ Stop Recording';
}

// ── Bug Marker ────────────────────────────────────────────────────────────────
function toggleMarkerInput() {
    const row = document.getElementById('marker-row');
    const isVisible = row.classList.toggle('visible');
    if (isVisible) document.getElementById('marker-note').focus();
}

function submitMarker() {
    const note = document.getElementById('marker-note').value.trim();
    chrome.runtime.sendMessage({ type: 'ADD_BUG_MARKER', note });
    document.getElementById('marker-note').value = '';
    document.getElementById('marker-row').classList.remove('visible');
    showToast('🐛 Bug marker added');
}

// Allow pressing Enter to submit marker
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('marker-note').addEventListener('keydown', e => {
        if (e.key === 'Enter') submitMarker();
    });

    // Wire up buttons (inline onclick is blocked by CSP)
    document.getElementById('btn-start').addEventListener('click', startRecording);
    document.getElementById('btn-stop').addEventListener('click', stopRecording);
    document.getElementById('btn-marker').addEventListener('click', toggleMarkerInput);
    document.getElementById('btn-submit-marker').addEventListener('click', submitMarker);
    document.getElementById('btn-viewer').addEventListener('click', openViewer);

    init();
});

// ── Open Viewer ───────────────────────────────────────────────────────────────
function openViewer() {
    chrome.tabs.create({ url: 'http://127.0.0.1:17890' });
}
