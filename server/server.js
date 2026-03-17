const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const archiver = require('archiver');
const multer = require('multer');

const db = require('./db');
const { generateTriageView } = require('./filter');

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
    const { tab_id, url, title } = req.body || {};

    const sessionDir = getSessionDir(sessionId);
    fs.mkdirSync(path.join(sessionDir, 'raw'), { recursive: true });
    fs.mkdirSync(path.join(sessionDir, 'views'), { recursive: true });
    fs.mkdirSync(path.join(sessionDir, 'video'), { recursive: true });

    const meta = { id: sessionId, started_at: now, tab_id, url, title, status: 'recording' };
    fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify(meta, null, 2));

    db.createSession({ id: sessionId, started_at: now, tab_id: tab_id || null, url: url || null, title: title || null });

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
            for (const e of events) {
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
        const result = generateTriageView(sessionDir);
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
    res.json({ total, recording, done, clean, totalErrors, totalNetFailures, totalSlowReqs });
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
        const result = generateTriageView(sessionDir);
        res.json({ ok: true, ...result });
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
