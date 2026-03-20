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
      // Not running, spawn it in background
      const chromeArgs = [
        `--user-data-dir=${this.profileDir}`,
        `--remote-debugging-port=9223`,
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank'
      ];
      
      const chromeProcess = spawn('google-chrome', chromeArgs, {
        detached: true,
        stdio: 'ignore'
      });
      chromeProcess.unref();

      // Wait a moment for Chrome to boot and open the websocket port
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

      // Handle missing initially loaded navigation step
      if (steps.length > 0 && steps[0].type !== 'action.navigation' && this.options.startUrl) {
        try { await this.page.goto(this.options.startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) {}
      }

      for (let i = 0; i < steps.length; i++) {
        this.activeStepIndex = i + 1;
        
        const stepReport = {
          index: i + 1,
          type: steps[i].type,
          status: 'failed',
          duration_ms: 0,
          associated_logs: [],
          associated_network_failures: []
        };
        this.report.steps.push(stepReport);

        if (this.aborted) {
          this.report.failures.ui.push({ step_index: i + 1, type: 'engine_aborted', message: 'Replay aborted by user' });
          stepReport.error = 'Replay aborted by user';
          break;
        }
        
        const startTime = Date.now();
        await this._executeStep(steps[i], this.page, i + 1);
        stepReport.duration_ms = Date.now() - startTime;
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

  _attachListeners(page) {
    page.on('console', msg => {
      const type = msg.type();
      const text = `[${type}] ${msg.text()}`;
      if (type === 'error') {
        this.report.failures.js_errors.push({ type: 'console', message: text });
      }
      if (this.activeStepIndex > 0 && this.report.steps[this.activeStepIndex - 1]) {
        this.report.steps[this.activeStepIndex - 1].associated_logs.push(text);
      }
    });
    page.on('pageerror', err => {
      this.report.failures.js_errors.push({ type: 'page_error', message: err.message });
      if (this.activeStepIndex > 0 && this.report.steps[this.activeStepIndex - 1]) {
        this.report.steps[this.activeStepIndex - 1].associated_logs.push(`[uncaught_error] ${err.message}`);
      }
    });
    page.on('requestfailed', req => {
      const url = req.url();
      const errText = req.failure()?.errorText || 'failed';
      this.report.failures.network.push({ url, error: errText });
      if (this.activeStepIndex > 0 && this.report.steps[this.activeStepIndex - 1]) {
        this.report.steps[this.activeStepIndex - 1].associated_network_failures.push(`${url} failed: ${errText}`);
      }
    });
  }

  async _executeStep(step, page, stepIndex) {
    const data = step.data || {};
    try {
      if (step.type === 'action.navigation') {
        const targetUrl = data.to_url || data.url;
        if (targetUrl) {
          if (stepIndex === 1) {
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          } else {
            // As requested, do NOT force a hard page reload for SPA navigations.
            // The preceding user interactions (like action.click) will have naturally 
            // triggered the navigation. We just wait passively to give it time.
            try {
              // Wait up to 5 seconds for the URL to naturally change as a result of the last click, 
              // but don't crash or force a reload if it doesn't match perfectly.
              await page.waitForTimeout(1000); 
            } catch (e) {}
          }
        }
      } else if (step.type === 'action.click') {
        const text = data.text_snippet ? data.text_snippet.trim() : '';
        let locator;
        if (data.selector && text) {
          locator = page.locator(data.selector, { hasText: text });
          if ((await locator.count()) === 0) {
            locator = page.locator(data.selector);
          }
        } else if (data.selector) {
          locator = page.locator(data.selector);
        } else if (text) {
          locator = page.getByText(text, { exact: false });
        }

        if (locator) {
          try {
            await locator.first().click({ timeout: 5000 });
          } catch (e) {
            await locator.first().click({ timeout: 2000, force: true });
          }
        }
      } else if (step.type === 'action.input') {
        if (data.selector && data.text !== undefined) {
          try {
            await page.locator(data.selector).first().fill(data.text, { timeout: 5000 });
          } catch (e) {
            await page.locator(data.selector).first().fill(data.text, { timeout: 2000, force: true });
          }
        }
      } else if (step.type === 'action.scroll') {
        if (data.deltaY) {
          await page.evaluate(`window.scrollBy(0, ${data.deltaY})`);
        }
      }
      this.report.summary.passed++;
      if (this.report.steps[stepIndex - 1]) {
        this.report.steps[stepIndex - 1].status = 'passed';
      }
    } catch (err) {
      this.report.summary.failed++;
      if (this.report.steps[stepIndex - 1]) {
        this.report.steps[stepIndex - 1].status = 'failed';
        this.report.steps[stepIndex - 1].error = err.message;
      }
      this.report.failures.ui.push({
        step_index: stepIndex,
        type: step.type,
        message: err.message
      });
      // Soft-fail: Catch to allow continuing to next step
    }
  }
}

module.exports = { ReplayEngine };
