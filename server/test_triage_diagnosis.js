'use strict';

const assert = require('assert');
const analyzeTriageEventRule = require('./public/triage_diagnosis');

const tests = [
  {
    name: 'classifies network.failure as critical',
    fn: () => {
      const r = analyzeTriageEventRule({ type: 'network.failure', data: {} });
      assert.ok(r);
      assert.strictEqual(r.cls, 'critical');
    },
  },
  {
    name: 'classifies network.response 500 as critical',
    fn: () => {
      const r = analyzeTriageEventRule({ type: 'network.response', data: { status: 500 } });
      assert.ok(r);
      assert.strictEqual(r.cls, 'critical');
    },
  },
  {
    name: 'classifies network.response 401 as warning',
    fn: () => {
      const r = analyzeTriageEventRule({ type: 'network.response', data: { status: 401 } });
      assert.ok(r);
      assert.strictEqual(r.cls, 'warning');
    },
  },
  {
    name: 'classifies network.response 404 as warning',
    fn: () => {
      const r = analyzeTriageEventRule({ event_type: 'network.response', data: { status: 404 } });
      assert.ok(r);
      assert.strictEqual(r.cls, 'warning');
    },
  },
  {
    name: 'classifies network.response 422 as warning',
    fn: () => {
      const r = analyzeTriageEventRule({ type: 'network.response', data: { status: 422 } });
      assert.ok(r);
      assert.strictEqual(r.cls, 'warning');
    },
  },
  {
    name: 'does not classify network.request event',
    fn: () => {
      const r = analyzeTriageEventRule({ type: 'network.request', data: {} });
      assert.strictEqual(r, null);
    },
  },
  {
    name: 'classifies runtime.exception as critical',
    fn: () => {
      const r = analyzeTriageEventRule({ type: 'runtime.exception', data: {} });
      assert.ok(r);
      assert.strictEqual(r.cls, 'critical');
    },
  },
];

let passed = 0;
let failed = 0;

console.log('\n-- triage diagnosis tests ----------------------------------------');
for (const t of tests) {
  try {
    t.fn();
    passed++;
    console.log(`[PASS] ${t.name}`);
  } catch (err) {
    failed++;
    console.error(`[FAIL] ${t.name}`);
    console.error(`       ${err.message}`);
  }
}

console.log('\n===================================================');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('Triage diagnosis tests passed.');
