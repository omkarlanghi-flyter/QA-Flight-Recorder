/**
 * test_replay_accounting.js — Reliability Step 1 tests
 *
 * Run: node test_replay_accounting.js
 */
'use strict';

const assert = require('assert');
const { ReplayEngine } = require('./engine/replay');

function makeFakePage() {
  let closed = false;
  return {
    isClosed: () => closed,
    close: async () => { closed = true; },
    bringToFront: async () => {},
  };
}

function wireFakeBrowser(engine) {
  const page = makeFakePage();
  const context = {
    newPage: async () => page,
    pages: () => [page],
    on: () => {},
  };
  const browser = {
    contexts: () => [context],
    disconnect: async () => {},
  };

  engine._ensureBrowser = async function ensureBrowserFake() {
    this.browser = browser;
  };
  engine._attachListeners = () => {};
}

function makeActionEvent(type, ts) {
  return {
    type,
    source: 'content',
    ts_epoch_ms: ts,
    data: { selector: '#btn' },
  };
}

const tests = [
  {
    name: 'single-step success: summary counts are correct',
    fn: async () => {
      const events = [makeActionEvent('action.click', Date.now())];
      const engine = new ReplayEngine(events, {});
      wireFakeBrowser(engine);
      engine._runStepWithRetry = async () => ({ ok: true, attempts: 1 });

      const report = await engine.run();
      assert.strictEqual(report.summary.total_steps, 1);
      assert.strictEqual(report.summary.passed, 1);
      assert.strictEqual(report.summary.failed, 0);
      assert.strictEqual(report.summary.passed + report.summary.failed, report.summary.total_steps);
    },
  },
  {
    name: 'retry success: attempts tracked, pass counted once',
    fn: async () => {
      const events = [makeActionEvent('action.click', Date.now())];
      const engine = new ReplayEngine(events, {});
      wireFakeBrowser(engine);
      engine._runStepWithRetry = async () => ({ ok: true, attempts: 2 });

      const report = await engine.run();
      assert.strictEqual(report.summary.total_steps, 1);
      assert.strictEqual(report.summary.passed, 1);
      assert.strictEqual(report.summary.failed, 0);
      assert.strictEqual(report.steps[0].attempts, 2);
      assert.strictEqual(report.steps[0].retry_count, 1);
      assert.strictEqual(report.summary.passed + report.summary.failed, report.summary.total_steps);
    },
  },
  {
    name: 'mixed pass/fail: one pass and one fail are counted correctly',
    fn: async () => {
      const now = Date.now();
      const events = [
        makeActionEvent('action.click', now),
        makeActionEvent('action.input', now + 1),
      ];
      const engine = new ReplayEngine(events, {});
      wireFakeBrowser(engine);

      const outcomes = [
        { ok: true, attempts: 1 },
        { ok: false, error: new Error('step failed'), attempts: 2 },
      ];
      let idx = 0;
      engine._runStepWithRetry = async () => outcomes[idx++];

      const report = await engine.run();
      assert.strictEqual(report.summary.total_steps, 2);
      assert.strictEqual(report.summary.passed, 1);
      assert.strictEqual(report.summary.failed, 1);
      assert.strictEqual(report.steps.length, 2);
      assert.strictEqual(report.summary.passed + report.summary.failed, report.summary.total_steps);
    },
  },
  {
    name: '_executeStep does not mutate summary counters directly',
    fn: async () => {
      const engine = new ReplayEngine([], {});
      engine.report.summary = { total_steps: 0, passed: 0, failed: 0 };
      await engine._executeStep({ type: 'action.unknown', data: {} }, {}, 1, 0);
      assert.strictEqual(engine.report.summary.passed, 0);
      assert.strictEqual(engine.report.summary.failed, 0);
    },
  },
];

async function main() {
  let passed = 0;
  let failed = 0;
  console.log('\n-- replay accounting (Step 1) ------------------------------------');

  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  [PASS] ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  [FAIL] ${t.name}`);
      console.error(`         ${err.message}`);
      failed++;
    }
  }

  console.log('\n===================================================');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log('Replay accounting tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
