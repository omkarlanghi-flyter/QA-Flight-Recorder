/**
 * filter.js - Triage view generation and summary logic
 * Processes raw NDJSON events to create AI-friendly filtered views
 */
const fs = require('fs');
const path = require('path');
const { getEventType, normalizeEventType } = require('./event_type');

const SLOW_REQUEST_THRESHOLD_MS = 2000;
const ERROR_STATUS_THRESHOLD = 400;
const CONTEXT_WINDOW_MS = 30 * 1000; // ±30 seconds around any included event

// Redaction patterns
const REDACT_PATTERNS = [
    { name: 'authorization', pattern: /authorization/i },
    { name: 'cookie', pattern: /^cookie$/i },
    { name: 'set-cookie', pattern: /^set-cookie$/i },
    { name: 'jwt', pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
    { name: 'bearer', pattern: /Bearer\s+[^\s"']+/gi },
    { name: 'api-key', pattern: /api[_-]?key[=:\s]+[^\s"'&]+/gi },
];

/**
 * Redact sensitive fields from a URL
 */
function sanitizeUrl(url) {
    if (!url) return url;
    try {
        const u = new URL(url);
        // Strip query params by default (retain only path)
        return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
        return url;
    }
}

/**
 * Redact headers object
 */
function redactHeaders(headers) {
    if (!headers) return headers;
    const redacted = {};
    for (const [k, v] of Object.entries(headers)) {
        if (REDACT_PATTERNS.some(p => p.pattern.test(k))) {
            redacted[k] = '[REDACTED]';
        } else {
            redacted[k] = v;
        }
    }
    return redacted;
}

/**
 * Parse all events from NDJSON file
 */
function parseEvents(eventsFile) {
    if (!fs.existsSync(eventsFile)) return [];
    const content = fs.readFileSync(eventsFile, 'utf8').trim();
    if (!content) return [];
    return content.split('\n').map(line => {
        try { return normalizeEventType(JSON.parse(line)); } catch { return null; }
    }).filter(Boolean);
}

/**
 * Generate a signature for an error event for deduplication
 */
function errorSignature(event) {
    const type = getEventType(event);
    if (!event.data) return type;
    if (type === 'network.failure') {
        const url = event.data.url_sanitized || event.data.url_full || 'unknown_url';
        return `network.failure::${url}`;
    }
    const msg = event.data.message || event.data.text || '';
    // Take first 120 chars of message as signature
    return `${type}::${msg.slice(0, 120)}`;
}

/**
 * Main filtering function
 */
function generateTriageView(sessionDir, ignoredSignatures = []) {
    const ignoredSet = new Set(ignoredSignatures);
    const eventsFile = path.join(sessionDir, 'raw', 'events.ndjson');
    const viewsDir = path.join(sessionDir, 'views');
    fs.mkdirSync(viewsDir, { recursive: true });

    const allEvents = parseEvents(eventsFile);
    const rulesTriggered = [];
    const anchorTimestamps = new Set();

    // --- PASS 1: Collect anchor events (errors, failures, slow requests) ---
    const networkRequests = {}; // request_id -> { request, response, timing, failure }

    // First pass: group network events by request_id
    for (const event of allEvents) {
        const type = getEventType(event);
        if (type === 'network.request' && event.data?.request_id) {
            networkRequests[event.data.request_id] = { requestEvent: event };
        } else if (type === 'network.response' && event.data?.request_id) {
            const r = networkRequests[event.data.request_id];
            if (r) r.responseEvent = event;
        } else if (type === 'network.timing' && event.data?.request_id) {
            const r = networkRequests[event.data.request_id];
            if (r) r.timingEvent = event;
        } else if (type === 'network.failure' && event.data?.request_id) {
            const r = networkRequests[event.data.request_id];
            if (r) r.failureEvent = event;
        }
    }

    const anchorEventSet = new Set();

    // Include all console warn/error + runtime exceptions + websocket errors
    for (const event of allEvents) {
        const type = getEventType(event);
        if (['console.warn', 'console.error', 'runtime.exception', 'network.ws_error'].includes(type)) {
            anchorTimestamps.add(event.ts_epoch_ms);
            anchorEventSet.add(event);
            rulesTriggered.push({ rule: type, ts: event.ts_epoch_ms });
        }
    }

    // Include network failures and status >= 400
    for (const [, req] of Object.entries(networkRequests)) {
        if (req.failureEvent) {
            anchorTimestamps.add(req.failureEvent.ts_epoch_ms);
            anchorEventSet.add(req.failureEvent);
            rulesTriggered.push({ rule: 'network.failure', ts: req.failureEvent.ts_epoch_ms });
        }
        if (req.responseEvent?.data?.status >= ERROR_STATUS_THRESHOLD) {
            anchorTimestamps.add(req.responseEvent.ts_epoch_ms);
            anchorEventSet.add(req.responseEvent);
            rulesTriggered.push({ rule: `network.status_${req.responseEvent.data.status}`, ts: req.responseEvent.ts_epoch_ms });
        }
        // Include slow requests
        if (req.timingEvent?.data?.duration_ms > SLOW_REQUEST_THRESHOLD_MS) {
            anchorTimestamps.add(req.timingEvent.ts_epoch_ms);
            anchorEventSet.add(req.timingEvent);
            rulesTriggered.push({ rule: 'network.slow', ts: req.timingEvent.ts_epoch_ms, duration_ms: req.timingEvent.data.duration_ms });
        }
    }

    // Include all bug markers + system warnings (e.g. "video did not start")
    for (const event of allEvents) {
        const type = getEventType(event);
        if (type === 'marker.bug' || type === 'system.warning') {
            anchorTimestamps.add(event.ts_epoch_ms);
            anchorEventSet.add(event);
            rulesTriggered.push({ rule: type, ts: event.ts_epoch_ms });
        }
    }

    // --- PASS 2: Collect action events within ±30s of any anchor ---
    const anchorTsArray = Array.from(anchorTimestamps).sort((a, b) => a - b);
    const includedWindows = [];

    for (const ts of anchorTsArray) {
        includedWindows.push({ from: ts - CONTEXT_WINDOW_MS, to: ts + CONTEXT_WINDOW_MS });
    }

    // Merge overlapping windows
    const mergedWindows = [];
    for (const w of includedWindows) {
        if (mergedWindows.length && mergedWindows[mergedWindows.length - 1].to >= w.from) {
            mergedWindows[mergedWindows.length - 1].to = Math.max(mergedWindows[mergedWindows.length - 1].to, w.to);
        } else {
            mergedWindows.push({ ...w });
        }
    }

    // Collect all action events inside merged windows
    for (const event of allEvents) {
        const type = getEventType(event);
        if (type.startsWith('action.')) {
            for (const w of mergedWindows) {
                if (event.ts_epoch_ms >= w.from && event.ts_epoch_ms <= w.to) {
                    anchorEventSet.add(event);
                    break;
                }
            }
        }
    }

    // --- PASS 3: Collapse repeated console errors ---
    const signatureCounts = {};
    for (const event of anchorEventSet) {
        const type = getEventType(event);
        if (['console.error', 'console.warn', 'runtime.exception'].includes(type)) {
            const sig = errorSignature(event);
            if (!signatureCounts[sig]) {
                signatureCounts[sig] = { first: event, count: 0, type };
            }
            signatureCounts[sig].count++;
        }
    }

    // Build final triage events list (sorted by timestamp, deduplicated errors)
    const seenErrorSigs = new Set();
    const triageEvents = [];

    const sortedAnchorEvents = Array.from(anchorEventSet).sort((a, b) => a.ts_epoch_ms - b.ts_epoch_ms);

    for (const event of sortedAnchorEvents) {
        const type = getEventType(event);
        if (['console.error', 'console.warn', 'runtime.exception'].includes(type)) {
            const sig = errorSignature(event);
            if (seenErrorSigs.has(sig)) {
                // Skip duplicates; will annotate count on first occurrence
                continue;
            }
            seenErrorSigs.add(sig);
            const enriched = { 
                ...event, 
                _triage: { 
                    dedup_count: signatureCounts[sig].count,
                    is_ignored: ignoredSet.has(sig)
                } 
            };
            triageEvents.push(enriched);
        } else {
            triageEvents.push(event);
        }
    }

    // Write triage_view.ndjson
    const triageFile = path.join(viewsDir, 'triage_view.ndjson');
    fs.writeFileSync(triageFile, triageEvents.map(e => JSON.stringify(e)).join('\n') + '\n');

    // --- Build view_manifest.json ---
    const viewManifest = {
        generated_at: Date.now(),
        rules: [
            { id: 'console_errors', description: 'All console warn/error and runtime exceptions' },
            { id: 'network_failures', description: 'All network failures' },
            { id: 'http_errors', description: `HTTP status >= ${ERROR_STATUS_THRESHOLD}` },
            { id: 'slow_requests', description: `Requests slower than ${SLOW_REQUEST_THRESHOLD_MS}ms` },
            { id: 'action_context', description: `User actions within ±${CONTEXT_WINDOW_MS / 1000}s of any included event` },
            { id: 'bug_markers', description: 'Manual bug markers' },
        ],
        rules_triggered: rulesTriggered,
        included_windows: mergedWindows,
        total_raw_events: allEvents.length,
        total_triage_events: triageEvents.length,
        error_signatures: Object.fromEntries(
            Object.entries(signatureCounts).map(([sig, data]) => [sig, data.count])
        ),
    };
    fs.writeFileSync(path.join(viewsDir, 'view_manifest.json'), JSON.stringify(viewManifest, null, 2));

    // --- Build summary.json ---
    // Top error clusters
    const errorClusters = Object.entries(signatureCounts)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 10)
        .map(([sig, data]) => ({
            signature: sig,
            count: data.count,
            type: data.type,
            first_ts: data.first.ts_epoch_ms,
            sample_message: data.first.data?.message || data.first.data?.text || '',
        }));

    // Failed endpoints
    const failedEndpoints = {};
    for (const [, req] of Object.entries(networkRequests)) {
        if (req.failureEvent || (req.responseEvent?.data?.status >= ERROR_STATUS_THRESHOLD)) {
            const url = req.requestEvent?.data?.url_sanitized || 'unknown';
            const status = req.failureEvent ? 'network_failure' : `${req.responseEvent.data.status}`;
            const key = `${status}::${url}`;
            const eventObj = req.failureEvent || req.responseEvent;
            const sig = errorSignature(eventObj);
            if (ignoredSet.has(sig)) continue; // Skip ignored in summary
            failedEndpoints[key] = (failedEndpoints[key] || 0) + 1;
        }
    }

    // Slow endpoints + p95
    const requestDurations = {};
    for (const [, req] of Object.entries(networkRequests)) {
        if (req.timingEvent?.data?.duration_ms) {
            const url = req.requestEvent?.data?.url_sanitized || 'unknown';
            if (!requestDurations[url]) requestDurations[url] = [];
            requestDurations[url].push(req.timingEvent.data.duration_ms);
        }
    }
    const slowEndpoints = Object.entries(requestDurations)
        .map(([url, durations]) => {
            const sorted = durations.slice().sort((a, b) => a - b);
            const p95idx = Math.floor(sorted.length * 0.95);
            return { url, count: durations.length, p95_ms: sorted[p95idx] || sorted[sorted.length - 1], max_ms: sorted[sorted.length - 1] };
        })
        .filter(e => e.p95_ms > SLOW_REQUEST_THRESHOLD_MS)
        .sort((a, b) => b.p95_ms - a.p95_ms)
        .slice(0, 10);

    // Likely trigger: first action event before earliest anchor
    const firstAnchorTs = anchorTsArray[0] || null;
    let likelyTrigger = null;
    if (firstAnchorTs) {
        const actionsBefore = allEvents
            .filter(e => getEventType(e).startsWith('action.') && e.ts_epoch_ms <= firstAnchorTs)
            .sort((a, b) => b.ts_epoch_ms - a.ts_epoch_ms);
        likelyTrigger = actionsBefore[0] || null;
    }

    const summary = {
        generated_at: Date.now(),
        top_error_clusters: errorClusters,
        failed_endpoints: Object.entries(failedEndpoints).map(([key, count]) => ({ key, count })),
        slow_endpoints: slowEndpoints,
        likely_trigger_action: likelyTrigger,
    };
    fs.writeFileSync(path.join(sessionDir, 'summary.json'), JSON.stringify(summary, null, 2));

    return { triageEventCount: triageEvents.length, errorClusters: errorClusters.length, rulesTriggered: rulesTriggered.length };
}

module.exports = { generateTriageView, sanitizeUrl, redactHeaders, errorSignature };
