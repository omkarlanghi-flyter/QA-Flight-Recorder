/**
 * slack.js - Slack Bot Token integration for reporting bugs/sessions.
 *
 * Uses a Bot Token (xoxb-...) + the Slack Web API directly (chat.postMessage)
 * rather than an Incoming Webhook, because webhooks can't reply into an
 * arbitrary existing thread — only a token-authenticated chat.postMessage
 * call with `thread_ts` can. The token is stored locally at
 * ~/.qa-flight-recorder/slack_config.json (same pattern as ignored_errors.json)
 * and is NEVER sent back to the frontend once saved.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CONFIG_FILE = path.join(os.homedir(), '.qa-flight-recorder', 'slack_config.json');

function loadConfig() {
    let cfg;
    try {
        cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
        cfg = {};
    }
    return {
        botToken: cfg.botToken || null,
        defaultChannel: cfg.defaultChannel || null,
        savedChannels: Array.isArray(cfg.savedChannels) ? cfg.savedChannels : [],
        savedThreads: Array.isArray(cfg.savedThreads) ? cfg.savedThreads : [],
    };
}

function saveConfig({ botToken, defaultChannel, savedChannels, savedThreads }) {
    const current = loadConfig();
    const next = {
        botToken: botToken !== undefined ? botToken : current.botToken,
        defaultChannel: defaultChannel !== undefined ? defaultChannel : current.defaultChannel,
        savedChannels: savedChannels !== undefined ? savedChannels : current.savedChannels,
        savedThreads: savedThreads !== undefined ? savedThreads : current.savedThreads,
    };
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
    return next;
}

function isConfigured() {
    const cfg = loadConfig();
    return Boolean(cfg.botToken);
}

/** Adds (or updates, if the id already exists) a saved channel shortcut. */
function addChannel({ id, name }) {
    const cfg = loadConfig();
    const next = [...cfg.savedChannels.filter(c => c.id !== id), { id, name: name || id }];
    const patch = { savedChannels: next };
    // First saved channel becomes the default automatically if none is set yet.
    if (!cfg.defaultChannel) patch.defaultChannel = id;
    return saveConfig(patch);
}

function removeChannel(id) {
    const cfg = loadConfig();
    const next = cfg.savedChannels.filter(c => c.id !== id);
    const patch = { savedChannels: next };
    if (cfg.defaultChannel === id) patch.defaultChannel = next[0]?.id || null;
    return saveConfig(patch);
}

function setDefaultChannel(id) {
    return saveConfig({ defaultChannel: id });
}

/** Adds a saved thread shortcut from a pasted Slack message permalink. */
function addThread({ name, link }) {
    const parsed = parsePermalink(link);
    if (!parsed) throw new Error('Could not parse that Slack message link');
    const cfg = loadConfig();
    // Re-saving the same message link updates the existing entry (keeps its
    // id) instead of creating a duplicate row in the dropdown.
    const existing = cfg.savedThreads.find(t => t.link === link);
    const entry = {
        id: existing ? existing.id : crypto.randomUUID(),
        name: name || existing?.name || `Thread in ${parsed.channel}`,
        link,
        channel: parsed.channel,
        thread_ts: parsed.thread_ts,
    };
    const next = [...cfg.savedThreads.filter(t => t.link !== link), entry];
    return saveConfig({ savedThreads: next });
}

function removeThread(id) {
    const cfg = loadConfig();
    return saveConfig({ savedThreads: cfg.savedThreads.filter(t => t.id !== id) });
}

/**
 * Parses a Slack message permalink (from "Copy link" on a message) into
 * { channel, thread_ts }. Permalinks look like:
 *   https://yourteam.slack.com/archives/C0123456789/p1699999999000123
 *   https://yourteam.slack.com/archives/C0123456789/p1699999999000123?thread_ts=1699999999.000000&cid=C0123456789
 * The `p<digits>` segment is the message timestamp with the decimal point
 * removed, and always 16 digits (10 seconds + 6 microseconds).
 */
