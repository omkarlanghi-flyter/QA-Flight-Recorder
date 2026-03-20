/**
 * background.js - Chrome Extension Service Worker
 * Handles CDP attachment, event collection, and streaming to local server
 */

const COLLECTOR_URL = 'http://127.0.0.1:17890';
const BATCH_INTERVAL_MS = 2000;
const MAX_BATCH_SIZE = 50;
const VIDEO_CHUNK_TIMESLICE_MS = 5000;

let state = {
    recording: false,
    sessionId: null,
    tabId: null,
    startedAt: null,
    // Video
    mediaRecorder: null,
    videoEnabled: true,
    captureFailedBodies: false,
    // Buffered events
    eventBuffer: [],
    batchTimer: null,
    chunkIndex: 0,
    // CDP request tracking
    pendingRequests: {},
};

// ── Storage helpers ──────────────────────────────────────────────────────────
async function loadSettings() {
    const settings = await chrome.storage.local.get(['collectorUrl', 'videoEnabled', 'captureFailedBodies']);
    return {
        collectorUrl: settings.collectorUrl || COLLECTOR_URL,
        videoEnabled: settings.videoEnabled !== undefined ? settings.videoEnabled : true,
        captureFailedBodies: settings.captureFailedBodies || false,
    };
}

async function getStatus() {
    await chrome.storage.local.set({
        recording: state.recording,
        sessionId: state.sessionId,
        tabId: state.tabId,
        startedAt: state.startedAt,
    });
    return {
        recording: state.recording,
        sessionId: state.sessionId,
        tabId: state.tabId,
        startedAt: state.startedAt,
    };
}

// ── Event helpers ────────────────────────────────────────────────────────────
function makeEvent(type, source, data, url) {
    return {
        session_id: state.sessionId,
        ts_epoch_ms: Date.now(),
        type,
        source,
        tab_id: state.tabId,
        url: url || undefined,
        data,
    };
}

function bufferEvent(event) {
    if (!state.recording) return;
    state.eventBuffer.push(event);
    if (state.eventBuffer.length >= MAX_BATCH_SIZE) {
        flushEvents();
    }
}

