/**
 * test_normalization.js — Smoke tests for the normalization pipeline
 *
 * Run: node test_normalization.js
 */
'use strict';

const assert = require('assert');
const os     = require('os');
const path   = require('path');
const fs     = require('fs');

const { groupEvents }       = require('./normalization/event_grouper');
const { buildSteps }        = require('./normalization/step_builder');
const { attachAssertions }  = require('./normalization/assertion_extractor');
const { normalize }         = require('./normalization/normalizer');

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

// ── Synthetic event factory ───────────────────────────────────────────────────
let _ts = 1000000;
function makeEvt(type, data = {}, tsOffset = 0) {
    _ts += 500 + tsOffset;
    return { event_type: type, type, source: 'content', timestamp: _ts, ts_epoch_ms: _ts, data };
}

// ── event_grouper Tests ───────────────────────────────────────────────────────
console.log('\n── event_grouper.js ──────────────────────────────────────────────');

test('groupEvents() returns empty array for empty input', () => {
    const groups = groupEvents([]);
    assert.deepStrictEqual(groups, []);
});

test('groupEvents() groups a navigation event', () => {
    const events = [makeEvt('action.navigation', { from_url: '/a', to_url: '/b' })];
    const groups = groupEvents(events);
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].group_type, 'navigate');
    assert.strictEqual(groups[0].meta.to_url, '/b');
});

test('groupEvents() groups two clicks as separate groups', () => {
    const events = [
        makeEvt('action.click', { selector: '#btn1', text_snippet: 'Save' }),
        makeEvt('action.click', { selector: '#btn2', text_snippet: 'Cancel' }),
    ];
    const groups = groupEvents(events);
    const clickGroups = groups.filter(g => g.group_type === 'click' || g.group_type === 'open_modal');
    assert.strictEqual(clickGroups.length, 2);
});

test('groupEvents() groups consecutive inputs into a fill group', () => {
    const events = [
        makeEvt('action.input', { selector: 'input[name=email]', final_value: 'test@example.com', input_type: 'email' }),
        makeEvt('action.input', { selector: 'input[name=password]', final_value: '***', input_type: 'password', is_sensitive: true }),
    ];
    const groups = groupEvents(events);
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].group_type, 'fill');
    assert.strictEqual(groups[0].meta.fields.length, 2);
});

test('groupEvents() detects form_submit when input followed by Enter keydown', () => {
    const events = [
        makeEvt('action.input', { selector: 'input[name=q]', final_value: 'hello', input_type: 'text' }),
        makeEvt('action.keydown', { key: 'Enter' }),
    ];
    const groups = groupEvents(events);
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].group_type, 'form_submit');
});

test('groupEvents() detects open_modal when click is followed by dom.state_change with dialog role', () => {
    const events = [
        makeEvt('action.click', { selector: '#open-modal-btn', text_snippet: 'Open' }),
        makeEvt('dom.state_change', { added: [{ tag: 'div', role: 'dialog', class: 'modal', text: 'My Dialog' }], removed: [] }),
    ];
    const groups = groupEvents(events);
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].group_type, 'open_modal');
});

test('groupEvents() attaches correlated network events to groups', () => {
    const clickTs = _ts + 600;
    const events = [
        makeEvt('action.click', { selector: '#submit' }),
        // Network response fires ~400ms after click (within correlation window)
        { event_type: 'network.response', type: 'network.response', source: 'cdp',
          timestamp: clickTs + 400, ts_epoch_ms: clickTs + 400,
          data: { status: 200, url_sanitized: 'http://api.example.com/login' } },
    ];
    const groups = groupEvents(events);
    const clickGroup = groups.find(g => g.group_type === 'click' || g.group_type === 'open_modal');
    assert.ok(clickGroup, 'Expected a click group');
    assert.ok(Array.isArray(clickGroup.context_events), 'context_events should be an array');
    // Network event should be in context
    assert.ok(clickGroup.context_events.some(e => (e.event_type || e.type) === 'network.response'),
        'Network response should be attached as context event');
});

