/**
 * event_grouper.js — Raw Event Grouper
 *
 * Converts a flat stream of raw events into logical *action groups*.
 * Groups represent coherent units of user intent:
 *
 *   • navigate    — a navigation event (standalone)
 *   • fill        — one or more inputs into the same/adjacent fields
 *   • click       — a click, possibly followed by a DOM change
 *   • keypress    — a tracked keydown (Enter/Escape/Tab)
 *   • scroll      — scroll interaction
 *   • form_submit — a fill sequence ending with an Enter keydown
 *   • open_modal  — a click followed by dom.state_change with role=dialog
 *   • toast       — a dom.state_change containing a toast/alert element
 *   • idle        — a quiet gap > GAP_THRESHOLD_MS (filtered out later)
 *
 * Output:
 *   [{ group_type, events: [...enriched events], start_ts, end_ts, meta: {} }]
 */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const GAP_THRESHOLD_MS = 3000;          // >3 s gap between actions = new group
const DOM_CORRELATION_WINDOW_MS = 1500; // DOM change within 1.5s of click = same group
const NET_CORRELATION_WINDOW_MS = 1500; // Network event within 1.5s of action = correlated

// ── Helpers ───────────────────────────────────────────────────────────────────
function getType(evt) {
    return evt.event_type || evt.type || '';
}

function getTs(evt) {
    return evt.timestamp ?? evt.ts_epoch_ms ?? 0;
}

/**
 * Return true if a dom.state_change event signals a modal/dialog appearing.
 */
function isModalChange(evt) {
    if (getType(evt) !== 'dom.state_change') return false;
    const added = evt.data?.added || [];
    return added.some(n =>
        n.role === 'dialog' ||
        /modal|dialog|overlay|popup/.test(n.class || '') ||
        /modal|dialog/.test((n.tag || ''))
    );
}

/**
 * Return true if a dom.state_change event signals a toast/alert appearing.
 */
function isToastChange(evt) {
    if (getType(evt) !== 'dom.state_change') return false;
    const added = evt.data?.added || [];
    return added.some(n =>
        n.role === 'alert' ||
        n.role === 'status' ||
        /toast|snackbar|notification|alert/.test(n.class || '') ||
        /success|error|warning|info/.test(n.class || '')
    );
}

/**
 * Determine whether an event is an "action" that should anchor a group.
 */
function isActionEvent(evt) {
    return getType(evt).startsWith('action.');
}

// ── Main Export ───────────────────────────────────────────────────────────────
/**
 * Group a flat array of raw events into logical action groups.
 *
 * @param {object[]} events  — Raw events (enriched or legacy format)
 * @returns {{ group_type: string, events: object[], start_ts: number, end_ts: number, meta: object }[]}
 */
