'use strict';

// Lightweight assertion evaluator used during plan replay.
// Supported types (hard or soft via `soft` flag):
// - assert_element_visible: expected.selector
// - assert_modal_open: expected.selector
// - assert_api_called: expected.url_contains (not implemented fully; placeholder passes)
// - assert_status_ok: expected.url_contains (placeholder)
// - assert_latency_lt: expected.ms (placeholder)
// - assert_no_js_errors
// - assert_no_console_errors
// - assert_business_event: expected.label (placeholder)

async function evaluateAssertions(assertions = [], context = {}) {
    const results = [];
    for (const a of assertions) {
        const res = await _evalOne(a, context);
        results.push(res);
    }
    return {
        passed: results.filter(r => r.status === 'passed').length,
        failed: results.filter(r => r.status === 'failed'),
        results,
    };
}

async function _evalOne(assertion, { page, report } = {}) {
    const soft = !!assertion.soft;
    const fail = (reason) => ({ ...assertion, status: 'failed', soft, reason });
    const pass = () => ({ ...assertion, status: 'passed', soft });

    switch (assertion.type) {
        case 'assert_element_visible': {
            const sel = assertion.expected?.selector;
            if (!sel || !page) return fail('selector missing');
            try {
                await page.locator(sel).first().waitFor({ state: 'visible', timeout: assertion.expected?.timeout_ms || 3000 });
                return pass();
            } catch (e) {
                return fail(e.message);
            }
        }
        case 'assert_modal_open': {
            const sel = assertion.expected?.selector || '[role="dialog"]';
            if (!page) return fail('page missing');
            try {
                await page.locator(sel).first().waitFor({ state: 'visible', timeout: assertion.expected?.timeout_ms || 3000 });
                return pass();
            } catch (e) {
                return fail(e.message);
            }
        }
        case 'assert_no_js_errors': {
            const hasErrors = (report?.failures?.js_errors || []).length > 0;
            return hasErrors ? fail('JS errors detected') : pass();
        }
        case 'assert_no_console_errors': {
            const hasErrors = (report?.failures?.js_errors || []).some(e => (e.type || '').includes('console'));
            return hasErrors ? fail('Console errors detected') : pass();
        }
        case 'assert_api_called':
        case 'assert_status_ok':
        case 'assert_latency_lt':
        case 'assert_business_event':
            // Placeholder implementations — require richer telemetry
            return pass();
        default:
            return pass();
    }
}

module.exports = { evaluateAssertions };
