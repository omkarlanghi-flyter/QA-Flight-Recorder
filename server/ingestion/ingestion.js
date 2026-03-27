/**
 * ingestion.js — Event Ingestion Pipeline
 *
 * Provides a per-session ingestion context that handles:
 *   1. Schema validation (via schema.js)
 *   2. Event enrichment (auto-fill event_id, schema_version, etc.)
 *   3. Per-session in-memory deduplication by event_id
 *   4. Atomic NDJSON append to events.ndjson
 *   5. High-signal DB indexing
 *
 * Usage:
 *   const ctx = createIngestionContext(sessionId, sessionDir, db);
 *   const result = ctx.ingest([event1, event2, ...]);
 *   // → { accepted: N, rejected: M, duplicates: K, errors: [...] }
 *   ctx.destroy(); // call on session stop to free memory
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { validate, enrich } = require('./schema');

// ── Active session contexts (kept for dedup across multiple flushes) ──────────
const activeContexts = new Map(); // sessionId → IngestionContext

// ── Class ─────────────────────────────────────────────────────────────────────
class IngestionContext {
    /**
     * @param {string} sessionId
     * @param {string} sessionDir   — absolute path to this session's data directory
     * @param {object} db           — db module (for indexEventsBatch)
     */
    constructor(sessionId, sessionDir, db) {
        this.sessionId  = sessionId;
        this.eventsFile = path.join(sessionDir, 'raw', 'events.ndjson');
        this.db         = db;
        this.seenIds    = new Set(); // per-session dedup set
        this._ensureRawDir(sessionDir);
    }

    _ensureRawDir(sessionDir) {
        fs.mkdirSync(path.join(sessionDir, 'raw'), { recursive: true });
    }

    /**
     * Ingest a batch of raw events.
     *
     * @param {object[]} rawEvents
     * @returns {{ accepted: number, rejected: number, duplicates: number, errors: string[] }}
     */
    ingest(rawEvents) {
        const result = { accepted: 0, rejected: 0, duplicates: 0, errors: [] };

        if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
            return result;
        }

        const toWrite   = [];
        const toIndex   = [];

        for (const raw of rawEvents) {
            // 1. Enrich (normalise field names, stamp event_id + schema_version)
            const enriched = enrich(raw, this.sessionId);

            // 2. Validate
            const { valid, errors } = validate(enriched);
            if (!valid) {
                result.rejected++;
                for (const e of errors) result.errors.push(e);
                continue;
            }

            // 3. Dedup by event_id
            if (this.seenIds.has(enriched.event_id)) {
                result.duplicates++;
                continue;
            }
            this.seenIds.add(enriched.event_id);

            toWrite.push(enriched);
            toIndex.push(enriched);
            result.accepted++;
        }

        // 4. Atomic NDJSON append
        if (toWrite.length > 0) {
            const lines = toWrite.map(e => JSON.stringify(e)).join('\n') + '\n';
            fs.appendFileSync(this.eventsFile, lines, 'utf8');
        }

        // 5. DB indexing (high-signal types only — db handles filtering internally)
        if (toIndex.length > 0 && this.db) {
            try {
                // Map enriched events to the format db.indexEventsBatch expects
                const dbEvents = toIndex.map(e => ({
                    session_id: e.session_id,
                    ts_epoch_ms: e.timestamp ?? e.ts_epoch_ms,
                    type: e.event_type || e.type,
                    source: e.source,
                    url: e.url || e.data?.url_sanitized || e.data?.url_full || null,
                    data: e.data || {},
                    // additional schema v2 fields
                    event_id: e.event_id,
                    schema_version: e.schema_version,
                    correlation_id: e.correlation_id,
                }));
                this.db.indexEventsBatch(dbEvents);
            } catch (err) {
                result.errors.push(`DB indexing error: ${err.message}`);
            }
        }

        return result;
    }

    /**
     * Release in-memory resources. Call when the session ends.
     */
    destroy() {
        this.seenIds.clear();
        activeContexts.delete(this.sessionId);
    }
}

// ── Factory ────────────────────────────────────────────────────────────────────
/**
 * Create (or reuse) an IngestionContext for a session.
 *
 * @param {string} sessionId
 * @param {string} sessionDir
 * @param {object} db
 * @returns {IngestionContext}
 */
function createIngestionContext(sessionId, sessionDir, db) {
    if (activeContexts.has(sessionId)) {
        return activeContexts.get(sessionId);
    }
    const ctx = new IngestionContext(sessionId, sessionDir, db);
    activeContexts.set(sessionId, ctx);
    return ctx;
}

/**
 * Get an existing context (returns null if session not active).
 */
function getIngestionContext(sessionId) {
    return activeContexts.get(sessionId) || null;
}

/**
 * Destroy a context (call on session stop).
 */
function destroyIngestionContext(sessionId) {
    const ctx = activeContexts.get(sessionId);
    if (ctx) ctx.destroy();
}

module.exports = {
    createIngestionContext,
    getIngestionContext,
    destroyIngestionContext,
    IngestionContext,
};
