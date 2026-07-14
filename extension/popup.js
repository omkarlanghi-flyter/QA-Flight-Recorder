/**
 * popup.js - Extension popup UI logic
 */

let timerInterval = null;
let startedAt = null;
let captureMode = 'video'; // 'video' | 'screenshot'
let screenshotSubMode = 'single'; // 'single' | 'multi' — only relevant when captureMode === 'screenshot'
let currentScreenshotDataUrl = null;
let reportingMultiCapture = false; // true while the report screen is submitting a multi-capture batch, not a single shot
let multiCaptureShotsForReport = []; // snapshot used only to render the preview strip on the report screen
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

    document.getElementById('screenshot-submode-row').style.display = captureMode === 'screenshot' ? '' : 'none';
    document.getElementById('mode-pill-single').classList.toggle('active', screenshotSubMode === 'single');
    document.getElementById('mode-pill-multi').classList.toggle('active', screenshotSubMode === 'multi');

    const btnStart = document.getElementById('btn-start');
    if (captureMode !== 'screenshot') btnStart.textContent = '● Start Recording';
    else btnStart.textContent = screenshotSubMode === 'multi' ? '📸 Start Multi-Capture' : '📸 Capture Screenshot';
}

function selectMode(mode) {
    captureMode = mode;
    chrome.storage.local.set({ captureMode: mode });
    updateModeUI();
}

function selectScreenshotSubMode(mode) {
    screenshotSubMode = mode;
    chrome.storage.local.set({ screenshotSubMode: mode });
    updateModeUI();
}

// ── Load state on open ────────────────────────────────────────────────────────
async function init() {
    // A "Multimedia" capture in progress takes over the whole popup, regardless
    // of which tab it was started from — reopening the popup on ANY tab (after
    // switching tabs to capture something else) should offer to add this tab's
    // shot to the same collection, not show the normal start screen.
    const mcStatus = await chrome.runtime.sendMessage({ type: 'GET_MULTI_CAPTURE_STATUS' });
    if (mcStatus && mcStatus.active) {
        showMultiCaptureStatusScreen(mcStatus);
        wireMultiCaptureStatusScreen();
        return;
    }

    const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    setRecordingUI(status.recording, status.sessionId, status.startedAt);

    // Load settings
    const settings = await chrome.storage.local.get(['liteCapture', 'captureLogs', 'captureMode', 'screenshotSubMode']);
    document.getElementById('toggle-bodies').checked = settings.liteCapture !== undefined ? settings.liteCapture : false;
    document.getElementById('toggle-logs').checked = settings.captureLogs !== undefined ? settings.captureLogs : true;
    captureMode = settings.captureMode === 'screenshot' ? 'screenshot' : 'video';
    screenshotSubMode = settings.screenshotSubMode === 'multi' ? 'multi' : 'single';
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
    document.getElementById('mode-pill-single').addEventListener('click', () => selectScreenshotSubMode('single'));
    document.getElementById('mode-pill-multi').addEventListener('click', () => selectScreenshotSubMode('multi'));
}

// ── Start / Capture dispatcher ─────────────────────────────────────────────────
function onStartClick() {
    if (captureMode === 'screenshot') {
        if (screenshotSubMode === 'multi') startMultiCapture();
        else captureScreenshot();
    } else {
        startRecording();
    }
}

// ── Multi-capture ("Multimedia") — hands off to the on-page tray immediately;
// the popup has nothing further to do since it'll close the moment the user
// clicks the page to navigate/interact between captures. All subsequent
// state lives in background.js, driven by content.js's tray widget.
async function startMultiCapture() {
    const btn = document.getElementById('btn-start');
    btn.disabled = true;
    btn.textContent = '…Starting';
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const res = await chrome.runtime.sendMessage({ type: 'START_MULTI_CAPTURE', tabId: tab?.id });
        if (res.error) throw new Error(res.error);
        showToast('📸 Capture tray opened — bottom-right of the page');
        window.close();
    } catch (e) {
        showToast(`Failed to start: ${e.message}`);
        btn.disabled = false;
        btn.textContent = '📸 Start Multi-Capture';
    }
}

