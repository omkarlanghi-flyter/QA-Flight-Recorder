/**
 * background.js - Chrome Extension Service Worker
 * Handles CDP attachment, event collection, and streaming to local server
 */

const COLLECTOR_URL = 'http://127.0.0.1:17890';
const BATCH_INTERVAL_MS = 2000;
const MAX_BATCH_SIZE = 50;
const VIDEO_CHUNK_TIMESLICE_MS = 5000;
const SCHEMA_VERSION = '2.0';

// Tracks the event_id of the most recent user-action event.
// Network/console events that fire within 1500ms get this as their correlation_id.
let _lastActionEventId = null;
let _lastActionTs = 0;
const CORRELATION_WINDOW_MS = 1500;

// ── Console Breadcrumb Ring-Buffer ───────────────────────────────────────────
// Stores the last N info/log messages as breadcrumbs for error context
const BREADCRUMB_BUFFER_SIZE = 50;
const consoleBreadcrumbs = [];

function addBreadcrumb(level, message) {
    consoleBreadcrumbs.push({ level, message, ts: Date.now() });
    if (consoleBreadcrumbs.length > BREADCRUMB_BUFFER_SIZE) {
        consoleBreadcrumbs.shift();
    }
}

function drainBreadcrumbs() {
    // Returns snapshot of breadcrumbs (do not clear — useful for multiple correlated errors)
    return consoleBreadcrumbs.slice();
}

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
    const eventId = crypto.randomUUID();
    const now = Date.now();

    // Determine correlation_id: network/console events correlate back to the
    // most recent user action that fired within CORRELATION_WINDOW_MS.
    let correlationId = null;
    const isActionEvent = type.startsWith('action.');
    if (!isActionEvent && _lastActionEventId && (now - _lastActionTs) <= CORRELATION_WINDOW_MS) {
        correlationId = _lastActionEventId;
    }

    const evt = {
        // Schema v2 canonical fields
        event_id:         eventId,
        session_id:       state.sessionId,
        timestamp:        now,
        event_type:       type,
        source,
        correlation_id:   correlationId,
        schema_version:   SCHEMA_VERSION,

        // Legacy compatibility fields (kept so old server code still reads fine)
        type,
        ts_epoch_ms:      now,
        tab_id:           state.tabId,
        url:              url || undefined,
        data,
    };

    // Track last action for correlation
    if (isActionEvent) {
        _lastActionEventId = eventId;
        _lastActionTs = now;
    }

    return evt;
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
        const baseUrl = settings.collectorUrl;

        // Try the v2 batch endpoint first; fall back to legacy on error
        const v2Url = `${baseUrl}/sessions/${state.sessionId}/events/batch`;
        const legacyUrl = `${baseUrl}/session/${state.sessionId}/event`;

        let ok = false;
        try {
            const resp = await fetch(v2Url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(batch),
            });
            ok = resp.ok;
        } catch (e) {
            // v2 endpoint failed (e.g. old server), try legacy
        }

        if (!ok) {
            await fetch(legacyUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-ingest-fallback': 'v2_failed',
                },
                body: JSON.stringify(batch),
            });
        }
    } catch (e) {
        console.error('[QA Recorder] Failed to flush events:', e.message);
        // Put events back so they aren't lost
        state.eventBuffer.unshift(...batch);
    }
}