// ── step_builder Tests ────────────────────────────────────────────────────────
console.log('\n── step_builder.js ───────────────────────────────────────────────');

test('buildSteps() produces one step per navigation group', () => {
    const groups = [
        { group_type: 'navigate', events: [], start_ts: 1000, end_ts: 1000, meta: { to_url: '/dashboard', from_url: '/' } },
        { group_type: 'navigate', events: [], start_ts: 2000, end_ts: 2000, meta: { to_url: '/settings', from_url: '/dashboard' } },
    ];
    const steps = buildSteps(groups);
    assert.strictEqual(steps.length, 2);
    assert.strictEqual(steps[0].step_type, 'navigate');
    assert.strictEqual(steps[0].url, '/dashboard');
    assert.strictEqual(steps[0].step_id, 'step_1');
    assert.strictEqual(steps[1].step_id, 'step_2');
});

test('buildSteps() produces fill_field step with selector and value', () => {
    const groups = [{
        group_type: 'fill',
        events: [],
        start_ts: 1000, end_ts: 1200,
        meta: {
            fields: [{ selector: 'input[name=email]', value: 'test@example.com', input_type: 'email', is_sensitive: false }]
        }
    }];
    const steps = buildSteps(groups);
    assert.strictEqual(steps.length, 1);
    assert.strictEqual(steps[0].step_type, 'fill_field');
    assert.strictEqual(steps[0].selector, 'input[name=email]');
    assert.strictEqual(steps[0].value, 'test@example.com');
});

test('buildSteps() produces submit_form step', () => {
    const groups = [{
        group_type: 'form_submit',
        events: [],
        start_ts: 1000, end_ts: 1500,
        meta: {
            fields: [{ selector: 'input[name=q]', value: 'hello', input_type: 'text', is_sensitive: false }]
        }
    }];
    const steps = buildSteps(groups);
    assert.strictEqual(steps[0].step_type, 'submit_form');
});

test('buildSteps() labels are human-readable strings', () => {
    const groups = [
        { group_type: 'click', events: [], start_ts: 1000, end_ts: 1000, meta: { selector: '#btn', text_snippet: 'Submit', tag: 'button' } },
        { group_type: 'scroll', events: [], start_ts: 2000, end_ts: 2000, meta: { final_scrollY: 500 } },
    ];
    const steps = buildSteps(groups);
    assert.ok(steps[0].label.includes('Submit'), `Expected label to contain "Submit", got: ${steps[0].label}`);
    assert.ok(steps[1].label.includes('500'), `Expected scroll label to mention y=500, got: ${steps[1].label}`);
});

// ── assertion_extractor Tests ─────────────────────────────────────────────────
console.log('\n── assertion_extractor.js ────────────────────────────────────────');

test('attachAssertions() adds assert_toast when toast DOM change follows step', () => {
    const toastTs = 2000;
    const step = { step_id: 'step_1', step_type: 'click', start_ts: 1000, end_ts: 1500 };
    const group = {
        group_type: 'click',
        context_events: [{
            event_type: 'dom.state_change', type: 'dom.state_change',
            timestamp: toastTs, ts_epoch_ms: toastTs,
            data: { added: [{ role: 'alert', class: 'toast success', text: 'Saved!' }], removed: [] }
        }]
    };
    attachAssertions([step], [group]);
    assert.ok(Array.isArray(step.assertions), 'assertions should be an array');
    const toast = step.assertions.find(a => a.type === 'assert_toast');
    assert.ok(toast, `Expected assert_toast, got: ${JSON.stringify(step.assertions)}`);
    assert.strictEqual(toast.expected.variant, 'success');
    assert.strictEqual(toast.soft, false);
});

