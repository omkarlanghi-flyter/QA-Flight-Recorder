/**
 * test_ingestion.js — Unit tests for schema.js and ingestion.js
 *
 * Run: node test_ingestion.js
 */
'use strict';

const assert = require('assert');
const os     = require('os');
const path   = require('path');
const fs     = require('fs');

const { validate, enrich, isDuplicate, CURRENT_SCHEMA_VERSION } = require('./ingestion/schema');
const { createIngestionContext } = require('./ingestion/ingestion');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ❌ ${name}`);
        console.error(`     ${err.message}`);
        failed++;
    }
}

// ── Schema Tests ──────────────────────────────────────────────────────────────
console.log('\n── schema.js ─────────────────────────────────────────────────────');

test('validate() accepts a valid canonical event', () => {
    const { valid, errors } = validate({
        session_id: 'sess-123',
        event_type: 'action.click',
        source: 'content',
        timestamp: Date.now(),
        data: { selector: 'button' },
    });
    assert.strictEqual(valid, true, `Expected valid but got errors: ${errors.join(', ')}`);
});

test('validate() accepts a valid legacy event (type / ts_epoch_ms fields)', () => {
    const { valid, errors } = validate({
        session_id: 'sess-123',
        event_type: 'network.response',  // enrich sets this from legacy 'type'
        source: 'cdp',
    });
    assert.strictEqual(valid, true, `Expected valid but got errors: ${errors.join(', ')}`);
});

test('validate() rejects event missing session_id', () => {
    const { valid, errors } = validate({
        event_type: 'action.click',
        source: 'content',
    });
    assert.strictEqual(valid, false);
    assert.ok(errors.some(e => e.includes('session_id')), `Expected session_id error, got: ${errors}`);
});

test('validate() rejects event missing event_type', () => {
    const { valid } = validate({ session_id: 'sess-123', source: 'content' });
    assert.strictEqual(valid, false);
});

test('enrich() auto-generates event_id when absent', () => {
    const enriched = enrich({ type: 'action.click', source: 'content' }, 'sess-abc');
    assert.ok(enriched.event_id, 'event_id should be generated');
    assert.match(enriched.event_id, /^[0-9a-f-]{36}$/, 'event_id should be a UUID');
});

test('enrich() stamps server-authoritative session_id (ignores client value)', () => {
    const enriched = enrich({ session_id: 'wrong-id', type: 'action.click' }, 'correct-id');
    assert.strictEqual(enriched.session_id, 'correct-id');
});

test('enrich() stamps schema_version from CURRENT_SCHEMA_VERSION constant', () => {
    const enriched = enrich({ type: 'action.click' }, 'sess-1');
    assert.strictEqual(enriched.schema_version, CURRENT_SCHEMA_VERSION);
});

test('enrich() maps legacy type/ts_epoch_ms to canonical event_type/timestamp', () => {
    const ts = Date.now();
    const enriched = enrich({ type: 'action.scroll', ts_epoch_ms: ts, source: 'content' }, 'sess-1');
    assert.strictEqual(enriched.event_type, 'action.scroll');
    assert.strictEqual(enriched.timestamp, ts);
    // Legacy fields still present for compat
    assert.strictEqual(enriched.type, 'action.scroll');
    assert.strictEqual(enriched.ts_epoch_ms, ts);
});

test('enrich() preserves correlation_id when provided', () => {
    const enriched = enrich({ type: 'network.response', correlation_id: 'evt-999' }, 'sess-1');
    assert.strictEqual(enriched.correlation_id, 'evt-999');
});

test('isDuplicate() detects same event_id', () => {
    const a = enrich({ type: 'action.click', event_id: 'dup-id-1' }, 'sess-1');
    const b = enrich({ type: 'action.click', event_id: 'dup-id-1' }, 'sess-1');
    assert.strictEqual(isDuplicate(a, b), true);
});

test('isDuplicate() passes different event_ids as distinct', () => {
    const a = enrich({ type: 'action.click' }, 'sess-1');
    const b = enrich({ type: 'action.click' }, 'sess-1');
    assert.strictEqual(isDuplicate(a, b), false);
});

// ── Ingestion Tests ───────────────────────────────────────────────────────────
console.log('\n── ingestion.js ──────────────────────────────────────────────────');

// Use a temp directory for ingestion tests
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ingestion-test-'));
const rawDir  = path.join(tmpDir, 'raw');
fs.mkdirSync(rawDir, { recursive: true });

// Minimal mock db (only needs indexEventsBatch)
const mockDb = { indexEventsBatch: () => {} };

test('ingest() accepts a valid event and writes to NDJSON', () => {
    const ctx = createIngestionContext('sess-test-1', tmpDir, mockDb);
    const result = ctx.ingest([{
        event_type: 'action.click',
        source: 'content',
        data: { selector: 'button' },
    }]);
    assert.strictEqual(result.accepted, 1);
    assert.strictEqual(result.rejected, 0);
    assert.strictEqual(result.duplicates, 0);

    const eventsFile = path.join(tmpDir, 'raw', 'events.ndjson');
    assert.ok(fs.existsSync(eventsFile), 'events.ndjson should be created');
    const lines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 1);
    const written = JSON.parse(lines[0]);
    assert.strictEqual(written.event_type, 'action.click');
    assert.strictEqual(written.schema_version, CURRENT_SCHEMA_VERSION);
    assert.ok(written.event_id, 'event_id should be stamped');
});

test('ingest() deduplicates events with the same event_id', () => {
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ingestion-dedup-'));
    const ctx = createIngestionContext('sess-dedup', tmpDir2, mockDb);
    const sameId = 'fixed-event-id-1234';

    const evt = { event_type: 'action.click', source: 'content', event_id: sameId, data: {} };

    const r1 = ctx.ingest([evt]);
    const r2 = ctx.ingest([evt]); // identical event_id

    assert.strictEqual(r1.accepted, 1, 'First ingest: 1 accepted');
    assert.strictEqual(r2.accepted, 0, 'Second ingest: 0 accepted (duplicate)');
    assert.strictEqual(r2.duplicates, 1, 'Second ingest: 1 duplicate');

    // NDJSON should contain exactly ONE line
    const eventsFile = path.join(tmpDir2, 'raw', 'events.ndjson');
    const lines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1, 'Only 1 event written despite 2 ingest calls');
    ctx.destroy();
});

test('ingest() handles mixed valid/invalid batch', () => {
    const tmpDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ingestion-mixed-'));
    const ctx = createIngestionContext('sess-mixed', tmpDir3, mockDb);

    const validEvent = { event_type: 'action.click', source: 'content', data: {} };
    // Use an invalid timestamp to trigger a validation error
    const invalidEvent = { event_type: 'action.click', source: 'content', timestamp: -99 };

    const result = ctx.ingest([validEvent, invalidEvent]);
    // Both are enriched with session_id by the server, but invalidEvent has a bad timestamp
    assert.strictEqual(result.accepted, 1, `Expected 1 accepted. Got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.rejected, 1, `Expected 1 rejected. Got: ${JSON.stringify(result)}`);
    assert.ok(result.errors.length > 0, 'Expected at least one error message');
    ctx.destroy();
});

test('ingest() accepts legacy events (type / ts_epoch_ms) without rejection', () => {
    const tmpDir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ingestion-legacy-'));
    const ctx = createIngestionContext('sess-legacy', tmpDir4, mockDb);

    const legacyEvent = {
        // Old extension format
        type: 'action.click',
        ts_epoch_ms: Date.now(),
        source: 'content',
        tab_id: 1,
        data: { selector: '#btn' },
    };

    const result = ctx.ingest([legacyEvent]);
    assert.strictEqual(result.accepted, 1, `Legacy event should be accepted. Errors: ${result.errors.join(', ')}`);
    ctx.destroy();
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n═══════════════════════════════════════════`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
} else {
    console.log('All ingestion tests passed! ✅');
}
