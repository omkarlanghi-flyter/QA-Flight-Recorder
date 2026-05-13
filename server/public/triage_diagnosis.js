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

    if (t === 'network.failure') {
      return { cls: critStyle, msg: '🚨 CRITICAL: The API endpoint crashed or was blocked by CORS. The server did not respond.' };
    }

    if (t === 'network.response' && Number.isFinite(statusNum)) {
      if (statusNum >= 500) return { cls: critStyle, msg: '🚨 CRITICAL BUG: Backend server crashed (5xx). Check server logs.' };
      if (statusNum === 401 || statusNum === 403) return { cls: warnStyle, msg: '⚠ AUTHENTICATION BUG: User is not logged in or lacks permissions (40x).' };
      if (statusNum === 404) return { cls: warnStyle, msg: '⚠ NOT FOUND: The application requested a resource that does not exist (404).' };
      if (statusNum === 400 || statusNum === 422) return { cls: warnStyle, msg: '⚠ VALIDATION BUG: Frontend sent an invalid request payload (400/422). Check request body.' };
    }

    if (t === 'runtime.exception') {
      return { cls: critStyle, msg: '🚨 CRITICAL APP CRASH: A JavaScript error halted the application thread. See stack trace.' };
    }

    return null;
  };
});
