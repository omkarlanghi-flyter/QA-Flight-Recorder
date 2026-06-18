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

function _toNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function _normalizeText(v) {
    return String(v || '').toLowerCase();
}

function _matchesUrl(url, expected = {}) {
    const u = String(url || '');
    if (!u) return false;

    if (expected.url_equals && u !== String(expected.url_equals)) return false;
    if (expected.url_contains && !u.includes(String(expected.url_contains))) return false;
    if (expected.path_contains) {
        try {
            const p = new URL(u).pathname;
            if (!p.includes(String(expected.path_contains))) return false;
        } catch {
            if (!u.includes(String(expected.path_contains))) return false;
        }
    }
    if (expected.url_regex) {
        try {
            const re = new RegExp(String(expected.url_regex));
            if (!re.test(u)) return false;
        } catch {
            return false;
        }
    }
    return true;
}

function _networkEvents(report, stepReport) {
    const all = report?.runtime?.network_events || [];
    if (!stepReport?.index) return all;
    const scoped = all.filter(e => e.step_index === stepReport.index);
    return scoped.length > 0 ? scoped : all;
}

function _consoleEvents(report, stepReport) {
    const all = report?.runtime?.console_events || [];
    if (!stepReport?.index) return all;
    const scoped = all.filter(e => e.step_index === stepReport.index);
    return scoped.length > 0 ? scoped : all;
}

function _isOkStatus(status, expected = {}) {
    const s = Number(status);
    if (!Number.isFinite(s)) return false;

    if (Array.isArray(expected.statuses) && expected.statuses.length > 0) {
        return expected.statuses.map(Number).includes(s);
    }
    if (expected.status !== undefined) {
        return s === Number(expected.status);
    }
    if (expected.status_range === '2xx') {
        return s >= 200 && s < 300;
    }
    return s < 400;
}

async function _evalOne(assertion, { page, report, stepReport } = {}) {
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
        case 'assert_toast': {
            if (!page) return fail('page missing');
            const exp = assertion.expected || {};
            const selectors = [
                exp.selector,
                exp.role ? `[role="${exp.role}"]` : null,
                exp.class ? `.${String(exp.class).trim().replace(/\s+/g, '.')}` : null,
                '[role="alert"]',
                '[role="status"]',
                '.toast',
            ].filter(Boolean);
            try {
                const timeout = exp.timeout_ms || 3000;
                for (const sel of selectors) {
                    const loc = page.locator(sel).first();
                    try {
                        await loc.waitFor({ state: 'visible', timeout });
                        if (exp.text) {
                            const t = await loc.innerText().catch(() => '');
                            if (!_normalizeText(t).includes(_normalizeText(exp.text))) {
                                continue;
                            }
                        }
                        return pass();
                    } catch {
                        // try next selector
                    }
                }
                return fail('toast/alert not found');
            } catch (e) {
                return fail(e.message);
            }
        }
        case 'assert_modal_closed': {
            if (!page) return fail('page missing');
            const sel = assertion.expected?.selector || '[role="dialog"]';
            try {
                await page.locator(sel).first().waitFor({ state: 'hidden', timeout: assertion.expected?.timeout_ms || 3000 });
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
        case 'assert_no_net_failure': {
            const maxFailures = _toNum(assertion.expected?.max_failures);
            const threshold = maxFailures === null ? 0 : maxFailures;
            const net = _networkEvents(report, stepReport);
            const failures = net.filter(e => e.kind === 'failure' || (e.kind === 'response' && Number(e.status) >= 400));
            return failures.length > threshold
                ? fail(`network failures ${failures.length} exceeded ${threshold}`)
                : pass();
        }
        case 'assert_api_called': {
            const exp = assertion.expected || {};
            const method = exp.method ? String(exp.method).toUpperCase() : null;
            const net = _networkEvents(report, stepReport);
            const matches = net.filter(e => {
                if (!['request', 'response', 'failure'].includes(e.kind)) return false;
                if (method && String(e.method || '').toUpperCase() !== method) return false;
                return _matchesUrl(e.url, exp);
            });
            return matches.length > 0
                ? pass()
                : fail(`expected API call not observed${exp.url_contains ? ` for ${exp.url_contains}` : ''}`);
        }
        case 'assert_status_ok':
        case 'assert_api_success': {
            const exp = assertion.expected || {};
            const net = _networkEvents(report, stepReport);
            const responses = net.filter(e => e.kind === 'response' && _matchesUrl(e.url, exp));
            if (responses.length === 0) {
                return fail('no matching HTTP response observed');
            }
            const bad = responses.filter(r => !_isOkStatus(r.status, exp));
            if (bad.length > 0) {
                return fail(`unexpected HTTP status: ${bad.map(b => b.status).join(', ')}`);
            }
            return pass();
        }
        case 'assert_latency_lt': {
            const exp = assertion.expected || {};
            const maxMs = _toNum(exp.ms ?? exp.max_ms);
            if (maxMs === null) return fail('expected.ms is required');
            const net = _networkEvents(report, stepReport);
            const durations = net
                .filter(e => ['response', 'failure'].includes(e.kind) && _matchesUrl(e.url, exp))
                .map(e => _toNum(e.duration_ms))
                .filter(v => v !== null);
            if (durations.length === 0) {
                return fail('no latency telemetry for matching request');
            }
            const worst = Math.max(...durations);
            return worst < maxMs ? pass() : fail(`latency ${worst}ms exceeds ${maxMs}ms`);
        }
        case 'assert_business_event': {
            const exp = assertion.expected || {};
            const label = exp.label || exp.text || exp.event || null;
            if (!label && !exp.regex) return fail('expected.label or expected.regex required');
            const logs = _consoleEvents(report, stepReport).map(e => String(e.message || ''));

            let matched = false;
            if (label) {
                const needle = _normalizeText(label);
                matched = logs.some(m => _normalizeText(m).includes(needle));
            }
            if (!matched && exp.regex) {
                try {
                    const re = new RegExp(String(exp.regex));
                    matched = logs.some(m => re.test(m));
                } catch {
                    return fail('invalid expected.regex');
                }
            }
            return matched ? pass() : fail('expected business event not found in runtime logs');
        }
        case 'assert_url_changed': {
            if (!page) return fail('page missing');
            const exp = assertion.expected || {};
            const currentUrl = page.url();
            if (exp.url) {
                return currentUrl.includes(String(exp.url))
                    ? pass()
                    : fail(`expected URL to include ${exp.url}, got ${currentUrl}`);
            }
            return currentUrl && currentUrl !== 'about:blank'
                ? pass()
                : fail('URL did not change from blank state');
        }
        default:
            return pass();
    }
}

module.exports = { evaluateAssertions };