function groupEvents(events) {
    if (!events || events.length === 0) return [];

    // Work only with action + dom.state_change events for grouping purposes.
    // Network + console events are attached as context to groups later.
    const actionStream = events
        .filter(e => isActionEvent(e) || getType(e) === 'dom.state_change')
        .sort((a, b) => getTs(a) - getTs(b));

    const networkEvents = events
        .filter(e => getType(e).startsWith('network.') || getType(e).startsWith('console.') || getType(e).startsWith('runtime.'))
        .sort((a, b) => getTs(a) - getTs(b));

    const groups = [];
    let i = 0;

    while (i < actionStream.length) {
        const evt = actionStream[i];
        const evtType = getType(evt);
        const evtTs = getTs(evt);

        // ── Navigation ──────────────────────────────────────────────────────
        if (evtType === 'action.navigation') {
            groups.push({
                group_type: 'navigate',
                events: [evt],
                start_ts: evtTs,
                end_ts: evtTs,
                meta: {
                    from_url: evt.data?.from_url || null,
                    to_url:   evt.data?.to_url   || null,
                },
            });
            i++;
            continue;
        }

        // ── Scroll ─────────────────────────────────────────────────────────
        if (evtType === 'action.scroll') {
            // Merge consecutive scrolls (within GAP_THRESHOLD_MS)
            const scrollGroup = [evt];
            let j = i + 1;
            while (j < actionStream.length && getType(actionStream[j]) === 'action.scroll') {
                const gap = getTs(actionStream[j]) - getTs(actionStream[j - 1]);
                if (gap > GAP_THRESHOLD_MS) break;
                scrollGroup.push(actionStream[j]);
                j++;
            }
            const last = scrollGroup[scrollGroup.length - 1];
            groups.push({
                group_type: 'scroll',
                events: scrollGroup,
                start_ts: evtTs,
                end_ts: getTs(last),
                meta: {
                    final_scrollY: last.data?.scrollY,
                    final_scrollX: last.data?.scrollX,
                },
            });
            i = j;
            continue;
        }

        // ── Input (fill) ────────────────────────────────────────────────────
        if (evtType === 'action.input') {
            // Collect consecutive inputs (possibly into different fields — all part of form fill)
            const fillGroup = [evt];
            let j = i + 1;
            while (j < actionStream.length) {
                const next = actionStream[j];
                const nextType = getType(next);
                const gap = getTs(next) - getTs(actionStream[j - 1]);
                if (gap > GAP_THRESHOLD_MS) break;
                // Include additional inputs and clicks-on-inputs
                if (nextType === 'action.input') {
                    fillGroup.push(next);
                    j++;
                } else {
                    break;
                }
            }

            // Check if immediately followed by Enter (form submit)
            const followup = actionStream[j];
            const isSubmit =
                followup &&
                getType(followup) === 'action.keydown' &&
                followup.data?.key === 'Enter' &&
                getTs(followup) - getTs(fillGroup[fillGroup.length - 1]) < 2000;

            const groupType = isSubmit ? 'form_submit' : 'fill';
            if (isSubmit) {
                fillGroup.push(followup);
                j++;
            }

            const last = fillGroup[fillGroup.length - 1];
            groups.push({
                group_type: groupType,
                events: fillGroup,
                start_ts: evtTs,
                end_ts: getTs(last),
                meta: {
                    fields: fillGroup
                        .filter(e => getType(e) === 'action.input')
                        .map(e => ({
                            selector: e.data?.selector,
                            input_type: e.data?.input_type,
                            is_sensitive: e.data?.is_sensitive || false,
                            value: e.data?.is_sensitive ? '***' : e.data?.final_value,
                        })),
                },
            });
            i = j;
            continue;
        }

        // ── Select ─────────────────────────────────────────────────────────
        if (evtType === 'action.select') {
            groups.push({
                group_type: 'select_option',
                events: [evt],
                start_ts: evtTs,
                end_ts: evtTs,
                meta: {
                    selector:     evt.data?.selector,
                    selected_value: evt.data?.selected_value,
                    selected_text:  evt.data?.selected_text,
                },
            });
            i++;
            continue;
        }

        // ── Keydown ─────────────────────────────────────────────────────────
        if (evtType === 'action.keydown') {
            groups.push({
                group_type: 'keypress',
                events: [evt],
                start_ts: evtTs,
                end_ts: evtTs,
                meta: { key: evt.data?.key },
            });
            i++;
            continue;
        }

        // ── Click ────────────────────────────────────────────────────────────
        if (evtType === 'action.click') {
            const clickGroup = [evt];
            let end_ts = evtTs;

            // Look ahead for DOM state change within correlation window
            let j = i + 1;
            let detectedModal = false;
            let detectedToast = false;

            while (j < actionStream.length) {
                const next = actionStream[j];
                const gap = getTs(next) - evtTs;
                if (gap > DOM_CORRELATION_WINDOW_MS) break;
                if (getType(next) === 'dom.state_change') {
                    if (isModalChange(next)) { detectedModal = true; clickGroup.push(next); end_ts = getTs(next); }
                    else if (isToastChange(next)) { detectedToast = true; clickGroup.push(next); end_ts = getTs(next); }
                    j++;
                } else {
                    break;
                }
            }

            let groupType = 'click';
            if (detectedModal) groupType = 'open_modal';
            else if (detectedToast) groupType = 'click_with_toast';

            groups.push({
                group_type: groupType,
                events: clickGroup,
                start_ts: evtTs,
                end_ts,
                meta: {
                    selector:     evt.data?.selector,
                    text_snippet: evt.data?.text_snippet,
                    tag:          evt.data?.tag,
                    x: evt.data?.x,
                    y: evt.data?.y,
                },
            });
            i = j;
            continue;
        }

        // ── Standalone DOM change (toast/modal not correlated to a click) ──
        if (evtType === 'dom.state_change') {
            if (isToastChange(evt)) {
                const added = (evt.data?.added || []).find(n =>
                    n.role === 'alert' || n.role === 'status' ||
                    /toast|snackbar|notification/.test(n.class || '')
                );
                groups.push({
                    group_type: 'toast',
                    events: [evt],
                    start_ts: evtTs,
                    end_ts: evtTs,
                    meta: {
                        text:  added?.text  || null,
                        class: added?.class || null,
                        role:  added?.role  || null,
                    },
                });
            }
            // Otherwise ignore standalone dom.state_change events
            i++;
            continue;
        }

        // Fallback: unrecognized action type — pass through as standalone
        groups.push({
            group_type: evtType,
            events: [evt],
            start_ts: evtTs,
            end_ts: evtTs,
            meta: {},
        });
        i++;
    }

    // ── Attach correlated network/console context to each group ──────────────
    for (const group of groups) {
        const from = group.start_ts;
        const to   = group.end_ts + NET_CORRELATION_WINDOW_MS;
        group.context_events = networkEvents.filter(e => {
            const ts = getTs(e);
            return ts >= from && ts <= to;
        });
    }

    return groups;
}

module.exports = { groupEvents };
