/**
 * content.js - Enhanced content script for exhaustive DOM action capture
 * Captures: clicks, inputs, selects, key actions, navigation, and DOM state changes
 * Security: password fields are automatically redacted to '***'
 */

// Guard against double injection
if (!window.__qaRecorderInjected) {
    window.__qaRecorderInjected = true;

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
        } else if (el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(el.type)) {
            const { primary, strategies } = getSelectors(el);
            sendEvent('action.input', {
                selector: primary,
                selector_strategies: strategies,
                final_value: String(el.checked),
                input_type: el.type,
                is_sensitive: false,
                tag: 'input',
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
     * Emits lightweight 'dom.state_change' events for implicit assertions during replay.
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
