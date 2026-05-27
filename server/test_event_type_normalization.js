'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getEventType, normalizeEventType } = require('./event_type');
const { generateTriageView } = require('./filter');

function testGetEventType() {
  assert.strictEqual(getEventType({ event_type: 'network.response' }), 'network.response');
  assert.strictEqual(getEventType({ type: 'action.click' }), 'action.click');
  assert.strictEqual(getEventType({}), '');
}

function testNormalizeEventType() {
  const onlyEventType = normalizeEventType({ event_type: 'console.error', data: {} });
  assert.strictEqual(onlyEventType.type, 'console.error');
  assert.strictEqual(onlyEventType.event_type, 'console.error');

  const onlyType = normalizeEventType({ type: 'runtime.exception', data: {} });
  assert.strictEqual(onlyType.type, 'runtime.exception');
  assert.strictEqual(onlyType.event_type, 'runtime.exception');
}

function testTriageGenerationWithCanonicalOnlyEvents() {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-step3-event-type-'));
  fs.mkdirSync(path.join(sessionDir, 'raw'), { recursive: true });

  const now = Date.now();
  const events = [
    {
      event_type: 'action.click',
      ts_epoch_ms: now,
      timestamp: now,
      source: 'content',
      data: { selector: '#submit' },
    },
    {
      event_type: 'network.request',
      ts_epoch_ms: now + 10,
      timestamp: now + 10,
      source: 'cdp',
      data: { request_id: 'req-1', url_sanitized: 'https://api.example.com/login', method: 'POST' },
    },
    {
      event_type: 'network.response',
      ts_epoch_ms: now + 50,
      timestamp: now + 50,
      source: 'cdp',
      data: { request_id: 'req-1', status: 500, url_sanitized: 'https://api.example.com/login' },
    },
  ];

  fs.writeFileSync(path.join(sessionDir, 'raw', 'events.ndjson'), events.map(e => JSON.stringify(e)).join('\n') + '\n');

  const result = generateTriageView(sessionDir, []);
  assert.ok(result.triageEventCount >= 1);

  const triage = fs.readFileSync(path.join(sessionDir, 'views', 'triage_view.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l));

  assert.ok(triage.some(e => e.type === 'network.response'));
  assert.ok(triage.some(e => e.event_type === 'network.response'));
}

function main() {
  let passed = 0;
  let failed = 0;
  const tests = [
    ['getEventType resolves both fields', testGetEventType],
    ['normalizeEventType stamps type and event_type', testNormalizeEventType],
    ['triage generation works with canonical-only events', testTriageGenerationWithCanonicalOnlyEvents],
  ];

  console.log('\n-- event type normalization tests -------------------------------');
  for (const [name, fn] of tests) {
    try {
      fn();
      passed++;
      console.log(`[PASS] ${name}`);
    } catch (err) {
      failed++;
      console.error(`[FAIL] ${name}`);
      console.error(`       ${err.message}`);
    }
  }

  console.log('\n===================================================');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log('Event type normalization tests passed.');
}

main();
