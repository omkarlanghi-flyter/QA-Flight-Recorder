'use strict';

const assert = require('assert');
const { evaluateAssertions } = require('./engine/assertions');

const baseContext = {
  report: {
    failures: { js_errors: [], network: [], ui: [] },
    runtime: {
      network_events: [
        { kind: 'request', method: 'POST', url: 'https://api.example.com/login', step_index: 1, ts_epoch_ms: Date.now() - 120 },
        { kind: 'response', method: 'POST', url: 'https://api.example.com/login', status: 200, duration_ms: 120, step_index: 1, ts_epoch_ms: Date.now() - 10 },
        { kind: 'response', method: 'GET', url: 'https://api.example.com/profile', status: 503, duration_ms: 45, step_index: 2, ts_epoch_ms: Date.now() - 5 },
      ],
      console_events: [
        { type: 'info', message: 'BUSINESS_EVENT: user_logged_in', step_index: 1, ts_epoch_ms: Date.now() - 8 },
      ],
    },
  },
};

const tests = [
  {
    name: 'assert_api_called passes when URL/method match',
    fn: async () => {
      const out = await evaluateAssertions([
        { type: 'assert_api_called', expected: { url_contains: '/login', method: 'POST' }, soft: false },
      ], { ...baseContext, stepReport: { index: 1 } });
      assert.strictEqual(out.failed.length, 0);
      assert.strictEqual(out.results[0].status, 'passed');
    },
  },
  {
    name: 'assert_status_ok fails for matching 5xx response',
    fn: async () => {
      const out = await evaluateAssertions([
        { type: 'assert_status_ok', expected: { url_contains: '/profile' }, soft: false },
      ], { ...baseContext, stepReport: { index: 2 } });
      assert.strictEqual(out.failed.length, 1);
      assert.strictEqual(out.results[0].status, 'failed');
    },
  },
  {
    name: 'assert_latency_lt passes when latency under threshold',
    fn: async () => {
      const out = await evaluateAssertions([
        { type: 'assert_latency_lt', expected: { url_contains: '/login', ms: 200 }, soft: false },
      ], { ...baseContext, stepReport: { index: 1 } });
      assert.strictEqual(out.failed.length, 0);
      assert.strictEqual(out.results[0].status, 'passed');
    },
  },
  {
    name: 'assert_business_event passes when label appears in runtime logs',
    fn: async () => {
      const out = await evaluateAssertions([
        { type: 'assert_business_event', expected: { label: 'user_logged_in' }, soft: false },
      ], { ...baseContext, stepReport: { index: 1 } });
      assert.strictEqual(out.failed.length, 0);
      assert.strictEqual(out.results[0].status, 'passed');
    },
  },
];

async function main() {
  let passed = 0;
  let failed = 0;
  console.log('\n-- assertion evaluator tests ------------------------------------');

  for (const t of tests) {
    try {
      await t.fn();
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
  console.log('Assertion evaluator tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
