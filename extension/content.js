/**
 * content.js - Minimal content script for DOM action capture
 * Only captures user actions (clicks, scroll, navigation events)
 * IMPORTANT: Does NOT capture typed values for privacy
 */

// Guard against double injection
if (!window.__qaRecorderInjected) {
    window.__qaRecorderInjected = true;

    let videoRecorder = null;
    let videoStream = null;

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

    /**
     * Get a simple CSS selector for the element (non-sensitive)
     */
    function getSelector(el) {
        if (!el || el === document.body) return 'body';
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id.slice(0, 30)}` : '';
        const cls = el.className && typeof el.className === 'string'
            ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
            : '';
        return `${tag}${id}${cls}`.slice(0, 80);
    }

    /**
     * Get a short non-sensitive text snippet (button label, link text, aria-label)
     * Does NOT capture input values
     */
    function getTextSnippet(el) {
        // Never capture input/textarea/select values
        if (!el || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return '';
        const ariaLabel = el.getAttribute('aria-label') || '';
        const text = (el.textContent || '').trim();
        const snippet = (ariaLabel || text).slice(0, 60);
        return snippet;
    }

    // ── Click Listener ─────────────────────────────────────────────────────────
    document.addEventListener('click', (e) => {
        const el = e.target;
        sendEvent('action.click', {
            selector: getSelector(el),
            text_snippet: getTextSnippet(el),
            x: Math.round(e.clientX),
            y: Math.round(e.clientY),
            button: e.button,
        });
    }, { capture: true, passive: true });

    // ── Scroll Listener (throttled) ─────────────────────────────────────────────
    let lastScroll = 0;
    document.addEventListener('scroll', (e) => {
        const now = Date.now();
        if (now - lastScroll < 500) return; // throttle to 2/s
        lastScroll = now;
        sendEvent('action.scroll', {
            deltaY: Math.round(window.scrollY),
        });
    }, { capture: true, passive: true });

    // ── SPA Navigation (hashchange + popstate) ──────────────────────────────────
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

    // Intercept pushState/replaceState for SPA detection
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



    console.log('[QA Recorder] Content script injected');
}
