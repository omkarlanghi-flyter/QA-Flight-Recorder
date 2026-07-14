const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const archiver = require('archiver');
const multer = require('multer');

const db = require('./db');
const { createIngestionContext, destroyIngestionContext } = require('./ingestion/ingestion');
const { normalize } = require('./normalization/normalizer');
const { getEventType, normalizeEventType } = require('./event_type');
const { generateTriageView, errorSignature } = require('./filter');
const { resolveStack } = require('./debug/sourcemap');
const slack = require('./integrations/slack');
const bugs = require('./bugs');

const ingestMetrics = {
    legacy_calls: 0,
    legacy_events: 0,
    v2_calls: 0,
    v2_accepted: 0,
    v2_rejected: 0,
    v2_duplicates: 0,
    fallback_to_legacy: 0,
};

// ── Ignored Error Signatures ──────────────────────────────────────────────────
const IGNORED_FILE = path.join(os.homedir(), '.qa-flight-recorder', 'ignored_errors.json');

function loadIgnored() {
    try {
        return JSON.parse(fs.readFileSync(IGNORED_FILE, 'utf8'));
    } catch {
        return [];
    }
}

function saveIgnored(list) {
    fs.writeFileSync(IGNORED_FILE, JSON.stringify(list, null, 2));
}

const PORT = process.env.PORT || 17890;
// Default stays localhost-only (this tool is local-first / privacy-first).
// Set HOST=0.0.0.0 to let a teammate on the same trusted network open the
// dashboard directly and share session links — there is no auth layer, so
// only do this on a network you trust.
const HOST = process.env.HOST || '127.0.0.1';
const app = express();

// Configure multer for in-memory video chunk uploads
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '100mb' }));

// Serve viewer UI static files
app.use(express.static(path.join(__dirname, 'public')));

// ── Session helpers ──────────────────────────────────────────────────────────
function getSessionDir(id) {
    return db.getSessionDir(id);
}

function ensureSessionRawDir(id) {
    const dir = path.join(getSessionDir(id), 'raw');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getEventsFile(id) {
    return path.join(getSessionDir(id), 'raw', 'events.ndjson');
}

function parseNdjsonEvents(content) {
    if (!content) return [];
    return content
        .split('\n')
        .map(l => { try { return normalizeEventType(JSON.parse(l)); } catch { return null; } })
        .filter(Boolean);
}

function countIngestPayloadEvents(body) {
    if (Array.isArray(body)) return body.length;
    return body ? 1 : 0;
}

function sendApiError(res, status, code, message, details) {
    return res.status(status).json({
        ok: false,
        code,
        message,
        details: details || null,
    });
}

function validateBatchBody(events) {
    const errs = [];
    if (!Array.isArray(events)) return ['request body must be an event object or event array'];
    if (events.length === 0) errs.push('event batch cannot be empty');
    if (events.length > 5000) errs.push('event batch too large (max 5000 events)');
    for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (!e || typeof e !== 'object' || Array.isArray(e)) {
            errs.push(`event at index ${i} must be an object`);
            continue;
        }
        const t = e.event_type || e.type;
        if (t !== undefined && typeof t !== 'string') {
            errs.push(`event at index ${i} has invalid type/event_type`);
        }
    }
    return errs;
}

function appendEvents(sessionId, events) {
    const file = getEventsFile(sessionId);
    const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(file, lines, 'utf8');
    db.indexEventsBatch(events);
}

// ── API Endpoints ────────────────────────────────────────────────────────────

/**
 * POST /session/start
 * Body: { tab_id, url, title }
 */
app.post('/session/start', (req, res) => {
    const sessionId = uuidv4();
    const now = Date.now();
    const { tab_id, url, title, browser_info } = req.body || {};

    const sessionDir = getSessionDir(sessionId);
    fs.mkdirSync(path.join(sessionDir, 'raw'), { recursive: true });
    fs.mkdirSync(path.join(sessionDir, 'views'), { recursive: true });
    fs.mkdirSync(path.join(sessionDir, 'video'), { recursive: true });

    const meta = {
        id: sessionId,
        started_at: now,
        tab_id,
        url,
        title,
        status: 'recording',
        browser_info: browser_info || null,
    };
    fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify(meta, null, 2));

    db.createSession({
        id: sessionId,
        started_at: now,
        tab_id: tab_id || null,
        url: url || null,
        title: title || null,
        browser_info: browser_info || null,
    });

    console.log(`[START] Session ${sessionId} for tab ${tab_id} url=${url}`);
    res.json({ session_id: sessionId, started_at: now });
});

/**
 * POST /session/:id/event
 * Body: single event or array of events
 */
app.post('/session/:id/event', (req, res) => {
    const { id } = req.params;
    if (!db.getSession(id)) return res.status(404).json({ error: 'Session not found' });

    let events = req.body;
    if (!Array.isArray(events)) events = [events];

    ingestMetrics.legacy_calls += 1;
    ingestMetrics.legacy_events += events.length;
    if (req.headers['x-ingest-fallback'] === 'v2_failed') {
        ingestMetrics.fallback_to_legacy += 1;
        console.warn(`[INGEST] v2->legacy fallback session=${id} batches=${ingestMetrics.fallback_to_legacy}`);
    }

    // Ensure all events have session_id
    events = events.map(e => ({ ...e, session_id: id }));

    ensureSessionRawDir(id);
    appendEvents(id, events);

    res.json({ ok: true, count: events.length });
});

