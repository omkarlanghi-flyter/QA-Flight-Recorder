const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

class ReplayEngine {
  constructor(events, options = {}) {
    this.events = events || [];
    this.options = options;
    this.profileDir = options.profileDir || path.join(os.homedir(), '.qa-automation-profile');
    this.cdpUrl = 'http://localhost:9223';
    this.retries = options.retries || 2;
    this.timeouts = {
      elementVisible: 6500,
      click: 4500,
      navigation: 12000,
      initialNavigation: 16000,
      networkIdle: 2500,
      navigationIdle: 6000,
      settleDelay: 300,
      stepBudget: 12000,
    };
    this.slowRequestFactor = options.slowRequestFactor || 2.0;
    this.minAdaptiveWait = options.minAdaptiveWait || 1500;
    this.slowRequestFactor = options.slowRequestFactor || 2.0;
    this.minAdaptiveWait = options.minAdaptiveWait || 1500;
    this.aborted = false;
    this.browser = null;
    this.activeStepIndex = -1;
    this.report = {
      summary: { total_steps: 0, passed: 0, failed: 0 },
      failures: { ui: [], network: [], js_errors: [] },
      steps: []
    };
  }

  async abort() {
    this.aborted = true;
    if (this.page && !this.page.isClosed()) {
      try { await this.page.close(); } catch (e) {}
    }
    if (this.browser) {
      try { await this.browser.disconnect(); } catch (e) {}
    }
  }

  async _ensureBrowser() {
    try {
      this.browser = await chromium.connectOverCDP(this.cdpUrl);
      return;
    } catch (e) {
      const chromeArgs = [
        `--user-data-dir=${this.profileDir}`,
        `--remote-debugging-port=9223`,
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank'
      ];
      const chromeProcess = spawn('google-chrome', chromeArgs, { detached: true, stdio: 'ignore' });
      chromeProcess.unref();
      await new Promise(r => setTimeout(r, 2000));
      this.browser = await chromium.connectOverCDP(this.cdpUrl);
    }
  }

