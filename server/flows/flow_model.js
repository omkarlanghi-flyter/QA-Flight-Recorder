/**
 * flow_model.js — Flow + FlowStep Schema Constants and Validators
 *
 * Defines:
 *   PRIORITY_LEVELS, CRITICALITY_LEVELS, STEP_TYPES, FALLBACK_STRATEGIES
 *   validateFlow(flow)  → { valid, errors }
 *   validateFlowStep(step) → { valid, errors }
 *   flowFromNormalized(normalized, options) → { flow, steps }
 */

'use strict';

const { v4: uuidv4 } = require('uuid');

// ── Enum constants ─────────────────────────────────────────────────────────────
const PRIORITY_LEVELS     = ['low', 'medium', 'high', 'critical'];
const CRITICALITY_LEVELS  = ['normal', 'blocker', 'smoke'];
const FALLBACK_STRATEGIES = ['coordinate_click', 'text_match', 'skip', 'throw'];

const STEP_TYPES = new Set([
    'navigate', 'click', 'fill_field', 'submit_form',
    'select_option', 'press_key', 'scroll',
    'observe_toast', 'raw_action',
]);

// ── Flow Validator ─────────────────────────────────────────────────────────────
/**
 * @param {object} flow
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateFlow(flow) {
    const errors = [];
    if (!flow || typeof flow !== 'object') return { valid: false, errors: ['Flow must be an object'] };

    if (!flow.flow_name || typeof flow.flow_name !== 'string') {
        errors.push('flow_name is required and must be a string');
    } else if (flow.flow_name.trim().length < 2) {
        errors.push('flow_name must be at least 2 characters');
    }

    if (flow.priority && !PRIORITY_LEVELS.includes(flow.priority)) {
        errors.push(`priority must be one of: ${PRIORITY_LEVELS.join(', ')}`);
    }

    if (flow.criticality && !CRITICALITY_LEVELS.includes(flow.criticality)) {
        errors.push(`criticality must be one of: ${CRITICALITY_LEVELS.join(', ')}`);
    }

    if (flow.tags !== undefined && !Array.isArray(flow.tags)) {
        errors.push('tags must be an array');
    }

    return { valid: errors.length === 0, errors };
}

// ── FlowStep Validator ─────────────────────────────────────────────────────────
/**
 * @param {object} step
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateFlowStep(step) {
    const errors = [];
    if (!step || typeof step !== 'object') return { valid: false, errors: ['Step must be an object'] };

    if (!step.step_type) errors.push('step_type is required');
    else if (!STEP_TYPES.has(step.step_type)) {
        errors.push(`step_type must be one of: ${[...STEP_TYPES].join(', ')}`);
    }

    if (typeof step.step_index !== 'number' || step.step_index < 1) {
        errors.push('step_index must be a positive integer');
    }

    if (step.fallback_strategy && !FALLBACK_STRATEGIES.includes(step.fallback_strategy)) {
        errors.push(`fallback_strategy must be one of: ${FALLBACK_STRATEGIES.join(', ')}`);
    }

    return { valid: errors.length === 0, errors };
}

// ── Promote from normalized.json ───────────────────────────────────────────────
/**
 * Convert the output of normalizer.normalize() into a Flow + FlowSteps pair
 * ready to be passed to flow_store.createFlow().
 *
 * @param {object} normalized    — result of normalizer.normalize()
 * @param {object} options       — { flow_name, module, feature, priority, criticality,
 *                                   tags, owner, description, source_session_id }
 * @returns {{ flow: object, steps: object[] }}
 */
