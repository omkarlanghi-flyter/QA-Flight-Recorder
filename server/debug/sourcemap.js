/**
 * sourcemap.js - On-demand resolution of minified stack traces back to
 * original source, using a captured event's stack + the app's own
 * `//# sourceMappingURL=` comment (works whether that URL is a relative
 * path, absolute URL, or inline base64 data: URI).
 *
 * Fetches happen at request time (not at capture time) so recording a
 * session never depends on network access to the target app's static
 * assets, and results are cached per JS file URL for the process lifetime.
 */
'use strict';

const { SourceMapConsumer } = require('source-map');

const SOURCEMAP_COMMENT_RE = /\/\/[#@]\s*sourceMappingURL=([^\s]+)/g;
const STACK_FRAME_RE = /at\s+(?:(.*?)\s+\()?(https?:\/\/[^\s)]+):(\d+):(\d+)\)?/g;

// jsFileUrl -> Promise<SourceMapConsumer|null>
const consumerCache = new Map();

async function fetchText(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}

function resolveMapUrl(jsUrl, mapUrlRaw) {
    if (mapUrlRaw.startsWith('data:')) return mapUrlRaw;
    try {
        return new URL(mapUrlRaw, jsUrl).href;
    } catch {
        return null;
    }
}

async function loadConsumerFor(jsUrl) {
    if (consumerCache.has(jsUrl)) return consumerCache.get(jsUrl);

    const promise = (async () => {
        let jsText;
        try {
            jsText = await fetchText(jsUrl);
        } catch {
            return null;
        }

        // Use the LAST sourceMappingURL comment in the file (some bundlers emit
        // more than one, e.g. inside string literals of embedded source).
        let match;
        let lastMapUrl = null;
        SOURCEMAP_COMMENT_RE.lastIndex = 0;
        while ((match = SOURCEMAP_COMMENT_RE.exec(jsText)) !== null) {
            lastMapUrl = match[1];
        }
        if (!lastMapUrl) return null;

        let mapJson;
        try {
            if (lastMapUrl.startsWith('data:')) {
                const b64 = lastMapUrl.split(',')[1];
                mapJson = Buffer.from(b64, 'base64').toString('utf8');
            } else {
                const mapUrl = resolveMapUrl(jsUrl, lastMapUrl);
                if (!mapUrl) return null;
                mapJson = await fetchText(mapUrl);
            }
            const rawMap = JSON.parse(mapJson);
            return await new SourceMapConsumer(rawMap);
        } catch {
            return null;
        }
    })();

    consumerCache.set(jsUrl, promise);
    return promise;
}

/**
 * Resolve a single {source, line, column} stack frame to its original
 * location. Returns null if no source map is available or the position
 * doesn't map to anything.
 */
async function resolveFrame({ source, line, column }) {
    if (!source || !line) return null;
    const consumer = await loadConsumerFor(source);
    if (!consumer) return null;

    const pos = consumer.originalPositionFor({ line: Number(line), column: Number(column) || 0 });
    if (!pos || pos.line == null) return null;
    return {
        source: pos.source,
        line: pos.line,
        column: pos.column,
        name: pos.name || null,
    };
}

/**
 * Parse a raw V8 stack trace string and resolve every frame it can find.
 * Returns an array of { raw, resolved } — resolved is null when no map
 * was found for that frame's file.
 */
async function resolveStack(stackText) {
    if (!stackText || typeof stackText !== 'string') return [];
    const frames = [];
    let match;
    STACK_FRAME_RE.lastIndex = 0;
    while ((match = STACK_FRAME_RE.exec(stackText)) !== null) {
        frames.push({
            raw: match[0].trim(),
            fnName: match[1] || null,
            source: match[2],
            line: Number(match[3]),
            column: Number(match[4]),
        });
    }

    const resolved = await Promise.all(
        frames.map(async (f) => ({
            raw: f.raw,
            fnName: f.fnName,
            resolved: await resolveFrame(f),
        }))
    );
    return resolved;
}

module.exports = { resolveFrame, resolveStack };
