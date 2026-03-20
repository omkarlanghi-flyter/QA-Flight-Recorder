/**
 * db.js - SQLite database using sql.js (pure JS, no native compilation)
 * Persists to disk manually after each write.
 */
const initSqlJs = require('sql.js');
const path = require('path');
const os = require('os');
const fs = require('fs');

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
      recording_type TEXT,
      flow_name TEXT,
      module_name TEXT
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

    CREATE INDEX IF NOT EXISTS idx_events_session ON events_index(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events_index(session_id, type);
    CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
  `);

  // Migrate existing DB if necessary
  try { db.run("ALTER TABLE sessions ADD COLUMN recording_type TEXT"); } catch (e) {}
  try { db.run("ALTER TABLE sessions ADD COLUMN flow_name TEXT"); } catch (e) {}
  try { db.run("ALTER TABLE sessions ADD COLUMN module_name TEXT"); } catch (e) {}

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
      `INSERT INTO sessions (id, started_at, tab_id, url, title, status, recording_type, flow_name, module_name)
       VALUES (?, ?, ?, ?, ?, 'recording', ?, ?, ?)`,
      [
          session.id, 
          session.started_at, 
          session.tab_id || null, 
          session.url || null, 
          session.title || null,
          session.recording_type || null,
          session.flow_name || null,
          session.module_name || null
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

  listSanityFlows() {
    return queryAll(`
      SELECT 
        id, flow_name, module_name, MAX(started_at) as created_at, status as last_run_status,
        duration_ms, error_count, network_failure_count, slow_request_count
      FROM sessions
      WHERE recording_type = 'sanity'
      GROUP BY flow_name, module_name
      ORDER BY created_at DESC
    `);
  },

  getSession(id) {
    return queryOne('SELECT * FROM sessions WHERE id = ?', [id]);
  },

  indexEventsBatch(events) {
    for (const event of events) {
      if (!HIGH_SIGNAL_TYPES.has(event.type)) continue;
      db.run(
        `INSERT INTO events_index (session_id, ts_epoch_ms, type, source, url, summary)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          event.session_id,
          event.ts_epoch_ms,
          event.type,
          event.source || null,
          event.url || null,
          JSON.stringify(event.data || {}).slice(0, 200),
        ]
      );
    }
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
    persistDb();
  },
};