  async run() {
    try {
      await this._ensureBrowser();
      const contexts = this.browser.contexts();
      const context = contexts.length > 0 ? contexts[0] : await this.browser.newContext();
      this.page = await context.newPage();

      this._attachListeners(this.page);

      // Filter to actionable steps only
      const steps = this.events.filter(e => e && e.type && e.type.startsWith('action.'));
    this.report.summary.total_steps = steps.length;

      // Pre-compute timing info and correlation for network-aware waits
      this._timingsByPath = this._buildTimingByPath();
      this._networkIndex = this._buildNetworkIndex(steps);

      // Handle missing initial navigation
      if (steps.length > 0 && steps[0].type !== 'action.navigation' && this.options.startUrl) {
        try { await this.page.goto(this.options.startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) {}
      }

      for (let i = 0; i < steps.length; i++) {
        this.activeStepIndex = i + 1;

      const stepReport = {
        index: i + 1,
        type: steps[i].type,
        selector: steps[i].data?.selector,
        status: 'failed',
        duration_ms: 0,
        attempts: 0,
        associated_logs: [],
        associated_network_failures: []
      };
      this.report.steps.push(stepReport);

        if (this.aborted) {
          stepReport.error = 'Replay aborted by user';
          this.report.failures.ui.push({ step_index: i + 1, type: 'engine_aborted', message: 'Replay aborted by user' });
          break;
        }

      const startTime = Date.now();
      const outcome = await this._runStepWithRetry(steps[i], this.page, i + 1, i);
      stepReport.duration_ms = Date.now() - startTime;
      stepReport.attempts = outcome.attempts || (outcome.ok ? 1 : this.retries + 1);

      if (outcome.ok) {
        this.report.summary.passed++;
        stepReport.status = 'passed';
      } else {
        this.report.summary.failed++;
        stepReport.status = 'failed';
        if (outcome.error) stepReport.error = outcome.error.message;
        this.report.failures.ui.push({
          step_index: i + 1,
          type: steps[i].type,
          selector: steps[i].data?.selector,
          message: outcome.error?.message || 'step failed'
        });
      }
      }
    } catch (err) {
      if (this.aborted) {
        this.report.failures.ui.push({ step_index: this.activeStepIndex, type: 'engine_aborted', message: 'Replay aborted by user' });
      } else {
        this.report.failures.ui.push({ step_index: this.activeStepIndex, type: 'engine_crash', message: err.message });
      }
    } finally {
      if (this.page && !this.page.isClosed()) {
        try { await this.page.close(); } catch (e) {}
      }
      if (this.browser) {
        try { await this.browser.disconnect(); } catch (e) {}
      }
    }
    return this.report;
  }

  /**
   * Build an index of {stepIndex → [sanitized URL patterns]} for network-aware waiting.
   * Looks at network.request events that fired within 1500ms AFTER each action step.
   */
  _buildNetworkIndex(actionSteps) {
    const index = {};
    // Only correlate with XHR/Fetch API calls (not document navigations or asset loads)
    const networkRequests = this.events.filter(e =>
      e.type === 'network.request' &&
      e.data?.method &&
      ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(e.data.method) &&
      e.data?.url_sanitized &&
      !e.data.url_sanitized.match(/\.(js|css|png|jpg|gif|svg|ico|webp|woff|ttf|mp4)$/)
    );

    for (let i = 0; i < actionSteps.length; i++) {
      const step = actionSteps[i];
      const stepTs = step.ts_epoch_ms || 0;
      if (!stepTs) continue;

      const correlated = networkRequests.filter(nr => {
        const nrTs = nr.ts_epoch_ms || 0;
        // Only requests that fired between 0ms and 1500ms after this step
        return nrTs > stepTs && nrTs <= stepTs + 1500;
      });

      if (correlated.length > 0) {
        // Extract the path portion only (strip scheme+host, strip query/hash already done by sanitizeUrl)
        index[i] = correlated
          .map(nr => {
            try {
              const u = new URL(nr.data.url_sanitized);
              return u.pathname; // e.g. '/api/auth/login'
            } catch {
              return null;
            }
          })
          .filter(Boolean)
          .slice(0, 2); // Cap at 2 correlated URLs per step to avoid over-waiting
      }
    }
    return index;
  }

  _buildTimingByPath() {
    const requestPathById = {};
    const durationsByPath = {};

    for (const evt of this.events) {
      if (evt.type === 'network.request' && evt.data?.request_id && evt.data?.url_sanitized) {
        try {
          const u = new URL(evt.data.url_sanitized);
          requestPathById[evt.data.request_id] = u.pathname;
        } catch { /* ignore */ }
      }
    }

    for (const evt of this.events) {
      if (evt.type === 'network.timing' && evt.data?.request_id && typeof evt.data.duration_ms === 'number') {
        const path = requestPathById[evt.data.request_id];
        if (!path) continue;
        if (!durationsByPath[path]) durationsByPath[path] = [];
        durationsByPath[path].push(evt.data.duration_ms);
      }
    }

    return durationsByPath;
  }

  _adaptiveTimeout(pathname) {
    const durations = this._timingsByPath?.[pathname];
    if (durations && durations.length) {
      const maxDur = Math.max(...durations);
      const expected = Math.max(this.minAdaptiveWait, Math.round(maxDur * this.slowRequestFactor));
      const cap = this.timeouts.stepBudget || expected;
      return Math.min(expected, cap);
    }
    const fallback = 8000;
    return Math.min(fallback, this.timeouts.stepBudget || fallback);
  }

  _attachListeners(page) {
    page.on('console', msg => {
      const type = msg.type();
      const text = `[${type}] ${msg.text()}`;
      if (type === 'error') {
        this.report.failures.js_errors.push({ type: 'console', message: text.slice(0, 300) });
      }
      if (this.activeStepIndex > 0 && this.report.steps[this.activeStepIndex - 1]) {
        this.report.steps[this.activeStepIndex - 1].associated_logs.push(text.slice(0, 200));
      }
    });
    page.on('pageerror', err => {
      this.report.failures.js_errors.push({ type: 'page_error', message: err.message.slice(0, 300) });
      if (this.activeStepIndex > 0 && this.report.steps[this.activeStepIndex - 1]) {
        this.report.steps[this.activeStepIndex - 1].associated_logs.push(`[uncaught] ${err.message.slice(0, 200)}`);
      }
    });
    page.on('requestfailed', req => {
      const url = req.url();
      const errText = req.failure()?.errorText || 'failed';
      this.report.failures.network.push({ url, error: errText });
      if (this.activeStepIndex > 0 && this.report.steps[this.activeStepIndex - 1]) {
        this.report.steps[this.activeStepIndex - 1].associated_network_failures.push(`${url} → ${errText}`);
      }
    });
    page.on('response', resp => {
      const status = resp.status();
      if (status >= 400) {
        const url = resp.url();
        this.report.failures.network.push({ url, status, error: `HTTP ${status}` });
        if (this.activeStepIndex > 0 && this.report.steps[this.activeStepIndex - 1]) {
          this.report.steps[this.activeStepIndex - 1].associated_network_failures.push(`${url} → HTTP ${status}`);
        }
      }
    });
  }

  /**
   * Resolve an element using multi-strategy selectors with smart waiting.
   * Returns a Playwright Locator, or null if nothing found.
   */
  async _resolveLocator(page, data) {
    const strategies = Array.isArray(data?.selector_strategies) && data.selector_strategies.length > 0
      ? data.selector_strategies
      : data?.selector ? [data.selector] : [];

    const text = data?.text_snippet ? data.text_snippet.trim() : '';
    const locatorsToTry = [];

    // Build list of valid locators
    for (const sel of strategies) {
      if (!sel || sel === 'body') continue;
      try {
        if (text) locatorsToTry.push({ loc: page.locator(sel, { hasText: text }).first(), preferred: true });
        locatorsToTry.push({ loc: page.locator(sel).first(), preferred: false });
      } catch (e) { /* ignore invalid selectors */ }
    }

    if (text && text.length >= 2) {
      try { locatorsToTry.push({ loc: page.getByText(text, { exact: false }).first(), preferred: false }); } catch (e) {}
    }

    if (locatorsToTry.length === 0) return null;

    // Fast path: check if any are already in the DOM right now
    for (const { loc } of locatorsToTry) {
      try {
        if (await loc.count() > 0 && await loc.isVisible().catch(() => true)) return loc;
      } catch (e) {}
    }

    // Slow path: wait for ANY of them to appear in the DOM (race them)
    // We wait for 'attached' state rather than 'visible' here, visibility check is done later
    try {
      const winner = await Promise.any(
        locatorsToTry.map(async ({ loc }) => {
          await loc.waitFor({ state: 'attached', timeout: this.timeouts.elementVisible });
          return loc;
        })
      );
      return winner;
    } catch (e) {
      // AggregateError: all strategies timed out
      return null;
    }
  }

  /**
   * FIXED: Network-aware settle uses Promise.race pattern.
   * The response listener is set up BEFORE the action runs (caller's responsibility),
   * then passed in here to await after the action. This avoids the race condition where
   * the response comes back before we start listening.
   *
   * For steps without correlated calls, we use a short load-state wait instead.
   */
  async _awaitNetworkPromises(page, stepIdx, networkPromises) {
    if (!networkPromises || networkPromises.length === 0) {
      // No correlated network calls — use a lightweight network-idle check (max 1.5s)
      try {
        await page.waitForLoadState('networkidle', { timeout: 1500 });
      } catch (e) {
        // networkidle timed out — page may have ongoing background requests. That is OK.
      }
      return;
    }

    // Await all pre-registered response promises with a single overall timeout
    try {
      const overallCap = this.timeouts.stepBudget || 8000;
      await Promise.race([
        Promise.all(networkPromises),
        new Promise(r => setTimeout(r, overallCap)),
      ]);
    } catch (e) {
      // Suppress — a missed response is not a test failure
    }
  }

  /**
   * Build response promises BEFORE the action fires (fixes race condition).
   * Returns an array of promises to be awaited after the action.
   */
  _buildResponsePromises(page, stepIdx) {
    const urls = this._networkIndex?.[stepIdx];
    if (!urls || urls.length === 0) return [];

    return urls.map(urlPath => {
      const timeout = this._adaptiveTimeout(urlPath);
      return page.waitForResponse(
        resp => {
          try {
            return new URL(resp.url()).pathname === urlPath;
          } catch {
            return false;
          }
        },
        { timeout }
      ).catch(() => null); // timeout is not a failure
    });
  }

  async _postActionSettle(page, opts = {}) {
    const hasNetwork = opts.hasNetwork || false;
    if (hasNetwork) {
      const idleTimeout = opts.navigation ? this.timeouts.navigationIdle : this.timeouts.networkIdle;
      try { await page.waitForLoadState('networkidle', { timeout: idleTimeout }); } catch (e) { }
      if (this.timeouts.settleDelay > 0) {
        try { await page.waitForTimeout(this.timeouts.settleDelay); } catch (e) {}
      }
    } else {
      // Fast path: no correlated network, just a tiny settle
      try { await page.waitForTimeout(Math.min(300, this.timeouts.settleDelay)); } catch (e) {}
    }
  }

  async _runStepWithRetry(step, page, stepIndex, stepArrayIndex) {
    let lastError = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        await this._withStepTimeout(() => this._executeStep(step, page, stepIndex, stepArrayIndex));
        return { ok: true, attempts: attempt + 1 };
      } catch (err) {
        lastError = err;
        if (attempt >= this.retries) break;
        // brief backoff before retry
        try { await page.waitForTimeout(200 * (attempt + 1)); } catch (e) {}
      }
    }
    return { ok: false, error: lastError };
  }

  async _withStepTimeout(fn) {
    const budget = this.timeouts.stepBudget;
    if (!budget || budget <= 0) return fn();
    let timer;
    try {
      return await Promise.race([
        fn(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('step timeout')), budget); })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async _executeStep(step, page, stepIndex, stepArrayIndex) {
    const data = step.data || {};
    try {
      // ── Navigation ─────────────────────────────────────────────────────────
      if (step.type === 'action.navigation') {
        const targetUrl = data.to_url || data.url;
        if (targetUrl) {
          const targetPath = (() => {
            try { return new URL(targetUrl).pathname; } catch { return null; }
          })();

          const netPromises = this._buildResponsePromises(page, stepArrayIndex);

          if (stepIndex === 1) {
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: this.timeouts.initialNavigation });
            await this._awaitNetworkPromises(page, stepArrayIndex, netPromises);
            await this._postActionSettle(page, { navigation: true, hasNetwork: (netPromises?.length || 0) > 0 });
          } else {
            // Try to let SPA navigation happen naturally first, then fall back to a goto
            try {
              if (targetPath) {
                await page.waitForFunction(
                  (p) => window.location.pathname === p,
                  targetPath,
                  { timeout: this.timeouts.navigation }
                );
              } else {
                await page.waitForURL(targetUrl, { timeout: this.timeouts.navigation });
              }
            } catch (e) {
              await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: this.timeouts.navigation }).catch(() => {});
            }
            await this._awaitNetworkPromises(page, stepArrayIndex, netPromises);
            await this._postActionSettle(page, { navigation: true, hasNetwork: (netPromises?.length || 0) > 0 });
          }
        }

      // ── Click ───────────────────────────────────────────────────────────────
      } else if (step.type === 'action.click') {
        // FIX: Set up response promises BEFORE clicking so we don't miss them
        const netPromises = this._buildResponsePromises(page, stepArrayIndex);

        const locator = await this._resolveLocator(page, data);
        if (locator) {
          try {
            await locator.waitFor({ state: 'visible', timeout: this.timeouts.elementVisible });
            if (await locator.isEnabled().catch(() => true)) {
              await locator.click({ timeout: this.timeouts.click });
            } else {
              throw new Error('Locator disabled');
            }
          } catch (e) {
            // Try coordinates fallback before force
            if (typeof data.x === 'number' && typeof data.y === 'number') {
              await page.mouse.click(data.x, data.y, { timeout: this.timeouts.click }).catch(() => {});
            } else {
              await locator.click({ force: true, timeout: this.timeouts.click }).catch(() => {});
            }
          }
        } else {
          const tried = (data.selector_strategies || (data.selector ? [data.selector] : [])).join(' | ');
          throw new Error(`Element not found. Tried: ${tried || 'no selectors'}`);
        }

        await this._awaitNetworkPromises(page, stepArrayIndex, netPromises);
        await this._postActionSettle(page, { hasNetwork: (netPromises?.length || 0) > 0 });

      // ── Input ───────────────────────────────────────────────────────────────
      } else if (step.type === 'action.input') {
        const locator = await this._resolveLocator(page, data);
        if (locator) {
          await locator.waitFor({ state: 'visible', timeout: this.timeouts.elementVisible });
          // Clear field first, then fill with final value
          await locator.clear({ timeout: this.timeouts.click }).catch(() => {});
          await locator.fill(String(data.final_value ?? data.text ?? ''), { timeout: this.timeouts.click });
        } else {
          const tried = (data.selector_strategies || (data.selector ? [data.selector] : [])).join(' | ');
          throw new Error(`Input element not found. Tried: ${tried || 'no selectors'}`);
        }
        await this._postActionSettle(page, { hasNetwork: false });

      // ── Select Dropdown ─────────────────────────────────────────────────────
      } else if (step.type === 'action.select') {
        const netPromises = this._buildResponsePromises(page, stepArrayIndex);
        const locator = await this._resolveLocator(page, data);
        if (locator) {
          await locator.waitFor({ state: 'visible', timeout: this.timeouts.elementVisible });
          try {
            await locator.selectOption({ value: String(data.selected_value) }, { timeout: this.timeouts.click });
          } catch (e) {
            if (data.selected_text) {
              await locator.selectOption({ label: data.selected_text }, { timeout: this.timeouts.click });
            } else {
              throw e;
            }
          }
        }
        await this._awaitNetworkPromises(page, stepArrayIndex, netPromises);
        await this._postActionSettle(page, { hasNetwork: (netPromises?.length || 0) > 0 });

      // ── Keydown (Enter / Escape / Tab) ──────────────────────────────────────
      } else if (step.type === 'action.keydown') {
        const key = data.key;
        if (key) {
          // FIX: Set up response promises BEFORE pressing key (Enter can trigger API calls)
          const netPromises = this._buildResponsePromises(page, stepArrayIndex);

          if (data.selector || data.selector_strategies) {
            const locator = await this._resolveLocator(page, data);
            if (locator) {
              try {
                await locator.waitFor({ state: 'visible', timeout: this.timeouts.elementVisible });
                await locator.press(key, { timeout: this.timeouts.click });
              } catch (e) {
                await page.keyboard.press(key);
              }
            } else {
              await page.keyboard.press(key);
            }
          } else {
            await page.keyboard.press(key);
          }

          await this._awaitNetworkPromises(page, stepArrayIndex, netPromises);
          await this._postActionSettle(page, { hasNetwork: (netPromises?.length || 0) > 0 });
        }

      // ── Scroll ──────────────────────────────────────────────────────────────
      } else if (step.type === 'action.scroll') {
        const scrollY = data.scrollY;
        const scrollX = data.scrollX;
        if (scrollY !== undefined || scrollX !== undefined) {
          await page.evaluate(({ x, y }) => window.scrollTo(x ?? window.scrollX, y ?? window.scrollY), { x: scrollX, y: scrollY });
        } else {
          const deltaY = data.deltaY ?? 0;
          const deltaX = data.deltaX ?? 0;
          await page.evaluate(({ dx, dy }) => window.scrollBy(dx, dy), { dx: deltaX, dy: deltaY });
        }
        }

    } catch (err) {
      throw err;
    }

    // ── Step passed ─────────────────────────────────────────────────────────
    this.report.summary.passed++;
    if (this.report.steps[stepIndex - 1]) {
      this.report.steps[stepIndex - 1].status = 'passed';
    }
  }
}

module.exports = { ReplayEngine };
