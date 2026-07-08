/**
 * popup.js - Extension popup UI logic
 */

let timerInterval = null;
let startedAt = null;
let captureMode = 'video'; // 'video' | 'screenshot'
let currentScreenshotDataUrl = null;
let slackConfigForPopup = null; // cached { configured, defaultChannel, savedChannels, savedThreads }

const DEFAULT_COLLECTOR_URL = 'http://127.0.0.1:17890';

async function getCollectorUrl() {
    const { collectorUrl } = await chrome.storage.local.get(['collectorUrl']);
    return collectorUrl || DEFAULT_COLLECTOR_URL;
}

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
        document.getElementById('btn-start').style.display = 'flex';
    }
}

// ── Capture mode (Video / Screenshot) ──────────────────────────────────────────
function updateModeUI() {
    document.getElementById('mode-pill-video').classList.toggle('active', captureMode === 'video');
    document.getElementById('mode-pill-screenshot').classList.toggle('active', captureMode === 'screenshot');
    document.getElementById('row-toggle-logs').classList.toggle('dimmed', captureMode !== 'video');
    document.getElementById('row-toggle-bodies').classList.toggle('dimmed', captureMode !== 'video' || !document.getElementById('toggle-logs').checked);

    const btnStart = document.getElementById('btn-start');
    btnStart.textContent = captureMode === 'screenshot' ? '📸 Capture Screenshot' : '● Start Recording';
}

function selectMode(mode) {
    captureMode = mode;
    chrome.storage.local.set({ captureMode: mode });
    updateModeUI();
}

// ── Load state on open ────────────────────────────────────────────────────────
async function init() {
    const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    setRecordingUI(status.recording, status.sessionId, status.startedAt);

    // Load settings
    const settings = await chrome.storage.local.get(['liteCapture', 'captureLogs', 'captureMode']);
    document.getElementById('toggle-bodies').checked = settings.liteCapture !== undefined ? settings.liteCapture : false;
    document.getElementById('toggle-logs').checked = settings.captureLogs !== undefined ? settings.captureLogs : true;
    captureMode = settings.captureMode === 'screenshot' ? 'screenshot' : 'video';
    updateModeUI();

    // Save on toggle change
    document.getElementById('toggle-bodies').addEventListener('change', e => {
        chrome.storage.local.set({ liteCapture: e.target.checked });
    });
    document.getElementById('toggle-logs').addEventListener('change', e => {
        chrome.storage.local.set({ captureLogs: e.target.checked });
        updateModeUI();
    });
    document.getElementById('mode-pill-video').addEventListener('click', () => selectMode('video'));
    document.getElementById('mode-pill-screenshot').addEventListener('click', () => selectMode('screenshot'));
}

// ── Start / Capture dispatcher ─────────────────────────────────────────────────
function onStartClick() {
    if (captureMode === 'screenshot') captureScreenshot();
    else startRecording();
}

// ── Start Recording (video mode) ────────────────────────────────────────────────
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

// ── Screenshot capture + report flow ────────────────────────────────────────────
async function captureScreenshot() {
    const btn = document.getElementById('btn-start');
    btn.disabled = true;
    btn.textContent = '…Capturing';

    try {
        const res = await chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' });
        if (res.error) throw new Error(res.error);
        currentScreenshotDataUrl = res.dataUrl;
        await showScreenshotReport();
    } catch (e) {
        showToast(`Screenshot failed: ${e.message}`);
    }

    btn.disabled = false;
    btn.textContent = '📸 Capture Screenshot';
}

async function showScreenshotReport() {
    document.getElementById('main-screen').style.display = 'none';
    document.getElementById('screenshot-report').style.display = 'block';
    document.getElementById('screenshot-preview').src = currentScreenshotDataUrl;
    document.getElementById('screenshot-desc').value = '';

    const collectorUrl = await getCollectorUrl();
    const channelSelect = document.getElementById('screenshot-channel');
    const threadSelect = document.getElementById('screenshot-thread');
    channelSelect.innerHTML = '<option>Loading…</option>';
    threadSelect.innerHTML = '<option value="">No thread — new message</option>';

    try {
        const res = await fetch(`${collectorUrl}/integrations/slack/config`);
        slackConfigForPopup = await res.json();
    } catch {
        slackConfigForPopup = { configured: false, savedChannels: [], savedThreads: [] };
    }

    if (!slackConfigForPopup.configured || !(slackConfigForPopup.savedChannels || []).length) {
        channelSelect.innerHTML = '<option value="">No channel configured</option>';
        showToast('Set up Slack channels in the Viewer UI → Settings first');
        document.getElementById('btn-send-screenshot').disabled = true;
        return;
    }
    document.getElementById('btn-send-screenshot').disabled = false;

    channelSelect.innerHTML = slackConfigForPopup.savedChannels
        .map(c => `<option value="${c.id}">${c.name} (${c.id})</option>`).join('');
    if (slackConfigForPopup.defaultChannel) channelSelect.value = slackConfigForPopup.defaultChannel;

    threadSelect.innerHTML = '<option value="">No thread — new message</option>' +
        (slackConfigForPopup.savedThreads || []).map(t => `<option value="${t.id}">${t.name}</option>`).join('');
}

function hideScreenshotReport() {
    document.getElementById('screenshot-report').style.display = 'none';
    document.getElementById('main-screen').style.display = 'block';
    currentScreenshotDataUrl = null;
}

async function sendScreenshotReport() {
    if (!currentScreenshotDataUrl) return;
    const btn = document.getElementById('btn-send-screenshot');
    const channel = document.getElementById('screenshot-channel').value;
    const threadId = document.getElementById('screenshot-thread').value;
    const text = document.getElementById('screenshot-desc').value.trim();

    if (!channel) { showToast('Choose a channel'); return; }

    const savedThread = threadId ? (slackConfigForPopup.savedThreads || []).find(t => t.id === threadId) : null;

    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
        const collectorUrl = await getCollectorUrl();
        const blob = await (await fetch(currentScreenshotDataUrl)).blob();
        const form = new FormData();
        form.append('image', blob, 'screenshot.png');
        form.append('channel', channel);
        if (savedThread) form.append('threadLink', savedThread.link);
        if (text) form.append('text', text);

        const res = await fetch(`${collectorUrl}/integrations/slack/send-screenshot`, { method: 'POST', body: form });
        const data = await res.json();
        if (!data.ok) throw new Error(data.message || 'Failed to send');
        showToast('📸 Sent to Slack ✓');
        hideScreenshotReport();
    } catch (e) {
        showToast(`Failed to send: ${e.message}`);
    }
    btn.disabled = false;
    btn.textContent = 'Send to Slack';
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
    document.getElementById('btn-start').addEventListener('click', onStartClick);
    document.getElementById('btn-stop').addEventListener('click', stopRecording);
    document.getElementById('btn-marker').addEventListener('click', toggleMarkerInput);
    document.getElementById('btn-submit-marker').addEventListener('click', submitMarker);
    document.getElementById('btn-viewer').addEventListener('click', openViewer);
    document.getElementById('btn-send-screenshot').addEventListener('click', sendScreenshotReport);
    document.getElementById('btn-cancel-screenshot').addEventListener('click', hideScreenshotReport);

    init();
});

// ── Open Viewer ───────────────────────────────────────────────────────────────
function openViewer() {
    chrome.tabs.create({ url: 'http://127.0.0.1:17890' });
}
