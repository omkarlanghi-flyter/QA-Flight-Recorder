/**
 * assertion_extractor.js — Assertion Extractor
 *
 * Infers expected outcomes (assertions) from observable signals that occurred
 * AFTER each semantic step. These assertions are attached to the step and can
 * be used during replay to validate correctness.
 *
 * Assertion types:
 *   assert_toast          — a toast/alert appeared with specific text/role
 *   assert_modal_open     — a dialog/modal appeared
 *   assert_modal_closed   — a dialog/modal was removed from DOM
 *   assert_api_success    — a network call returned 2xx after this step
 *   assert_no_js_errors   — no console.error/runtime.exception within the window
 *   assert_no_net_failure — no network.failure within the window
 *   assert_url_changed    — page URL changed to a different path
 *
 * Each assertion has a `soft` flag:
 *   soft: false → hard failure if not met during replay
 *   soft: true  → warning only (does not fail the step)
 */

'use strict';

const ASSERTION_WINDOW_MS = 2500; // events within this ms window after step end are considered

function getType(evt) {
    return evt.event_type || evt.type || '';
}

function getTs(evt) {
    return evt.timestamp ?? evt.ts_epoch_ms ?? 0;
}

/**
 * Extract assertions for a single step by examining its context_events.
 *
 * @param {object} step         — semantic step (from step_builder.buildStep)
 * @param {object} group        — original action group with context_events
 * @returns {object[]} array of assertion objects
 */
function extractAssertionsForStep(step, group) {
    const assertions = [];
    const contextEvents = group.context_events || [];

    // Only look at events that occurred after this step started
    const stepEnd = step.end_ts || step.start_ts || 0;
    const windowEnd = stepEnd + ASSERTION_WINDOW_MS;

    const within = contextEvents.filter(e => {
        const ts = getTs(e);
        return ts >= step.start_ts && ts <= windowEnd;
    });

    // ── assert_toast ─────────────────────────────────────────────────────────
    const domChanges = within.filter(e => getType(e) === 'dom.state_change');
    for (const dc of domChanges) {
        const added = dc.data?.added || [];
        for (const node of added) {
            const isAlert =
                node.role === 'alert' || node.role === 'status' ||
                /toast|snackbar|notification/.test(node.class || '');
            if (isAlert) {
                const isSuccess = /success|done|saved|complete|ok/i.test(node.text || node.class || '');
                const isError   = /error|fail|invalid|wrong/i.test(node.text || node.class || '');
                assertions.push({
                    type: 'assert_toast',
                    expected: {
                        role:     node.role  || null,
                        class:    node.class || null,
                        text:     node.text  || null,
                        variant:  isSuccess ? 'success' : isError ? 'error' : 'info',
                    },
                    soft: false,
                });
            }

            // ── assert_modal_open ─────────────────────────────────────────────
            const isModal =
                node.role === 'dialog' ||
                /modal|dialog|overlay/.test(node.class || '');
            if (isModal) {
                assertions.push({
                    type: 'assert_modal_open',
                    expected: { role: node.role || null, class: node.class || null },
                    soft: false,
                });
            }
        }

        // ── assert_modal_closed ───────────────────────────────────────────────
        const removed = dc.data?.removed || [];
        for (const node of removed) {
            const wasModal =
                node.role === 'dialog' ||
                /modal|dialog/.test(node.role || '');
            if (wasModal) {
                assertions.push({
                    type: 'assert_modal_closed',
                    expected: { role: node.role || null },
                    soft: true, // soft: modal close might happen at different times
                });
            }
        }
    }

    // ── assert_api_success ────────────────────────────────────────────────────
    const networkResponses = within.filter(e => getType(e) === 'network.response');
    for (const nr of networkResponses) {
        const status = nr.data?.status;
        if (status && status >= 200 && status < 300) {
            const url = nr.data?.url_sanitized || nr.data?.url_full || nr.url;
            if (url && !_isStaticAsset(url)) {
                assertions.push({
                    type: 'assert_api_success',
                    expected: {
                        url_contains: _extractPath(url),
                        status_range: '2xx',
                    },
                    soft: true, // soft: API URL might change
                });
            }
        }
    }

    // ── assert_no_js_errors ───────────────────────────────────────────────────
    const jsErrors = within.filter(e =>
        getType(e) === 'console.error' || getType(e) === 'runtime.exception'
    );
    if (jsErrors.length === 0 && contextEvents.length > 0) {
        // Only add this when there were events to check (non-trivial window)
        assertions.push({
            type: 'assert_no_js_errors',
            expected: { max_errors: 0 },
            soft: true, // soft: pre-existing JS errors are noisy
        });
    }

    // ── assert_no_net_failure ─────────────────────────────────────────────────
    const netFailures = within.filter(e => getType(e) === 'network.failure');
    if (netFailures.length === 0 && networkResponses.length > 0) {
        assertions.push({
            type: 'assert_no_net_failure',
            expected: { max_failures: 0 },
            soft: false,
        });
    }

    return assertions;
}

/**
 * Attach assertions to each step given the corresponding groups.
 * Modifies steps in-place (adds `assertions` array).
 *
 * @param {object[]} steps   — from step_builder.buildSteps()
 * @param {object[]} groups  — from event_grouper.groupEvents()
 * @returns {object[]} same steps array with assertions attached
 */
function attachAssertions(steps, groups) {
    for (let i = 0; i < steps.length && i < groups.length; i++) {
        steps[i].assertions = extractAssertionsForStep(steps[i], groups[i]);
    }
    return steps;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const STATIC_ASSET_RE = /\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|css|map)(\?|$)/i;

function _isStaticAsset(url) {
    try { return STATIC_ASSET_RE.test(new URL(url).pathname); }
    catch { return STATIC_ASSET_RE.test(url); }
}

function _extractPath(url) {
    try { return new URL(url).pathname; }
    catch { return url.split('?')[0]; }
}

module.exports = { extractAssertionsForStep, attachAssertions };
