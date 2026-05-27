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

    -- Flows (Step 3)
    CREATE TABLE IF NOT EXISTS flows (
      flow_id           TEXT PRIMARY KEY,
      flow_name         TEXT NOT NULL,
      module            TEXT,
      feature           TEXT,
      priority          TEXT DEFAULT 'medium',
      criticality       TEXT DEFAULT 'normal',
      tags              TEXT DEFAULT '[]',
      owner             TEXT,
      version           INTEGER DEFAULT 1,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      source_session_id TEXT,
      description       TEXT
    );

    CREATE TABLE IF NOT EXISTS flow_steps (
      step_id           TEXT PRIMARY KEY,
      flow_id           TEXT NOT NULL REFERENCES flows(flow_id) ON DELETE CASCADE,
      step_index        INTEGER NOT NULL,
      step_name         TEXT,
      intent            TEXT,
      step_type         TEXT NOT NULL,
      selectors         TEXT DEFAULT '[]',
      expected_outcome  TEXT,
      assertions        TEXT DEFAULT '[]',
      fallback_strategy TEXT,
      wait_strategy     TEXT,
      meta              TEXT DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_flow_steps_flow ON flow_steps(flow_id);

    -- Runs & failure intelligence (Step 7/8/9)
    CREATE TABLE IF NOT EXISTS runs (
      run_id        TEXT PRIMARY KEY,
      flow_id       TEXT NOT NULL,
      flow_version  INTEGER,
      release_id    TEXT,
      started_at    INTEGER NOT NULL,
      finished_at   INTEGER,
      status        TEXT DEFAULT 'running',
      score         REAL,
      cluster_counts TEXT DEFAULT '{}',
      timings        TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS run_steps (
      run_step_id   TEXT PRIMARY KEY,
      run_id        TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      step_index    INTEGER NOT NULL,
      step_type     TEXT,
      status        TEXT,
      retry_count   INTEGER DEFAULT 0,
      assertion_failures TEXT DEFAULT '[]',
      evidence_path TEXT,
      cluster_id    TEXT,
      duration_ms   INTEGER,
      label         TEXT,
      timings       TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS failure_clusters (
      cluster_id    TEXT PRIMARY KEY,
      signature     TEXT NOT NULL UNIQUE,
      failure_class TEXT,
      count         INTEGER DEFAULT 1,
      first_seen    INTEGER NOT NULL,
      last_seen     INTEGER NOT NULL,
      exemplar_run_step_id TEXT,
      label         TEXT
    );

    CREATE TABLE IF NOT EXISTS modules (
      module_id TEXT PRIMARY KEY,
      name      TEXT UNIQUE
    );

    CREATE TABLE IF NOT EXISTS releases (
      release_id   TEXT PRIMARY KEY,
      version      TEXT,
      created_at   INTEGER NOT NULL,
      status       TEXT DEFAULT 'created',
      modules      TEXT DEFAULT '[]',
      risk_score   REAL
    );

    CREATE INDEX IF NOT EXISTS idx_runs_flow ON runs(flow_id);
    CREATE INDEX IF NOT EXISTS idx_runs_release ON runs(release_id);
    CREATE INDEX IF NOT EXISTS idx_failure_signature ON failure_clusters(signature);
  `);

  // Migrate existing DB if necessary
  try { db.run("ALTER TABLE sessions ADD COLUMN recording_type TEXT"); } catch (e) {}
  try { db.run("ALTER TABLE sessions ADD COLUMN flow_name TEXT"); } catch (e) {}
  try { db.run("ALTER TABLE sessions ADD COLUMN module_name TEXT"); } catch (e) {}
  // Schema v2 normalization fields
  try { db.run("ALTER TABLE sessions ADD COLUMN normalized_at INTEGER"); } catch (e) {}
  try { db.run("ALTER TABLE sessions ADD COLUMN normalized_step_count INTEGER DEFAULT 0"); } catch (e) {}
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
  // Flow schema migrations (idempotent)
  try { db.run("ALTER TABLE flows ADD COLUMN description TEXT"); } catch (e) {}
  // Profiling migrations
  try { db.run("ALTER TABLE runs ADD COLUMN timings TEXT"); } catch (e) {}
  try { db.run("ALTER TABLE run_steps ADD COLUMN timings TEXT"); } catch (e) {}

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
        id, flow_name, module_name, started_at as created_at, status as last_run_status,
        duration_ms, error_count, network_failure_count, slow_request_count
      FROM (
        SELECT *, ROW_NUMBER() OVER(PARTITION BY flow_name, module_name ORDER BY started_at DESC) as rn
        FROM sessions
        WHERE recording_type = 'sanity'
      )
      WHERE rn = 1
      ORDER BY created_at DESC
    `);
  },

  // ── Flow CRUD ──────────────────────────────────────────────────────────
  createFlow(flow, steps = []) {
    if (!flow || !flow.flow_id) throw new Error('flow.flow_id is required');

    db.run(
      `INSERT INTO flows (flow_id, flow_name, module, feature, priority, criticality, tags, owner, version, created_at, updated_at, source_session_id, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      , [
        flow.flow_id,
        flow.flow_name,
        flow.module || null,
        flow.feature || null,
        flow.priority || 'medium',
        flow.criticality || 'normal',
        JSON.stringify(flow.tags || []),
        flow.owner || null,
        flow.version || 1,
        flow.created_at || Date.now(),
        flow.updated_at || Date.now(),
        flow.source_session_id || null,
        flow.description || null,
      ]
    );

    const stmt = db.prepare(`INSERT INTO flow_steps (step_id, flow_id, step_index, step_name, intent, step_type, selectors, expected_outcome, assertions, fallback_strategy, wait_strategy, meta)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const s of steps) {
      stmt.run([
        s.step_id,
        flow.flow_id,
        s.step_index,
        s.step_name || null,
        s.intent || null,
        s.step_type,
        JSON.stringify(s.selectors || []),
        s.expected_outcome || null,
        JSON.stringify(s.assertions || []),
        s.fallback_strategy || null,
        s.wait_strategy ? JSON.stringify(s.wait_strategy) : null,
        JSON.stringify(s.meta || {}),
      ]);
    }
    stmt.free();
    persistDb();
  },

  listFlows(filters = {}) {
    const clauses = [];
    const params = [];
    if (filters.module) { clauses.push('module = ?'); params.push(filters.module); }
    if (filters.feature) { clauses.push('feature = ?'); params.push(filters.feature); }
    if (filters.priority) { clauses.push('priority = ?'); params.push(filters.priority); }
    if (filters.criticality) { clauses.push('criticality = ?'); params.push(filters.criticality); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return queryAll(`SELECT * FROM flows ${where} ORDER BY updated_at DESC`, params)
      .map(f => ({ ...f, tags: _safeParseJson(f.tags, []) }));
  },

  getFlow(flowId, { withSteps = false } = {}) {
    const flow = queryOne('SELECT * FROM flows WHERE flow_id = ?', [flowId]);
    if (!flow) return null;
    flow.tags = _safeParseJson(flow.tags, []);
    if (!withSteps) return flow;
    const steps = queryAll('SELECT * FROM flow_steps WHERE flow_id = ? ORDER BY step_index ASC', [flowId])
      .map(s => ({
        ...s,
        selectors: _safeParseJson(s.selectors, []),
        assertions: _safeParseJson(s.assertions, []),
        wait_strategy: _safeParseJson(s.wait_strategy, s.wait_strategy),
        meta: _safeParseJson(s.meta, {}),
      }));
    return { flow, steps };
  },

  updateFlow(flowId, patch = {}) {
    const flow = queryOne('SELECT * FROM flows WHERE flow_id = ?', [flowId]);
    if (!flow) throw new Error('Flow not found');
    const nextVersion = (flow.version || 1) + 1;
    const updatedAt = Date.now();

    db.run(
      `UPDATE flows SET flow_name = ?, module = ?, feature = ?, priority = ?, criticality = ?, tags = ?, owner = ?, version = ?, updated_at = ?, description = ?
       WHERE flow_id = ?`,
      [
        patch.flow_name ?? flow.flow_name,
        patch.module ?? flow.module,
        patch.feature ?? flow.feature,
        patch.priority ?? flow.priority,
        patch.criticality ?? flow.criticality,
        JSON.stringify(patch.tags ?? _safeParseJson(flow.tags, [])),
        patch.owner ?? flow.owner,
        nextVersion,
        updatedAt,
        patch.description ?? flow.description,
        flowId,
      ]
    );
    persistDb();
    return nextVersion;
  },

  deleteFlow(flowId) {
    db.run('DELETE FROM flow_steps WHERE flow_id = ?', [flowId]);
    db.run('DELETE FROM flows WHERE flow_id = ?', [flowId]);
    persistDb();
  },

  // ── Runs & failure clusters ─────────────────────────────────────────────
  createRun(run) {
    const id = run.run_id || uuidv4();
    db.run(
      `INSERT INTO runs (run_id, flow_id, flow_version, release_id, started_at, status, score, cluster_counts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      , [
        id,
        run.flow_id,
        run.flow_version || 1,
        run.release_id || null,
        run.started_at || Date.now(),
        run.status || 'running',
        run.score || null,
        JSON.stringify(run.cluster_counts || {}),
      ]
    );
    persistDb();
    return id;
  },

  updateRun(runId, patch = {}) {
    const run = queryOne('SELECT * FROM runs WHERE run_id = ?', [runId]);
    if (!run) throw new Error('Run not found');
    db.run(
      `UPDATE runs SET flow_id = ?, flow_version = ?, release_id = ?, started_at = ?, finished_at = ?, status = ?, score = ?, cluster_counts = ?, timings = ?
       WHERE run_id = ?`,
      [
        patch.flow_id ?? run.flow_id,
        patch.flow_version ?? run.flow_version,
        patch.release_id ?? run.release_id,
        patch.started_at ?? run.started_at,
        patch.finished_at ?? run.finished_at ?? null,
        patch.status ?? run.status,
        patch.score ?? run.score,
        JSON.stringify(patch.cluster_counts ?? _safeParseJson(run.cluster_counts, {})),
        JSON.stringify(patch.timings ?? _safeParseJson(run.timings, {})),
        runId,
      ]
    );
    persistDb();
  },

  insertRunSteps(runId, steps = []) {
    const stmt = db.prepare(`INSERT INTO run_steps (run_step_id, run_id, step_index, step_type, status, retry_count, assertion_failures, evidence_path, cluster_id, duration_ms, label, timings)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const s of steps) {
      stmt.run([
        s.run_step_id || uuidv4(),
        runId,
        s.step_index,
        s.step_type || null,
        s.status || null,
        s.retry_count || 0,
        JSON.stringify(s.assertion_failures || []),
        s.evidence_path || null,
        s.cluster_id || null,
        s.duration_ms || null,
        s.label || null,
        JSON.stringify(s.timings || {}),
      ]);
    }
    stmt.free();
    persistDb();
  },

  listRuns({ flow_id, release_id, limit = 50, offset = 0 } = {}) {
    const clauses = [];
    const params = [];
    if (flow_id) { clauses.push('flow_id = ?'); params.push(flow_id); }
    if (release_id) { clauses.push('release_id = ?'); params.push(release_id); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return queryAll(`SELECT * FROM runs ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset])
      .map(r => ({ ...r, cluster_counts: _safeParseJson(r.cluster_counts, {}), timings: _safeParseJson(r.timings, {}) }));
  },

  getRun(runId, { withSteps = false } = {}) {
    const run = queryOne('SELECT * FROM runs WHERE run_id = ?', [runId]);
    if (!run) return null;
    run.cluster_counts = _safeParseJson(run.cluster_counts, {});
    run.timings = _safeParseJson(run.timings, {});
    if (!withSteps) return run;
    const steps = queryAll('SELECT * FROM run_steps WHERE run_id = ? ORDER BY step_index ASC', [runId])
      .map(s => ({ ...s, assertion_failures: _safeParseJson(s.assertion_failures, []), timings: _safeParseJson(s.timings, {}) }));
    return { run, steps };
  },

  upsertFailureCluster({ signature, failure_class, exemplar_run_step_id, label }) {
    let cluster = queryOne('SELECT * FROM failure_clusters WHERE signature = ?', [signature]);
    const now = Date.now();
    if (cluster) {
      db.run('UPDATE failure_clusters SET count = ?, last_seen = ?, failure_class = COALESCE(?, failure_class), exemplar_run_step_id = COALESCE(?, exemplar_run_step_id) WHERE signature = ?',
        [cluster.count + 1, now, failure_class || null, exemplar_run_step_id || null, signature]);
      cluster = queryOne('SELECT * FROM failure_clusters WHERE signature = ?', [signature]);
    } else {
      const id = uuidv4();
      db.run(
        `INSERT INTO failure_clusters (cluster_id, signature, failure_class, count, first_seen, last_seen, exemplar_run_step_id, label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        , [id, signature, failure_class || null, 1, now, now, exemplar_run_step_id || null, label || null]);
      cluster = queryOne('SELECT * FROM failure_clusters WHERE cluster_id = ?', [id]);
    }
    persistDb();
    return cluster;
  },

  listFailureClusters({ limit = 50, offset = 0 } = {}) {
    return queryAll('SELECT * FROM failure_clusters ORDER BY last_seen DESC LIMIT ? OFFSET ?', [limit, offset]);
  },

  getFailureCluster(id) {
    return queryOne('SELECT * FROM failure_clusters WHERE cluster_id = ? OR signature = ?', [id, id]);
  },

  // ── Releases / modules ───────────────────────────────────────────────────
  createRelease(release) {
    const rid = release.release_id || uuidv4();
    db.run(
      `INSERT INTO releases (release_id, version, created_at, status, modules, risk_score)
       VALUES (?, ?, ?, ?, ?, ?)`
      , [rid, release.version || null, release.created_at || Date.now(), release.status || 'created', JSON.stringify(release.modules || []), release.risk_score || null]
    );
    persistDb();
    return rid;
  },

  listReleases({ limit = 50, offset = 0 } = {}) {
    return queryAll('SELECT * FROM releases ORDER BY created_at DESC LIMIT ? OFFSET ?', [limit, offset])
      .map(r => ({ ...r, modules: _safeParseJson(r.modules, []) }));
  },

  getRelease(releaseId) {
    const r = queryOne('SELECT * FROM releases WHERE release_id = ?', [releaseId]);
    if (!r) return null;
    r.modules = _safeParseJson(r.modules, []);
    return r;
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

  getSessionsByFlow(flowName, moduleName) {
    if (moduleName) {
      return queryAll('SELECT * FROM sessions WHERE flow_name = ? AND module_name = ? ORDER BY started_at DESC', [flowName, moduleName]);
    } else {
      return queryAll('SELECT * FROM sessions WHERE flow_name = ? AND module_name IS NULL ORDER BY started_at DESC', [flowName]);
    }
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
