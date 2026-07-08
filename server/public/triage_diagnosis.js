'use strict';

(function initTriageDiagnosis(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.analyzeTriageEventRule = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAnalyzer() {
  return function analyzeTriageEventRule(ev) {
    const d = (ev && ev.data) || {};
    const t = (ev && (ev.event_type || ev.type)) || '';
    const critStyle = 'critical';
    const warnStyle = 'warning';
    const statusNum = Number(d.status ?? d.response_status);
    const critIcon = '<svg class="icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:3px;"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
    const warnIcon = '<svg class="icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:3px;"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

    if (t === 'network.failure') {
      return { cls: critStyle, msg: critIcon + 'CRITICAL: The API endpoint crashed or was blocked by CORS. The server did not respond.' };
    }

    if (t === 'network.response' && Number.isFinite(statusNum)) {
      if (statusNum >= 500) return { cls: critStyle, msg: critIcon + 'CRITICAL BUG: Backend server crashed (5xx). Check server logs.' };
      if (statusNum === 401 || statusNum === 403) return { cls: warnStyle, msg: warnIcon + 'AUTHENTICATION BUG: User is not logged in or lacks permissions (40x).' };
      if (statusNum === 404) return { cls: warnStyle, msg: warnIcon + 'NOT FOUND: The application requested a resource that does not exist (404).' };
      if (statusNum === 400 || statusNum === 422) return { cls: warnStyle, msg: warnIcon + 'VALIDATION BUG: Frontend sent an invalid request payload (400/422). Check request body.' };
    }

    if (t === 'runtime.exception') {
      return { cls: critStyle, msg: critIcon + 'CRITICAL APP CRASH: A JavaScript error halted the application thread. See stack trace.' };
    }

    return null;
  };
});
