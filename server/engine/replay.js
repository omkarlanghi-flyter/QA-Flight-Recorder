const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { evaluateAssertions } = require('./assertions');

class ReplayEngine {
  constructor(events, options = {}) {
    this.events = events || [];
    this.options = options;
    this.profileDir = options.profileDir || path.join(os.homedir(), '.qa-flight-recorder-profile');
    this.cdpUrl = options.cdpUrl || 'http://127.0.0.1:9223';
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
    this.artifactDir = options.artifactDir || null; // directory to write per-step debug artifacts
    this.aborted = false;
    this.browser = null;
    this.activeStepIndex = -1;
    this.report = {
      summary: { total_steps: 0, passed: 0, failed: 0 },
      failures: { ui: [], network: [], js_errors: [] },
      steps: [],
      runtime: { network_events: [], console_events: [] },
      timings: {
        browser_start_time_ms: 0,
        profile_load_time_ms: 0,
        navigation_time_ms: 0,
        selector_resolution_time_ms: 0,
        wait_time_ms: 0,
        assertion_time_ms: 0,
        artifact_capture_time_ms: 0,
        report_generation_time_ms: 0,
        total_run_time_ms: 0,
      },
    };
  }

  async _captureStepArtifact(stepIndex, stepReport, page) {
    if (!this.artifactDir || !page || page.isClosed()) return;
    const tStart = Date.now();
    const stepDir = path.join(this.artifactDir, `step-${stepIndex}`);
    try {
      fs.mkdirSync(stepDir, { recursive: true });
      // Screenshot on failure
      try {
        const screenshotPath = path.join(stepDir, 'screenshot.png');
        await page.screenshot({ path: screenshotPath, fullPage: false });
        stepReport.artifact_paths = stepReport.artifact_paths || [];
        stepReport.artifact_paths.push(screenshotPath);
      } catch (e) {
        stepReport.artifact_errors = stepReport.artifact_errors || [];
        stepReport.artifact_errors.push(`screenshot: ${e.message}`);
      }
      // Debug context
      const debugContext = {
        step_index: stepIndex,
        step_type: stepReport.step_type,
        selector: stepReport.selector,
        error: stepReport.error,
        attempts: stepReport.attempts,
        retry_count: stepReport.retry_count,
        selector_attempt_count: stepReport.selector_attempt_count,
        wait_reason: stepReport.wait_reason,
        wait_duration_ms: stepReport.wait_duration_ms,
        associated_network_failures: stepReport.associated_network_failures || [],
        page_url: page.url(),
        timestamp: Date.now(),
      };
      const debugPath = path.join(stepDir, 'debug.json');
      require('fs').writeFileSync(debugPath, JSON.stringify(debugContext, null, 2));
      stepReport.artifact_paths = stepReport.artifact_paths || [];
      stepReport.artifact_paths.push(debugPath);
    } catch (e) {
      stepReport.artifact_errors = stepReport.artifact_errors || [];
      stepReport.artifact_errors.push(`artifact_dir: ${e.message}`);
    }
    this.report.timings.artifact_capture_time_ms += Date.now() - tStart;
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
    const cdpUrls = [
      this.cdpUrl,
      this.cdpUrl.includes('127.0.0.1') ? 'http://localhost:9223' : 'http://127.0.0.1:9223',
    ];

    const tryConnect = async () => {
      let lastErr = null;
      for (const url of cdpUrls) {
        try {
          this.browser = await chromium.connectOverCDP(url);
          this.cdpUrl = url;
          return true;
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr || new Error('CDP connection failed');
    };

    try {
      await tryConnect();
      return;
    } catch (e) {
      const chromeArgs = [
        `--user-data-dir=${this.profileDir}`,
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=9223',
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank'
      ];
      const candidates = [
        this.options.chromeExecutablePath,
        '/opt/google/chrome/chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        'google-chrome',
        'google-chrome-stable',
        'chromium',
        'chromium-browser',
      ].filter(Boolean);

      let launched = false;
      let launchError = null;
      for (const bin of candidates) {
        try {
          await new Promise((resolve, reject) => {
            const proc = spawn(bin, chromeArgs, { detached: true, stdio: 'ignore' });
            proc.once('error', reject);
            proc.once('spawn', () => {
              proc.unref();
              resolve();
            });
          });
          launched = true;
          break;
        } catch (err) {
          launchError = err;
        }
      }

      if (!launched) {
        throw new Error(`Unable to launch Chrome for replay: ${launchError ? launchError.message : 'no executable found'}`);
      }

      let lastConnectError = null;
      for (let i = 0; i < 12; i++) {
        try {
          await tryConnect();
          return;
        } catch (err) {
          lastConnectError = err;
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      throw new Error(`Chrome started but CDP connect failed on ${this.cdpUrl}: ${lastConnectError ? lastConnectError.message : 'unknown error'}`);
    }
  }

  async run() {
    const runStart = Date.now();
    try {
      const tBrowser = Date.now();
      await this._ensureBrowser();
      this.report.timings.browser_start_time_ms = Date.now() - tBrowser;
      const contexts = this.browser.contexts();
      const context = contexts.length > 0 ? contexts[0] : await this.browser.newContext();
      const tProfile = Date.now();
      this.page = await context.newPage();
      this.report.timings.profile_load_time_ms = Date.now() - tProfile;

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
      // Only content/user-sourced events are replayed; browser-sourced events are
      // automatic duplicates from chrome.tabs.onUpdated that include pre-recording tab noise.
      const rawSteps = this.events.filter(e => {
        if (!e || !e.type || !e.type.startsWith('action.')) return false;
        if (e.type === 'action.navigation') {
          return e.source === 'content';
        }
        if (e.type === 'action.input') {
          // Skip checkbox/radio input events — they are auto-generated noise from
          // the content script's change handler, not intentional user actions.
          const inputType = e.data?.input_type || e.data?.type || '';
          if (inputType === 'checkbox' || inputType === 'radio') return false;
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
          const tNav = Date.now();
          await this.page.goto(this.options.startUrl, { waitUntil: 'domcontentloaded', timeout: this.timeouts.initialNavigation }); 
          await this._waitForNetworkSettled(this.page, 15000, 500);
          this.report.timings.navigation_time_ms += Date.now() - tNav;
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
        retry_count: 0,
        step_start_at: null,
        step_end_at: null,
        step_duration_ms: 0,
        selector_attempt_count: 0,
        selector_resolution_time_ms: 0,
        wait_reason: null,
        wait_duration_ms: 0,
        assertion_duration_ms: 0,
        artifact_duration_ms: 0,
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
      const endTime = Date.now();
      stepReport.step_start_at = startTime;
      stepReport.step_end_at = endTime;
      stepReport.step_duration_ms = endTime - startTime;
      stepReport.duration_ms = endTime - startTime;
      stepReport.attempts = outcome.attempts || (outcome.ok ? 1 : this.retries + 1);
      stepReport.retry_count = Math.max(0, stepReport.attempts - 1);

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
      const finalizeStart = Date.now();
      this.report.timings.total_run_time_ms = finalizeStart - runStart;
      this.report.timings.report_generation_time_ms = Date.now() - finalizeStart;
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
   * Execute an ExecutionPlan (planner output) instead of raw events.
   */
  async runPlan(plan) {
    if (!plan || !Array.isArray(plan.steps)) throw new Error('Invalid plan');

    // reset report for plan run
    this.report = {
      summary: { total_steps: plan.steps.length, passed: 0, failed: 0 },
      failures: { ui: [], network: [], js_errors: [] },
      steps: [],
      runtime: { network_events: [], console_events: [] },
      timings: {
        browser_start_time_ms: 0,
        profile_load_time_ms: 0,
        navigation_time_ms: 0,
        selector_resolution_time_ms: 0,
        wait_time_ms: 0,
        assertion_time_ms: 0,
        artifact_capture_time_ms: 0,
        report_generation_time_ms: 0,
        total_run_time_ms: 0,
      },
    };

    const runStart = Date.now();
    try {
      const tBrowser = Date.now();
      await this._ensureBrowser();
      this.report.timings.browser_start_time_ms = Date.now() - tBrowser;

      const contexts = this.browser.contexts();
      const context = contexts.length > 0 ? contexts[0] : await this.browser.newContext();
      const tProfile = Date.now();
      this.page = await context.newPage();
      this.report.timings.profile_load_time_ms = Date.now() - tProfile;

      // Clean up stray pages
      for (const p of context.pages()) {
        if (p !== this.page) {
          try { await p.close({ runBeforeUnload: false }); } catch (e) {}
        }
      }

      this._attachListeners(this.page);

      for (let i = 0; i < plan.steps.length; i++) {
        const pStep = plan.steps[i];
        if (this.aborted) break;
        const stepReport = {
          index: i + 1,
          step_type: pStep.step_type,
          label: pStep.label,
          selector: (pStep.selector_chain || [])[0]?.value || null,
          status: 'failed',
          duration_ms: 0,
          attempts: 0,
          retry_count: 0,
          step_start_at: null,
          step_end_at: null,
          step_duration_ms: 0,
          selector_attempt_count: 0,
          selector_resolution_time_ms: 0,
          wait_reason: null,
          wait_duration_ms: 0,
          assertion_duration_ms: 0,
          artifact_duration_ms: 0,
          associated_logs: [],
          associated_network_failures: [],
          artifact_paths: [],
          artifact_errors: [],
        };
        this.report.steps.push(stepReport);

        const start = Date.now();
        stepReport.step_start_at = start;
        const outcome = await this._runPlanStepWithRetry(pStep, this.page);
        const end = Date.now();
        stepReport.step_end_at = end;
        stepReport.duration_ms = end - start;
        stepReport.attempts = outcome.attempts;
        stepReport.selector_attempt_count = outcome.selector_attempt_count || stepReport.selector_attempt_count || 0;
        stepReport.selector_resolution_time_ms = outcome.selector_resolution_time_ms || 0;
        stepReport.wait_duration_ms = outcome.wait_duration_ms || 0;
        stepReport.wait_reason = outcome.wait_reason || stepReport.wait_reason;
        stepReport.retry_count = Math.max(0, stepReport.attempts - 1);
        stepReport.step_duration_ms = stepReport.duration_ms;

        if (outcome.ok) {
          stepReport.status = 'passed';
          this.report.summary.passed++;
        } else {
          stepReport.status = 'failed';
          stepReport.error = outcome.error?.message || 'step failed';
          this.report.summary.failed++;
          this.report.failures.ui.push({ step_index: i + 1, type: pStep.step_type, message: stepReport.error });
          await this._captureStepArtifact(i + 1, stepReport, this.page);
          if (this.abortOnFailure) break;
        }

        // Evaluate assertions after action completes
        if (Array.isArray(pStep.assertions) && pStep.assertions.length > 0) {
          const tAssert = Date.now();
          const assertResult = await evaluateAssertions(pStep.assertions, {
            page: this.page,
            report: this.report,
            stepReport,
          });
          const assertDur = Date.now() - tAssert;
          stepReport.assertion_duration_ms = assertDur;
          this.report.timings.assertion_time_ms += assertDur;
          stepReport.assertions = assertResult.results;
          const hardFailures = assertResult.failed.filter(f => !f.soft);
          if (hardFailures.length > 0 && stepReport.status === 'passed') {
            stepReport.status = 'failed';
            this.report.summary.failed++;
            this.report.summary.passed = Math.max(0, this.report.summary.passed - 1);
            this.report.failures.ui.push({ step_index: i + 1, type: pStep.step_type, message: 'assertion failed' });
            await this._captureStepArtifact(i + 1, stepReport, this.page);
          }
        }
      }
    } catch (err) {
      this.report.failures.ui.push({ step_index: this.report.steps.length + 1, type: 'engine_crash', message: err.message });
    } finally {
      const finalizeStart = Date.now();
      this.report.timings.total_run_time_ms = finalizeStart - runStart;
      this.report.timings.report_generation_time_ms = Date.now() - finalizeStart;
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
    const requestMeta = new Map();

    page.on('console', msg => {
      const type = msg.type();
      const rawText = msg.text();
      const text = `[${type}] ${rawText}`;
      this.report.runtime.console_events.push({
        type,
        message: rawText.slice(0, 500),
        ts_epoch_ms: Date.now(),
        step_index: this.activeStepIndex > 0 ? this.activeStepIndex : null,
      });
      if (type === 'error') {
        this.report.failures.js_errors.push({ type: 'console', message: text.slice(0, 300) });
      }
      if (this.activeStepIndex > 0 && this.report.steps[this.activeStepIndex - 1]) {
        this.report.steps[this.activeStepIndex - 1].associated_logs.push(text.slice(0, 200));
      }
    });
    page.on('pageerror', err => {
      this.report.runtime.console_events.push({
        type: 'page_error',
        message: String(err.message || '').slice(0, 500),
        ts_epoch_ms: Date.now(),
        step_index: this.activeStepIndex > 0 ? this.activeStepIndex : null,
      });
      this.report.failures.js_errors.push({ type: 'page_error', message: err.message.slice(0, 300) });
      if (this.activeStepIndex > 0 && this.report.steps[this.activeStepIndex - 1]) {
        this.report.steps[this.activeStepIndex - 1].associated_logs.push(`[uncaught] ${err.message.slice(0, 200)}`);
      }
    });
    page.on('request', req => {
      const meta = {
        url: req.url(),
        method: req.method(),
        started_at: Date.now(),
        step_index: this.activeStepIndex > 0 ? this.activeStepIndex : null,
      };
      requestMeta.set(req, meta);
      this.report.runtime.network_events.push({
        kind: 'request',
        url: meta.url,
        method: meta.method,
        ts_epoch_ms: meta.started_at,
        step_index: meta.step_index,
      });
    });
    page.on('requestfailed', req => {
      const url = req.url();
      const errText = req.failure()?.errorText || 'failed';
      const meta = requestMeta.get(req);
      const now = Date.now();
      const durationMs = meta ? Math.max(0, now - meta.started_at) : null;
      this.report.runtime.network_events.push({
        kind: 'failure',
        url,
        method: req.method(),
        error: errText,
        duration_ms: durationMs,
        ts_epoch_ms: now,
        step_index: meta?.step_index ?? (this.activeStepIndex > 0 ? this.activeStepIndex : null),
      });
      this.report.failures.network.push({ url, error: errText });
      if (this.activeStepIndex > 0 && this.report.steps[this.activeStepIndex - 1]) {
        this.report.steps[this.activeStepIndex - 1].associated_network_failures.push(`${url} → ${errText}`);
      }
      requestMeta.delete(req);
    });
    page.on('response', resp => {
      const status = resp.status();
      const req = resp.request();
      const meta = requestMeta.get(req);
      const now = Date.now();
      const durationMs = meta ? Math.max(0, now - meta.started_at) : null;
      this.report.runtime.network_events.push({
        kind: 'response',
        url: resp.url(),
        method: req.method(),
        status,
        duration_ms: durationMs,
        ts_epoch_ms: now,
        step_index: meta?.step_index ?? (this.activeStepIndex > 0 ? this.activeStepIndex : null),
      });
      if (status >= 400) {
        const url = resp.url();
        this.report.failures.network.push({ url, status, error: `HTTP ${status}` });
        if (this.activeStepIndex > 0 && this.report.steps[this.activeStepIndex - 1]) {
          this.report.steps[this.activeStepIndex - 1].associated_network_failures.push(`${url} → HTTP ${status}`);
        }
      }
      requestMeta.delete(req);
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
    const started = Date.now();
    if (!networkPromises || networkPromises.length === 0) {
      // No correlated network calls — ultra-short settle only
      try { await page.waitForTimeout(120); } catch (e) {}
      return { matched: true, reason: 'no_network_expected', duration_ms: Date.now() - started };
    }

    // Await all pre-registered response promises with a single overall timeout
    const overallCap = this.timeouts.stepBudget || 8000;
    const waitAll = Promise.all(networkPromises);
    const results = await Promise.race([
      waitAll,
      new Promise(resolve => setTimeout(() => resolve(null), overallCap)),
    ]);

    if (results === null) {
      return { matched: false, reason: 'network_timeout', duration_ms: Date.now() - started };
    }

    const anyMatched = Array.isArray(results) ? results.some(Boolean) : Boolean(results);
    if (!anyMatched) {
      return { matched: false, reason: 'network_timeout', duration_ms: Date.now() - started };
    }
    return { matched: true, reason: 'network_ok', duration_ms: Date.now() - started };
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
    const start = Date.now();
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
    return Date.now() - start;
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

  async _runPlanStepWithRetry(planStep, page) {
    const retryCfg = planStep.retry_config || { max_attempts: 1, backoff_ms: 0 };
    let attempt = 0;
    let lastError = null;
    const maxAttempts = Math.max(1, retryCfg.max_attempts || 1);
    let selectorAttemptsAgg = 0;
    let selectorResolutionMsAgg = 0;
    let waitDurationAgg = 0;
    let waitReasonFinal = (planStep.wait_layers || [])[0]?.type || planStep.wait_strategy?.type || 'none';
    while (attempt < maxAttempts) {
      try {
        const result = await this._withStepTimeout(() => this._executePlanStep(planStep, page));
        selectorAttemptsAgg += result?.selector_attempt_count || 0;
        selectorResolutionMsAgg += result?.selector_resolution_time_ms || 0;
        waitDurationAgg += result?.wait_duration_ms || 0;
        waitReasonFinal = result?.wait_reason || waitReasonFinal;
        return { ok: true, attempts: attempt + 1, selector_attempt_count: selectorAttemptsAgg, selector_resolution_time_ms: selectorResolutionMsAgg, wait_duration_ms: waitDurationAgg, wait_reason: waitReasonFinal };
      } catch (err) {
        lastError = err;
        attempt++;
        if (attempt >= maxAttempts) break;
        // Optional recovery: page reload between attempts
        if (planStep.recovery?.reload_on_fail) {
          try { await page.reload({ waitUntil: 'domcontentloaded' }); } catch (e) {}
        }
        const backoff = retryCfg.backoff_ms || 0;
        if (backoff > 0) { try { await page.waitForTimeout(backoff); } catch (e) {} }
      }
    }
    return { ok: false, attempts: attempt, error: lastError };
  }

  async _executePlanStep(step, page) {
    const selectorChain = step.selector_chain || [];
    const baseMeta = (step.meta && typeof step.meta === 'object') ? step.meta : {};
    const meta = {
      ...baseMeta,
      url: step.url !== undefined ? step.url : baseMeta.url,
      value: step.value !== undefined ? step.value : baseMeta.value,
      key: step.key !== undefined ? step.key : baseMeta.key,
      selected_value: step.selected_value !== undefined ? step.selected_value : baseMeta.selected_value,
      selected_text: step.selected_text !== undefined ? step.selected_text : baseMeta.selected_text,
      scroll_x: step.scroll_x !== undefined ? step.scroll_x : baseMeta.scroll_x,
      scroll_y: step.scroll_y !== undefined ? step.scroll_y : baseMeta.scroll_y,
    };
    const waitStrategy = step.wait_strategy || { type: 'none' };
    const stepTiming = {
      selector_resolution_time_ms: 0,
      wait_duration_ms: 0,
      wait_reason: (step.wait_layers || [])[0]?.type || waitStrategy.type || 'none',
      selector_attempt_count: 0,
      wait_breakdown: [],
      artifact_duration_ms: 0,
    };

    const addNavFromBreakdown = (breakdown = []) => {
      const nav = Array.isArray(breakdown) ? breakdown.find(b => b.type === 'network_idle') : null;
      if (nav && typeof nav.duration_ms === 'number') {
        this.report.timings.navigation_time_ms += nav.duration_ms;
      }
    };

    // Resolve locator once (timed) and get attempts
    const resolved = await this._resolveLocatorTimed(page, selectorChain, meta);
    stepTiming.selector_attempt_count = resolved.attempts;
    stepTiming.selector_resolution_time_ms += resolved.duration_ms;
    this.report.timings.selector_resolution_time_ms += resolved.duration_ms;

    const recordWait = (dur, reason, breakdown = []) => {
      stepTiming.wait_duration_ms += dur;
      this.report.timings.wait_time_ms += dur;
      if (reason) stepTiming.wait_reason = reason;
      if (breakdown.length) stepTiming.wait_breakdown = breakdown;
      addNavFromBreakdown(breakdown);
    };

    switch (step.step_type) {
      case 'navigate': {
        if (meta.url) {
          const tNav = Date.now();
          await page.goto(meta.url, { waitUntil: 'domcontentloaded', timeout: waitStrategy.max_ms || this.timeouts.navigation });
          this.report.timings.navigation_time_ms += Date.now() - tNav;
        }
        const tWait = Date.now();
        await this._waitLayers(page, step.wait_layers || [], waitStrategy);
        recordWait(Date.now() - tWait);
        return stepTiming;
      }
      case 'click': {
        const locator = resolved.locator;
        if (locator) {
          await locator.click({ timeout: this.timeouts.click });
        } else if (this._hasCoordinates(selectorChain)) {
          const { x, y } = this._coordsFromChain(selectorChain);
          await page.mouse.click(x, y, { timeout: this.timeouts.click });
        } else {
          throw new Error('No clickable element found');
        }
        const waitRes = await this._waitLayers(page, step.wait_layers || [], waitStrategy);
        recordWait(waitRes.total, waitRes.dominant, waitRes.breakdown);
        const net = waitRes.breakdown.find(b => b.type === 'network_idle');
        if (net) this.report.timings.navigation_time_ms += net.duration_ms;
        return stepTiming;
      }
      case 'fill_field': {
        const locator = resolved.locator;
        if (!locator) throw new Error('Field not found');
        await locator.fill(meta.value ?? '', { timeout: this.timeouts.elementVisible });
        const waitRes = await this._waitLayers(page, step.wait_layers || [], waitStrategy);
        recordWait(waitRes.total, waitRes.dominant, waitRes.breakdown);
        return stepTiming;
      }
      case 'select_option': {
        const locator = resolved.locator;
        if (!locator) throw new Error('Select element not found');
        if (meta.selected_value) {
          await locator.selectOption({ value: meta.selected_value });
        } else if (meta.selected_text) {
          await locator.selectOption({ label: meta.selected_text });
        }
        const waitRes = await this._waitLayers(page, step.wait_layers || [], waitStrategy);
        recordWait(waitRes.total, waitRes.dominant, waitRes.breakdown);
        return stepTiming;
      }
      case 'submit_form': {
        const tSel = Date.now();
        const locator = await this._resolveLocatorFromChain(page, selectorChain, meta);
        const selDur = Date.now() - tSel;
        stepTiming.selector_resolution_time_ms += selDur;
        this.report.timings.selector_resolution_time_ms += selDur;
        if (locator) {
          await locator.click({ timeout: this.timeouts.click });
        } else if (this._hasCoordinates(selectorChain)) {
          const { x, y } = this._coordsFromChain(selectorChain);
          await page.mouse.click(x, y, { timeout: this.timeouts.click });
        } else {
          await page.keyboard.press('Enter');
        }
        const tWait = Date.now();
        await this._waitLayers(page, step.wait_layers || [], waitStrategy);
        recordWait(Date.now() - tWait);
        return stepTiming;
      }
      case 'press_key': {
        if (!meta.key) throw new Error('key is required');
        await page.keyboard.press(meta.key);
        const tWait = Date.now();
        await this._waitLayers(page, step.wait_layers || [], waitStrategy);
        recordWait(Date.now() - tWait);
        return stepTiming;
      }
      case 'scroll': {
        if (typeof meta.scroll_y === 'number' || typeof meta.scroll_x === 'number') {
          await page.mouse.wheel(meta.scroll_x || 0, meta.scroll_y || 0);
        } else {
          await page.mouse.wheel(0, 500);
        }
        const tWait = Date.now();
        await this._waitLayers(page, step.wait_layers || [], waitStrategy);
        recordWait(Date.now() - tWait);
        return stepTiming;
      }
      case 'observe_toast': {
        const locator = await this._resolveLocatorFromChain(page, selectorChain, meta);
        if (locator) {
          await locator.waitFor({ state: 'visible', timeout: waitStrategy.max_ms || 5000 });
        } else {
          const tWait = Date.now();
          await this._waitLayers(page, step.wait_layers || [], waitStrategy);
          recordWait(Date.now() - tWait);
        }
        return stepTiming;
      }
      default:
        return stepTiming; // no-op for raw_action or unknown
    }
  }

  async _waitStrategy(page, strategy = { type: 'none' }) {
    switch ((strategy.type || 'none')) {
      case 'network_idle':
        return this._waitForNetworkSettled(page, strategy.max_ms || 15000, strategy.idle_ms || 500);
      case 'network_settle':
        return this._waitForNetworkSettled(page, strategy.max_ms || 10000, strategy.idle_ms || 300);
      case 'element_visible':
        if (strategy.selector) {
          const loc = page.locator(strategy.selector);
          return loc.waitFor({ state: 'visible', timeout: strategy.max_ms || 5000 }).catch(() => {});
        }
        return page.waitForTimeout(strategy.max_ms || 500);
      case 'dom_change':
        return page.waitForTimeout(strategy.max_ms || 5000);
      case 'none':
      default:
        return page.waitForTimeout(strategy.idle_ms || 0).catch(() => {});
    }
  }

  async _waitLayers(page, layers = [], fallbackStrategy) {
    const breakdown = [];
    if (!Array.isArray(layers) || layers.length === 0) {
      const start = Date.now();
      await this._waitStrategy(page, fallbackStrategy || { type: 'none' });
      const dur = Date.now() - start;
      breakdown.push({ type: fallbackStrategy?.type || 'none', duration_ms: dur });
      return { total: dur, dominant: breakdown[0].type, breakdown };
    }
    for (const layer of layers) {
      if (!layer || this.aborted) break;
      const start = Date.now();
      switch (layer.type) {
        case 'dom_ready':
          try { await page.waitForLoadState('domcontentloaded', { timeout: layer.timeout_ms || 5000 }); } catch (e) {}
          break;
        case 'element_visible':
          if (layer.selector) {
            const loc = page.locator(layer.selector);
            await loc.waitFor({ state: 'visible', timeout: layer.timeout_ms || 5000 }).catch(() => {});
          }
          break;
        case 'network_idle':
          await this._waitForNetworkSettled(page, layer.max_ms || 10000, layer.idle_ms || 300).catch(() => {});
          break;
        case 'timeout_fallback':
          if (layer.timeout_ms) { await page.waitForTimeout(layer.timeout_ms).catch(() => {}); }
          break;
        default:
          break;
      }
      breakdown.push({ type: layer.type || 'unknown', duration_ms: Date.now() - start });
    }
    const total = breakdown.reduce((s, b) => s + b.duration_ms, 0);
    const dominant = breakdown.reduce((max, b) => b.duration_ms > (max?.duration_ms || 0) ? b : max, null)?.type || (fallbackStrategy?.type || 'none');
    return { total, dominant, breakdown };
  }

  async _resolveLocatorTimed(page, chain, meta) {
    const attempts = await this._resolveLocatorFromChain(page, chain, meta, { countOnly: true, returnAttempts: true }) || 0;
    const start = Date.now();
    const locator = await this._resolveLocatorFromChain(page, chain, meta);
    const duration_ms = Date.now() - start;
    return { locator, attempts, duration_ms };
  }

  _countSelectorStrategies(data) {
    const strategies = Array.isArray(data?.selector_strategies) && data.selector_strategies.length > 0
      ? data.selector_strategies
      : data?.selector ? [data.selector] : [];
    return strategies.filter(s => s && s !== 'body').length;
  }

  async _resolveLocatorFromChain(page, chain, meta, options = {}) {
    if (!Array.isArray(chain)) return null;
    let attempts = 0;
    const sorted = chain.sort((a, b) => (a.priority || 99) - (b.priority || 99));
    for (const sel of sorted) {
      if (!sel || !sel.value) continue;
      attempts++;
      if (options.countOnly) continue;
      if (sel.strategy === 'text') {
        const loc = page.getByText(sel.value, { exact: false });
        if (await loc.count().catch(() => 0) > 0) return loc.first();
      } else if (sel.strategy === 'label') {
        try {
          const loc = page.getByLabel(sel.value);
          if (await loc.count().catch(() => 0) > 0) return loc.first();
        } catch (e) {}
      } else if (sel.strategy === 'role') {
        try {
          const loc = page.getByRole(sel.value, sel.options || {});
          if (await loc.count().catch(() => 0) > 0) return loc.first();
        } catch (e) {}
      } else if (sel.strategy === 'data_testid') {
        try {
          const loc = page.locator(`[data-testid="${sel.value}"]`);
          if (await loc.count().catch(() => 0) > 0) return loc.first();
        } catch (e) {}
      } else if (sel.strategy === 'coordinates') {
        continue; // handled by caller
      } else if (sel.strategy === 'xpath') {
        try {
          const loc = page.locator(`xpath=${sel.value}`);
          if (await loc.count().catch(() => 0) > 0) return loc.first();
        } catch (e) {}
      } else {
        try {
          const loc = page.locator(sel.value);
          if (await loc.count().catch(() => 0) > 0) return loc.first();
        } catch (e) {}
      }
    }
    if (options.returnAttempts) return attempts;
    return null;
  }

  _hasCoordinates(chain) {
    if (!Array.isArray(chain)) return false;
    return chain.some(s => s.strategy === 'coordinates' && typeof s.value === 'string' && s.value.includes(','));
  }

  _coordsFromChain(chain) {
    const entry = Array.isArray(chain) ? chain.find(s => s.strategy === 'coordinates') : null;
    if (!entry) return { x: 0, y: 0 };
    const [x, y] = entry.value.split(',').map(v => parseFloat(v));
    return { x: x || 0, y: y || 0 };
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
    const stepReport = this.report.steps[stepIndex - 1] || null;
    const recordSelector = (attempts, dur) => {
      if (!stepReport) return;
      stepReport.selector_attempt_count += attempts;
      stepReport.selector_resolution_time_ms += dur;
      this.report.timings.selector_resolution_time_ms += dur;
    };
    const recordWait = (dur, reason) => {
      if (!stepReport) return;
      stepReport.wait_duration_ms += dur;
      if (!stepReport.wait_reason && reason) stepReport.wait_reason = reason;
      this.report.timings.wait_time_ms += dur;
      if (reason && reason.startsWith('network')) {
        this.report.timings.navigation_time_ms += dur;
      }
    };
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
              const tNav = Date.now();
              await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: this.timeouts.initialNavigation });
              await this._waitForNetworkSettled(page, 15000, 500);
              this.report.timings.navigation_time_ms += Date.now() - tNav;
            } catch (e) {}
        const netResult = await this._awaitNetworkPromises(page, stepArrayIndex, netPromises);
        if (netResult?.duration_ms) recordWait(netResult.duration_ms, netResult.reason);
        const settleDur = await this._postActionSettle(page, { navigation: true, hasNetwork: (netPromises?.length || 0) > 0 });
        recordWait(settleDur, netResult?.reason || 'post_action_settle');
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
            if (netResult?.duration_ms) recordWait(netResult.duration_ms, netResult.reason);
            const settleDur = await this._postActionSettle(page, { navigation: true, hasNetwork: (netPromises?.length || 0) > 0 });
            recordWait(settleDur, netResult?.reason || 'post_action_settle');
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

        const selStart = Date.now();
        const locator = await this._resolveLocator(page, data);
        recordSelector(this._countSelectorStrategies(data), Date.now() - selStart);
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
        if (netResult?.duration_ms) recordWait(netResult.duration_ms, netResult.reason);
        const settleDur = await this._postActionSettle(page, { hasNetwork: (netPromises?.length || 0) > 0 });
        recordWait(settleDur, netResult?.reason || 'post_action_settle');
        if (netPromises.length > 0 && !netResult?.matched) {
          if (this.strictNetworkWait) {
            throw new Error(netResult?.reason || 'network wait failed');
          } else if (this.report.steps[stepIndex - 1]) {
            this.report.steps[stepIndex - 1].warning = netResult?.reason || 'network wait failed';
          }
        }

      // ── Input ───────────────────────────────────────────────────────────────
      } else if (step.type === 'action.input') {
        const selStart = Date.now();
        const inputType = data.input_type || data.type || '';
        const isCheckable = inputType === 'checkbox' || inputType === 'radio';
        const locator = await this._resolveLocator(page, data);
        recordSelector(this._countSelectorStrategies(data), Date.now() - selStart);
        if (locator) {
          await locator.waitFor({ state: 'visible', timeout: this.timeouts.elementVisible });
          if (isCheckable) {
            const checked = data.final_value === 'true' || data.final_value === 'on';
            await locator.setChecked(checked, { timeout: this.timeouts.click });
          } else {
            // Clear field first, then fill with final value
            await locator.clear({ timeout: this.timeouts.click }).catch(() => {});
            await locator.fill(String(data.final_value ?? data.text ?? ''), { timeout: this.timeouts.click });
          }
        } else {
          const tried = (data.selector_strategies || (data.selector ? [data.selector] : [])).join(' | ');
          throw new Error(`Input element not found. Tried: ${tried || 'no selectors'}`);
        }
        const settleDur = await this._postActionSettle(page, { hasNetwork: false });
        recordWait(settleDur, 'post_action_settle');

      // ── Select Dropdown ─────────────────────────────────────────────────────
      } else if (step.type === 'action.select') {
        const netPromises = this._buildResponsePromises(page, stepArrayIndex);
        const selStart = Date.now();
        const locator = await this._resolveLocator(page, data);
        recordSelector(this._countSelectorStrategies(data), Date.now() - selStart);
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
        if (netResult?.duration_ms) recordWait(netResult.duration_ms, netResult.reason);
        const settleDur = await this._postActionSettle(page, { hasNetwork: (netPromises?.length || 0) > 0 });
        recordWait(settleDur, netResult?.reason || 'post_action_settle');
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
            const selStart = Date.now();
            const locator = await this._resolveLocator(page, data);
            recordSelector(this._countSelectorStrategies(data), Date.now() - selStart);
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
          if (netResult?.duration_ms) recordWait(netResult.duration_ms, netResult.reason);
          const settleDur = await this._postActionSettle(page, { hasNetwork: (netPromises?.length || 0) > 0 });
          recordWait(settleDur, netResult?.reason || 'post_action_settle');
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
        const settleDur = await this._postActionSettle(page, { hasNetwork: false });
        recordWait(settleDur, 'post_action_settle');
        }

    } catch (err) {
      throw err;
    }

    // Step pass/fail accounting is handled by caller loops.
  }
}

module.exports = { ReplayEngine };