async function flushEvents() {
    if (!state.eventBuffer.length || !state.sessionId) return;
    const batch = state.eventBuffer.splice(0, state.eventBuffer.length);
    try {
        const settings = await loadSettings();
        await fetch(`${settings.collectorUrl}/session/${state.sessionId}/event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(batch),
        });
    } catch (e) {
        console.error('[QA Recorder] Failed to flush events:', e.message);
        // Put events back on error
        state.eventBuffer.unshift(...batch);
    }
}

// ── CDP Event Handlers ───────────────────────────────────────────────────────
// Static asset extensions — skip these entirely to avoid flooding events
const STATIC_ASSET_RE = /\.(png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|otf|css|map|mp4|webm|mp3|wav|pdf|zip|gz)(\?|#|$)/i;
const BODY_SIZE_LIMIT_BYTES = 50000; // 50KB — skip body capture for large responses

function isStaticAsset(url) {
    if (!url) return false;
    try { return STATIC_ASSET_RE.test(new URL(url).pathname); }
    catch { return STATIC_ASSET_RE.test(url); }
}

function handleCDPEvent(source, method, params) {
    if (!state.recording) return;

    switch (method) {

        // ── Network ────────────────────────────────────────────────────────────
        case 'Network.requestWillBeSent': {
            const req = params.request;
            const reqId = params.requestId;
            const rawUrl = req.url;

            // PERF FIX 1: Skip static assets entirely — no events, no memory
            if (isStaticAsset(rawUrl)) break;

            const url = sanitizeUrl(rawUrl);

            // Capture POST/PUT body if available (limit to 50KB)
            let requestBody = null;
            if (req.hasPostData && req.postData) {
                requestBody = req.postData.substring(0, BODY_SIZE_LIMIT_BYTES);
            }

            // PERF FIX 2: Only capture request headers for API calls, not assets
            const requestHeaders = redactHeaders(req.headers || {});

            state.pendingRequests[reqId] = {
                url,
                rawUrl,
                method: req.method,
                startTime: params.timestamp,
                requestBody,
                requestHeaders,
                responseBody: null,
                responseHeaders: null,
                responseStatus: null,
                bodyFetchPromise: null,
                isAPI: false, // confirmed when responseReceived fires with XHR/Fetch type
            };

            bufferEvent(makeEvent('network.request', 'cdp', {
                request_id: reqId,
                method: req.method,
                url_sanitized: url,
                url_full: rawUrl,
                request_body: requestBody,
                request_headers: requestHeaders,
                initiator: params.initiator?.type,
            }, url));
            break;
        }

        case 'Network.responseReceived': {
            const resp = params.response;
            const reqId = params.requestId;
            const pending = state.pendingRequests[reqId];

            // PERF FIX 3: If this request wasn't tracked (was a static asset at request time)
            // or Chrome confirmed it's a non-API type, silently drop it
            const isAPIType = params.type === 'Fetch' || params.type === 'XHR' || params.type === 'Document';
            if (!pending) break; // static asset, already skipped

            pending.responseStatus = resp.status;
            pending.isAPI = isAPIType;
            pending.responseHeaders = redactHeaders(resp.headers || {});

            // PERF FIX 4: Gate body capture by status code and user setting
            // Default (captureFailedBodies=false): only fetch bodies for errors (>=400)
            // Opt-in (captureFailedBodies=true): fetch bodies for ALL XHR/Fetch
            const isErrorResponse = resp.status >= 400;
            const shouldCaptureBody = isAPIType && (
                isErrorResponse || state.captureFailedBodies
            ) && (resp.encodedDataLength || 0) < BODY_SIZE_LIMIT_BYTES * 4;

            if (shouldCaptureBody) {
                pending.bodyFetchPromise = chrome.debugger
                    .sendCommand({ tabId: source.tabId }, 'Network.getResponseBody', { requestId: reqId })
                    .then((result) => {
                        if (result && result.body) {
                            pending.responseBody = result.body.substring(0, BODY_SIZE_LIMIT_BYTES);
                        }
                    })
                    .catch(() => { /* preflight or body dropped */ });
            }

            bufferEvent(makeEvent('network.response', 'cdp', {
                request_id: reqId,
                status: resp.status,
                mimeType: resp.mimeType,
                encodedDataLength: resp.encodedDataLength,
                url_sanitized: sanitizeUrl(resp.url),
                url_full: resp.url,
                response_headers: pending.responseHeaders,
            }, sanitizeUrl(resp.url)));
            break;
        }

        case 'Network.loadingFinished': {
            const reqId = params.requestId;
            const pending = state.pendingRequests[reqId];
            if (pending) {
                const duration_ms = params.timestamp
                    ? Math.round((params.timestamp - pending.startTime) * 1000)
                    : null;

                // FIXED: Await the body fetch promise before emitting the timing event
                // This eliminates the old 50ms race condition where body was always null
                const emitTiming = () => {
                    bufferEvent(makeEvent('network.timing', 'cdp', {
                        request_id: reqId,
                        duration_ms,
                        method: pending.method,
                        url_sanitized: pending.url,
                        url_full: pending.rawUrl,
                        request_body: pending.requestBody,
                        request_headers: pending.requestHeaders,
                        response_body: pending.responseBody,
                        response_headers: pending.responseHeaders,
                        response_status: pending.responseStatus,
                    }, pending.url));
                    delete state.pendingRequests[reqId];
                };

                if (pending.bodyFetchPromise) {
                    pending.bodyFetchPromise.then(emitTiming);
                } else {
                    emitTiming();
                }
            }
            break;
        }

        case 'Network.loadingFailed': {
            const reqId = params.requestId;
            const pending = state.pendingRequests[reqId];
            bufferEvent(makeEvent('network.failure', 'cdp', {
                request_id: reqId,
                errorText: params.errorText,
                canceled: params.canceled,
                method: pending?.method,
                url_sanitized: pending?.url,
                url_full: pending?.rawUrl,
                request_body: pending?.requestBody,
                request_headers: pending?.requestHeaders,
            }, pending?.url));
            if (pending) delete state.pendingRequests[reqId];
            break;
        }

        // ── Runtime Exceptions ──────────────────────────────────────────────────
        case 'Runtime.exceptionThrown': {
            const exc = params.exceptionDetails;
            const msg = exc?.exception?.description || exc?.text || 'Unknown exception';
            const stack = exc?.exception?.description || null;
            bufferEvent(makeEvent('runtime.exception', 'cdp', {
                message: msg.split('\n')[0].slice(0, 500),
                stack: stack ? stack.slice(0, 1000) : null,
                source: exc?.url,
                line: exc?.lineNumber,
                column: exc?.columnNumber,
            }));
            break;
        }

        // ── Log Entries ────────────────────────────────────────────────────────
        case 'Log.entryAdded': {
            const entry = params.entry;
            if (!['warning', 'error'].includes(entry.level)) return;
            const type = entry.level === 'warning' ? 'console.warn' : 'console.error';
            bufferEvent(makeEvent(type, 'cdp-log', {
                message: (entry.text || '').slice(0, 500),
                source: entry.source,
                url: entry.url,
            }, entry.url));
            break;
        }

        // ── Runtime Console messages ───────────────────────────────────────────
        case 'Runtime.consoleAPICalled': {
            const level = params.type;
            if (!['warning', 'error'].includes(level)) return;
            const type = level === 'warning' ? 'console.warn' : 'console.error';
            const args = (params.args || []).map(a => a.value || a.description || String(a.type)).join(' ');
            bufferEvent(makeEvent(type, 'cdp-runtime', {
                message: args.slice(0, 500),
            }));
            break;
        }
    }
}

// ── URL Sanitization ─────────────────────────────────────────────────────────
function sanitizeUrl(url) {
    if (!url) return url;
    try {
        const u = new URL(url);
        // Keep only protocol + host + pathname; strip query and hash
        return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
        return url;
    }
}

// ── Header Redaction ──────────────────────────────────────────────────────────
const SENSITIVE_HEADERS = /^(authorization|cookie|set-cookie|x-api-key|x-auth-token|proxy-authorization)$/i;

function redactHeaders(headers) {
    if (!headers || typeof headers !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
        out[k] = SENSITIVE_HEADERS.test(k) ? '[REDACTED]' : v;
    }
    return out;
}

// ── CDP Attachment ────────────────────────────────────────────────────────────
async function attachCDP(tabId) {
    try {
        await chrome.debugger.attach({ tabId }, '1.3');
        await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
        await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {});
        await chrome.debugger.sendCommand({ tabId }, 'Log.enable', {});
        // Enable console API calls via Runtime
        await chrome.debugger.sendCommand({ tabId }, 'Runtime.setAsyncCallStackDepth', { maxDepth: 32 });
        console.log('[QA Recorder] CDP attached to tab', tabId);
    } catch (e) {
        console.error('[QA Recorder] CDP attach failed:', e.message);
        throw e;
    }
}

async function detachCDP(tabId) {
    try {
        await chrome.debugger.sendCommand({ tabId }, 'Network.disable', {});
        await chrome.debugger.sendCommand({ tabId }, 'Runtime.disable', {});
        await chrome.debugger.sendCommand({ tabId }, 'Log.disable', {});
        await chrome.debugger.detach({ tabId });
        console.log('[QA Recorder] CDP detached from tab', tabId);
    } catch (e) {
        console.warn('[QA Recorder] CDP detach error:', e.message);
    }
}

// Listen to CDP events from all debugger sessions
chrome.debugger.onEvent.addListener((source, method, params) => {
    // CRITICAL FIX: Only process events for the specific tab we are recording
    if (state.recording && source.tabId === state.tabId) {
        handleCDPEvent(source, method, params);
    }
});

// ── Tab Capture / Video ──────────────────────────────────────────────────────
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

async function ensureOffscreenDocument() {
    if (await chrome.offscreen.hasDocument()) {
        return;
    }
    await chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: ['USER_MEDIA'],
        justification: 'Recording video of the current tab for QA testing'
    });
}

async function startVideoCapture(tabId) {
    const settings = await loadSettings();
    if (!settings.videoEnabled) return;

    try {
        const streamId = await new Promise((resolve, reject) => {
            chrome.tabCapture.getMediaStreamId(
                { targetTabId: tabId },
                (streamId) => {
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                    else resolve(streamId);
                }
            );
        });

        await ensureOffscreenDocument();

        // Send message to offscreen document
        await chrome.runtime.sendMessage({
            type: 'START_VIDEO_CAPTURE',
            streamId,
            sessionId: state.sessionId,
            collectorUrl: settings.collectorUrl,
        });
    } catch (e) {
        console.warn('[QA Recorder] Video capture not available or timed out:', e.message);
    }
}

async function stopVideoCapture() {
    try {
        await chrome.runtime.sendMessage({ type: 'STOP_VIDEO_CAPTURE' });
        // Give it a tiny bit of time to finalize tracks before tearing down document
        setTimeout(async () => {
            if (await chrome.offscreen.hasDocument()) {
                await chrome.offscreen.closeDocument();
            }
        }, 100);
    } catch { }
}

// ── Start Recording ───────────────────────────────────────────────────────────
async function startRecording(tabId, options = {}) {
    if (state.recording) return { error: 'Already recording' };

    const settings = await loadSettings();

    // Get tab info
    const tab = await chrome.tabs.get(tabId);
    state.tabId = tabId;
    state.videoEnabled = settings.videoEnabled;
    state.captureFailedBodies = settings.captureFailedBodies;
    state.chunkIndex = 0;
    state.pendingRequests = {};
    state.eventBuffer = [];

    // Start session on server
    const res = await fetch(`${settings.collectorUrl}/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            tab_id: tabId, 
            url: tab.url, 
            title: tab.title,
            recording_type: options.recordingType,
            flow_name: options.flowName,
            module_name: options.moduleName
        }),
    });
    const { session_id, started_at } = await res.json();
    state.sessionId = session_id;
    state.startedAt = started_at;
    state.recording = true;

    // Attach CDP
    await attachCDP(tabId);

    // Inject content script
    await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js'],
    });

    // Start video capture
    await startVideoCapture(tabId);

    // Start batch flush timer
    state.batchTimer = setInterval(flushEvents, BATCH_INTERVAL_MS);

    // Save state
    await getStatus();

    chrome.action.setBadgeText({ text: '●', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444', tabId });

    console.log('[QA Recorder] Started session', session_id);
    return { ok: true, session_id, started_at };
}

// ── Stop Recording ────────────────────────────────────────────────────────────
async function stopRecording() {
    if (!state.recording) return { error: 'Not recording' };

    const { sessionId, tabId } = state;

    // Stop batch timer
    if (state.batchTimer) {
        clearInterval(state.batchTimer);
        state.batchTimer = null;
    }

    // Flush remaining events
    await flushEvents();

    // Stop video capture (ignore errors if page navigated or closed)
    try {
        await stopVideoCapture();
    } catch (e) {
        console.warn('[QA Recorder] stopVideoCapture error (ignored):', e.message);
    }

    // Detach CDP (ignore errors if already closed)
    if (tabId) {
        try {
            await detachCDP(tabId);
        } catch (e) {
            console.warn('[QA Recorder] detachCDP error (ignored):', e.message);
        }
    }

    // Reset state early so UI updates immediately
    state.recording = false;
    const sid = state.sessionId;
    state.sessionId = null;
    state.tabId = null;
    state.startedAt = null;

    if (tabId) {
        chrome.action.setBadgeText({ text: '', tabId }).catch(() => { });
    }
    await getStatus();

    // Notify server to stop (do this last)
    try {
        const settings = await loadSettings();
        const res = await fetch(`${settings.collectorUrl}/session/${sid}/stop`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        const data = await res.json();
        console.log('[QA Recorder] Stopped session', sid);
        return { ok: true, session_id: sid, duration_ms: data.duration_ms };
    } catch (e) {
        console.error('[QA Recorder] Server stop failed:', e.message);
        return { ok: true, session_id: sid, error: 'Server unreachable during stop' };
    }
}

// ── Bug Marker ────────────────────────────────────────────────────────────────
function addBugMarker(note) {
    if (!state.recording) return;
    bufferEvent(makeEvent('marker.bug', 'user', { note: note || '' }));
    flushEvents();
}

// ── Message Handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
        switch (msg.type) {
            case 'GET_STATUS':
                sendResponse(await getStatus());
                break;

            case 'START_RECORDING':
                sendResponse(await startRecording(msg.tabId, {
                    recordingType: msg.recordingType,
                    flowName: msg.flowName,
                    moduleName: msg.moduleName
                }));
                break;

            case 'STOP_RECORDING':
                sendResponse(await stopRecording());
                break;

            case 'ADD_BUG_MARKER':
                addBugMarker(msg.note);
                sendResponse({ ok: true });
                break;

            case 'CONTENT_EVENT':
                // Action events from content script
                bufferEvent({ ...msg.event, session_id: state.sessionId });
                sendResponse({ ok: true });
                break;

            case 'VIDEO_CHUNK': {
                // Video chunk from content script
                if (!state.sessionId) break;
                const settings = await loadSettings();
                const idx = state.chunkIndex++;
                const blob = msg.chunk;
                await fetch(`${settings.collectorUrl}/session/${state.sessionId}/video-chunk`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'x-chunk-index': String(idx),
                    },
                    body: blob,
                }).catch(e => console.warn('Chunk upload failed:', e.message));
                sendResponse({ ok: true });
                break;
            }

            case 'STOP_RECORDING_FROM_SYSTEM_BAR':
                if (state.recording) {
                    stopRecording().catch(e => console.error('Failed to stop recording from sys bar', e));
                }
                sendResponse({ ok: true });
                break;

            default:
                sendResponse({ error: 'Unknown message type' });
        }
    })();
    return true; // keep channel open for async
});

