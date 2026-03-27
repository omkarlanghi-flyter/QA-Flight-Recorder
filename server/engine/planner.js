/**
 * planner.js — Replay Planner
 *
 * Converts a structured Flow (from flow_store) into an ExecutionPlan that the
 * ReplayEngine can consume for deterministic, assertion-aware replay.
 *
 * The plan pre-computes for each step:
 *   • selector_chain — priority-ordered list of selectors to try
 *   • wait_strategy  — what to wait for after the action (network_idle,
 *                      element_visible, dom_change, none, network_settle)
 *   • retry_config   — max_attempts + backoff_ms per step type
 *   • assertions     — copied from flow step + implicit additions
 *   • fallback       — what to do if all selectors fail
 *
 * Usage:
 *   const { createPlan } = require('./planner');
 *   const plan = createPlan(flow, steps);
 *   // → { plan_id, flow_id, flow_version, created_at, steps: [...] }
 */

'use strict';

const { v4: uuidv4 } = require('uuid');

// ── Wait strategy types ────────────────────────────────────────────────────────
const WAIT_STRATEGIES = {
    NETWORK_IDLE:    'network_idle',
    NETWORK_SETTLE:  'network_settle',    // wait for triggered XHR/Fetch to complete
    ELEMENT_VISIBLE: 'element_visible',
    DOM_CHANGE:      'dom_change',        // wait for a DOM mutation (modal/toast)
    NONE:            'none',
};

// ── Retry defaults by step type ────────────────────────────────────────────────
const RETRY_CONFIG = {
    navigate:      { max_attempts: 1, backoff_ms: 0   },  // idempotency risk
    click:         { max_attempts: 3, backoff_ms: 200 },
    fill_field:    { max_attempts: 3, backoff_ms: 200 },
    submit_form:   { max_attempts: 1, backoff_ms: 0   },  // idempotency risk
    select_option: { max_attempts: 3, backoff_ms: 200 },
    press_key:     { max_attempts: 2, backoff_ms: 150 },
    scroll:        { max_attempts: 1, backoff_ms: 0   },
    observe_toast: { max_attempts: 1, backoff_ms: 0   },
    raw_action:    { max_attempts: 2, backoff_ms: 200 },
};

// ── Wait strategy defaults by step type ───────────────────────────────────────
function _waitStrategyFor(step, meta) {
    switch (step.step_type) {
        case 'navigate':
            return { type: WAIT_STRATEGIES.NETWORK_IDLE, max_ms: 15000, idle_ms: 500 };

        case 'submit_form':
            return { type: WAIT_STRATEGIES.NETWORK_SETTLE, max_ms: 15000, idle_ms: 400 };

        case 'click':
            // If the click opens a modal or triggers a toast, wait for DOM change
            if (meta?.opens_modal || meta?.triggers_toast) {
                return { type: WAIT_STRATEGIES.DOM_CHANGE, max_ms: 5000 };
            }
            // Otherwise settle network + short UI wait
            return { type: WAIT_STRATEGIES.NETWORK_SETTLE, max_ms: 8000, idle_ms: 300 };

        case 'fill_field':
        case 'select_option':
            return { type: WAIT_STRATEGIES.ELEMENT_VISIBLE, max_ms: 5000 };

        case 'press_key':
            // Enter can trigger submissions → treat like network_settle
            if (meta?.key === 'Enter') {
                return { type: WAIT_STRATEGIES.NETWORK_SETTLE, max_ms: 10000, idle_ms: 400 };
            }
            return { type: WAIT_STRATEGIES.NONE };

        case 'scroll':
        case 'observe_toast':
        case 'raw_action':
            return { type: WAIT_STRATEGIES.NONE };

        default:
            return { type: WAIT_STRATEGIES.NONE };
    }
}

// ── Implicit assertions ────────────────────────────────────────────────────────
/**
 * Add implicit assertions that should always be checked, not present in flow step.
 */