// ── CDP Event Handlers ───────────────────────────────────────────────────────
// Static asset extensions to skip — NOTE: .js and .css are intentionally NOT here
// so we can still detect 4xx/5xx failures on critical scripts and stylesheets.
const STATIC_ASSET_RE = /\.(png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|otf|map|mp4|webm|mp3|wav|pdf|zip|gz)(\?|#|$)/i;
const BODY_SIZE_LIMIT_BYTES = 50000; // 50KB — skip body capture for large responses

function isStaticAsset(url) {
    if (!url) return false;
    try { return STATIC_ASSET_RE.test(new URL(url).pathname); }
    catch { return STATIC_ASSET_RE.test(url); }
}

/**
 * Attempt to extract GraphQL operation name and query type from a POST body.
 * Returns null if the request is not a GraphQL request.
 */
function parseGraphQL(url, postBody) {
    if (!postBody || !url) return null;
    try {
        // Check if URL pattern suggests GraphQL
        if (!/graphql|gql/i.test(url)) return null;
        const body = JSON.parse(postBody);
        if (!body || (!body.query && !body.operationName)) return null;
        const operationName = body.operationName || null;
        // Extract the operation type and name from the query string (query/mutation/subscription)
        let operationType = 'query';
        let parsedName = operationName;
        if (body.query) {
            const match = body.query.trim().match(/^(query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/);
            if (match) {
                operationType = match[1];
                parsedName = parsedName || match[2];
            }
        }
        return {
            graphql_operation: parsedName || 'anonymous',
            graphql_type: operationType,
            graphql_query_preview: body.query ? body.query.trim().slice(0, 200) : null,
        };
    } catch {
        return null;
    }
}

function handleCDPEvent(source, method, params) {
    if (!state.recording) return;

    switch (method) {

        // ── Network ────────────────────────────────────────────────────────────
        case 'Network.requestWillBeSent': {
            const req = params.request;
            const reqId = params.requestId;
            const rawUrl = req.url;

            // Skip media/font/image static assets but keep .js/.css so we detect critical failures
            if (isStaticAsset(rawUrl)) break;

            const url = sanitizeUrl(rawUrl);

            // Capture POST/PUT body if available (limit to 50KB)
            let requestBody = null;
            if (req.hasPostData && req.postData) {
                requestBody = req.postData.substring(0, BODY_SIZE_LIMIT_BYTES);
            }

            const requestHeaders = redactHeaders(req.headers || {});

            // Extract GraphQL operation metadata if applicable
            const gql = parseGraphQL(rawUrl, requestBody);

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
                isAPI: false,
                graphql: gql,
            };

            const eventData = {
                request_id: reqId,
                method: req.method,
                url_sanitized: url,
                url_full: rawUrl,
                request_body: requestBody,
                request_headers: requestHeaders,
                initiator: params.initiator?.type,
            };
            // Attach GraphQL metadata if present
            if (gql) Object.assign(eventData, gql);

            bufferEvent(makeEvent('network.request', 'cdp', eventData, url));
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

                const emitTiming = () => {
                    const timingData = {
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
                    };
                    // Include GraphQL metadata on timing events too
                    if (pending.graphql) Object.assign(timingData, pending.graphql);
                    bufferEvent(makeEvent('network.timing', 'cdp', timingData, pending.url));
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
            const level = entry.level;
            const message = (entry.text || '').slice(0, 500);

            if (level === 'info' || level === 'verbose') {
                // Info/verbose: add to breadcrumb buffer only, do not stream as event
                addBreadcrumb(level, message);
            } else if (level === 'warning') {
                addBreadcrumb('warn', message);
                bufferEvent(makeEvent('console.warn', 'cdp-log', {
                    message,
                    source: entry.source,
                    url: entry.url,
                }, entry.url));
            } else if (level === 'error') {
                bufferEvent(makeEvent('console.error', 'cdp-log', {
                    message,
                    source: entry.source,
                    url: entry.url,
                    breadcrumbs: drainBreadcrumbs(),
                }, entry.url));
            }
            break;
        }

        // ── Runtime Console messages ───────────────────────────────────────────
        case 'Runtime.consoleAPICalled': {
            const level = params.type; // 'log' | 'info' | 'warning' | 'error' | 'debug'
            const args = (params.args || []).map(a => a.value ?? a.description ?? String(a.type)).join(' ');
            const message = args.slice(0, 500);

            if (level === 'log' || level === 'info' || level === 'debug') {
                // Only goes into the breadcrumb ring-buffer for context, not the event stream
                addBreadcrumb(level, message);
            } else if (level === 'warning') {
                addBreadcrumb('warn', message);
                bufferEvent(makeEvent('console.warn', 'cdp-runtime', { message }));
            } else if (level === 'error') {
                bufferEvent(makeEvent('console.error', 'cdp-runtime', {
                    message,
                    breadcrumbs: drainBreadcrumbs(),
                }));
            }
            break;
        }

        // ── CORS / CSP Audit Violations ────────────────────────────────────────
        case 'Audits.issueAdded': {
            const issue = params.issue;
            const code = issue?.code;
            // Only track CORS and CSP issues
            if (code === 'CorsIssue' || code === 'ContentSecurityPolicyIssue') {
                const details = issue.details?.corsIssueDetails || issue.details?.contentSecurityPolicyIssueDetails || {};
                bufferEvent(makeEvent('browser.audit_violation', 'cdp-audits', {
                    issue_code: code,
                    blocked_url: details.blockedURL || details.violatedDirective || null,
                    details: JSON.stringify(details).slice(0, 500),
                }));
            }
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
        // Enable Audits domain for CORS/CSP violation tracking
        await chrome.debugger.sendCommand({ tabId }, 'Audits.enable', {}).catch(() => {
            // Audits domain may not be available in all Chrome versions — silent fail
            console.warn('[QA Recorder] Audits domain not available (Chrome <92?), CORS/CSP tracking disabled');
        });
        console.log('[QA Recorder] CDP attached to tab', tabId);
    } catch (e) {
        console.error('[QA Recorder] CDP attach failed:', e.message);
        throw e;
    }
}

async function detachCDP(tabId) {
    try {
        await chrome.debugger.sendCommand({ tabId }, 'Audits.disable', {}).catch(() => {});
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
    if (state.recording && tabId === state.tabId) {
        if (changeInfo.url) {
            bufferEvent(makeEvent('action.navigation', 'browser', {
                from_url: sanitizeUrl(state.lastUrl || ''),
                to_url: sanitizeUrl(changeInfo.url),
            }, changeInfo.url));
            state.lastUrl = changeInfo.url;
        }

        // Re-inject content script to survive full page navigations
        if (changeInfo.status === 'complete') {
            chrome.scripting.executeScript({
                target: { tabId },
                files: ['content.js']
            }).catch(() => {});
        }
    }
});