// ── Multi-capture status screen (shown on reopen while a capture is active) ────
// This is what makes cross-tab/cross-app capture work: chrome.tabs.captureVisibleTab
// can only ever grab the tab that's active right now, so to add a shot of a
// *different* tab, the user switches to it and reopens the popup — which,
// since the popup always reflects whichever tab it's opened from, naturally
// captures the right one. For anything the extension can't capture at all
// (a native app like Postman), "Add from File" imports an existing image
// instead of trying to screenshot it.
function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

function showMultiCaptureStatusScreen(mcStatus) {
    document.getElementById('main-screen').style.display = 'none';
    document.getElementById('screenshot-report').style.display = 'none';
    document.getElementById('multi-capture-status').style.display = 'block';
    renderMultiCaptureStatus(mcStatus);
}

function renderMultiCaptureStatus(mcStatus) {
    const count = mcStatus.shots.length;
    const atLimit = count >= mcStatus.maxShots;
    document.getElementById('mc-shot-count').textContent =
        `${count} screenshot${count !== 1 ? 's' : ''}${atLimit ? ' (max reached)' : ''}`;
    document.getElementById('mc-thumbs').innerHTML = mcStatus.shots.map(s => `<img src="${s.dataUrl}" />`).join('');
    document.getElementById('btn-mc-capture-tab').disabled = atLimit;
    document.getElementById('btn-mc-from-file').disabled = atLimit;
    document.getElementById('btn-mc-report').disabled = count === 0;
}

function wireMultiCaptureStatusScreen() {
    document.getElementById('btn-mc-capture-tab').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = '…Capturing';
        const res = await chrome.runtime.sendMessage({ type: 'CAPTURE_ANOTHER_SHOT' });
        btn.textContent = '📸 Capture This Tab';
        if (res.error) { showToast(res.error); btn.disabled = false; return; }
        const mcStatus = await chrome.runtime.sendMessage({ type: 'GET_MULTI_CAPTURE_STATUS' });
        renderMultiCaptureStatus(mcStatus);
    });

    document.getElementById('btn-mc-from-file').addEventListener('click', () => {
        document.getElementById('mc-file-input').click();
    });

    document.getElementById('mc-file-input').addEventListener('change', async (e) => {
        const files = Array.from(e.target.files || []).filter(f => f.type.startsWith('image/'));
        e.target.value = ''; // allow re-selecting the same file next time
        if (!files.length) return;
        const dataUrls = await Promise.all(files.map(readFileAsDataUrl));
        const res = await chrome.runtime.sendMessage({ type: 'ADD_MULTI_CAPTURE_FILES', dataUrls });
        if (res.error) { showToast(res.error); return; }
        if (res.skipped > 0) showToast(`Added ${res.added}, skipped ${res.skipped} — hit the ${8} screenshot limit`);
        const mcStatus = await chrome.runtime.sendMessage({ type: 'GET_MULTI_CAPTURE_STATUS' });
        renderMultiCaptureStatus(mcStatus);
    });

    document.getElementById('btn-mc-report').addEventListener('click', async () => {
        const mcStatus = await chrome.runtime.sendMessage({ type: 'GET_MULTI_CAPTURE_STATUS' });
        if (!mcStatus.shots.length) return;
        reportingMultiCapture = true;
        multiCaptureShotsForReport = mcStatus.shots;
        await showScreenshotReport();
    });

    document.getElementById('btn-mc-cancel').addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: 'CANCEL_MULTI_CAPTURE' });
        window.close();
    });
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
            if (captureMode === 'video' && res.videoCaptureFailed) {
                // Recording still proceeded (logs/network still capture fine) —
                // but video specifically didn't start, and that's easy to miss
                // until you open the viewer later and find no video tab. Give
                // it a long-lived toast so it's actually seen now.
                showToast(`⚠️ Video did not start: ${res.videoCaptureError || 'unknown error'}`, 8000);
            }
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
            showToast('Session saved ✓ Open Dashboard to browse');
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
    document.getElementById('multi-capture-status').style.display = 'none';
    document.getElementById('screenshot-report').style.display = 'block';

    const preview = document.getElementById('screenshot-preview');
    const strip = document.getElementById('screenshot-preview-strip');
    if (reportingMultiCapture) {
        preview.style.display = 'none';
        strip.style.display = 'flex';
        strip.innerHTML = multiCaptureShotsForReport.map(s => `<img src="${s.dataUrl}" />`).join('');
    } else {
        preview.style.display = 'block';
        strip.style.display = 'none';
        preview.src = currentScreenshotDataUrl;
    }
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
        showToast('Set up Slack channels in the Dashboard → Integrations first');
        document.getElementById('btn-send-screenshot').disabled = true;
        return;
    }
    document.getElementById('btn-send-screenshot').disabled = false;

    channelSelect.innerHTML = slackConfigForPopup.savedChannels
        .map(c => `<option value="${c.id}">${c.name} (${c.id})</option>`).join('');
    if (slackConfigForPopup.defaultChannel) channelSelect.value = slackConfigForPopup.defaultChannel;

    renderScreenshotThreadOptions();
}

