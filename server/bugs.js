/**
 * bugs.js - Persistent bug tracker.
 *
 * Reporting a bug to Slack (session report, bug marker, or screenshot) is
 * otherwise fire-and-forget — once the message lands in Slack, this tool
 * has no memory of it. This module keeps a durable, statusable record of
 * every reported bug so a QA engineer can look back and see what's still
 * open. Storage follows the same JSON-file pattern as slack_config.json
 * (server/integrations/slack.js) — a simple list, not queryable session
 * data, so sql.js/db.js's session index would be the wrong tool here.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const BUGS_FILE = path.join(os.homedir(), '.qa-flight-recorder', 'bugs.json');

const VALID_STATUSES = new Set(['open', 'fixed', 'next_release', 'wont_fix']);

function loadBugs() {
    let data;
    try {
        data = JSON.parse(fs.readFileSync(BUGS_FILE, 'utf8'));
    } catch {
        data = {};
    }
    return Array.isArray(data.bugs) ? data.bugs : [];
}

function saveBugs(bugs) {
    fs.mkdirSync(path.dirname(BUGS_FILE), { recursive: true });
    fs.writeFileSync(BUGS_FILE, JSON.stringify({ bugs }, null, 2));
    return bugs;
}

function listBugs({ status, channel } = {}) {
    let bugs = loadBugs();
    if (status) bugs = bugs.filter(b => b.status === status);
    if (channel) bugs = bugs.filter(b => b.channel === channel);
    // Newest first — the most recently reported/updated bug is what you're
    // most likely checking on.
    return bugs.slice().sort((a, b) => b.created_at - a.created_at);
}

function getBug(id) {
    return loadBugs().find(b => b.id === id) || null;
}

function createBug({ description, context, status, session_id, channel, channel_name, thread_link, permalink, source }) {
    if (!description || typeof description !== 'string') {
        throw new Error('description is required');
    }
    const bugs = loadBugs();
    const now = Date.now();
    const bug = {
        id: crypto.randomUUID(),
        description,
        // Read-only page/URL/health/link summary, kept separate from the
        // human-written description so the two never get concatenated into
        // one wall of text — see the comment above confirmSendToSlack() in
        // app.js for how this used to get smashed together.
        context: context || null,
        status: VALID_STATUSES.has(status) ? status : 'open',
        session_id: session_id || null,
        channel: channel || null,
        channel_name: channel_name || null,
        thread_link: thread_link || null,
        permalink: permalink || null,
        source: source || 'manual',
        created_at: now,
        updated_at: now,
        // Unified timeline: both plain comments and status transitions live
        // here in chronological order, each tagged with `type` so the UI can
        // render "Status: Open -> Won't Fix" distinctly from a plain note —
        // this is what lets a status change carry its "why" alongside it
        // instead of being a bare, unexplained flip.
        notes: [],
    };
    bugs.push(bug);
    saveBugs(bugs);
    return bug;
}

function updateBugStatus(id, status, comment) {
    if (!VALID_STATUSES.has(status)) {
        throw new Error(`Invalid status: "${status}"`);
    }
    const bugs = loadBugs();
    const bug = bugs.find(b => b.id === id);
    if (!bug) throw new Error('Bug not found');
    const from = bug.status;
    bug.status = status;
    bug.updated_at = Date.now();
    if (from !== status) {
        bug.notes.push({
            type: 'status_change',
            from,
            to: status,
            text: (comment || '').trim() || null,
            ts: bug.updated_at,
        });
    }
    saveBugs(bugs);
    return bug;
}

function addBugNote(id, text) {
    if (!text || typeof text !== 'string' || !text.trim()) {
        throw new Error('note text is required');
    }
    const bugs = loadBugs();
    const bug = bugs.find(b => b.id === id);
    if (!bug) throw new Error('Bug not found');
    bug.notes.push({ type: 'comment', text: text.trim(), ts: Date.now() });
    bug.updated_at = Date.now();
    saveBugs(bugs);
    return bug;
}

function deleteBug(id) {
    const bugs = loadBugs();
    const next = bugs.filter(b => b.id !== id);
    saveBugs(next);
    return next;
}

module.exports = {
    VALID_STATUSES,
    listBugs,
    getBug,
    createBug,
    updateBugStatus,
    addBugNote,
    deleteBug,
};