/**
 * POST /session/:id/video-chunk
 * Binary upload of video data chunk
 */
app.post('/session/:id/video-chunk', upload.single('chunk'), (req, res) => {
    const { id } = req.params;
    if (!db.getSession(id)) return res.status(404).json({ error: 'Session not found' });

    const videoDir = path.join(getSessionDir(id), 'video');
    fs.mkdirSync(videoDir, { recursive: true });

    const chunkIndex = req.headers['x-chunk-index'] || Date.now();
    const filename = `chunk_${String(chunkIndex).padStart(6, '0')}.webm`;
    const chunkPath = path.join(videoDir, filename);

    let data;
    if (req.file) {
        data = req.file.buffer;
    } else if (req.body && req.body.length > 0) {
        data = req.body;
    } else {
        return res.status(400).json({ error: 'No chunk data' });
    }

    fs.writeFileSync(chunkPath, data);
    console.log(`[CHUNK] Session ${id} chunk ${chunkIndex} size=${data.length}bytes`);
    res.json({ ok: true, filename });
});

/**
 * POST /session/:id/stop
 */
app.post('/session/:id/stop', async (req, res) => {
    const { id } = req.params;
    const session = db.getSession(id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const stoppedAt = Date.now();
    const sessionDir = getSessionDir(id);

    // Count events
    let eventCount = 0;
    let errorCount = 0;
    let networkFailureCount = 0;
    let slowRequestCount = 0;

    const eventsFile = getEventsFile(id);
    if (fs.existsSync(eventsFile)) {
        const content = fs.readFileSync(eventsFile, 'utf8').trim();
        if (content) {
            const events = parseNdjsonEvents(content);
            eventCount = events.length;
            
            // Get ignored signatures
            const ignoredSet = new Set(loadIgnored().map(i => i.signature));
            
            for (const e of events) {
                const sig = errorSignature(e);
                if (ignoredSet.has(sig)) continue; // Skip ignored errors from counts

                const evtType = getEventType(e);
                if (['console.error', 'runtime.exception'].includes(evtType)) errorCount++;
                if (evtType === 'network.failure') networkFailureCount++;
                // Use timing for slow requests
                if (evtType === 'network.timing' && e.data?.duration_ms > 2000) slowRequestCount++;
            }
        }
    }

    db.updateSessionStop(id, stoppedAt, {
        duration_ms: stoppedAt - session.started_at,
        event_count: eventCount,
        error_count: errorCount,
        network_failure_count: networkFailureCount,
        slow_request_count: slowRequestCount,
    });

    // Update meta.json
    const metaPath = path.join(sessionDir, 'meta.json');
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { }
    meta.stopped_at = stoppedAt;
    meta.duration_ms = stoppedAt - session.started_at;
    meta.status = 'done';
    meta.event_count = eventCount;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    // Generate triage views asynchronously
    try {
        const ignoredSigs = loadIgnored().map(i => i.signature);
        const result = generateTriageView(sessionDir, ignoredSigs);
        console.log(`[STOP] Session ${id} done. Triage: ${result.triageEventCount} events, ${result.errorClusters} clusters`);
    } catch (err) {
        console.error(`[STOP] Triage generation failed for ${id}:`, err.message);
    }

    res.json({ ok: true, session_id: id, duration_ms: stoppedAt - session.started_at });
});

/**
 * GET /sessions
 */
app.get('/sessions', (req, res) => {
    const { limit, offset, status } = req.query;
    const sessions = db.listSessions({
        limit: parseInt(limit) || 50,
        offset: parseInt(offset) || 0,
        status,
    });
    res.json({ sessions });
});

/**
 * GET /stats
 * Returns aggregated stats across all sessions
 */
app.get('/stats', (req, res) => {
    const sessions = db.listSessions({ limit: 10000, offset: 0 });
    const total = sessions.length;
    const recording = sessions.filter(s => s.status === 'recording').length;
    const done = sessions.filter(s => s.status === 'done').length;
    const totalErrors = sessions.reduce((sum, s) => sum + (s.error_count || 0), 0);
    const totalNetFailures = sessions.reduce((sum, s) => sum + (s.network_failure_count || 0), 0);
    const totalSlowReqs = sessions.reduce((sum, s) => sum + (s.slow_request_count || 0), 0);
    const clean = sessions.filter(s => (s.error_count || 0) === 0 && (s.network_failure_count || 0) === 0 && s.status === 'done').length;
    res.json({
        total,
        recording,
        done,
        clean,
        totalErrors,
        totalNetFailures,
        totalSlowReqs,
        ingest: {
            legacy_calls: ingestMetrics.legacy_calls,
            legacy_events: ingestMetrics.legacy_events,
            v2_calls: ingestMetrics.v2_calls,
            v2_accepted: ingestMetrics.v2_accepted,
            v2_rejected: ingestMetrics.v2_rejected,
            v2_duplicates: ingestMetrics.v2_duplicates,
            fallback_to_legacy: ingestMetrics.fallback_to_legacy,
        },
    });
});

/**
 * POST /sessions/bulk-delete
 * Body: { ids: ["id1", "id2"] }
 */
app.post('/sessions/bulk-delete', (req, res) => {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'No ids provided' });

    try {
        // Delete files from disk first
        for (const id of ids) {
            const sessionDir = getSessionDir(id);
            if (fs.existsSync(sessionDir)) {
                fs.rmSync(sessionDir, { recursive: true, force: true });
            }
        }
        
        // Delete all from DB in one go
        db.deleteSessions(ids);
        res.json({ ok: true, deleted: ids.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * DELETE /sessions/:id
 */
app.delete('/sessions/:id', (req, res) => {
    const { id } = req.params;
    const session = db.getSession(id);
    if (!session) return res.status(404).json({ error: 'Not found' });
    const sessionDir = getSessionDir(id);
    try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        db.deleteSession(id);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /sessions/:id
 */
app.get('/sessions/:id', (req, res) => {
    const session = db.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Not found' });

    const sessionDir = getSessionDir(req.params.id);
    let summary = null;
    try {
        summary = JSON.parse(fs.readFileSync(path.join(sessionDir, 'summary.json'), 'utf8'));
    } catch { }

    res.json({ session, summary });
});

/**
 * GET /sessions/:id/triage
 * Returns triage NDJSON as JSON array for the UI
 */
app.get('/sessions/:id/triage', (req, res) => {
    const sessionDir = getSessionDir(req.params.id);
    const triageFile = path.join(sessionDir, 'views', 'triage_view.ndjson');
    let manifest = null;
    try {
        manifest = JSON.parse(fs.readFileSync(path.join(sessionDir, 'views', 'view_manifest.json'), 'utf8'));
    } catch { }

    if (!fs.existsSync(triageFile)) {
        return res.json({ events: [], manifest });
    }
    const content = fs.readFileSync(triageFile, 'utf8').trim();
    const events = content ? parseNdjsonEvents(content) : [];
    res.json({ events, manifest });
});

/**
 * GET /sessions/:id/events
 * Returns all raw events as JSON array (paginated, with types filtering)
 */
app.get('/sessions/:id/events', (req, res) => {
    const eventsFile = getEventsFile(req.params.id);
    if (!fs.existsSync(eventsFile)) return res.json({ events: [], total: 0 });

    const content = fs.readFileSync(eventsFile, 'utf8').trim();
    const allEvents = content ? parseNdjsonEvents(content) : [];

    const limit = parseInt(req.query.limit) || 500;
    const offset = parseInt(req.query.offset) || 0;

    // Support filtering by multiple types (e.g. types=action.click,action.scroll)
    let filtered = allEvents;
    if (req.query.types) {
        const allowedTypes = new Set(req.query.types.split(','));
        filtered = allEvents.filter(e => allowedTypes.has(getEventType(e)));
    } else if (req.query.type) {
        filtered = allEvents.filter(e => getEventType(e) === req.query.type);
    }

    res.json({ events: filtered.slice(offset, offset + limit), total: filtered.length });
});

/**
 * GET /sessions/:id/video
 * Serves a concatenated video playlist or first chunk
 */
app.get('/sessions/:id/video', (req, res) => {
    const videoDir = path.join(getSessionDir(req.params.id), 'video');
    if (!fs.existsSync(videoDir)) return res.status(404).json({ error: 'No video' });

    const chunks = fs.readdirSync(videoDir)
        .filter(f => f.endsWith('.webm'))
        .sort();

    if (chunks.length === 0) return res.status(404).json({ error: 'No video chunks' });

    // Return list of chunk URLs instead of streaming, or stream first chunk
    if (req.query.list === '1') {
        return res.json({ chunks: chunks.map(c => `/sessions/${req.params.id}/video/${c}`) });
    }

    // Calculate total size
    const chunkStats = chunks.map(c => {
        const p = path.join(videoDir, c);
        return { path: p, size: fs.statSync(p).size };
    });
    const totalSize = chunkStats.reduce((sum, c) => sum + c.size, 0);

    const rangeStart = req.headers.range ? parseInt(req.headers.range.replace(/bytes=/, '').split('-')[0]) : 0;
    const rangeEnd = req.headers.range && req.headers.range.split('-')[1] ? parseInt(req.headers.range.split('-')[1]) : totalSize - 1;

    res.setHeader('Content-Type', 'video/webm');
    res.setHeader('Accept-Ranges', 'bytes');

    if (req.headers.range) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${rangeStart}-${rangeEnd}/${totalSize}`);
        res.setHeader('Content-Length', rangeEnd - rangeStart + 1);
    } else {
        res.setHeader('Content-Length', totalSize);
    }

    let byteOffset = 0;
    let currentChunkIndex = 0;

    // Find the starting chunk
    while (currentChunkIndex < chunkStats.length) {
        if (byteOffset + chunkStats[currentChunkIndex].size > rangeStart) break;
        byteOffset += chunkStats[currentChunkIndex].size;
        currentChunkIndex++;
    }

    const streamChunk = (index, currentByteStart) => {
        if (index >= chunkStats.length || currentByteStart > rangeEnd) return res.end();

        const stat = chunkStats[index];
        const chunkStart = Math.max(0, rangeStart - currentByteStart);
        const chunkEnd = Math.min(stat.size - 1, rangeEnd - currentByteStart);

        if (chunkStart <= chunkEnd) {
            const stream = fs.createReadStream(stat.path, { start: chunkStart, end: chunkEnd });
            stream.on('end', () => streamChunk(index + 1, currentByteStart + stat.size));
            stream.on('error', () => res.end());
            stream.pipe(res, { end: false });
        } else {
            streamChunk(index + 1, currentByteStart + stat.size);
        }
    };

    streamChunk(currentChunkIndex, byteOffset);
});

/**
 * GET /sessions/:id/video/:filename
 */
app.get('/sessions/:id/video/:filename', (req, res) => {
    const { id, filename } = req.params;
    const filePath = path.join(getSessionDir(id), 'video', filename);
    if (!fs.existsSync(filePath)) return res.status(404).end();
    res.setHeader('Content-Type', 'video/webm');
    fs.createReadStream(filePath).pipe(res);
});

/**
 * GET /sessions/:id/download
 * Zip download of the entire session
 */
app.get('/sessions/:id/download', (req, res) => {
    const sessionDir = getSessionDir(req.params.id);
    if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'Not found' });

    const session = db.getSession(req.params.id);
    const title = (session?.title || req.params.id).replace(/[^a-zA-Z0-9-_]/g, '_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="session_${title}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => res.status(500).end());
    archive.pipe(res);
    archive.directory(sessionDir, false);
    archive.finalize();
});

/**
 * GET /sessions/:id/regenerate-views
 * Regenerate triage views on demand
 */
app.post('/sessions/:id/regenerate-views', (req, res) => {
    const sessionDir = getSessionDir(req.params.id);
    if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'Not found' });
    try {
        const ignoredSigs = loadIgnored().map(i => i.signature);
        const result = generateTriageView(sessionDir, ignoredSigs);
        
        // Also update the counts in the database based on current ignore list
        const eventsFile = getEventsFile(req.params.id);
        if (fs.existsSync(eventsFile)) {
            const content = fs.readFileSync(eventsFile, 'utf8').trim();
            if (content) {
                const events = parseNdjsonEvents(content);
                const ignoredSet = new Set(loadIgnored().map(i => i.signature));
                let errorCount = 0;
                let networkFailureCount = 0;
                let slowRequestCount = 0;
                for (const e of events) {
                    const sig = errorSignature(e);
                    if (ignoredSet.has(sig)) continue;
                    const evtType = getEventType(e);
                    if (['console.error', 'runtime.exception'].includes(evtType)) errorCount++;
                    if (evtType === 'network.failure') networkFailureCount++;
                    if (evtType === 'network.timing' && e.data?.duration_ms > 2000) slowRequestCount++;
                }
                const session = db.getSession(req.params.id);
                db.updateSessionStop(req.params.id, session.stopped_at || Date.now(), {
                    duration_ms: session.duration_ms || 0,
                    event_count: events.length,
                    error_count: errorCount,
                    network_failure_count: networkFailureCount,
                    slow_request_count: slowRequestCount
                });
            }
        }

        res.json({ ok: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Ignored Error Signatures API ─────────────────────────────────────────────

/**
 * GET /ignored-errors
 * Returns all ignored error signatures
 */
app.get('/ignored-errors', (req, res) => {
    res.json({ ignored: loadIgnored() });
});

/**
 * POST /ignored-errors
 * Body: { signature, label, source_session_id? }
 * Adds a new signature to the ignore list
 */
app.post('/ignored-errors', (req, res) => {
    const { signature, label, source_session_id } = req.body || {};
    if (!signature) return res.status(400).json({ error: 'signature is required' });

    const list = loadIgnored();
    if (list.find(e => e.signature === signature)) {
        return res.json({ ok: true, already_exists: true });
    }

    const entry = {
        id: uuidv4(),
        signature,
        label: label || signature,
        source_session_id: source_session_id || null,
        ignored_at: Date.now(),
    };
    list.push(entry);
    saveIgnored(list);
    res.json({ ok: true, entry });
});

/**
 * DELETE /ignored-errors/:id
 * Removes an entry from the ignore list
 */
app.delete('/ignored-errors/:id', (req, res) => {
    let list = loadIgnored();
    const before = list.length;
    list = list.filter(e => e.id !== req.params.id);
    if (list.length === before) return res.status(404).json({ error: 'Not found' });
    saveIgnored(list);
    res.json({ ok: true });
});

// ── Schema v2 API Endpoints (additive — legacy endpoints unchanged below) ─────

/**
 * POST /sessions
 * Canonical session start (v2). Same behaviour as POST /session/start but
 * initialises an IngestionContext for structured batch ingestion.
 * Body: { tab_id, url, title, browser_info? }
 */
app.post('/sessions', (req, res) => {
    const sessionId = uuidv4();
    const now = Date.now();
    const { tab_id, url, title, browser_info } = req.body || {};

    const sessionDir = getSessionDir(sessionId);
    fs.mkdirSync(path.join(sessionDir, 'raw'),    { recursive: true });
    fs.mkdirSync(path.join(sessionDir, 'views'),  { recursive: true });
    fs.mkdirSync(path.join(sessionDir, 'video'),  { recursive: true });

    const meta = {
        id: sessionId, started_at: now, tab_id, url, title,
        status: 'recording',
        schema_version: '2.0',
        browser_info: browser_info || null,
    };
    fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify(meta, null, 2));

    db.createSession({
        id: sessionId, started_at: now,
        tab_id: tab_id || null, url: url || null, title: title || null,
        browser_info: browser_info || null,
    });

    // Pre-create ingestion context so the first batch call is fast
    createIngestionContext(sessionId, sessionDir, db);

    console.log(`[v2/START] Session ${sessionId} tab=${tab_id} url=${url}`);
    res.json({ session_id: sessionId, started_at: now, schema_version: '2.0' });
});

/**
 * POST /sessions/:id/events/batch
 * Validated, deduplicated batch event ingestion (v2).
 * Body: Array of event objects.
 * Returns: { ok, accepted, rejected, duplicates, errors }
 */
app.post('/sessions/:id/events/batch', (req, res) => {
    const { id } = req.params;
    const session = db.getSession(id);
    if (!session) return sendApiError(res, 404, 'SESSION_NOT_FOUND', 'Session not found');

    let events = req.body;
    if (!Array.isArray(events)) events = [events];

    const batchValidationErrors = validateBatchBody(events);
    if (batchValidationErrors.length > 0) {
        return sendApiError(res, 400, 'INVALID_EVENT_BATCH', 'Event batch validation failed', batchValidationErrors);
    }

    ingestMetrics.v2_calls += 1;

    const sessionDir = getSessionDir(id);
    const ctx = createIngestionContext(id, sessionDir, db);
    const result = ctx.ingest(events);

    ingestMetrics.v2_accepted += result.accepted || 0;
    ingestMetrics.v2_rejected += result.rejected || 0;
    ingestMetrics.v2_duplicates += result.duplicates || 0;

    const requestEvents = countIngestPayloadEvents(req.body);
    const missed = Math.max(0, requestEvents - ((result.accepted || 0) + (result.rejected || 0) + (result.duplicates || 0)));
    if (missed > 0) {
        console.warn(`[INGEST] Accounting mismatch session=${id} request=${requestEvents} accepted=${result.accepted || 0} rejected=${result.rejected || 0} duplicates=${result.duplicates || 0}`);
    }

    if (result.fatal) {
        return sendApiError(res, 500, 'INGEST_WRITE_FAILED', 'Failed to persist event batch', result.errors);
    }

    res.json({ ok: true, ...result });
});

/**
 * POST /sessions/:id/video/chunk
 * Canonical video chunk upload (v2 path). Delegates to same logic as legacy endpoint.
 */
app.post('/sessions/:id/video/chunk', upload.single('chunk'), (req, res) => {
    const { id } = req.params;
    if (!db.getSession(id)) return res.status(404).json({ error: 'Session not found' });

    const videoDir = path.join(getSessionDir(id), 'video');
    fs.mkdirSync(videoDir, { recursive: true });

    const chunkIndex = req.headers['x-chunk-index'] || Date.now();
    const filename = `chunk_${String(chunkIndex).padStart(6, '0')}.webm`;
    const chunkPath = path.join(videoDir, filename);

    const data = req.file ? req.file.buffer : (req.body?.length > 0 ? req.body : null);
    if (!data) return res.status(400).json({ error: 'No chunk data' });

    fs.writeFileSync(chunkPath, data);
    res.json({ ok: true, filename });
});

/**
 * POST /sessions/:id/finish
 * Canonical session stop (v2). Mirrors POST /session/:id/stop.
 * Destroys the ingestion context to free dedup memory.
 */
app.post('/sessions/:id/finish', async (req, res) => {
    const { id } = req.params;
    const session = db.getSession(id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const stoppedAt  = Date.now();
    const sessionDir = getSessionDir(id);

    // Count events
    let eventCount = 0, errorCount = 0, networkFailureCount = 0, slowRequestCount = 0;
    const eventsFile = getEventsFile(id);
    if (fs.existsSync(eventsFile)) {
        const content = fs.readFileSync(eventsFile, 'utf8').trim();
        if (content) {
            const events = parseNdjsonEvents(content);
            eventCount = events.length;
            const ignoredSet = new Set(loadIgnored().map(i => i.signature));
            for (const e of events) {
                const sig = errorSignature(e);
                if (ignoredSet.has(sig)) continue;
                const evtType = getEventType(e);
                if (['console.error', 'runtime.exception'].includes(evtType)) errorCount++;
                if (evtType === 'network.failure') networkFailureCount++;
                if (evtType === 'network.timing' && e.data?.duration_ms > 2000) slowRequestCount++;
            }
        }
    }

    db.updateSessionStop(id, stoppedAt, {
        duration_ms: stoppedAt - session.started_at,
        event_count: eventCount, error_count: errorCount,
        network_failure_count: networkFailureCount, slow_request_count: slowRequestCount,
    });

    // Update meta.json
    const metaPath = path.join(sessionDir, 'meta.json');
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
    Object.assign(meta, { stopped_at: stoppedAt, duration_ms: stoppedAt - session.started_at, status: 'done', event_count: eventCount });
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    // Generate triage views
    try {
        const ignoredSigs = loadIgnored().map(i => i.signature);
        generateTriageView(sessionDir, ignoredSigs);
    } catch (err) {
        console.error(`[FINISH] Triage failed for ${id}:`, err.message);
    }

    // Destroy ingestion context (free dedup memory)
    destroyIngestionContext(id);

    console.log(`[v2/FINISH] Session ${id} done. events=${eventCount}`);
    res.json({ ok: true, session_id: id, duration_ms: stoppedAt - session.started_at });
});

/**
 * POST /sessions/:id/normalize
 * Run the normalization pipeline on demand for a session.
 * Writes normalized.json to the session dir.
 */
app.post('/sessions/:id/normalize', (req, res) => {
    const { id } = req.params;
    const session = db.getSession(id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const sessionDir = getSessionDir(id);
    try {
        const result = normalize(sessionDir);
        db.updateSessionNormalized(id, result.step_count);
        console.log(`[NORMALIZE] Session ${id}: ${result.step_count} steps, ${result.assertion_count} assertions`);
        res.json({
            ok: true,
            step_count: result.step_count,
            assertion_count: result.assertion_count,
            group_count: result.group_count,
            step_type_summary: result.step_type_summary,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /sessions/:id/resolve-stack
 * Resolves a raw (possibly minified) stack trace against the app's own
 * source maps, fetched on demand. Body: { stack: string }.
 */
app.post('/sessions/:id/resolve-stack', async (req, res) => {
    const { id } = req.params;
    const session = db.getSession(id);
    if (!session) return sendApiError(res, 404, 'SESSION_NOT_FOUND', 'Session not found');

    const stack = req.body && req.body.stack;
    if (!stack || typeof stack !== 'string') {
        return sendApiError(res, 400, 'INVALID_BODY', 'Body must include a "stack" string');
    }

    try {
        const frames = await resolveStack(stack);
        res.json({ ok: true, frames });
    } catch (err) {
        return sendApiError(res, 500, 'RESOLVE_STACK_FAILED', 'Failed to resolve stack trace', { reason: err.message });
    }
});

// ── Slack Integration ───────────────────────────────────────────────────────

/**
 * GET /integrations/slack/config
 * Never returns the bot token itself — only whether one is configured, plus
 * the default channel and saved channel/thread shortcuts (not secret).
 */
app.get('/integrations/slack/config', (req, res) => {
    const cfg = slack.loadConfig();
    res.json({
        configured: Boolean(cfg.botToken),
        defaultChannel: cfg.defaultChannel || null,
        savedChannels: cfg.savedChannels,
        savedThreads: cfg.savedThreads,
    });
});

/**
 * POST /integrations/slack/config
 * Body: { botToken?, defaultChannel? } — either field can be omitted to
 * leave it unchanged (e.g. update just the default channel).
 */
app.post('/integrations/slack/config', (req, res) => {
    const { botToken, defaultChannel } = req.body || {};
    if (botToken !== undefined && (typeof botToken !== 'string' || !botToken.trim())) {
        return sendApiError(res, 400, 'INVALID_BODY', 'botToken must be a non-empty string');
    }
    const saved = slack.saveConfig({ botToken, defaultChannel });
    res.json({
        ok: true,
        configured: Boolean(saved.botToken),
        defaultChannel: saved.defaultChannel || null,
        savedChannels: saved.savedChannels,
        savedThreads: saved.savedThreads,
    });
});

/**
 * Saved channel shortcuts — so a channel only needs to be entered once and
 * can be picked from a dropdown afterwards instead of retyped/pasted.
 */
app.post('/integrations/slack/channels', (req, res) => {
    const { id, name } = req.body || {};
    if (!id || typeof id !== 'string' || !id.trim()) {
        return sendApiError(res, 400, 'INVALID_BODY', 'id is required');
    }
    const saved = slack.addChannel({ id: id.trim(), name: (name || '').trim() });
    res.json({ ok: true, savedChannels: saved.savedChannels, defaultChannel: saved.defaultChannel });
});

app.delete('/integrations/slack/channels/:id', (req, res) => {
    const saved = slack.removeChannel(req.params.id);
    res.json({ ok: true, savedChannels: saved.savedChannels, defaultChannel: saved.defaultChannel });
});

app.post('/integrations/slack/channels/:id/default', (req, res) => {
    const saved = slack.setDefaultChannel(req.params.id);
    res.json({ ok: true, defaultChannel: saved.defaultChannel });
});

/**
 * Saved thread shortcuts — paste a Slack message link once, give it a label,
 * and reply into it again later from a dropdown instead of re-pasting.
 */
app.post('/integrations/slack/threads', (req, res) => {
    const { name, link } = req.body || {};
    if (!link || typeof link !== 'string') {
        return sendApiError(res, 400, 'INVALID_BODY', 'link is required');
    }
    try {
        const saved = slack.addThread({ name, link });
        res.json({ ok: true, savedThreads: saved.savedThreads });
    } catch (err) {
        return sendApiError(res, 400, 'INVALID_THREAD_LINK', err.message);
    }
});

app.delete('/integrations/slack/threads/:id', (req, res) => {
    const saved = slack.removeThread(req.params.id);
    res.json({ ok: true, savedThreads: saved.savedThreads });
});

/**
 * POST /integrations/slack/send
 * Body: { text, channel?, threadLink? }
 * `channel` falls back to the configured default channel if omitted.
 * `threadLink` is a pasted Slack message permalink — when present, the
 * message is sent as a reply in that thread instead of a new message.
 */
// Shared by /send and /send-screenshot: resolves the target channel + optional
// thread_ts from an explicit channel and/or a pasted thread permalink.
// Returns { targetChannel, thread_ts } or { error: { code, message } }.
function resolveSlackTarget({ channel, threadLink }) {
    let targetChannel = channel || slack.loadConfig().defaultChannel;
    let thread_ts;
    if (threadLink) {
        const parsed = slack.parsePermalink(threadLink);
        if (!parsed) {
            return { error: { code: 'INVALID_THREAD_LINK', message: 'Could not parse that Slack message link' } };
        }
        targetChannel = channel || parsed.channel;
        thread_ts = parsed.thread_ts;
    }
    if (!targetChannel) {
        return { error: { code: 'NO_CHANNEL', message: 'No channel specified and no default channel configured' } };
    }
    return { targetChannel, thread_ts };
}

function channelNameFor(channelId) {
    const saved = (slack.loadConfig().savedChannels || []).find(c => c.id === channelId);
    return saved ? saved.name : null;
}

app.post('/integrations/slack/send', async (req, res) => {
    const { text, note, context, channel, threadLink, session_id, source } = req.body || {};
    if (!text || typeof text !== 'string') {
        return sendApiError(res, 400, 'INVALID_BODY', 'Body must include "text"');
    }
    if (!slack.isConfigured()) {
        return sendApiError(res, 400, 'SLACK_NOT_CONFIGURED', 'Slack is not configured yet — add a Bot Token first');
    }

    const target = resolveSlackTarget({ channel, threadLink });
    if (target.error) return sendApiError(res, 400, target.error.code, target.error.message);

    try {
        const result = await slack.postMessage({ channel: target.targetChannel, text, thread_ts: target.thread_ts });
        // Reporting to Slack is otherwise fire-and-forget — this is what lets
        // the Bugs tab show it afterward. Never let a tracker-write failure
        // fail the send itself; the message already reached Slack. `text` is
        // the full message actually posted to Slack (note + context, if the
        // sender chose to include it); `note`/`context` are the same two
        // pieces kept separate so the tracker's description isn't a wall of
        // concatenated page/URL/health text — see bugs.js createBug().
        let bug = null;
        try {
            bug = bugs.createBug({
                description: (note && note.trim()) || text,
                context: context || null,
                session_id: session_id || null,
                channel: target.targetChannel,
                channel_name: channelNameFor(target.targetChannel),
                thread_link: threadLink || null,
                permalink: result.permalink,
                source: source === 'bug_marker' ? 'bug_marker' : 'session_report',
            });
        } catch (e) {
            console.warn('[BUGS] Failed to record bug after Slack send:', e.message);
        }
        res.json({ ok: true, ...result, bug_id: bug?.id || null });
    } catch (err) {
        return sendApiError(res, 502, 'SLACK_SEND_FAILED', 'Failed to send Slack message', { reason: err.message });
    }
});

/**
 * POST /integrations/slack/send-screenshot
 * multipart/form-data: image (PNG file), channel?, threadLink?, text? (caption)
 */
app.post('/integrations/slack/send-screenshot', upload.single('image'), async (req, res) => {
    if (!req.file) {
        return sendApiError(res, 400, 'INVALID_BODY', 'No image uploaded (field name must be "image")');
    }
    if (!slack.isConfigured()) {
        return sendApiError(res, 400, 'SLACK_NOT_CONFIGURED', 'Slack is not configured yet — add a Bot Token first');
    }

    const { channel, threadLink, text } = req.body || {};
    const target = resolveSlackTarget({ channel, threadLink });
    if (target.error) return sendApiError(res, 400, target.error.code, target.error.message);

    try {
        const result = await slack.uploadFile({
            channel: target.targetChannel,
            thread_ts: target.thread_ts,
            buffer: req.file.buffer,
            filename: 'screenshot.png',
            initialComment: text || undefined,
        });
        let bug = null;
        try {
            bug = bugs.createBug({
                description: text || '(screenshot, no description)',
                channel: target.targetChannel,
                channel_name: channelNameFor(target.targetChannel),
                thread_link: threadLink || null,
                permalink: result.permalink,
                source: 'screenshot',
            });
        } catch (e) {
            console.warn('[BUGS] Failed to record bug after screenshot upload:', e.message);
        }
        res.json({ ok: true, ...result, bug_id: bug?.id || null });
    } catch (err) {
        return sendApiError(res, 502, 'SLACK_UPLOAD_FAILED', 'Failed to upload screenshot to Slack', { reason: err.message });
    }
});

/**
 * POST /integrations/slack/send-screenshots
 * multipart/form-data: images (multiple PNG files, field name "images"), channel?, threadLink?, text? (caption)
 * "Multimedia" bug report — multiple screenshots captured via the on-page
 * tray (extension/content.js), sent as ONE Slack message with several
 * attachments, and recorded as ONE bug (not one per image).
 */
// The 8-image cap here matches MAX_MULTI_SHOTS in extension/background.js —
// the client already stops the user at 8, this is just the server-side backstop.
app.post('/integrations/slack/send-screenshots', upload.array('images', 8), async (req, res) => {
    if (!req.files || !req.files.length) {
        return sendApiError(res, 400, 'INVALID_BODY', 'No images uploaded (field name must be "images")');
    }
    if (!slack.isConfigured()) {
        return sendApiError(res, 400, 'SLACK_NOT_CONFIGURED', 'Slack is not configured yet — add a Bot Token first');
    }

    const { channel, threadLink, text } = req.body || {};
    const target = resolveSlackTarget({ channel, threadLink });
    if (target.error) return sendApiError(res, 400, target.error.code, target.error.message);

    try {
        const result = await slack.uploadFiles({
            channel: target.targetChannel,
            thread_ts: target.thread_ts,
            files: req.files.map((f, i) => ({ buffer: f.buffer, filename: `screenshot-${i + 1}.png` })),
            initialComment: text || undefined,
        });
        let bug = null;
        try {
            bug = bugs.createBug({
                description: text || `(${req.files.length} screenshots, no description)`,
                channel: target.targetChannel,
                channel_name: channelNameFor(target.targetChannel),
                thread_link: threadLink || null,
                permalink: result.permalink,
                source: 'screenshot',
            });
        } catch (e) {
            console.warn('[BUGS] Failed to record bug after multi-screenshot upload:', e.message);
        }
        res.json({ ok: true, ...result, bug_id: bug?.id || null });
    } catch (err) {
        return sendApiError(res, 502, 'SLACK_UPLOAD_FAILED', 'Failed to upload screenshots to Slack', { reason: err.message });
    }
});

// ── Bug Tracker ─────────────────────────────────────────────────────────────
app.get('/bugs', (req, res) => {
    const { status, channel } = req.query;
    res.json({ ok: true, bugs: bugs.listBugs({ status, channel }) });
});

app.get('/bugs/:id', (req, res) => {
    const bug = bugs.getBug(req.params.id);
    if (!bug) return sendApiError(res, 404, 'BUG_NOT_FOUND', 'Bug not found');
    res.json({ ok: true, bug });
});

app.post('/bugs', (req, res) => {
    const { description, session_id, channel, channel_name, thread_link } = req.body || {};
    if (!description || typeof description !== 'string' || !description.trim()) {
        return sendApiError(res, 400, 'INVALID_BODY', 'description is required');
    }
    try {
        const bug = bugs.createBug({
            description: description.trim(),
            session_id: session_id || null,
            channel: channel || null,
            channel_name: channel_name || null,
            thread_link: thread_link || null,
            source: 'manual',
        });
        res.json({ ok: true, bug });
    } catch (err) {
        return sendApiError(res, 400, 'CREATE_FAILED', err.message);
    }
});

app.patch('/bugs/:id/status', (req, res) => {
    const { status, comment } = req.body || {};
    try {
        const bug = bugs.updateBugStatus(req.params.id, status, comment);
        res.json({ ok: true, bug });
    } catch (err) {
        return sendApiError(res, 400, 'UPDATE_FAILED', err.message);
    }
});

app.post('/bugs/:id/notes', (req, res) => {
    const { text } = req.body || {};
    try {
        const bug = bugs.addBugNote(req.params.id, text);
        res.json({ ok: true, bug });
    } catch (err) {
        return sendApiError(res, 400, 'ADD_NOTE_FAILED', err.message);
    }
});

app.delete('/bugs/:id', (req, res) => {
    const remaining = bugs.deleteBug(req.params.id);
    res.json({ ok: true, bugs: remaining });
});

/**
 * GET /sessions/:id/normalized
 * Returns the normalized flow for a session.
 */
app.get('/sessions/:id/normalized', (req, res) => {
    const { id } = req.params;
    const session = db.getSession(id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const normalizedPath = path.join(getSessionDir(id), 'normalized.json');
    if (!fs.existsSync(normalizedPath)) {
        return res.status(404).json({ error: 'Not yet normalized. Call POST /sessions/:id/normalize first.' });
    }

    try {
        const data = JSON.parse(fs.readFileSync(normalizedPath, 'utf8'));
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Serve viewer for all other routes (SPA fallback)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function getLanUrls(port) {
    const nets = os.networkInterfaces();
    const urls = [];
    for (const ifaces of Object.values(nets)) {
        for (const iface of ifaces || []) {
            if (iface.family === 'IPv4' && !iface.internal) {
                urls.push(`http://${iface.address}:${port}`);
            }
        }
    }
    return urls;
}

// ── Bootstrap ────────────────────────────────────────────────────────────────
(async () => {
    try {
        await db.init();
        app.listen(PORT, HOST, () => {
            console.log(`
────────────────────────────────────────────────────
  QA Flight Recorder — Local Server
  Listening on http://${HOST}:${PORT}
  Data dir: ~/.qa-flight-recorder/`);
            if (HOST === '0.0.0.0') {
                const urls = getLanUrls(PORT);
                if (urls.length) {
                    console.log(`  Shared on your network at:`);
                    urls.forEach(u => console.log(`    ${u}`));
                } else {
                    console.log(`  HOST=0.0.0.0 set but no LAN interface found.`);
                }
            }
            console.log('────────────────────────────────────────────────────\n');
        });
    } catch (err) {
        console.error('[FATAL] Failed to initialize database:', err);
        process.exit(1);
    }
})();