// Threads are scoped to whichever channel is currently selected above, same
// as the Settings tab nests threads under their channel — otherwise the
// dropdown mixes threads from every saved channel with no indication of
// which one they actually belong to.
function renderScreenshotThreadOptions() {
    const channelId = document.getElementById('screenshot-channel').value;
    const threadSelect = document.getElementById('screenshot-thread');
    const threads = (slackConfigForPopup?.savedThreads || []).filter(t => t.channel === channelId);
    threadSelect.innerHTML = '<option value="">No thread — new message</option>' +
        threads.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
}

async function hideScreenshotReport() {
    document.getElementById('screenshot-report').style.display = 'none';
    currentScreenshotDataUrl = null;

    if (reportingMultiCapture) {
        reportingMultiCapture = false;
        // "Cancel" here just backs out of the report form — the capture itself
        // is still in progress, so return to the status screen rather than
        // discarding it. "Cancel Capture" on that screen is the real cancel.
        const mcStatus = await chrome.runtime.sendMessage({ type: 'GET_MULTI_CAPTURE_STATUS' });
        if (mcStatus && mcStatus.active) showMultiCaptureStatusScreen(mcStatus);
        else window.close(); // already sent/cancelled elsewhere in the meantime
    } else {
        document.getElementById('main-screen').style.display = 'block';
    }
}

async function sendScreenshotReport() {
    if (!reportingMultiCapture && !currentScreenshotDataUrl) return;
    const btn = document.getElementById('btn-send-screenshot');
    const channel = document.getElementById('screenshot-channel').value;
    const threadId = document.getElementById('screenshot-thread').value;
    const text = document.getElementById('screenshot-desc').value.trim();

    if (!channel) { showToast('Choose a channel'); return; }

    const savedThread = threadId ? (slackConfigForPopup.savedThreads || []).find(t => t.id === threadId) : null;

    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
        if (reportingMultiCapture) {
            // Shots already live in background.js (multiCapture.shots) — no
            // need to re-send the image data, just the report fields.
            const res = await chrome.runtime.sendMessage({
                type: 'SUBMIT_MULTI_CAPTURE_REPORT',
                channel, threadLink: savedThread ? savedThread.link : undefined, text,
            });
            if (res.error) throw new Error(res.error);
        } else {
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
        }
        showToast('📸 Sent to Slack ✓');
        reportingMultiCapture = false; // capture already torn down server-side; just close, nothing to return to
        window.close();
    } catch (e) {
        showToast(`Failed to send: ${e.message}`);
        btn.disabled = false;
        btn.textContent = 'Send to Slack';
    }
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
    document.getElementById('btn-viewer').addEventListener('click', openDashboard);
    document.getElementById('btn-send-screenshot').addEventListener('click', sendScreenshotReport);
    document.getElementById('btn-cancel-screenshot').addEventListener('click', hideScreenshotReport);
    document.getElementById('screenshot-channel').addEventListener('change', renderScreenshotThreadOptions);

    init();
});

// ── Open Dashboard ────────────────────────────────────────────────────────────
function openDashboard() {
    chrome.tabs.create({ url: 'http://127.0.0.1:17890' });
}