// ── Keyboard Commands ─────────────────────────────────────────────────────────
chrome.commands.onCommand.addListener(async (command) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    if (command === 'toggle-recording') {
        if (state.recording) {
            await stopRecording();
        } else {
            await startRecording(tab.id);
        }
    } else if (command === 'add-bug-marker') {
        addBugMarker();
    }
});

// ── Debugger detach listener (e.g. if user opens DevTools) ────────────────────
chrome.debugger.onDetach.addListener((source, reason) => {
    if (state.recording && source.tabId === state.tabId) {
        console.warn('[QA Recorder] CDP detached unexpectedly:', reason);
        if (reason === 'target_closed') return;

        // If the user clicked "Cancel" on the yellow debugging bar
        if (reason === 'canceled_by_user') {
            console.log('[QA Recorder] User canceled debugging. Stopping recording.');
            stopRecording().catch(e => console.error('Failed to stop recording from debugger detach', e));
            return;
        }

        // Re-attach on navigation detach
        attachCDP(source.tabId).catch(() => { });
    }
});

// ── Tab Navigation listener ────────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (state.recording && tabId === state.tabId && changeInfo.url) {
        bufferEvent(makeEvent('action.navigation', 'browser', {
            from_url: sanitizeUrl(state.lastUrl || ''),
            to_url: sanitizeUrl(changeInfo.url),
        }, changeInfo.url));
        state.lastUrl = changeInfo.url;
    }
});