test('attachAssertions() adds assert_modal_open when dialog DOM change follows step', () => {
    const step = { step_id: 'step_1', step_type: 'click', start_ts: 1000, end_ts: 1500 };
    const group = {
        group_type: 'click',
        context_events: [{
            event_type: 'dom.state_change', type: 'dom.state_change',
            timestamp: 1600, ts_epoch_ms: 1600,
            data: { added: [{ role: 'dialog', class: 'modal-overlay', text: '' }], removed: [] }
        }]
    };
    attachAssertions([step], [group]);
    const modal = step.assertions.find(a => a.type === 'assert_modal_open');
    assert.ok(modal, 'Expected assert_modal_open');
});

test('attachAssertions() adds assert_no_js_errors (soft) when no errors in context', () => {
    const step = { step_id: 'step_1', step_type: 'navigate', start_ts: 1000, end_ts: 2000 };
    // context has only a successful network response (no errors)
    const group = {
        group_type: 'navigate',
        context_events: [{
            event_type: 'network.response', type: 'network.response',
            timestamp: 1500, ts_epoch_ms: 1500,
            data: { status: 200, url_sanitized: 'http://api/data' }
        }]
    };
    attachAssertions([step], [group]);
    const noErrors = step.assertions.find(a => a.type === 'assert_no_js_errors');
    assert.ok(noErrors, 'Expected assert_no_js_errors');
    assert.strictEqual(noErrors.soft, true);
});

// ── Full Pipeline Smoke Test ──────────────────────────────────────────────────
console.log('\n── normalize() full pipeline ─────────────────────────────────────');

test('normalize() runs on a synthetic session dir end-to-end', () => {
    // Create a temp session directory with a synthetic events.ndjson
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-norm-smoke-'));
    fs.mkdirSync(path.join(sessionDir, 'raw'), { recursive: true });

    const events = [
        { event_type: 'action.navigation', type: 'action.navigation', source: 'browser',
          timestamp: 100000, ts_epoch_ms: 100000, data: { from_url: '/', to_url: '/login' } },
        { event_type: 'action.input', type: 'action.input', source: 'content',
          timestamp: 101000, ts_epoch_ms: 101000, data: { selector: 'input[name=email]', final_value: 'test@example.com', input_type: 'email' } },
        { event_type: 'action.input', type: 'action.input', source: 'content',
          timestamp: 102000, ts_epoch_ms: 102000, data: { selector: 'input[name=password]', final_value: '***', input_type: 'password', is_sensitive: true } },
        { event_type: 'action.keydown', type: 'action.keydown', source: 'content',
          timestamp: 102800, ts_epoch_ms: 102800, data: { key: 'Enter' } },
        { event_type: 'dom.state_change', type: 'dom.state_change', source: 'content',
          timestamp: 103500, ts_epoch_ms: 103500, data: { added: [{ role: 'alert', class: 'toast success', text: 'Login successful' }], removed: [] } },
        { event_type: 'action.navigation', type: 'action.navigation', source: 'browser',
          timestamp: 104000, ts_epoch_ms: 104000, data: { from_url: '/login', to_url: '/dashboard' } },
    ];

    const ndjson = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(path.join(sessionDir, 'raw', 'events.ndjson'), ndjson, 'utf8');

    const result = normalize(sessionDir);

    assert.ok(result.step_count > 0, `Expected at least 1 step, got ${result.step_count}`);
    assert.ok(Array.isArray(result.steps), 'steps should be an array');

    // Should have at least the two navigation steps
    const navSteps = result.steps.filter(s => s.step_type === 'navigate');
    assert.ok(navSteps.length >= 1, `Expected ≥1 navigate step, got ${navSteps.length}`);

    // Should have a form_submit step (inputs + Enter)
    const submitStep = result.steps.find(s => s.step_type === 'submit_form');
    assert.ok(submitStep, 'Expected a submit_form step from inputs + Enter sequence');

    // normalized.json should be written
    assert.ok(fs.existsSync(path.join(sessionDir, 'normalized.json')), 'normalized.json should be written');

    // Step type summary should be present
    assert.ok(typeof result.step_type_summary === 'object', 'step_type_summary should be an object');
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n═══════════════════════════════════════════`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
} else {
    console.log('All normalization tests passed! ✅');
}
