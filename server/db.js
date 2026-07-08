/**
 * db.js - SQLite database using sql.js (pure JS, no native compilation)
 * Persists to disk manually after each write.
 */
const initSqlJs = require('sql.js');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { getEventType } = require('./event_type');

const DATA_DIR = path.join(os.homedir(), '.qa-flight-recorder');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const DB_PATH = path.join(DATA_DIR, 'index.db');

// Ensure directories exist
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// High-signal event types to index
const HIGH_SIGNAL_TYPES = new Set([
  'console.error', 'console.warn', 'runtime.exception',
  'network.failure', 'marker.bug', 'action.navigation'
]);

let db = null;

/**
 * Initialize the database (async because sql.js needs to load WASM)
 */
async function initDb() {
  const SQL = await initSqlJs();

  // Load existing DB from disk if it exists
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // Create schema
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      stopped_at INTEGER,
      tab_id INTEGER,
      url TEXT,
      title TEXT,
      duration_ms INTEGER,
      status TEXT DEFAULT 'recording',
      event_count INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      network_failure_count INTEGER DEFAULT 0,
      slow_request_count INTEGER DEFAULT 0,
      tags TEXT DEFAULT '[]',
      browser_info TEXT
    );

    CREATE TABLE IF NOT EXISTS events_index (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ts_epoch_ms INTEGER NOT NULL,
      type TEXT NOT NULL,
      source TEXT,
      url TEXT,
      summary TEXT
    );

    CREATE TABLE IF NOT EXISTS event_dedup (
      session_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, event_id)
    );

    CREATE INDEX IF NOT EXISTS idx_events_session ON events_index(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events_index(session_id, type);
    CREATE INDEX IF NOT EXISTS idx_event_dedup_session ON event_dedup(session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
  `);

  // Migrate existing DB if necessary
  // Schema v2 normalization fields
  try { db.run("ALTER TABLE sessions ADD COLUMN normalized_at INTEGER"); } catch (e) {}
  try { db.run("ALTER TABLE sessions ADD COLUMN normalized_step_count INTEGER DEFAULT 0"); } catch (e) {}
  try { db.run("ALTER TABLE sessions ADD COLUMN browser_info TEXT"); } catch (e) {}
  // Schema v2 event index fields
  try { db.run("ALTER TABLE events_index ADD COLUMN event_id TEXT"); } catch (e) {}
  try { db.run("ALTER TABLE events_index ADD COLUMN schema_version TEXT"); } catch (e) {}
  try { db.run("ALTER TABLE events_index ADD COLUMN correlation_id TEXT"); } catch (e) {}
  try {
    db.run(`
      DELETE FROM events_index
      WHERE event_id IS NOT NULL
        AND event_id <> ''
        AND id NOT IN (
          SELECT MIN(id)
          FROM events_index
          WHERE event_id IS NOT NULL AND event_id <> ''
          GROUP BY session_id, event_id
        )
    `);
    db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_events_session_event_id_unique ON events_index(session_id, event_id)");
  } catch (e) {
    console.warn('[DB] Unable to apply unique event_id index migration:', e.message);
  }

  persistDb();
  console.log('[DB] SQLite initialized at', DB_PATH);
}

// Persist in-memory DB to disk (called after every write)
function persistDb() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// Helper: run a query and return all rows as plain objects
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

// Helper: run a query and return one row
function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows[0] || null;
}

// Safe JSON parse helper with fallback
function _safeParseJson(str, fallback) {
  try {
    return typeof str === 'string' ? JSON.parse(str) : str ?? fallback;
  } catch {
    return fallback;
  }
}

module.exports = {
  DATA_DIR,
  SESSIONS_DIR,

  async init() {
    await initDb();
  },

  getSessionDir(sessionId) {
    return path.join(SESSIONS_DIR, sessionId);
  },

  createSession(session) {
    db.run(
      `INSERT INTO sessions (id, started_at, tab_id, url, title, status, browser_info)
       VALUES (?, ?, ?, ?, ?, 'recording', ?)`,
      [
          session.id,
          session.started_at,
          session.tab_id || null,
          session.url || null,
          session.title || null,
          session.browser_info ? JSON.stringify(session.browser_info) : null,
      ]
    );
    persistDb();
  },

  updateSessionStop(sessionId, stoppedAt, stats) {
    db.run(
      `UPDATE sessions SET
        stopped_at = ?, duration_ms = ?, status = 'done',
        event_count = ?, error_count = ?,
        network_failure_count = ?, slow_request_count = ?
       WHERE id = ?`,
      [
        stoppedAt,
        stats.duration_ms,
        stats.event_count,
        stats.error_count,
        stats.network_failure_count,
        stats.slow_request_count,
        sessionId,
      ]
    );
    persistDb();
  },

  listSessions({ limit = 50, offset = 0, status } = {}) {
    if (status) {
      return queryAll(
        'SELECT * FROM sessions WHERE status = ? ORDER BY started_at DESC LIMIT ? OFFSET ?',
        [status, limit, offset]
      );
    }
    return queryAll(
      'SELECT * FROM sessions ORDER BY started_at DESC LIMIT ? OFFSET ?',
      [limit, offset]
    );
  },

  /**
   * Update session after normalization completes.
   */
  updateSessionNormalized(sessionId, stepCount) {
    db.run(
      `UPDATE sessions SET normalized_at = ?, normalized_step_count = ? WHERE id = ?`,
      [Date.now(), stepCount || 0, sessionId]
    );
    persistDb();
  },

  getSession(id) {
    return queryOne('SELECT * FROM sessions WHERE id = ?', [id]);
  },

  indexEventsBatch(events) {
    for (const event of events) {
      const eventType = getEventType(event);
      if (!HIGH_SIGNAL_TYPES.has(eventType)) continue;
      db.run(
        `INSERT OR IGNORE INTO events_index (session_id, ts_epoch_ms, type, source, url, summary, event_id, schema_version, correlation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          event.session_id,
          event.ts_epoch_ms ?? event.timestamp,
          eventType,
          event.source || null,
          event.url || null,
          JSON.stringify(event.data || {}).slice(0, 200),
          event.event_id || null,
          event.schema_version || null,
          event.correlation_id || null,
        ]
      );
    }
    persistDb();
  },

  getExistingEventIds(sessionId, eventIds = []) {
    if (!sessionId || !Array.isArray(eventIds) || eventIds.length === 0) return [];
    const filtered = Array.from(new Set(eventIds.filter(id => typeof id === 'string' && id.trim().length > 0)));
    if (filtered.length === 0) return [];

    const placeholders = filtered.map(() => '?').join(',');
    const rows = queryAll(
      `SELECT event_id FROM events_index WHERE session_id = ? AND event_id IN (${placeholders})`,
      [sessionId, ...filtered]
    );
    return rows.map(r => r.event_id).filter(Boolean);
  },

  reserveEventIds(sessionId, eventIds = []) {
    if (!sessionId || !Array.isArray(eventIds) || eventIds.length === 0) return new Set();
    const accepted = new Set();
    const now = Date.now();
    const stmt = db.prepare('INSERT OR IGNORE INTO event_dedup (session_id, event_id, created_at) VALUES (?, ?, ?)');

    try {
      for (const rawId of eventIds) {
        if (typeof rawId !== 'string') continue;
        const id = rawId.trim();
        if (!id) continue;
        stmt.run([sessionId, id, now]);
        if (db.getRowsModified() > 0) accepted.add(id);
      }
    } finally {
      stmt.free();
    }

    if (accepted.size > 0) persistDb();
    return accepted;
  },

  releaseReservedEventIds(sessionId, eventIds = []) {
    if (!sessionId || !Array.isArray(eventIds) || eventIds.length === 0) return;
    const filtered = Array.from(new Set(eventIds.filter(id => typeof id === 'string' && id.trim().length > 0)));
    if (filtered.length === 0) return;

    const placeholders = filtered.map(() => '?').join(',');
    db.run(
      `DELETE FROM event_dedup WHERE session_id = ? AND event_id IN (${placeholders})`,
      [sessionId, ...filtered]
    );
    persistDb();
  },

  getIndexedEvents(sessionId) {
    return queryAll(
      'SELECT * FROM events_index WHERE session_id = ? ORDER BY ts_epoch_ms ASC',
      [sessionId]
    );
  },

  deleteSession(sessionId) {
    db.run('DELETE FROM sessions WHERE id = ?', [sessionId]);
    db.run('DELETE FROM events_index WHERE session_id = ?', [sessionId]);
    db.run('DELETE FROM event_dedup WHERE session_id = ?', [sessionId]);
    persistDb();
  },

  deleteSessions(sessionIds) {
    if (!sessionIds || sessionIds.length === 0) return;
    const placeholders = sessionIds.map(() => '?').join(',');
    db.run(`DELETE FROM sessions WHERE id IN (${placeholders})`, sessionIds);
    db.run(`DELETE FROM events_index WHERE session_id IN (${placeholders})`, sessionIds);
    db.run(`DELETE FROM event_dedup WHERE session_id IN (${placeholders})`, sessionIds);
    persistDb();
  },
};
