/**
 * step_builder.js — Semantic Step Builder
 *
 * Converts action groups (from event_grouper.js) into structured semantic
 * test steps that can be stored, compared, and replayed deterministically.
 *
 * Each step has:
 *   step_id       — sequential ID within the flow ('step_1', 'step_2', ...)
 *   step_type     — human-readable type (navigate, click, fill_field, etc.)
 *   label         — natural language description of the step
 *   selector      — primary CSS/aria selector (for replay)
 *   value         — filled value (for fill steps)
 *   url           — target URL (for navigate steps)
 *   source_event_ids — event_ids of the raw events that produced this step
 *   source_group  — original group_type from event_grouper
 *   start_ts      — timestamp of first event in this step
 *   end_ts        — timestamp of last event in this step
 */

'use strict';

function getEventId(evt) {
    return evt.event_id || evt.ts_epoch_ms || null;
}

/**
 * Convert a single action group into a semantic step object.
 *
 * @param {object} group  — from event_grouper.groupEvents()
 * @param {number} index  — 1-based step index
 * @returns {object|null} step object, or null if the group should be skipped
 */
function buildStep(group, index) {
    const { group_type, events, meta, start_ts, end_ts } = group;
    const sourceIds = events.map(getEventId).filter(Boolean);

    const base = {
        step_id: `step_${index}`,
        source_group: group_type,
        source_event_ids: sourceIds,
        start_ts,
        end_ts,
    };

    switch (group_type) {

        case 'navigate': {
            const toUrl = meta.to_url || '';
            return {
                ...base,
                step_type: 'navigate',
                label: `Navigate to ${_shortUrl(toUrl)}`,
                url: toUrl,
                from_url: meta.from_url || null,
            };
        }

        case 'click': {
            const label = meta.text_snippet
                ? `Click "${_truncate(meta.text_snippet, 40)}"`
                : `Click ${meta.tag || 'element'} [${_truncate(meta.selector || '?', 50)}]`;
            return {
                ...base,
                step_type: 'click',
                label,
                selector: meta.selector || null,
                text_snippet: meta.text_snippet || null,
                tag: meta.tag || null,
                x: meta.x,
                y: meta.y,
            };
        }

        case 'open_modal': {
            const label = meta.text_snippet
                ? `Click "${_truncate(meta.text_snippet, 40)}" (opens modal)`
                : `Click ${meta.tag || 'element'} (opens modal)`;
            return {
                ...base,
                step_type: 'click',
                label,
                selector: meta.selector || null,
                text_snippet: meta.text_snippet || null,
                opens_modal: true,
                tag: meta.tag || null,
            };
        }

        case 'click_with_toast': {
            const label = meta.text_snippet
                ? `Click "${_truncate(meta.text_snippet, 40)}" (triggers notification)`
                : `Click ${meta.tag || 'element'} (triggers notification)`;
            return {
                ...base,
                step_type: 'click',
                label,
                selector: meta.selector || null,
                triggers_toast: true,
            };
        }

        case 'fill': {
            const fields = meta.fields || [];
            if (fields.length === 0) return null;
            const primary = fields[0];
            const label = fields.length === 1
                ? `Fill field [${_truncate(primary.selector || '?', 40)}]`
                : `Fill ${fields.length} fields`;
            return {
                ...base,
                step_type: 'fill_field',
                label,
                selector: primary.selector || null,
                value: primary.value,
                input_type: primary.input_type,
                is_sensitive: primary.is_sensitive,
                all_fields: fields,
            };
        }

        case 'form_submit': {
            const fields = meta.fields || [];
            const primary = fields[0];
            const label = fields.length > 0
                ? `Fill and submit form (${fields.length} field${fields.length > 1 ? 's' : ''})`
                : 'Submit form';
            return {
                ...base,
                step_type: 'submit_form',
                label,
                selector: primary?.selector || null,
                value: primary?.value,
                is_sensitive: primary?.is_sensitive || false,
                all_fields: fields,
            };
        }

        case 'select_option': {
            return {
                ...base,
                step_type: 'select_option',
                label: `Select "${meta.selected_text || meta.selected_value}" from dropdown`,
                selector: meta.selector || null,
                selected_value: meta.selected_value,
                selected_text: meta.selected_text || null,
            };
        }

        case 'keypress': {
            return {
                ...base,
                step_type: 'press_key',
                label: `Press ${meta.key}`,
                key: meta.key,
            };
        }

        case 'scroll': {
            const finalY = meta.final_scrollY;
            return {
                ...base,
                step_type: 'scroll',
                label: finalY !== undefined ? `Scroll to y=${finalY}` : 'Scroll page',
                scroll_y: finalY,
                scroll_x: meta.final_scrollX,
            };
        }

        case 'toast': {
            // Standalone toast — not a user action, used as assertion context
            return {
                ...base,
                step_type: 'observe_toast',
                label: `Observe notification: "${_truncate(meta.text || '', 60)}"`,
                toast_text: meta.text,
                toast_class: meta.class,
                toast_role: meta.role,
            };
        }

        default: {
            // Unknown group — pass through as raw_action
            return {
                ...base,
                step_type: 'raw_action',
                label: `Raw action: ${group_type}`,
            };
        }
    }
}

/**
 * Build all steps from a list of groups.
 *
 * @param {object[]} groups  — from event_grouper.groupEvents()
 * @returns {object[]} array of semantic step objects
 */
function buildSteps(groups) {
    const steps = [];
    let stepIndex = 1;

    for (const group of groups) {
        // Skip idle/gap placeholders if any
        if (group.group_type === 'idle') continue;

        const step = buildStep(group, stepIndex);
        if (step) {
            steps.push(step);
            stepIndex++;
        }
    }

    return steps;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _truncate(str, maxLen) {
    if (!str) return '';
    return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}

function _shortUrl(url) {
    if (!url) return '(unknown)';
    try {
        const u = new URL(url);
        return u.pathname.length > 1 ? u.pathname : url;
    } catch {
        return url.slice(0, 60);
    }
}

module.exports = { buildStep, buildSteps };
