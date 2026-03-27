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
      elementVisible: 5000,
      click: 5000,
      navigation: 10000,
      initialNavigation: 30000,
      networkIdle: 15000,
      navigationIdle: 4000,
      settleDelay: options.stepDelay !== undefined ? options.stepDelay : 1000,
      stepBudget: 15000,
    };
    this.slowRequestFactor = options.slowRequestFactor || 1.5;
    this.minAdaptiveWait = options.minAdaptiveWait || 1000;
    this.strictNetworkWait = options.strictNetworkWait || false; // if true, network missing = fail; else warn
    this.abortOnFailure = options.abortOnFailure || false; // if true, stop replay on first failure
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
      try { await this.page.close({ runBeforeUnload: false }); } catch (e) {}
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

      // Kill any rogue pages left over from previous aborted replays in the persistent Chrome process
      for (const p of context.pages()) {
        if (p !== this.page) {
          try { await p.close({ runBeforeUnload: false }); } catch (e) {}
        }
      }

      // Prevent untracked popups (like documentation links) from stealing focus
      context.on('page', async (newPage) => {
        if (newPage !== this.page) {
          try {
            await newPage.close();
            await this.page.bringToFront().catch(() => {});
          } catch (e) {
            // New page might have closed itself or already been handled
          }
        }
      });

      this._attachListeners(this.page);

      // Filter to actionable steps only (ignore stray/duplicate actions outside recorder context)
      const rawSteps = this.events.filter(e => {
        if (!e || !e.type || !e.type.startsWith('action.')) return false;
        if (e.type === 'action.navigation') {
          return e.source === 'browser' || e.source === 'content';
        }
        return e.source === 'content' || e.source === 'user';
      });

      // Restrict to actions occurring at/after the first recorded user/content action to avoid replaying pre-recording tab events
      const firstActionTs = rawSteps
        .filter(e => e.ts_epoch_ms)
        .reduce((min, e) => Math.min(min, e.ts_epoch_ms), Number.POSITIVE_INFINITY);

      const dedupSet = new Set();
      const steps = rawSteps
        .filter(e => !e.ts_epoch_ms || e.ts_epoch_ms >= firstActionTs)
        .filter(e => {
          // Deduplicate identical action at the same timestamp
          const key = `${e.type}::${e.data?.selector || ''}::${e.ts_epoch_ms || ''}`;
          if (dedupSet.has(key)) return false;
          dedupSet.add(key);
          return true;
        });

      this.report.summary.total_steps = steps.length;

      // Pre-compute timing info and correlation for network-aware waits
      this._timingsByPath = this._buildTimingByPath();
      this._networkIndex = this._buildNetworkIndex(steps);

      // Handle missing initial navigation
      if (steps.length > 0 && steps[0].type !== 'action.navigation' && this.options.startUrl) {
        try { 
          await this.page.goto(this.options.startUrl, { waitUntil: 'domcontentloaded', timeout: this.timeouts.initialNavigation }); 
          await this._waitForNetworkSettled(this.page, 15000, 500);
        } catch (e) {}
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
        if (this.abortOnFailure) {
          break;
        }
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
        try { await this.page.close({ runBeforeUnload: false }); } catch (e) {}
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
          .slice(0, 1); // Keep only the primary correlated URL to reduce wait overhead
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
    const fallback = 3000;
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

  async _waitForNetworkSettled(page, maxWaitMs = 15000, idleTime = 500) {
    return new Promise(resolve => {
      let inflight = 0;
      let idleTimer = null;
      let resolved = false;

      const finish = () => {
        if (resolved) return;
        resolved = true;
        if (abortInterval) clearInterval(abortInterval);
        page.removeListener('request', onRequest);
        page.removeListener('requestfinished', onDone);
        page.removeListener('requestfailed', onDone);
        resolve();
      };

      const abortInterval = setInterval(() => {
        if (this.aborted || page.isClosed()) {
          finish();
        }
      }, 500);

      const resetTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (inflight === 0) {
          idleTimer = setTimeout(finish, idleTime);
        }
      };

      const onRequest = (req) => {
        const type = req.resourceType();
        if (['fetch', 'xhr', 'document', 'script'].includes(type) && !req.url().startsWith('data:')) {
          inflight++;
          if (idleTimer) clearTimeout(idleTimer);
        }
      };

      const onDone = (req) => {
        const type = req.resourceType();
        if (['fetch', 'xhr', 'document', 'script'].includes(type) && !req.url().startsWith('data:')) {
          inflight = Math.max(0, inflight - 1);
          resetTimer();
        }
      };

      page.on('request', onRequest);
      page.on('requestfinished', onDone);
      page.on('requestfailed', onDone);

      // Master fallback
      setTimeout(finish, maxWaitMs);
      
      // Kick off
      resetTimer();
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
    const waitTimeMs = this.timeouts.elementVisible;
    const startTime = Date.now();

    while (Date.now() - startTime < waitTimeMs) {
      if (this.aborted || page.isClosed()) return null;

      for (const sel of strategies) {
        if (!sel || sel === 'body') continue;
        
        try {
            // First try strict match with text (highly preferred uniqueness check)
            if (text) {
                const locText = page.locator(sel, { hasText: text });
                // If it resolves exactly 1 element, we confidently return it.
                // Playwright action handlers (like click) will inherently wait for visibility automatically.
                if (await locText.count() === 1) return locText.first();
            }

            // Then try strict match without text
            const locStrict = page.locator(sel);
            if (await locStrict.count() === 1) return locStrict.first();
        } catch (e) {
            // ignore invalid selectors
        }
      }

      await page.waitForTimeout(250).catch(() => {});
    }

    // Desperation path: timeout reached, just grab the FIRST element matching ANY strategy within the priority order,
    // prioritizing ones that at least match the text snippet. Playwright will enforce visibility/actionability on it.
    for (const sel of strategies) {
      if (!sel || sel === 'body') continue;
      try {
        if (text) {
          const locText = page.locator(sel, { hasText: text }).first();
          if (await locText.count() > 0) return locText;
        }
        const loc = page.locator(sel).first();
        if (await loc.count() > 0) return loc;
      } catch (e) {}
    }

    return null;
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
      // No correlated network calls — ultra-short settle only
      try { await page.waitForTimeout(120); } catch (e) {}
      return { matched: true, reason: 'no_network_expected' };
    }

    // Await all pre-registered response promises with a single overall timeout
    const overallCap = this.timeouts.stepBudget || 8000;
    const waitAll = Promise.all(networkPromises);
    const results = await Promise.race([
      waitAll,
      new Promise(resolve => setTimeout(() => resolve(null), overallCap)),
    ]);

    if (results === null) {
      return { matched: false, reason: 'network_timeout' };
    }

    const anyMatched = Array.isArray(results) ? results.some(Boolean) : Boolean(results);
    if (!anyMatched) {
      return { matched: false, reason: 'network_timeout' };
    }
    return { matched: true, reason: 'network_ok' };
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
      ).then(() => true).catch(() => false); // timeout is not a failure but marked false
    });
  }

  async _postActionSettle(page, opts = {}) {
    if (opts.navigation) {
      try { await page.waitForLoadState('domcontentloaded'); } catch (e) {}
    }
    
    // Intelligently wait for dynamically triggered cascading API calls (XHR/Fetch) to settle
    try { await this._waitForNetworkSettled(page, 10000, 400); } catch (e) {}

    // Finally apply the fallback UI padding delay for CSS animations and rendering
    const delay = this.timeouts.settleDelay;
    if (delay > 0) {
      try { await page.waitForTimeout(delay); } catch (e) {}
    }
  }

  _retriesForStep(step) {
    // Heavier actions get the default retries; cheap actions get fewer to stay fast
    if (step.type === 'action.click' || step.type === 'action.navigation' || step.type === 'action.select') return this.retries;
    if (step.type === 'action.keydown') return Math.max(1, this.retries - 1);
    return Math.max(1, this.retries - 1); // input/scroll
  }

  async _runStepWithRetry(step, page, stepIndex, stepArrayIndex) {
    let lastError = null;
    const maxAttempts = this._retriesForStep(step) + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await this._withStepTimeout(() => this._executeStep(step, page, stepIndex, stepArrayIndex));
        return { ok: true, attempts: attempt + 1 };
      } catch (err) {
        lastError = err;
        if (attempt >= maxAttempts - 1) break;
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
            try {
              await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: this.timeouts.initialNavigation });
              await this._waitForNetworkSettled(page, 15000, 500);
            } catch (e) {}
        const netResult = await this._awaitNetworkPromises(page, stepArrayIndex, netPromises);
        await this._postActionSettle(page, { navigation: true, hasNetwork: (netPromises?.length || 0) > 0 });
        if (netPromises.length > 0 && !netResult?.matched) {
          if (this.strictNetworkWait) {
            throw new Error(netResult?.reason || 'network wait failed');
          } else if (this.report.steps[stepIndex - 1]) {
            this.report.steps[stepIndex - 1].warning = netResult?.reason || 'network wait failed';
          }
        }
          } else {
            // User feedback: skip explicit waiting or forced reload for navigations after initial page load.
            // Let the click naturally navigate exactly as the user experienced it.
            try { await page.waitForTimeout(100); } catch(e){}
            const netResult = await this._awaitNetworkPromises(page, stepArrayIndex, netPromises);
            await this._postActionSettle(page, { navigation: true, hasNetwork: (netPromises?.length || 0) > 0 });
            if (netPromises.length > 0 && !netResult?.matched) {
              if (this.strictNetworkWait) {
                throw new Error(netResult?.reason || 'network wait failed');
              } else if (this.report.steps[stepIndex - 1]) {
                this.report.steps[stepIndex - 1].warning = netResult?.reason || 'network wait failed';
              }
            }
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
          if (typeof data.x === 'number' && typeof data.y === 'number') {
            await page.mouse.click(data.x, data.y, { timeout: this.timeouts.click }).catch(() => {});
          } else {
            const tried = (data.selector_strategies || (data.selector ? [data.selector] : [])).join(' | ');
            throw new Error(`Element not found. Tried: ${tried || 'no selectors'}`);
          }
        }

        const netResult = await this._awaitNetworkPromises(page, stepArrayIndex, netPromises);
        await this._postActionSettle(page, { hasNetwork: (netPromises?.length || 0) > 0 });
        if (netPromises.length > 0 && !netResult?.matched) {
          if (this.strictNetworkWait) {
            throw new Error(netResult?.reason || 'network wait failed');
          } else if (this.report.steps[stepIndex - 1]) {
            this.report.steps[stepIndex - 1].warning = netResult?.reason || 'network wait failed';
          }
        }

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
        const netResult = await this._awaitNetworkPromises(page, stepArrayIndex, netPromises);
        await this._postActionSettle(page, { hasNetwork: (netPromises?.length || 0) > 0 });
        if (netPromises.length > 0 && !netResult?.matched) {
          if (this.strictNetworkWait) {
            throw new Error(netResult?.reason || 'network wait failed');
          } else if (this.report.steps[stepIndex - 1]) {
            this.report.steps[stepIndex - 1].warning = netResult?.reason || 'network wait failed';
          }
        }

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

          const netResult = await this._awaitNetworkPromises(page, stepArrayIndex, netPromises);
          await this._postActionSettle(page, { hasNetwork: (netPromises?.length || 0) > 0 });
          if (netPromises.length > 0 && !netResult?.matched) {
            if (this.strictNetworkWait) {
              throw new Error(netResult?.reason || 'network wait failed');
            } else if (this.report.steps[stepIndex - 1]) {
              this.report.steps[stepIndex - 1].warning = netResult?.reason || 'network wait failed';
            }
          }
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
