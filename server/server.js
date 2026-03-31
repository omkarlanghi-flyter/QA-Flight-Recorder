const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const archiver = require('archiver');
const multer = require('multer');

const { ReplayEngine } = require('./engine/replay');
const { createPlan } = require('./engine/planner');
const db = require('./db');
const { createIngestionContext, destroyIngestionContext } = require('./ingestion/ingestion');
const { normalize } = require('./normalization/normalizer');
const flowStore = require('./flows/flow_store');

const activeReplays = new Map();
const { generateTriageView, errorSignature } = require('./filter');

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

// Flow plan cache helper
function getFlowPlanPath(flowId) {
    const dir = path.join(db.DATA_DIR, 'flows', flowId);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'latest_plan.json');
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
    const { tab_id, url, title, recording_type, flow_name, module_name } = req.body || {};

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
        recording_type,
        flow_name,
        module_name 
    };
    fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify(meta, null, 2));

    db.createSession({ 
        id: sessionId, 
        started_at: now, 
        tab_id: tab_id || null, 
        url: url || null, 
        title: title || null,
        recording_type,
        flow_name,
        module_name
    });

    console.log(`[START] Session ${sessionId} for tab ${tab_id} url=${url} type=${recording_type || 'default'}`);
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
            const events = content.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
            eventCount = events.length;
            
            // Get ignored signatures
            const ignoredSet = new Set(loadIgnored().map(i => i.signature));
            
            for (const e of events) {
                const sig = errorSignature(e);
                if (ignoredSet.has(sig)) continue; // Skip ignored errors from counts

                if (['console.error', 'runtime.exception'].includes(e.type)) errorCount++;
                if (e.type === 'network.failure') networkFailureCount++;
                // Use timing for slow requests
                if (e.type === 'network.timing' && e.data?.duration_ms > 2000) slowRequestCount++;
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
 * GET /sanity-flows
 * Returns aggregated sanity flows (latest per flow_name)
 */
app.get('/sanity-flows', (req, res) => {
    try {
        const flows = db.listSanityFlows();
        res.json({ flows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /sessions/:id/replay
 * Replays a session using Playwright and CDP connection
 */
app.post('/sessions/:id/replay', async (req, res) => {
    const eventsFile = getEventsFile(req.params.id);
    if (!fs.existsSync(eventsFile)) return res.status(404).json({ error: 'Events not found' });

    const content = fs.readFileSync(eventsFile, 'utf8').trim();
    const events = content ? content.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];

    const session = db.getSession(req.params.id);

    try {
        const options = { startUrl: session?.url };
        if (req.body && req.body.profileDir) {
            // Expand tilde if present
            let pdir = req.body.profileDir.trim();
            if (pdir.startsWith('~')) {
                pdir = require('path').join(require('os').homedir(), pdir.slice(1));
            }
            options.profileDir = pdir;
        }
        if (req.body && req.body.stepDelay !== undefined) {
            options.stepDelay = Number(req.body.stepDelay);
        }

        const engine = new ReplayEngine(events, options);
        activeReplays.set(req.params.id, engine);
        const report = await engine.run();
        activeReplays.delete(req.params.id);

        report.timestamp = Date.now();
        const replaysDir = path.join(getSessionDir(req.params.id), 'replays');
        fs.mkdirSync(replaysDir, { recursive: true });
        fs.writeFileSync(path.join(replaysDir, `${report.timestamp}.json`), JSON.stringify(report, null, 2));

        res.json({ report });
    } catch (err) {
        activeReplays.delete(req.params.id);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /sessions/:id/replay/stop
 * Stops an active replay
 */
app.post('/sessions/:id/replay/stop', async (req, res) => {
    const engine = activeReplays.get(req.params.id);
    if (engine) {
        await engine.abort();
        res.json({ ok: true });
    } else {
        res.status(404).json({ error: 'No active replay for this session' });
    }
});

/**
 * GET /sessions/:id/replays
 * Returns all past sanity run reports for this session
 */
app.get('/sessions/:id/replays', (req, res) => {
    try {
        const session = db.getSession(req.params.id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        let targetSessions = [session];
        // If it's a sanity flow, find ALL recordings of this flow
        if (session.recording_type === 'sanity' && session.flow_name) {
            targetSessions = db.getSessionsByFlow(session.flow_name, session.module_name);
        }

        const events = [];

        for (const s of targetSessions) {
            // Add the manual recording baseline block
            events.push({
                type: 'manual_recording',
                timestamp: s.started_at,
                session_id: s.id,
                duration_ms: s.duration_ms,
                error_count: s.error_count || 0,
                network_failure_count: s.network_failure_count || 0
            });

            // Find all automated Playwright replays executed on this version
            const replaysDir = path.join(getSessionDir(s.id), 'replays');
            if (fs.existsSync(replaysDir)) {
                const files = fs.readdirSync(replaysDir).filter(f => f.endsWith('.json'));
                for (const f of files) {
                    try {
                        const report = JSON.parse(fs.readFileSync(path.join(replaysDir, f), 'utf8'));
                        report.type = 'automated_replay';
                        report.source_session_id = s.id;
                        events.push(report);
                    } catch { }
                }
            }
        }

        // Sort descending by timestamp
        events.sort((a, b) => b.timestamp - a.timestamp);
        
        // We still use the 'replays' key so the UI doesn't break
        res.json({ replays: events });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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
    res.json({ total, recording, done, clean, totalErrors, totalNetFailures, totalSlowReqs });
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
    const events = content ? content.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
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
    const allEvents = content ? content.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];

    const limit = parseInt(req.query.limit) || 500;
    const offset = parseInt(req.query.offset) || 0;

    // Support filtering by multiple types (e.g. types=action.click,action.scroll)
    let filtered = allEvents;
    if (req.query.types) {
        const allowedTypes = new Set(req.query.types.split(','));
        filtered = allEvents.filter(e => allowedTypes.has(e.type));
    } else if (req.query.type) {
        filtered = allEvents.filter(e => e.type === req.query.type);
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
                const events = content.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
                const ignoredSet = new Set(loadIgnored().map(i => i.signature));
                let errorCount = 0;
                let networkFailureCount = 0;
                let slowRequestCount = 0;
                for (const e of events) {
                    const sig = errorSignature(e);
                    if (ignoredSet.has(sig)) continue;
                    if (['console.error', 'runtime.exception'].includes(e.type)) errorCount++;
                    if (e.type === 'network.failure') networkFailureCount++;
                    if (e.type === 'network.timing' && e.data?.duration_ms > 2000) slowRequestCount++;
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
 * Body: { tab_id, url, title, recording_type?, flow_name?, module_name? }
 */
app.post('/sessions', (req, res) => {
    const sessionId = uuidv4();
    const now = Date.now();
    const { tab_id, url, title, recording_type, flow_name, module_name } = req.body || {};

    const sessionDir = getSessionDir(sessionId);
    fs.mkdirSync(path.join(sessionDir, 'raw'),    { recursive: true });
    fs.mkdirSync(path.join(sessionDir, 'views'),  { recursive: true });
    fs.mkdirSync(path.join(sessionDir, 'video'),  { recursive: true });

    const meta = {
        id: sessionId, started_at: now, tab_id, url, title,
        status: 'recording', recording_type, flow_name, module_name,
        schema_version: '2.0',
    };
    fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify(meta, null, 2));

    db.createSession({
        id: sessionId, started_at: now,
        tab_id: tab_id || null, url: url || null, title: title || null,
        recording_type, flow_name, module_name,
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
    if (!session) return res.status(404).json({ error: 'Session not found' });

    let events = req.body;
    if (!Array.isArray(events)) events = [events];

    const sessionDir = getSessionDir(id);
    const ctx = createIngestionContext(id, sessionDir, db);
    const result = ctx.ingest(events);

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
            const events = content.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
            eventCount = events.length;
            const ignoredSet = new Set(loadIgnored().map(i => i.signature));
            for (const e of events) {
                const sig = errorSignature(e);
                if (ignoredSet.has(sig)) continue;
                const evtType = e.event_type || e.type;
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

// ── Flow CRUD & Promotion (Step 3) ─────────────────────────────────────────

/**
 * POST /sessions/:id/promote
 * Promote a normalized session into a Flow + FlowSteps
 */
app.post('/sessions/:id/promote', (req, res) => {
    const { id } = req.params;
    const session = db.getSession(id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    try {
        const sessionDir = getSessionDir(id);
        const { flow, steps } = flowStore.promoteFromSession(id, sessionDir, req.body || {});
        res.status(201).json({ ok: true, flow, step_count: steps.length });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/**
 * POST /flows
 */
app.post('/flows', (req, res) => {
    try {
        const payload = req.body || {};
        const flow = payload.flow || payload;
        const steps = payload.steps || [];
        const result = flowStore.createFlow(flow, steps);
        res.status(201).json({ ok: true, flow: result.flow, steps: result.steps });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/**
 * GET /flows
 */
app.get('/flows', (req, res) => {
    try {
        const filters = {
            module: req.query.module,
            feature: req.query.feature,
            priority: req.query.priority,
            criticality: req.query.criticality,
        };
        const flows = flowStore.listFlows(filters);
        res.json({ flows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /flows/:id
 */
app.get('/flows/:id', (req, res) => {
    const result = flowStore.getFlow(req.params.id, { withSteps: true });
    if (!result) return res.status(404).json({ error: 'Flow not found' });
    res.json(result);
});

/**
 * PATCH /flows/:id
 */
app.patch('/flows/:id', (req, res) => {
    try {
        const updated = flowStore.updateFlow(req.params.id, req.body || {});
        res.json(updated);
    } catch (err) {
        res.status(err.message.includes('not found') ? 404 : 400).json({ error: err.message });
    }
});

/**
 * DELETE /flows/:id
 */
app.delete('/flows/:id', (req, res) => {
    try {
        flowStore.deleteFlow(req.params.id);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Planner & Replay (Step 4) ───────────────────────────────────────────────

/**
 * POST /flows/:id/plan
 * Generates and caches an execution plan for a flow
 */
app.post('/flows/:id/plan', (req, res) => {
    const result = flowStore.getFlow(req.params.id, { withSteps: true });
    if (!result) return res.status(404).json({ error: 'Flow not found' });
    try {
        const plan = createPlan(result.flow, result.steps);
        const planPath = getFlowPlanPath(req.params.id);
        fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
        res.json({ ok: true, plan });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /flows/:id/plan
 */
app.get('/flows/:id/plan', (req, res) => {
    const { id } = req.params;
    const result = flowStore.getFlow(id, { withSteps: true });
    if (!result) return res.status(404).json({ error: 'Flow not found' });
    const planPath = getFlowPlanPath(id);
    try {
        if (fs.existsSync(planPath) && !req.query.regenerate) {
            const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
            return res.json({ plan, cached: true });
        }
        const plan = createPlan(result.flow, result.steps);
        fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
        res.json({ plan, cached: false });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /flows/:id/run
 * Generates plan (if needed) and executes via ReplayEngine
 */
app.post('/flows/:id/run', async (req, res) => {
    const { id } = req.params;
    const result = flowStore.getFlow(id, { withSteps: true });
    if (!result) return res.status(404).json({ error: 'Flow not found' });

    const planPath = getFlowPlanPath(id);
    let plan;
    try {
        if (req.body?.regenerate || !fs.existsSync(planPath)) {
            plan = createPlan(result.flow, result.steps);
            fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
        } else {
            plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
        }
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }

    try {
        const options = { startUrl: result.flow?.module_start_url, ...req.body };
        const engine = new ReplayEngine([], options);
        const report = await engine.runPlan(plan);

        const runsDir = path.join(db.DATA_DIR, 'flows', id, 'runs');
        fs.mkdirSync(runsDir, { recursive: true });
        const ts = Date.now();
        fs.writeFileSync(path.join(runsDir, `${ts}.json`), JSON.stringify(report, null, 2));

        res.json({ report });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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

// ── Bootstrap ────────────────────────────────────────────────────────────────
(async () => {
    try {
        await db.init();
        app.listen(PORT, '127.0.0.1', () => {
            console.log(`
╔══════════════════════════════════════════════════╗
║       QA Flight Recorder — Local Server          ║
║  Listening on http://127.0.0.1:${PORT}             ║
║  Data dir: ~/.qa-flight-recorder/                ║
╚══════════════════════════════════════════════════╝
  `);
        });
    } catch (err) {
        console.error('[FATAL] Failed to initialize database:', err);
        process.exit(1);
    }
})();