function flowFromNormalized(normalized, options = {}) {
    const now        = Date.now();
    const flowId     = uuidv4();
    const flowName   = options.flow_name || 'Unnamed Flow';

    const flow = {
        flow_id:           flowId,
        flow_name:         flowName,
        module:            options.module      || null,
        feature:           options.feature     || null,
        priority:          options.priority    || 'medium',
        criticality:       options.criticality || 'normal',
        tags:              options.tags        || [],
        owner:             options.owner       || null,
        version:           1,
        created_at:        now,
        updated_at:        now,
        source_session_id: options.source_session_id || null,
        description:       options.description || null,
    };

    const steps = (normalized.steps || []).map((normStep, i) => {
        // Build selector list from normalization output
        const selectors = _buildSelectors(normStep);

        // Determine default fallback strategy
        const fallback = _defaultFallback(normStep);

        // Determine intent from step label
        const intent = normStep.label || `${normStep.step_type} step`;

        // Determine expected_outcome from assertions (first hard assertion)
        const hardAssertions = (normStep.assertions || []).filter(a => !a.soft);
        const expectedOutcome = hardAssertions.length > 0
            ? hardAssertions.map(a => _assertionToText(a)).join('; ')
            : null;

        return {
            step_id:          uuidv4(),
            flow_id:          flowId,
            step_index:       i + 1,
            step_name:        normStep.label || `Step ${i + 1}`,
            intent,
            step_type:        normStep.step_type,
            selectors,
            expected_outcome: expectedOutcome,
            assertions:       normStep.assertions || [],
            fallback_strategy: fallback,
            wait_strategy:    null, // planner fills this in
            meta:             _buildMeta(normStep),
        };
    });

    return { flow, steps };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _buildSelectors(normStep) {
    // normStep may have: selector, all_fields, selector_strategies (from raw events)
    const selectors = [];
    const primary = normStep.selector || normStep.url || null;

    if (normStep.all_fields && normStep.all_fields.length > 0) {
        // Fill/submit form: one selector per field
        for (const field of normStep.all_fields) {
            if (field.selector) {
                selectors.push({ strategy: 'css', value: field.selector, priority: selectors.length + 1, is_sensitive: field.is_sensitive || false });
            }
        }
    } else if (primary) {
        selectors.push({ strategy: 'css', value: primary, priority: 1 });
    }

    // Add text_snippet as a secondary text-match strategy for clicks
    if ((normStep.step_type === 'click') && normStep.text_snippet) {
        selectors.push({ strategy: 'text', value: normStep.text_snippet, priority: selectors.length + 1 });
    }

    // Add coordinate fallback for clicks with x/y
    if ((normStep.step_type === 'click') && typeof normStep.x === 'number' && typeof normStep.y === 'number') {
        selectors.push({ strategy: 'coordinates', value: `${normStep.x},${normStep.y}`, priority: selectors.length + 1 });
    }

    return selectors;
}

function _defaultFallback(normStep) {
    if (normStep.step_type === 'fill_field' || normStep.step_type === 'submit_form') {
        // Check if any field is sensitive
        const hasSensitive = (normStep.all_fields || []).some(f => f.is_sensitive);
        return hasSensitive ? 'skip' : 'throw';
    }
    if (normStep.step_type === 'click') {
        return typeof normStep.x === 'number' ? 'coordinate_click' : 'text_match';
    }
    if (normStep.step_type === 'navigate' || normStep.step_type === 'scroll') {
        return 'skip'; // non-critical fallback
    }
    return 'throw';
}

function _assertionToText(a) {
    switch (a.type) {
        case 'assert_toast':        return `Toast visible (${a.expected?.variant || 'any'})`;
        case 'assert_modal_open':   return 'Modal/dialog opens';
        case 'assert_modal_closed': return 'Modal/dialog closes';
        case 'assert_api_success':  return `API returns 2xx (${a.expected?.url_contains || ''})`;
        case 'assert_no_js_errors': return 'No JS errors';
        case 'assert_no_net_failure': return 'No network failures';
        case 'assert_url_changed':  return `URL changes to ${a.expected?.url || '?'}`;
        default: return a.type;
    }
}

function _buildMeta(normStep) {
    // Carry step-type-specific payload forward
    const meta = {};
    if (normStep.url)             meta.url = normStep.url;
    if (normStep.from_url)        meta.from_url = normStep.from_url;
    if (normStep.value !== undefined) meta.value = normStep.value;
    if (normStep.key)             meta.key = normStep.key;
    if (normStep.selected_value)  meta.selected_value = normStep.selected_value;
    if (normStep.selected_text)   meta.selected_text  = normStep.selected_text;
    if (normStep.scroll_y !== undefined) meta.scroll_y = normStep.scroll_y;
    if (normStep.scroll_x !== undefined) meta.scroll_x = normStep.scroll_x;
    if (normStep.opens_modal)     meta.opens_modal = true;
    if (normStep.triggers_toast)  meta.triggers_toast = true;
    return meta;
}

module.exports = {
    PRIORITY_LEVELS,
    CRITICALITY_LEVELS,
    FALLBACK_STRATEGIES,
    STEP_TYPES,
    validateFlow,
    validateFlowStep,
    flowFromNormalized,
};
