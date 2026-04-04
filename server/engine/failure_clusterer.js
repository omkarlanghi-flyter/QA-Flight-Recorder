'use strict';

const { v4: uuidv4 } = require('uuid');

function normalize(str) {
    return (str || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
}

function classify(stepReport) {
    const err = normalize(stepReport.error || '');
    const net = (stepReport.associated_network_failures || [])[0] || '';

    if (err.includes('element not found') || err.includes('clickable element')) return 'selector_issue';
    if (err.includes('timeout') && err.includes('navigation')) return 'environment_mismatch';
    if (err.includes('auth') || err.includes('login')) return 'auth_session';
    if (net || err.includes('http')) return 'backend_failure';
    return 'unknown';
}

function buildSignature(stepReport) {
    const base = normalize(stepReport.error || stepReport.status || 'unknown');
    const net = normalize((stepReport.associated_network_failures || [])[0] || '');
    const selector = normalize(stepReport.selector || '');
    const signature = [stepReport.step_type || 'unknown', base, net, selector].filter(Boolean).join('|');
    const failure_class = classify(stepReport);
    return { signature, failure_class, label: `${failure_class}: ${base.slice(0, 50)}` };
}

function attachClusters(stepReports, db) {
    const clusters = {};
    const enriched = stepReports.map(sr => {
        if (sr.status === 'passed') return sr;
        const { signature, failure_class, label } = buildSignature(sr);
        const cluster = db.upsertFailureCluster({ signature, failure_class, exemplar_run_step_id: sr.run_step_id || uuidv4(), label });
        clusters[cluster.cluster_id] = (clusters[cluster.cluster_id] || 0) + 1;
        return { ...sr, cluster_id: cluster.cluster_id };
    });
    return { stepReports: enriched, clusterCounts: clusters };
}

module.exports = { buildSignature, attachClusters };
