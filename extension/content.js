/**
 * content.js - Enhanced content script for exhaustive DOM action capture
 * Captures: clicks, inputs, selects, key actions, navigation, and DOM state changes
 * Security: password fields are automatically redacted to '***'
 */

// Guard against double injection
if (!window.__qaRecorderInjected) {
    window.__qaRecorderInjected = true;

    // ── On-page Recording Indicator ──────────────────────────────────────────────
    // The extension's popup closes the instant it loses focus (normal Chrome
    // behavior for action popups) — without something visible on the page
    // itself, there's no way to tell a recording is running, or to stop it,
    // without reopening the popup. This is a small fixed-position widget
    // (Shadow DOM, so host-page CSS can't break it and it can't break the
    // host page) that shows while recording and lets you stop directly.
    let __qaIndicatorHost = null;
    let __qaIndicatorTimer = null;

    function showRecordingIndicator(startedAt) {
        if (__qaIndicatorHost) return; // already showing

        __qaIndicatorHost = document.createElement('div');
        __qaIndicatorHost.style.cssText = 'all:initial; position:fixed; z-index:2147483647; bottom:16px; right:16px;';
        const shadow = __qaIndicatorHost.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
            <style>
                .pill {
                    display: flex; align-items: center; gap: 8px;
                    background: #1a1d29; color: #e2e8f0;
                    border: 1px solid #f87171; border-radius: 999px;
                    padding: 6px 8px 6px 12px;
                    font: 600 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                    box-shadow: 0 4px 16px rgba(0,0,0,0.35);
                    user-select: none;
                }
                .dot {
                    width: 8px; height: 8px; border-radius: 50%; background: #f87171;
                    animation: qa-pulse 1.2s infinite; flex-shrink: 0;
                }
                @keyframes qa-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
                .timer { font-variant-numeric: tabular-nums; color: #f87171; min-width: 34px; }
                button {
                    all: unset; cursor: pointer; display: flex; align-items: center; gap: 4px;
                    background: #f87171; color: #1a1d29; border-radius: 999px;
                    padding: 4px 10px; font: 700 11px inherit;
                }
                button:hover { background: #fca5a5; }
                button:disabled { opacity: 0.6; cursor: default; }
            </style>
            <div class="pill">
                <span class="dot"></span>
                <span>Recording</span>
                <span class="timer" id="t">0:00</span>
                <button id="stop">■ Stop</button>
            </div>
        `;
        document.documentElement.appendChild(__qaIndicatorHost);

        const timerEl = shadow.getElementById('t');
        const update = () => {
            const elapsed = Date.now() - startedAt;
            const s = Math.floor(elapsed / 1000) % 60;
            const m = Math.floor(elapsed / 60000);
            timerEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
        };
        update();
        __qaIndicatorTimer = setInterval(update, 1000);

        shadow.getElementById('stop').addEventListener('click', () => {
            const btn = shadow.getElementById('stop');
            btn.disabled = true;
            btn.textContent = '…Stopping';
            chrome.runtime.sendMessage({ type: 'STOP_RECORDING_FROM_INDICATOR' }).catch(() => { });
        });
    }

    function hideRecordingIndicator() {
        if (__qaIndicatorTimer) { clearInterval(__qaIndicatorTimer); __qaIndicatorTimer = null; }
        if (__qaIndicatorHost) { __qaIndicatorHost.remove(); __qaIndicatorHost = null; }
    }

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === 'SHOW_RECORDING_INDICATOR') showRecordingIndicator(msg.startedAt);
        else if (msg.type === 'HIDE_RECORDING_INDICATOR') hideRecordingIndicator();
        else if (msg.type === 'SHOW_MULTI_CAPTURE_TRAY') renderMultiCaptureTray(msg.shots, msg.maxShots);
        else if (msg.type === 'HIDE_MULTI_CAPTURE_TRAY') hideMultiCaptureTray(msg.reason);
    });

    // ── Multi-Screenshot Capture Tray ────────────────────────────────────────────
    // Same "popup closes on page click" problem as the recording indicator above,
    // but for the "Multimedia" bug-report flow: accumulates screenshots across
    // multiple captures/navigations, then hands off to an inline report form —
    // all living on the page since that's the only place that survives the user
    // clicking around between captures.
    let __qaTrayHost = null;
    let __qaTrayShots = [];

    const TRAY_STYLE = `
        :host { all: initial; }
        .tray {
            width: 280px;
            background: #1a1d29; color: #e2e8f0; border: 1px solid #3730a3;
            border-radius: 14px; box-shadow: 0 8px 32px rgba(0,0,0,0.45);
            font: 500 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            overflow: hidden;
        }
        .tray-header {
            display: flex; align-items: center; justify-content: space-between;
            padding: 10px 12px; font-weight: 700; border-bottom: 1px solid #2d3245;
        }
        .tray-header button {
            all: unset; cursor: pointer; color: #94a3b8; padding: 2px 6px; border-radius: 6px;
        }
        .tray-header button:hover { background: #2d3245; color: #e2e8f0; }
        .thumbs {
            display: flex; gap: 6px; flex-wrap: wrap; padding: 10px 12px;
            max-height: 160px; overflow-y: auto;
        }
        .thumb { position: relative; width: 56px; height: 56px; border-radius: 6px; overflow: hidden; border: 1px solid #2d3245; }
        .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .thumb-x {
            all: unset; position: absolute; top: 2px; right: 2px; cursor: pointer;
            background: rgba(0,0,0,0.6); color: #fff; width: 16px; height: 16px;
            border-radius: 50%; display: flex; align-items: center; justify-content: center;
            font-size: 10px; line-height: 1;
        }
        .thumb-x:hover { background: #ef4444; }
        .empty-hint { padding: 4px 12px 10px; color: #64748b; font-size: 11px; }
        .actions { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid #2d3245; }
        button.primary, button.secondary {
            all: unset; cursor: pointer; flex: 1; text-align: center;
            padding: 7px 0; border-radius: 8px; font: 700 11px inherit;
        }
        button.primary { background: #6366f1; color: #fff; }
        button.primary:hover { background: #818cf8; }
        button.primary:disabled { opacity: 0.4; cursor: default; }
        button.secondary { background: #2d3245; color: #e2e8f0; }
        button.secondary:hover { background: #3a4058; }
        .field-label { display: block; font-size: 11px; font-weight: 700; color: #94a3b8; margin: 10px 12px 4px; }
        textarea, select {
            all: unset; box-sizing: border-box; display: block; width: calc(100% - 24px);
            margin: 0 12px; background: #12141c; border: 1px solid #2d3245; border-radius: 8px;
            padding: 7px 9px; color: #e2e8f0; font: 500 12px inherit;
        }
        textarea { resize: vertical; min-height: 50px; }
        .strip { display: flex; gap: 4px; padding: 10px 12px 0; }
        .strip img { width: 32px; height: 32px; object-fit: cover; border-radius: 4px; border: 1px solid #2d3245; }
        .status-msg { padding: 8px 12px; font-size: 11px; color: #94a3b8; }
        .status-msg.error { color: #f87171; }
        .status-msg.success { color: #34d399; font-weight: 700; }
    `;

    function ensureTrayHost() {
        if (__qaTrayHost) return __qaTrayHost.shadowRoot;
        __qaTrayHost = document.createElement('div');
        __qaTrayHost.style.cssText = 'all:initial; position:fixed; z-index:2147483647; bottom:16px; right:16px;';
        document.documentElement.appendChild(__qaTrayHost);
        return __qaTrayHost.attachShadow({ mode: 'open' });
    }

    function renderMultiCaptureTray(shots, maxShots) {
        __qaTrayShots = shots || [];
        const shadow = ensureTrayHost();
        const atLimit = __qaTrayShots.length >= maxShots;
        shadow.innerHTML = `
            <style>${TRAY_STYLE}</style>
            <div class="tray">
                <div class="tray-header">
                    <span>📸 ${__qaTrayShots.length} screenshot${__qaTrayShots.length !== 1 ? 's' : ''}${atLimit ? ' (max)' : ''}</span>
                    <button id="close" title="Cancel — discard all">✕</button>
                </div>
                ${__qaTrayShots.length
                    ? `<div class="thumbs">${__qaTrayShots.map(s => `
                        <div class="thumb">
                            <img src="${s.dataUrl}" />
                            <button class="thumb-x" data-id="${s.id}" title="Remove">✕</button>
                        </div>`).join('')}</div>`
                    : `<div class="empty-hint">Navigate/click around the page, then "+ Capture" to add another shot. Switch to another tab and reopen the popup to capture there too, or add a screenshot of another app from a file.</div>`}
                <div class="actions">
                    <button class="secondary" id="add" ${atLimit ? 'disabled' : ''}>+ Capture</button>
                    <button class="secondary" id="from-file" ${atLimit ? 'disabled' : ''} title="Import a screenshot of another app (e.g. Postman) taken with your OS screenshot tool">🖼 File</button>
                </div>
                <div class="actions" style="padding-top:0;">
                    <button class="primary" id="report" ${__qaTrayShots.length === 0 ? 'disabled' : ''}>Report Bug →</button>
                </div>
                <input type="file" id="file-input" accept="image/*" multiple style="display:none;" />
            </div>
        `;
        shadow.getElementById('close').addEventListener('click', () => {
            chrome.runtime.sendMessage({ type: 'CANCEL_MULTI_CAPTURE' }).catch(() => { });
        });
        shadow.getElementById('add').addEventListener('click', (e) => {
            e.currentTarget.disabled = true;
            e.currentTarget.textContent = '…';
            chrome.runtime.sendMessage({ type: 'CAPTURE_ANOTHER_SHOT' }).catch(() => { });
        });
        shadow.getElementById('from-file').addEventListener('click', () => shadow.getElementById('file-input').click());
        shadow.getElementById('file-input').addEventListener('change', (e) => handleTrayFileImport(e.target.files));
        shadow.getElementById('report').addEventListener('click', () => showTrayReportForm());
        shadow.querySelectorAll('.thumb-x').forEach(btn => {
            btn.addEventListener('click', () => {
                chrome.runtime.sendMessage({ type: 'REMOVE_MULTI_CAPTURE_SHOT', shotId: btn.dataset.id }).catch(() => { });
            });
        });
    }

    function readFileAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
        });
    }

    async function handleTrayFileImport(fileList) {
        const files = Array.from(fileList || []).filter(f => f.type.startsWith('image/'));
        if (!files.length) return;
        const dataUrls = await Promise.all(files.map(readFileAsDataUrl));
        chrome.runtime.sendMessage({ type: 'ADD_MULTI_CAPTURE_FILES', dataUrls }).catch(() => { });
    }

    async function showTrayReportForm() {
        const shadow = __qaTrayHost.shadowRoot;
        shadow.innerHTML = `<style>${TRAY_STYLE}</style><div class="tray"><div class="tray-header"><span>Loading…</span></div></div>`;

        const cfg = await chrome.runtime.sendMessage({ type: 'GET_SLACK_CONFIG_FOR_TRAY' }).catch(() => null);

        if (!cfg || !cfg.configured || !(cfg.savedChannels || []).length) {
            shadow.innerHTML = `
                <style>${TRAY_STYLE}</style>
                <div class="tray">
                    <div class="tray-header"><span>Report Bug</span><button id="close">✕</button></div>
                    <div class="status-msg error">Set up a Slack channel in the Dashboard → Integrations first.</div>
                    <div class="actions"><button class="secondary" id="back">← Back</button></div>
                </div>`;
            shadow.getElementById('close').addEventListener('click', () => {
                chrome.runtime.sendMessage({ type: 'CANCEL_MULTI_CAPTURE' }).catch(() => { });
            });
            shadow.getElementById('back').addEventListener('click', () => renderMultiCaptureTray(__qaTrayShots, 8));
            return;
        }

        const threadsForChannel = (channelId) => (cfg.savedThreads || []).filter(t => t.channel === channelId);
        const defaultChannel = cfg.defaultChannel && cfg.savedChannels.some(c => c.id === cfg.defaultChannel)
            ? cfg.defaultChannel : cfg.savedChannels[0].id;

        const renderForm = () => `
            <style>${TRAY_STYLE}</style>
            <div class="tray">
                <div class="tray-header"><span>Report Bug (${__qaTrayShots.length} shot${__qaTrayShots.length !== 1 ? 's' : ''})</span><button id="close">✕</button></div>
                <div class="strip">${__qaTrayShots.map(s => `<img src="${s.dataUrl}" />`).join('')}</div>
                <label class="field-label">Description</label>
                <textarea id="desc" placeholder="What's broken?"></textarea>
                <label class="field-label">Channel</label>
                <select id="channel">
                    ${cfg.savedChannels.map(c => `<option value="${c.id}" ${c.id === defaultChannel ? 'selected' : ''}>${c.name}</option>`).join('')}
                </select>
                <label class="field-label">Thread</label>
                <select id="thread"></select>
                <div class="status-msg" id="status-msg"></div>
                <div class="actions">
                    <button class="secondary" id="back">← Back</button>
                    <button class="primary" id="send">Send to Slack</button>
                </div>
            </div>`;

        shadow.innerHTML = renderForm();

        const populateThreads = () => {
            const channelId = shadow.getElementById('channel').value;
            const threads = threadsForChannel(channelId);
            shadow.getElementById('thread').innerHTML =
                `<option value="">No thread — new message</option>` +
                threads.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
        };
        populateThreads();

        shadow.getElementById('channel').addEventListener('change', populateThreads);
        shadow.getElementById('close').addEventListener('click', () => {
            chrome.runtime.sendMessage({ type: 'CANCEL_MULTI_CAPTURE' }).catch(() => { });
        });
        shadow.getElementById('back').addEventListener('click', () => renderMultiCaptureTray(__qaTrayShots, 8));
        shadow.getElementById('send').addEventListener('click', async () => {
            const sendBtn = shadow.getElementById('send');
            const statusEl = shadow.getElementById('status-msg');
            const channel = shadow.getElementById('channel').value;
            const threadId = shadow.getElementById('thread').value;
            const thread = threadId ? threadsForChannel(channel).find(t => t.id === threadId) : null;
            const text = shadow.getElementById('desc').value.trim();

            sendBtn.disabled = true;
            sendBtn.textContent = 'Sending…';
            statusEl.textContent = '';
            statusEl.className = 'status-msg';

            const result = await chrome.runtime.sendMessage({
                type: 'SUBMIT_MULTI_CAPTURE_REPORT',
                channel, threadLink: thread ? thread.link : undefined, text,
            }).catch((e) => ({ error: e.message }));

            if (result && result.ok) {
                statusEl.textContent = '✓ Sent to Slack';
                statusEl.className = 'status-msg success';
                // Background already tore down multiCapture state and will send
                // HIDE_MULTI_CAPTURE_TRAY; leave the success message showing
                // briefly so it isn't a jarring instant disappearance.
            } else {
                sendBtn.disabled = false;
                sendBtn.textContent = 'Send to Slack';
                statusEl.textContent = (result && result.error) || 'Failed to send';
                statusEl.className = 'status-msg error';
            }
        });
    }

    function hideMultiCaptureTray(reason) {
        if (!__qaTrayHost) return;
        if (reason === 'sent') {
            setTimeout(() => { if (__qaTrayHost) { __qaTrayHost.remove(); __qaTrayHost = null; } }, 1400);
        } else {
            __qaTrayHost.remove();
            __qaTrayHost = null;
        }
    }

    // ── Event Helpers ──────────────────────────────────────────────────────────
    function sendEvent(type, data) {
        chrome.runtime.sendMessage({
            type: 'CONTENT_EVENT',
            event: {
                ts_epoch_ms: Date.now(),
                type,
                source: 'content',
                tab_id: null,
                url: window.location.href,
                data,
            }
        }).catch(() => { });
    }

    // ── Multi-Strategy Selector ────────────────────────────────────────────────
    /**
     * Returns a selector object with multiple fallback strategies.
     * Priority: data-testid → aria/name attrs → CSS path
     */
    function getSelectors(el) {
        if (!el || el === document.body) return { primary: 'body', strategies: ['body'] };

        const strategies = [];

        // Strategy 1: data-testid, data-qa, data-cy (most stable for playwright/jest)
        for (const attr of ['data-testid', 'data-qa', 'data-cy', 'data-test']) {
            const val = el.getAttribute(attr);
            if (val) {
                strategies.push(`[${attr}="${val}"]`);
                break;
            }
        }

        // Strategy 2: id-based (only if id is not auto-generated)
        if (el.id && !/^\d/.test(el.id) && !el.id.match(/^(react-|ember|ng-|__)/)) {
            strategies.push(`#${el.id.slice(0, 50)}`);
        }

        // Strategy 3: semantic attributes (aria-label, name, placeholder, type+value)
        const tag = el.tagName.toLowerCase();
        const ariaLabel = el.getAttribute('aria-label');
        const name = el.getAttribute('name');
        const placeholder = el.getAttribute('placeholder');
        const role = el.getAttribute('role');

        if (ariaLabel) strategies.push(`${tag}[aria-label="${ariaLabel.slice(0, 60)}"]`);
        if (name) strategies.push(`${tag}[name="${name}"]`);
        if (placeholder) strategies.push(`${tag}[placeholder="${placeholder.slice(0, 60)}"]`);
        if (role) strategies.push(`[role="${role}"]`);

        // Strategy 4: Full structural CSS path (most verbose but reliable)
        strategies.push(getCSSPath(el));

        // Strategy 5: Simple tag + class (fallback)
        const cls = el.className && typeof el.className === 'string'
            ? '.' + el.className.trim().split(/\s+/).filter(c => c && !c.match(/^(active|hover|focus|selected|disabled)$/)).slice(0, 2).join('.')
            : '';
        strategies.push(`${tag}${cls}`.slice(0, 80));

        // Primary selector is the highest-priority available
        const primary = strategies[0] || 'body';
        return { primary, strategies: [...new Set(strategies)] };
    }

    /**
     * Build a full CSS path from root to element (e.g. body > div:nth-child(2) > input[name="email"])
     */
    function getCSSPath(el) {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) return 'body';
        const parts = [];
        let current = el;

        while (current && current !== document.body && current.nodeType === Node.ELEMENT_NODE) {
            const tag = current.tagName.toLowerCase();
            const parent = current.parentElement;
            if (!parent) break;

            // Use attribute-based selection for form elements
            const name = current.getAttribute('name');
            const type = current.getAttribute('type');
            if (name) {
                parts.unshift(`${tag}[name="${name}"]`);
            } else {
                // Use nth-child for disambiguation
                const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
                if (siblings.length > 1) {
                    const idx = siblings.indexOf(current) + 1;
                    parts.unshift(`${tag}:nth-child(${idx})`);
                } else {
                    parts.unshift(tag);
                }
            }
            current = parent;
        }
        return (parts.length ? 'body > ' + parts.join(' > ') : 'body').slice(0, 200);
    }

    /**
     * Get a short non-sensitive text snippet (label, aria-label, button text)
     * NEVER captures input/textarea values
     */
    function getTextSnippet(el) {
        if (!el || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return '';
        const ariaLabel = el.getAttribute('aria-label') || '';
        const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
        return (ariaLabel || text).slice(0, 80);
    }

    /**
     * Detects if a field is sensitive (passwords, CC numbers, secrets)
     */
    function isSensitiveField(el) {
        if (!el) return false;
        const type = (el.getAttribute('type') || '').toLowerCase();
        const name = (el.getAttribute('name') || '').toLowerCase();
        const id = (el.id || '').toLowerCase();
        const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();

        return (
            type === 'password' ||
            /password|passwd|secret|token|cc-number|cvv|ssn/.test(name) ||
            /password|passwd|secret|token/.test(id) ||
            autocomplete === 'current-password' ||
            autocomplete === 'new-password'
        );
    }

    // ── Click Listener ─────────────────────────────────────────────────────────
    document.addEventListener('click', (e) => {
        const el = e.target;
        const { primary, strategies } = getSelectors(el);
        sendEvent('action.click', {
            selector: primary,
            selector_strategies: strategies,
            text_snippet: getTextSnippet(el),
            tag: el.tagName?.toLowerCase(),
            x: Math.round(e.clientX),
            y: Math.round(e.clientY),
            button: e.button,
        });
    }, { capture: true, passive: true });

    // ── Input / Change Listener (Debounced) ────────────────────────────────────
    const inputTimers = new WeakMap();

    function handleInput(e) {
        const el = e.target;
        if (!['INPUT', 'TEXTAREA'].includes(el.tagName)) return;
        if (el.type === 'checkbox' || el.type === 'radio') return;

        // Debounce: wait 600ms after user stops typing before emitting
        if (inputTimers.has(el)) clearTimeout(inputTimers.get(el));

        inputTimers.set(el, setTimeout(() => {
            const sensitive = isSensitiveField(el);
            const { primary, strategies } = getSelectors(el);
            const value = sensitive ? '***' : el.value;
            const inputType = (el.getAttribute('type') || 'text').toLowerCase();

            sendEvent('action.input', {
                selector: primary,
                selector_strategies: strategies,
                final_value: value,
                input_type: inputType,
                is_sensitive: sensitive,
                tag: el.tagName.toLowerCase(),
            });
        }, 600));
    }

    document.addEventListener('input', handleInput, { capture: true, passive: true });

    // ── Select / Dropdown Change Listener ─────────────────────────────────────
    document.addEventListener('change', (e) => {
        const el = e.target;
        if (el.tagName === 'SELECT') {
            const { primary, strategies } = getSelectors(el);
            const selectedOption = el.options[el.selectedIndex];
            sendEvent('action.select', {
                selector: primary,
                selector_strategies: strategies,
                selected_value: el.value,
                selected_text: selectedOption ? selectedOption.text : '',
                tag: 'select',
            });
        }
    }, { capture: true, passive: true });

    // ── Key Action Listener (Critical Keys Only) ───────────────────────────────
    const TRACKED_KEYS = new Set(['Enter', 'Escape', 'Tab']);

    document.addEventListener('keydown', (e) => {
        if (!TRACKED_KEYS.has(e.key)) return;
        const el = e.target;
        const { primary, strategies } = getSelectors(el);
        sendEvent('action.keydown', {
            key: e.key,
            selector: primary,
            selector_strategies: strategies,
            tag: el.tagName?.toLowerCase(),
        });
    }, { capture: true, passive: true });

    // ── Scroll Listener (Throttled) ────────────────────────────────────────────
    let lastScroll = 0;
    let lastScrollY = window.scrollY;
    let lastScrollX = window.scrollX;
    document.addEventListener('scroll', () => {
        const now = Date.now();
        if (now - lastScroll < 500) return;
        lastScroll = now;
        const currentY = Math.round(window.scrollY);
        const currentX = Math.round(window.scrollX);
        sendEvent('action.scroll', {
            scrollY: currentY,
            scrollX: currentX,
            deltaY: currentY - Math.round(lastScrollY),
            deltaX: currentX - Math.round(lastScrollX),
        });
        lastScrollY = currentY;
        lastScrollX = currentX;
    }, { capture: true, passive: true });

    // ── SPA Navigation ─────────────────────────────────────────────────────────
    let lastUrl = window.location.href;

    function detectNavigation() {
        const currentUrl = window.location.href;
        if (currentUrl !== lastUrl) {
            sendEvent('action.navigation', {
                from_url: lastUrl,
                to_url: currentUrl,
            });
            lastUrl = currentUrl;
        }
    }

    window.addEventListener('hashchange', detectNavigation, { passive: true });
    window.addEventListener('popstate', detectNavigation, { passive: true });

    const origPushState = history.pushState.bind(history);
    const origReplaceState = history.replaceState.bind(history);

    history.pushState = function (...args) {
        origPushState(...args);
        setTimeout(detectNavigation, 50);
    };
    history.replaceState = function (...args) {
        origReplaceState(...args);
        setTimeout(detectNavigation, 50);
    };

    // ── MutationObserver — DOM State Changes ───────────────────────────────────
    /**
     * Watches for significant DOM additions (modals, toasts, alerts, spinners)
     * and emits 'dom.state_change' events so the triage view can show what
     * the UI did right around an error (e.g. an error toast appearing).
     */
    const SIGNIFICANT_SELECTORS = [
        '[role="alert"]', '[role="dialog"]', '[role="status"]',
        '.toast', '.snackbar', '.notification', '.alert',
        '.modal', '.dialog', '.popup', '.overlay',
        '.success', '.error', '.warning', '.info',
        '[data-testid*="toast"]', '[data-testid*="modal"]', '[data-testid*="alert"]',
        '[data-testid*="error"]', '[data-testid*="success"]',
        '.loading', '.spinner', '[aria-live]',
    ];

    function isSignificantNode(node) {
        if (node.nodeType !== Node.ELEMENT_NODE) return false;
        // Check if it matches or contains a significant element
        try {
            if (SIGNIFICANT_SELECTORS.some(sel => node.matches(sel))) return true;
            if (node.querySelector && SIGNIFICANT_SELECTORS.some(sel => node.querySelector(sel))) return true;
        } catch (e) { }
        return false;
    }

    let mutationDebounceTimer = null;
    const pendingMutations = { added: [], removed: [] };

    const observer = new MutationObserver((mutationsList) => {
        for (const mutation of mutationsList) {
            if (mutation.type !== 'childList') continue;
            for (const node of mutation.addedNodes) {
                if (isSignificantNode(node)) {
                    const el = node;
                    const tag = el.tagName?.toLowerCase() || 'unknown';
                    const role = el.getAttribute?.('role') || '';
                    const cls = (el.className && typeof el.className === 'string')
                        ? el.className.trim().split(/\s+/).slice(0, 3).join(' ') : '';
                    const text = (el.textContent || '').trim().slice(0, 100);
                    pendingMutations.added.push({ tag, role, class: cls, text });
                }
            }
            for (const node of mutation.removedNodes) {
                if (isSignificantNode(node)) {
                    const el = node;
                    const tag = el.tagName?.toLowerCase() || 'unknown';
                    const role = el.getAttribute?.('role') || '';
                    pendingMutations.removed.push({ tag, role });
                }
            }
        }

        // Batch flush mutations to avoid flooding
        if (mutationDebounceTimer) clearTimeout(mutationDebounceTimer);
        if (pendingMutations.added.length === 0 && pendingMutations.removed.length === 0) return;
        mutationDebounceTimer = setTimeout(() => {
            if (pendingMutations.added.length > 0 || pendingMutations.removed.length > 0) {
                sendEvent('dom.state_change', {
                    added: [...pendingMutations.added],
                    removed: [...pendingMutations.removed],
                });
                pendingMutations.added.length = 0;
                pendingMutations.removed.length = 0;
            }
        }, 300);
    });

    observer.observe(document.body, { childList: true, subtree: true });

    console.log('[QA Recorder] Content script injected (enhanced v2)');
}