function _addImplicitAssertions(existingAssertions, stepType) {
    const out = [...existingAssertions];
    const types = new Set(out.map(a => a.type));

    // navigate + submit_form: always check for no network failures
    if (['navigate', 'submit_form'].includes(stepType)) {
        if (!types.has('assert_no_net_failure')) {
            out.push({ type: 'assert_no_net_failure', expected: { max_failures: 0 }, soft: false, implicit: true });
        }
    }

    // All steps: soft no-JS-errors check (added once per plan, here for each step to be visible)
    if (!types.has('assert_no_js_errors') && ['navigate', 'submit_form', 'click'].includes(stepType)) {
        out.push({ type: 'assert_no_js_errors', expected: { max_errors: 0 }, soft: true, implicit: true });
    }

    return out;
}

// ── Selector chain builder ─────────────────────────────────────────────────────
/**
 * Sort selectors by priority and format into a chain for the engine.
 * Adds a final 'text_match' strategy if a text_snippet is available.
 */
function _buildSelectorChain(stepSelectors, meta) {
    const chain = [...(stepSelectors || [])]
        .sort((a, b) => (a.priority || 99) - (b.priority || 99))
        .map(sel => ({
            strategy: sel.strategy || 'css',
            value:    sel.value,
            priority: sel.priority,
        }));

    return chain;
}

// ── Main export ────────────────────────────────────────────────────────────────
/**
 * Create an ExecutionPlan from a Flow and its FlowSteps.
 *
 * @param {object}   flow   — flow record from flow_store.getFlow()
 * @param {object[]} steps  — flow steps (flow.steps if pre-joined, or separate)
 * @returns {object} ExecutionPlan
 */
function createPlan(flow, steps) {
    if (!flow || !flow.flow_id) throw new Error('flow.flow_id is required');

    // Support passed-in { flow, steps } or a flat flow object with .steps[]
    const flowSteps = steps || flow.steps || [];

    const planSteps = flowSteps
        .slice() // don't mutate
        .sort((a, b) => (a.step_index || 0) - (b.step_index || 0))
        .map((step, i) => {
            const meta = _resolveMeta(step);

            // Build priority-ordered selector chain
            const selectorChain = _buildSelectorChain(step.selectors, meta);

            // Determine wait strategy
            const waitStrategy = step.wait_strategy
                ? (typeof step.wait_strategy === 'string' ? JSON.parse(step.wait_strategy) : step.wait_strategy)
                : _waitStrategyFor(step, meta);

            // Retry config
            const retryConfig = { ...(RETRY_CONFIG[step.step_type] || RETRY_CONFIG.raw_action) };

            // Assertions (flow step + implicit)
            const stepAssertions = _resolveAssertions(step);
            const allAssertions = _addImplicitAssertions(stepAssertions, step.step_type);

            // Fallback strategy
            const fallback = step.fallback_strategy || 'throw';

            return {
                plan_step_id:   `ps_${i + 1}`,
                step_index:     i + 1,
                source_step_id: step.step_id,
                step_type:      step.step_type,
                label:          step.step_name || step.intent || `Step ${i + 1}`,
                intent:         step.intent || null,

                // Selector resolution
                selector_chain: selectorChain,

                // Timing & synchronization
                wait_strategy:  waitStrategy,

                // Reliability
                retry_config:   retryConfig,
                fallback,

                // Validation
                assertions:     allAssertions,

                // Step-type payload (url, value, key, etc.)
                ...meta,
            };
        });

    return {
        plan_id:       uuidv4(),
        flow_id:       flow.flow_id,
        flow_name:     flow.flow_name,
        flow_version:  flow.version || 1,
        created_at:    Date.now(),
        total_steps:   planSteps.length,
        steps:         planSteps,
    };
}

// ── Internal helpers ──────────────────────────────────────────────────────────
function _resolveMeta(step) {
    // meta may be stored as a JSON string in DB
    if (!step.meta) return {};
    if (typeof step.meta === 'string') {
        try { return JSON.parse(step.meta); } catch { return {}; }
    }
    return step.meta;
}

function _resolveAssertions(step) {
    if (!step.assertions) return [];
    if (typeof step.assertions === 'string') {
        try { return JSON.parse(step.assertions); } catch { return []; }
    }
    if (Array.isArray(step.assertions)) return step.assertions;
    return [];
}

module.exports = {
    createPlan,
    WAIT_STRATEGIES,
    RETRY_CONFIG,
};
