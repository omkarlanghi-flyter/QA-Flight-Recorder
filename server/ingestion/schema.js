/**
 * schema.js — Canonical Event Schema v2.0
 *
 * Defines the required/optional fields for all events flowing through
 * the ingestion layer, plus validate() and enrich() helpers.
 *
 * Field reference:
 *   event_id         — Stable UUID for this event (dedup key). Auto-generated if absent.
 *   session_id       — UUID of the recording session this event belongs to.
 *   timestamp        — Unix epoch ms when the event was observed (client-side).
 *   event_type       — Dot-namespaced type string (e.g. 'action.click').
 *   source           — Origin of the event: 'content' | 'cdp' | 'cdp-log' | 'cdp-runtime'
 *                      | 'cdp-audits' | 'browser' | 'user' | 'system'
 *   correlation_id   — Optional: event_id of the preceding action that triggered this event
 *                      (used to correlate network/console events back to user actions).
 *   parent_action_id — Optional: event_id of the direct parent action in a multi-step group.
 *   schema_version   — Always stamped by server at ingestion ('2.0'). Client value ignored.
 *   data             — Arbitrary event payload object. Content varies by event_type.
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const { getEventType } = require('../event_type');

// ── Schema Version ────────────────────────────────────────────────────────────
const CURRENT_SCHEMA_VERSION = '2.0';

// ── Valid sources ─────────────────────────────────────────────────────────────
const VALID_SOURCES = new Set([
    'content',
    'cdp',
    'cdp-log',
    'cdp-runtime',
    'cdp-audits',
    'browser',
    'user',
    'system',
]);

// ── Valid event type prefixes ─────────────────────────────────────────────────
// Events must belong to one of these namespaces.
const VALID_TYPE_PREFIXES = [
    'action.',
    'network.',
    'console.',
    'runtime.',
    'browser.',
    'dom.',
    'marker.',
    'system.',
];

// ── Required fields ───────────────────────────────────────────────────────────
// event_id and schema_version are NOT required from clients — server fills them.
const REQUIRED_FIELDS = ['session_id', 'event_type'];

// ── Validate ──────────────────────────────────────────────────────────────────
/**
 * Validate a raw incoming event object.
 *
 * @param {object} event
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validate(event) {
    const errors = [];

    if (!event || typeof event !== 'object') {
        return { valid: false, errors: ['Event must be a non-null object'] };
    }

    // Required field presence
    for (const field of REQUIRED_FIELDS) {
        // Support both legacy field names and new canonical names
        const value = event[field] ?? event[legacyAlias(field)];
        if (!value) {
            errors.push(`Missing required field: ${field}`);
        }
    }

    // event_type must be a known namespace (be lenient — warn only, still accept)
    const eventType = getEventType(event);
    if (eventType && typeof eventType === 'string') {
        const knownPrefix = VALID_TYPE_PREFIXES.some(p => eventType.startsWith(p));
        if (!knownPrefix) {
            errors.push(`Unknown event_type namespace: "${eventType}" (expected one of ${VALID_TYPE_PREFIXES.join(', ')})`);
        }
    }

    // source must be a known value (warn only)
    const source = event.source;
    if (source && !VALID_SOURCES.has(source)) {
        errors.push(`Unknown source: "${source}"`);
    }

    // timestamp / ts_epoch_ms must be a reasonable number
    const ts = event.timestamp ?? event.ts_epoch_ms;
    if (ts !== undefined && (typeof ts !== 'number' || ts < 0)) {
        errors.push(`Invalid timestamp: ${ts}`);
    }

    return { valid: errors.length === 0, errors };
}

// ── Legacy alias mapping ──────────────────────────────────────────────────────
// Old extension sends 'type' instead of 'event_type', 'ts_epoch_ms' instead of 'timestamp'.
function legacyAlias(field) {
    const map = {
        event_type: 'type',
        timestamp: 'ts_epoch_ms',
        session_id: 'session_id', // same in both
    };
    return map[field] || field;
}

// ── Enrich ────────────────────────────────────────────────────────────────────
/**
 * Normalise a raw event (old or new format) into the canonical v2 schema.
 * Always safe to call — fills defaults, never throws.
 *
 * @param {object} rawEvent
 * @param {string} sessionId  — authoritative session ID (from URL path parameter)
 * @returns {object} enriched event in canonical form
 */
function enrich(rawEvent, sessionId) {
    const now = Date.now();

    // Resolve fields with legacy aliases
    const eventType  = getEventType(rawEvent) || 'system.unknown';
    const timestamp  = rawEvent.timestamp  ?? rawEvent.ts_epoch_ms ?? now;
    const source     = rawEvent.source     || 'system';
    const data       = rawEvent.data       || {};

    return {
        // Canonical fields
        event_id:          rawEvent.event_id || uuidv4(),
        session_id:        sessionId,                          // server is authoritative
        timestamp,
        event_type:        eventType,
        source,
        correlation_id:    rawEvent.correlation_id    || null,
        parent_action_id:  rawEvent.parent_action_id  || null,
        schema_version:    CURRENT_SCHEMA_VERSION,             // server stamps this

        // Payload
        data,

        // Legacy compatibility fields (kept so existing readers don't break)
        type:              eventType,
        ts_epoch_ms:       timestamp,
        tab_id:            rawEvent.tab_id || null,
        url:               rawEvent.url    || null,
    };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
/**
 * Returns true if two events are considered duplicates (same event_id,
 * same session, same type, same timestamp — matching any is sufficient
 * for conservative dedup).
 */
function isDuplicate(a, b) {
    if (a.event_id && b.event_id && a.event_id === b.event_id) return true;
    return false;
}

module.exports = {
    CURRENT_SCHEMA_VERSION,
    VALID_SOURCES,
    VALID_TYPE_PREFIXES,
    validate,
    enrich,
    isDuplicate,
};
