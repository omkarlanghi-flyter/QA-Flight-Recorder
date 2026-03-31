'use strict';

const fs   = require('fs');
const path = require('path');

const db = require('../db');
const { normalize } = require('../normalization/normalizer');
const { flowFromNormalized, validateFlow, validateFlowStep } = require('./flow_model');

function _loadNormalized(sessionDir) {
    const normalizedPath = path.join(sessionDir, 'normalized.json');
    if (!fs.existsSync(normalizedPath)) {
        throw new Error(`normalized.json not found in ${sessionDir}. Run normalization first.`);
    }
    return JSON.parse(fs.readFileSync(normalizedPath, 'utf8'));
}

function _ensureValidFlow(flow, steps) {
    const fv = validateFlow(flow);
    if (!fv.valid) throw new Error(`Flow validation failed: ${fv.errors.join('; ')}`);
    for (const s of steps) {
        const sv = validateFlowStep(s);
        if (!sv.valid) throw new Error(`Step ${s.step_index} validation failed: ${sv.errors.join('; ')}`);
    }
}

// Create flow + steps directly (assumes steps already built)
function createFlow(flow, steps) {
    _ensureValidFlow(flow, steps);
    db.createFlow(flow, steps);
    return { flow, steps };
}

// Promote a normalized session into a versioned Flow
function promoteFromSession(sessionId, sessionDir, options = {}) {
    const normalizedPath = path.join(sessionDir, 'normalized.json');
    if (!fs.existsSync(normalizedPath)) {
        if (options.normalizeIfMissing !== false) {
            normalize(sessionDir);
        } else {
            throw new Error('normalized.json missing and normalizeIfMissing=false');
        }
    }
    const normalized = _loadNormalized(sessionDir);
    const { flow, steps } = flowFromNormalized(normalized, {
        ...options,
        source_session_id: sessionId,
    });
    _ensureValidFlow(flow, steps);
    db.createFlow(flow, steps);
    return { flow, steps };
}

function listFlows(filters) {
    return db.listFlows(filters);
}

function getFlow(flowId, opts = { withSteps: true }) {
    return db.getFlow(flowId, opts);
}

function updateFlow(flowId, patch = {}) {
    const version = db.updateFlow(flowId, patch);
    return db.getFlow(flowId, { withSteps: true, version });
}

function deleteFlow(flowId) {
    return db.deleteFlow(flowId);
}

module.exports = {
    createFlow,
    promoteFromSession,
    listFlows,
    getFlow,
    updateFlow,
    deleteFlow,
};