function parsePermalink(permalink) {
    if (!permalink || typeof permalink !== 'string') return null;
    try {
        const url = new URL(permalink.trim());
        // Prefer an explicit thread_ts query param if present (replies to a reply)
        const explicitThreadTs = url.searchParams.get('thread_ts');
        const match = url.pathname.match(/\/archives\/([A-Z0-9]+)\/p(\d{16})/i);
        if (!match) return null;
        const channel = match[1];
        const raw = match[2];
        const ts = explicitThreadTs || `${raw.slice(0, 10)}.${raw.slice(10)}`;
        return { channel, thread_ts: ts };
    } catch {
        return null;
    }
}

async function callSlackApi(method, botToken, body) {
    const res = await fetch(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    if (!data.ok) {
        throw new Error(data.error || 'Slack API request failed');
    }
    return data;
}

// A handful of Slack Web API "read" methods (chat.getPermalink among them)
// are documented as GET-only, unlike chat.postMessage — query params, not a
// JSON body.
async function callSlackApiGet(method, botToken, params) {
    const url = new URL(`https://slack.com/api/${method}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${botToken}` },
        signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    if (!data.ok) {
        throw new Error(data.error || 'Slack API request failed');
    }
    return data;
}

// files.getUploadURLExternal predates Slack's JSON-body convention and wants
// application/x-www-form-urlencoded, not JSON.
async function callSlackApiForm(method, botToken, params) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) body.set(k, String(v));
    }
    const res = await fetch(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Bearer ${botToken}`,
        },
        body,
        signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();
    if (!data.ok) {
        throw new Error(data.error || 'Slack API request failed');
    }
    return data;
}

/**
 * Posts a message to a channel, or replies into a thread if thread_ts is given.
 * Returns { channel, ts, permalink }.
 */
async function postMessage({ channel, text, thread_ts }) {
    const cfg = loadConfig();
    if (!cfg.botToken) {
        throw new Error('Slack is not configured — add a Bot Token first');
    }
    if (!channel) {
        throw new Error('No Slack channel specified');
    }

    const result = await callSlackApi('chat.postMessage', cfg.botToken, {
        channel,
        text,
        thread_ts: thread_ts || undefined,
        unfurl_links: false,
    });

    let permalink = null;
    try {
        const permalinkRes = await callSlackApiGet('chat.getPermalink', cfg.botToken, {
            channel: result.channel,
            message_ts: result.ts,
        });
        permalink = permalinkRes.permalink || null;
    } catch {
        // non-fatal — message still sent, just no permalink to show back
    }

    return { channel: result.channel, ts: result.ts, permalink };
}

/**
 * Uploads a file (e.g. a screenshot) into a channel or thread using Slack's
 * three-step external-upload flow:
 *   1. files.getUploadURLExternal — reserve an upload slot, get a signed URL
 *   2. POST the raw bytes to that URL (multipart, no auth header needed —
 *      the URL itself is the credential)
 *   3. files.completeUploadExternal — finalize + post it to the channel/thread
 * Returns { channel, permalink }.
 */
async function uploadFile({ channel, thread_ts, buffer, filename, initialComment }) {
    const cfg = loadConfig();
    if (!cfg.botToken) {
        throw new Error('Slack is not configured — add a Bot Token first');
    }
    if (!channel) {
        throw new Error('No Slack channel specified');
    }

    const urlRes = await callSlackApiForm('files.getUploadURLExternal', cfg.botToken, {
        filename,
        length: buffer.length,
    });

    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'image/png' }), filename);
    const uploadRes = await fetch(urlRes.upload_url, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(20000),
    });
    if (!uploadRes.ok) {
        throw new Error(`Upload to Slack failed: HTTP ${uploadRes.status}`);
    }

    const completeRes = await callSlackApi('files.completeUploadExternal', cfg.botToken, {
        files: [{ id: urlRes.file_id, title: filename }],
        channel_id: channel,
        thread_ts: thread_ts || undefined,
        initial_comment: initialComment || undefined,
    });

    const uploaded = completeRes.files && completeRes.files[0];
    return { channel, permalink: uploaded?.permalink || null };
}

module.exports = {
    loadConfig, saveConfig, isConfigured, parsePermalink, postMessage, uploadFile,
    addChannel, removeChannel, setDefaultChannel, addThread, removeThread,
};
