/**
 * normalizer.js — Normalization Orchestrator
 *
 * Orchestrates the full normalization pipeline for a recorded session:
 *   1. Reads raw events from events.ndjson
 *   2. Groups events → event_grouper
 *   3. Builds semantic steps → step_builder
 *   4. Attaches assertions → assertion_extractor
 *   5. Writes normalized.json to the session flows directory
 *
 * Usage:
 *   const { normalize } = require('./normalization/normalizer');
 *   const result = normalize(sessionDir);
 *   // → { steps, generated_at, step_count, assertion_count }
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { groupEvents }        = require('./event_grouper');
const { buildSteps }         = require('./step_builder');
const { attachAssertions }   = require('./assertion_extractor');

// ── Main ──────────────────────────────────────────────────────────────────────
/**
 * Run the full normalization pipeline on a session directory.
 *
 * @param {string} sessionDir  — absolute path to session directory
 * @returns {{
 *   steps: object[],
 *   generated_at: number,
 *   step_count: number,
 *   assertion_count: number,
 *   group_count: number,
 * }}
 */
function normalize(sessionDir) {
    // 1. Read raw events
    const eventsFile = path.join(sessionDir, 'raw', 'events.ndjson');
    if (!fs.existsSync(eventsFile)) {
        throw new Error(`events.ndjson not found in ${sessionDir}`);
    }

    const content = fs.readFileSync(eventsFile, 'utf8').trim();
    const rawEvents = content
        ? content.split('\n').map(line => {
            try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean)
        : [];

    if (rawEvents.length === 0) {
        const result = {
            steps: [],
            generated_at: Date.now(),
            step_count: 0,
            assertion_count: 0,
            group_count: 0,
        };
        _writeNormalized(sessionDir, result);
        return result;
    }

    // 2. Group events into logical action groups
    const groups = groupEvents(rawEvents);

    // 3. Build semantic steps from groups
    const steps = buildSteps(groups);

    // 4. Attach inferred assertions to each step
    // We need to match steps back to their groups
    attachAssertions(steps, _matchStepsToGroups(steps, groups));

    // 5. Compute summary metrics
    const assertionCount = steps.reduce((sum, s) => sum + (s.assertions?.length || 0), 0);

    const result = {
        steps,
        generated_at: Date.now(),
        step_count: steps.length,
        assertion_count: assertionCount,
        group_count: groups.length,

        // Step-type breakdown for quick inspection
        step_type_summary: _summarizeStepTypes(steps),
    };

    // 6. Write to disk
    _writeNormalized(sessionDir, result);

    return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Match each step back to its originating group by source_group and start_ts.
 * Returns an array aligned with `steps` array (same indices).
 */
function _matchStepsToGroups(steps, groups) {
    // Build a map from group index to group
    const matched = [];
    let groupIdx = 0;

    for (const step of steps) {
        // Find the first group that matches this step's source_group and start_ts
        while (groupIdx < groups.length) {
            const g = groups[groupIdx];
            if (g.group_type === step.source_group && g.start_ts === step.start_ts) {
                matched.push(g);
                groupIdx++;
                break;
            }
            groupIdx++;
        }
        if (matched.length < steps.indexOf(step) + 1) {
            // Fallback: no match found
            matched.push({ context_events: [] });
        }
    }

    return matched;
}

function _summarizeStepTypes(steps) {
    const counts = {};
    for (const step of steps) {
        counts[step.step_type] = (counts[step.step_type] || 0) + 1;
    }
    return counts;
}

function _writeNormalized(sessionDir, result) {
    // Write to <sessionDir>/normalized.json
    const outPath = path.join(sessionDir, 'normalized.json');
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
}

module.exports = { normalize };
