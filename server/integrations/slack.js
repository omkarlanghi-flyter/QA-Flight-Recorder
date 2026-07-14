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
    const savedChannels = Array.isArray(cfg.savedChannels) ? cfg.savedChannels : [];
    const savedThreads = Array.isArray(cfg.savedThreads) ? cfg.savedThreads : [];

    // Self-heal channels saved before extractChannelId()/name-cleanup existed
    // — a pasted full Slack URL could end up stored as the "id" verbatim, or
    // (just as easily, since the Label field has no validation either) as
    // the "name" — either way showing up as a full path wherever displayed.
    let needsRewrite = false;
    const idRemap = new Map();
    const cleanedChannels = savedChannels.map((c) => {
        const cleanId = extractChannelId(c.id);
        const cleanName = isUrlLike(c.name) ? cleanId : c.name;
        if (cleanId !== c.id) { needsRewrite = true; idRemap.set(c.id, cleanId); }
        if (cleanName !== c.name) needsRewrite = true;
        return { ...c, id: cleanId, name: cleanName };
    });
    let defaultChannel = cfg.defaultChannel || null;
    if (defaultChannel && idRemap.has(defaultChannel)) defaultChannel = idRemap.get(defaultChannel);

    const result = {
        botToken: cfg.botToken || null,
        defaultChannel,
        savedChannels: cleanedChannels,
        savedThreads,
    };
    if (needsRewrite) {
        fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(result, null, 2));
    }
    return result;
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

/**
 * Pulls a bare channel ID (e.g. "C0123456789") out of whatever was pasted —
 * a raw ID, or a full Slack channel/message URL like
 * https://yourteam.slack.com/archives/C0123456789[/p169...]. Without this,
 * pasting a URL by mistake saves the whole link as the "id" and every place
 * that displays it (dropdowns, saved-channel rows) shows that full path
 * instead of a clean channel ID.
 */
function extractChannelId(raw) {
    if (!raw || typeof raw !== 'string') return raw;
    const trimmed = raw.trim();
    const match = trimmed.match(/\/archives\/([A-Z0-9]+)/i);
    return match ? match[1] : trimmed;
}

function isUrlLike(str) {
    return typeof str === 'string' && /^https?:\/\//i.test(str.trim());
}

/** Adds (or updates, if the id already exists) a saved channel shortcut. */
function addChannel({ id, name }) {
    const cleanId = extractChannelId(id);
    // A Slack message/thread link pasted into the Label field by mistake is
    // just as easy to do as pasting a channel URL into the ID field — don't
    // let a raw link become the display name either.
    const cleanName = (name && !isUrlLike(name)) ? name : cleanId;
    const cfg = loadConfig();
    const next = [...cfg.savedChannels.filter(c => c.id !== cleanId), { id: cleanId, name: cleanName }];
    const patch = { savedChannels: next };
    // First saved channel becomes the default automatically if none is set yet.
    if (!cfg.defaultChannel) patch.defaultChannel = cleanId;
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
    const trimmedName = (name || '').trim();

    // A saved thread's identity is its NAME, not its link — two differently
    // named shortcuts ("Login Bug", "Auth Team Thread") can legitimately
    // point at the exact same Slack thread. Re-saving the same name updates
    // that entry's link (lets you repoint a shortcut); a blank name still
    // dedupes by link so accidental double-submits don't pile up identical
    // "Thread in C0123..." rows.
    const existing = trimmedName
        ? cfg.savedThreads.find(t => t.channel === parsed.channel && t.name.toLowerCase() === trimmedName.toLowerCase())
        : cfg.savedThreads.find(t => t.link === link);
    const entry = {
        id: existing ? existing.id : crypto.randomUUID(),
        name: trimmedName || existing?.name || `Thread in ${parsed.channel}`,
        link,
        channel: parsed.channel,
        thread_ts: parsed.thread_ts,
    };
    const next = [...cfg.savedThreads.filter(t => t.id !== entry.id), entry];
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
 * Steps 1-2 of Slack's three-step external-upload flow for one file —
 * reserve a signed upload slot, then POST the raw bytes to it. Shared by
 * uploadFile (single) and uploadFiles (multiple) below; only step 3
 * (files.completeUploadExternal) differs between them, since that's the
 * step that actually decides whether files land as separate messages or
 * are grouped into one.
 */
async function reserveAndUploadFile(botToken, buffer, filename, mimeType) {
    const urlRes = await callSlackApiForm('files.getUploadURLExternal', botToken, {
        filename,
        length: buffer.length,
    });

    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeType }), filename);
    const uploadRes = await fetch(urlRes.upload_url, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(20000),
    });
    if (!uploadRes.ok) {
        throw new Error(`Upload to Slack failed: HTTP ${uploadRes.status}`);
    }

    return { id: urlRes.file_id, title: filename };
}

/**
 * Uploads a single file (e.g. a screenshot) into a channel or thread.
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

    const fileRef = await reserveAndUploadFile(cfg.botToken, buffer, filename, 'image/png');

    const completeRes = await callSlackApi('files.completeUploadExternal', cfg.botToken, {
        files: [fileRef],
        channel_id: channel,
        thread_ts: thread_ts || undefined,
        initial_comment: initialComment || undefined,
    });

    const uploaded = completeRes.files && completeRes.files[0];
    return { channel, permalink: uploaded?.permalink || null };
}

/**
 * Uploads multiple files (e.g. a "Multimedia" bug report's screenshots) as
 * ONE Slack message with several attachments. Steps 1-2 of the external-
 * upload flow are inherently per-file, but files.completeUploadExternal
 * accepts an array of file refs — a single call there finalizes all of them
 * into one post/thread reply instead of one message per screenshot.
 * `files` is [{ buffer, filename }, ...]. Returns { channel, permalink }
 * (permalink points at the one combined message).
 */
async function uploadFiles({ channel, thread_ts, files, initialComment }) {
    const cfg = loadConfig();
    if (!cfg.botToken) {
        throw new Error('Slack is not configured — add a Bot Token first');
    }
    if (!channel) {
        throw new Error('No Slack channel specified');
    }
    if (!files || !files.length) {
        throw new Error('No files to upload');
    }

    const fileRefs = await Promise.all(
        files.map(f => reserveAndUploadFile(cfg.botToken, f.buffer, f.filename, 'image/png'))
    );

    const completeRes = await callSlackApi('files.completeUploadExternal', cfg.botToken, {
        files: fileRefs,
        channel_id: channel,
        thread_ts: thread_ts || undefined,
        initial_comment: initialComment || undefined,
    });

    const uploaded = completeRes.files && completeRes.files[0];
    return { channel, permalink: uploaded?.permalink || null };
}

module.exports = {
    loadConfig, saveConfig, isConfigured, parsePermalink, postMessage, uploadFile, uploadFiles,
    addChannel, removeChannel, setDefaultChannel, addThread, removeThread, extractChannelId,
};
