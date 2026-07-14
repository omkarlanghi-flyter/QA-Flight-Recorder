/**
 * app.js - QA Flight Recorder Viewer UI Logic (v2)
 */
const API = window.location.origin;
let currentSessionId = null;
let currentTab = 'overview';
let allSessionsCache = [];
let allEventsCache = [];
let allInputEventsCache = [];
let allWsConnectionsCache = [];
let wsFilter = 'all';
let triageFilter = 'all';
let triageHideMuted = true; // muted errors are hidden by default — this is what makes "Ignore" actually declutter
let ignoredSignatures = new Set(); // globally muted error sigs

// ── Icon System ──────────────────────────────────────────────────────────────
// Small Feather-style line-icon set (24x24, stroke=currentColor) used everywhere
// instead of raw color emoji, so the chrome renders consistently across OS/fonts.
const ICONS = {
  logo: '<path d="M22 2 11 13"/><path d="M22 2 15 22 11 13 2 9 22 2z"/>',
  sun: '<circle cx="12" cy="12" r="5"/><path d="M12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.5 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.65 4.36A9 9 0 0 0 20.5 15"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  barChart: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  mousePointer: '<path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="M13 13l6 6"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  film: '<rect x="2" y="2" width="20" height="20" rx="2"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/>',
  play: '<polygon points="5 3 19 12 5 21 5 3"/>',
  pause: '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
  stop: '<rect x="4" y="4" width="16" height="16" rx="2"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  checkSquare: '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  alertTriangle: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  alertOctagon: '<polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  checkCircle: '<circle cx="12" cy="12" r="10"/><polyline points="16 8 10.5 15 8 12.5"/>',
  infoCircle: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="11"/><line x1="12" y1="7.5" x2="12.01" y2="7.5"/>',
  globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  bug: '<rect x="8" y="6" width="8" height="14" rx="4"/><path d="M19 7l-3 2M5 7l3 2M19 19l-3-2M5 19l3-2M12 6V3M9.5 3.5 12 6l2.5-2.5M2 13h4M18 13h4"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  arrowDown: '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>',
  arrowUp: '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  film2: '<rect x="1" y="4" width="15" height="16" rx="2"/><path d="M16 8l6-3v14l-6-3"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  slack: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
};

function icon(name, size, extra) {
  const body = ICONS[name] || '';
  const cls = 'icon' + (extra ? ' ' + extra : '');
  return `<svg class="${cls}" width="${size || 14}" height="${size || 14}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}
window.icon = icon;

// ── Theme ─────────────────────────────────────────────────────────────────────
function toggleTheme() {
  const html = document.documentElement;
  const isDark = html.dataset.theme === 'dark';
  html.dataset.theme = isDark ? 'light' : 'dark';
  document.getElementById('theme-toggle').innerHTML = icon(isDark ? 'moon' : 'sun', 15);
  localStorage.setItem('qa-theme', html.dataset.theme);
}

; (function initTheme() {
  const saved = localStorage.getItem('qa-theme') || 'light';
  document.documentElement.dataset.theme = saved;
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.innerHTML = icon(saved === 'dark' ? 'sun' : 'moon', 15);
})();

// ── Utilities ─────────────────────────────────────────────────────────────────
function formatDuration(ms) {
  if (!ms) return '—';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function formatTs(epochMs, sessionStartMs) {
  if (!epochMs) return '—';
  if (sessionStartMs) {
    const rel = epochMs - sessionStartMs;
    const sign = rel >= 0 ? '+' : '-';
    return `${sign}${formatDuration(Math.abs(rel))}`;
  }
  return new Date(epochMs).toLocaleTimeString();
}

function formatDate(epochMs) {
  if (!epochMs) return '—';
  const d = new Date(epochMs);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatBrowserInfo(raw) {
  if (!raw) return null;
  let info;
  try { info = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (!info || typeof info !== 'object') return null;

  let browser = 'Browser';
  const ua = info.user_agent || '';
  const m = ua.match(/(Chrome|Edg|Firefox|Safari)\/(\d+)/);
  if (m) browser = `${m[1] === 'Edg' ? 'Edge' : m[1]} ${m[2]}`;

  let os = info.platform || '';
  if (/Mac/i.test(os)) os = 'macOS';
  else if (/Win/i.test(os)) os = 'Windows';
  else if (/Linux/i.test(os)) os = 'Linux';

  const parts = [browser, os, info.viewport_width && info.viewport_height ? `${info.viewport_width}×${info.viewport_height}` : null]
    .filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getEventType(event) {
  if (!event || typeof event !== 'object') return '';
  const t = event.event_type || event.type || '';
  return typeof t === 'string' ? t : '';
}

function normalizeEventType(event) {
  if (!event || typeof event !== 'object') return event;
  const t = getEventType(event);
  if (!t) return event;
  if (event.event_type === t && event.type === t) return event;
  return { ...event, event_type: t, type: t };
}

function normalizeEventList(events) {
  if (!Array.isArray(events)) return [];
  return events.map(normalizeEventType);
}

function showToast(msg, type = 'info') {
  const toast = document.getElementById('toast');
  const iconName = type === 'error' ? 'alertTriangle' : type === 'success' ? 'checkCircle' : 'infoCircle';
  const color = type === 'error' ? 'var(--danger)' : type === 'success' ? 'var(--success)' : 'var(--accent)';
  toast.innerHTML = `<span style="color:${color};display:flex;">${icon(iconName, 16)}</span><span>${esc(msg)}</span>`;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

function getTypeClass(type) {
  if (!type) return '';
  if (type.startsWith('action.')) return 'type-action';
  if (type === 'network.failure' || type === 'network.ws_error') return 'type-network-fail';
  if (type.startsWith('network.')) return 'type-network';
  if (type === 'console.error' || type === 'runtime.exception') return 'type-error';
  if (type.startsWith('console.') || type === 'system.warning') return 'type-console';
  if (type.startsWith('marker.')) return 'type-marker';
  return '';
}

function getTriageClass(type) {
  if (!type) return '';
  if (['console.error', 'runtime.exception'].includes(type)) return 'is-error';
  if (type === 'console.warn') return 'is-warn';
  if (type.startsWith('action.')) return 'is-action';
  if (type.startsWith('network.')) return 'is-network';
  if (type.startsWith('marker.')) return 'is-marker';
  return '';
}

function prettyJson(raw) {
  if (!raw) return '';
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}

function makePayloadAccordion(label, content, isError) {
  if (!content) return '';
  const colorClass = isError ? 'color:var(--danger)' : 'color:var(--accent)';
  const pretty = prettyJson(content);
  return `<details class="payload-accordion"><summary style="cursor:pointer;font-weight:600;${colorClass};font-size:11px;padding:3px 0;">${label}</summary><pre class="payload-pre">${esc(pretty)}</pre></details>`;
}

function makeHeadersAccordion(label, headers) {
  if (!headers || !Object.keys(headers).length) return '';
  const rows = Object.entries(headers).map(([k, v]) =>
    `<tr><td style="color:var(--text-muted);padding-right:12px;white-space:nowrap;font-weight:600;">${esc(k)}</td><td style="word-break:break-all;">${esc(String(v))}</td></tr>`
  ).join('');
  return `<details class="payload-accordion"><summary style="cursor:pointer;font-weight:600;color:var(--text-muted);font-size:11px;padding:3px 0;">${label} (${Object.keys(headers).length})</summary><table style="font-size:10px;margin-top:4px;border-collapse:collapse;width:100%;">${rows}</table></details>`;
}

function summarizeEvent(event) {
  const d = event.data || {};
  const type = getEventType(event);
  let summary = '';
  const isNetworkError = type === 'network.failure' ||
    (type === 'network.response' && d.status >= 400);

  switch (type) {
    case 'action.click': summary = `Click: ${d.text_snippet || ''} (${d.selector || ''})`; break;
    case 'action.scroll': summary = `Scroll deltaY=${d.deltaY}`; break;
    case 'action.navigation': summary = `Nav: ${d.from_url || ''} → ${d.to_url || ''}`; break;
    case 'network.request': summary = `${d.method || 'GET'} ${d.url_full || d.url_sanitized || ''}`; break;
    case 'network.response': summary = `${d.status} ${d.mimeType || ''} ${d.url_full || d.url_sanitized || ''}`; break;
    case 'network.failure': summary = `FAILED ${d.errorText || ''} — ${d.url_full || d.url_sanitized || ''}`; break;
    case 'network.timing': summary = `${d.method || ''} ${d.response_status ? d.response_status + ' ' : ''}${d.duration_ms}ms — ${d.url_full || d.url_sanitized || ''}`; break;
    case 'network.ws_open': summary = `WS OPEN ${d.url_full || d.url_sanitized || ''}`; break;
    case 'network.ws_handshake': summary = `WS HANDSHAKE ${d.status || ''} ${d.statusText || ''} — ${d.url_sanitized || ''}`; break;
    case 'network.ws_frame': summary = `WS ${d.direction === 'sent' ? '↑' : '↓'} ${d.size ?? ''}B — ${d.url_sanitized || ''}`; break;
    case 'network.ws_error': summary = `WS ERROR: ${d.errorMessage || ''} — ${d.url_sanitized || ''}`; break;
    case 'network.ws_tail': summary = `WS TAIL: recovered ${d.frames?.length || 0} frame(s) leading up to ${d.reason || 'event'} — ${d.url_sanitized || ''}`; break;
    case 'network.ws_close': summary = `WS CLOSE ${d.frames_sent || 0}↑/${d.frames_received || 0}↓ frames — ${d.url_sanitized || ''}`; break;
    case 'console.warn': summary = `WARN: ${d.message || d.text || ''}`; break;
    case 'console.error': summary = `ERROR: ${d.message || d.text || ''}`; break;
    case 'runtime.exception': summary = `EXC: ${d.message || ''}`; break;
    case 'marker.bug': summary = `🐛 Bug Marker: ${d.note || ''}`; break;
    case 'system.warning': summary = `⚠️ ${d.message || ''}`; break;
    case 'action.input': summary = `Fill: ${d.selector || ''}${d.is_sensitive ? ' = ***' : d.final_value ? ` = '${d.final_value}'` : ''}`; break;
    case 'action.select': summary = `Select: ${d.selected_text || d.selected_value || ''} (${d.selector || ''})`; break;
    case 'action.keydown': summary = `Key: ${d.key || ''} (${d.selector || ''})`; break;
    case 'dom.state_change': summary = `${d.kind ? d.kind[0].toUpperCase() + d.kind.slice(1) : 'DOM change'}${d.role ? ` (${d.role})` : ''}${d.text ? `: ${d.text}` : ''}`; break;
    default: summary = type || 'Unknown event';
  }

  // Build accordions for payloads and headers
  let payloadHtml = '';
  payloadHtml += makePayloadAccordion('Request Body', d.request_body, false);
  payloadHtml += makeHeadersAccordion('Request Headers', d.request_headers);
  payloadHtml += makePayloadAccordion('Response Body', d.response_body, isNetworkError);
  payloadHtml += makeHeadersAccordion('Response Headers', d.response_headers);

  return esc(summary) + payloadHtml;
}

function analyzeTriageEvent(ev) {
  if (typeof analyzeTriageEventRule === 'function') return analyzeTriageEventRule(ev);
  return null;
}

// ── Copy to Clipboard ─────────────────────────────────────────────────────────
async function copyEventText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied to clipboard', 'success');
  } catch {
    showToast('Copy failed', 'error');
  }
}

// ── Global Stats ──────────────────────────────────────────────────────────────
async function loadGlobalStats() {
  try {
    const res = await fetch(`${API}/stats`);
    if (!res.ok) throw new Error();
    const s = await res.json();
    document.getElementById('gs-total').textContent = s.total;
    document.getElementById('gs-recording').textContent = s.recording;
    document.getElementById('gs-clean').textContent = s.clean;
    document.getElementById('gs-errors').textContent = s.totalErrors;
    document.getElementById('gs-net-fail').textContent = s.totalNetFailures;
    document.getElementById('gs-slow').textContent = s.totalSlowReqs;
    // Server status
    document.getElementById('status-dot').className = 'status-dot online';
    document.getElementById('server-status-text').textContent = 'Server Online';
    // Populate the ignored errors panel (only visible on the dashboard)
    loadDashboardIgnored();
  } catch {
    document.getElementById('status-dot').className = 'status-dot offline';
    document.getElementById('server-status-text').textContent = 'Server Offline';
  }
  const now = new Date();
  document.getElementById('last-refresh').textContent =
    `Updated ${now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

// ── Bulk Delete ───────────────────────────────────────────────────────────────
let isBulkMode = { sessions: false };
let bulkSelected = { sessions: new Set() };

function toggleBulkMode(type) {
  isBulkMode[type] = !isBulkMode[type];
  bulkSelected[type].clear();

  const controls = document.getElementById(`bulk-controls-${type}`);
  if (controls) controls.style.display = isBulkMode[type] ? 'flex' : 'none';

  if (type === 'sessions') renderSessionList(allSessionsCache);
}

function toggleBulkSelect(type, id, checked, e) {
  if (e) e.stopPropagation();
  if (checked) bulkSelected[type].add(id);
  else bulkSelected[type].delete(id);
}

async function executeBulkDelete(type) {
  const ids = Array.from(bulkSelected[type]);
  if (!ids.length) {
    showToast('No sessions selected', 'warn');
    return;
  }
  if (!confirm(`Delete ${ids.length} selected sequence(s)? This cannot be undone.`)) return;

  try {
    const res = await fetch(`${API}/sessions/bulk-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    });
    if (!res.ok) throw new Error();
    showToast(`${ids.length} item(s) deleted`, 'success');
    
    toggleBulkMode(type); // Reset UI

    if (ids.includes(currentSessionId)) {
      currentSessionId = null;
      document.getElementById('empty-state').style.display = '';
      document.getElementById('session-detail').style.display = 'none';
      loadDashboardIgnored();
    }
    
    await loadSessions();
  } catch {
    showToast('Failed to bulk delete sessions', 'error');
  }
}

// ── Sessions List ─────────────────────────────────────────────────────────────
async function loadSessions() {
  const status = document.getElementById('status-filter').value;
  const listEl = document.getElementById('sessions-list');
  listEl.innerHTML = '<div class="loading-row"><span class="spinner"></span> Loading…</div>';

  try {
    const params = new URLSearchParams({ limit: 200 });
    if (status) params.set('status', status);
    const res = await fetch(`${API}/sessions?${params}`);
    const { sessions } = await res.json();
    allSessionsCache = sessions;
    document.getElementById('session-count').textContent = sessions.length;
    renderSessionList(sessions);
    await loadGlobalStats();
  } catch {
    listEl.innerHTML = `<div class="loading-row" style="color:var(--danger)">⚠ Cannot connect to server at port 17890</div>`;
    document.getElementById('status-dot').className = 'status-dot offline';
    document.getElementById('server-status-text').textContent = 'Server Offline';
  }
}

function filterSessions() {
  const q = (document.getElementById('session-search').value || '').toLowerCase();
  if (!q) {
    renderSessionList(allSessionsCache);
    return;
  }
  const filtered = allSessionsCache.filter(s =>
    (s.title || '').toLowerCase().includes(q) ||
    (s.url || '').toLowerCase().includes(q) ||
    (s.id || '').toLowerCase().includes(q)
  );
  renderSessionList(filtered);
}

function sessionHealthColor(s) {
  if (s.status === 'recording') return '#ef4444';
  if ((s.error_count || 0) > 0) return '#ef4444';
  if ((s.network_failure_count || 0) > 0) return '#f59e0b';
  return '#10b981';
}

function renderSessionList(sessions) {
  const listEl = document.getElementById('sessions-list');
  if (!sessions.length) {
    listEl.innerHTML = '<div class="empty-list">No sessions found</div>';
    return;
  }
  listEl.innerHTML = sessions.map(s => {
    const health = sessionHealthColor(s);
    const isClean = (s.error_count || 0) === 0 && (s.network_failure_count || 0) === 0;
    
    const clickAction = isBulkMode.sessions 
        ? `toggleBulkSelect('sessions', '${esc(s.id)}', !this.querySelector('input').checked, event); const cb = this.querySelector('input'); cb.checked = !cb.checked;`
        : `selectSession('${esc(s.id)}')`;

    const checkboxHtml = isBulkMode.sessions 
        ? `<input type="checkbox" style="margin-right:10px; pointer-events:none;" ${bulkSelected.sessions.has(s.id) ? 'checked' : ''} />` 
        : '';
    const deleteBtn = !isBulkMode.sessions 
        ? `<button class="session-delete-btn" onclick="deleteSession(event,'${esc(s.id)}')" title="Delete session">${icon('x', 12)}</button>`
        : '';

    return `
    <div class="session-item ${s.id === currentSessionId ? 'active' : ''}" style="${isBulkMode.sessions ? 'cursor:pointer;' : ''}"
         onclick="${clickAction}" data-id="${esc(s.id)}">
      ${checkboxHtml}
      <div style="flex:1; min-width:0;">
          <div class="session-item-top">
            <div class="session-title" title="${esc(s.title || s.url || s.id)}">${esc(s.title || s.url || s.id)}</div>
            ${deleteBtn}
          </div>
          <div class="session-meta">
            <span>${formatDate(s.started_at)}</span>
            <span>${formatDuration(s.duration_ms)}</span>
          </div>
      <div class="session-badges">
        ${s.status === 'recording' ? '<span class="badge badge-recording">● Live</span>' : ''}
        ${(s.error_count || 0) > 0 ? `<span class="badge badge-error">⚠ ${s.error_count} err</span>` : ''}
        ${(s.network_failure_count || 0) > 0 ? `<span class="badge badge-warn">${s.network_failure_count} net fail</span>` : ''}
        ${(s.slow_request_count || 0) > 0 ? `<span class="badge badge-info">${s.slow_request_count} slow</span>` : ''}
        ${isClean && s.status !== 'recording' ? '<span class="badge badge-success">✓ Clean</span>' : ''}
      </div>
      <div class="health-bar-wrap">
        <div class="health-bar" style="background:${health};width:${isClean ? 100 : Math.max(10, 100 - (s.error_count || 0) * 15 - (s.network_failure_count || 0) * 10)}%"></div>
      </div>
    </div>
    </div>`;
  }).join('');
}


// ── Delete Session ────────────────────────────────────────────────────────────
async function deleteSession(e, id) {
  if (e) e.stopPropagation();
  if (!confirm('Delete this session? This cannot be undone.')) return;
  try {
    const res = await fetch(`${API}/sessions/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error();
    showToast('Session deleted', 'success');
    if (currentSessionId === id) {
      currentSessionId = null;
      document.getElementById('empty-state').style.display = '';
      document.getElementById('session-detail').style.display = 'none';
    }
    await loadSessions();
  } catch (err) {
    showToast('Failed to delete session', 'error');
  }
}

async function deleteCurrentSession() {
  if (!currentSessionId) return;
  await deleteSession(null, currentSessionId);
}

// ── Session Detail ────────────────────────────────────────────────────────────
let sessionStartMs = null;
let currentSessionData = null; // last-loaded { session, summary } — reused by the Slack report action

async function selectSession(id) {
  // Toggle: clicking the already-selected session closes it and shows the dashboard
  if (currentSessionId === id) {
    currentSessionId = null;
    document.querySelectorAll('.session-item').forEach(el => el.classList.remove('active'));
    document.getElementById('empty-state').style.display = '';
    document.getElementById('session-detail').style.display = 'none';
    history.replaceState(null, '', location.pathname + location.search);
    loadDashboardIgnored();
    return;
  }

  currentSessionId = id;
  document.querySelectorAll('.session-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
  });
  updateUrlHash();

  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('settings-view').style.display = 'none';
  const detail = document.getElementById('session-detail');
  detail.style.display = 'flex';

  const res = await fetch(`${API}/sessions/${id}`);
  const { session, summary } = await res.json();
  sessionStartMs = session.started_at;
  currentSessionData = session;

  document.getElementById('detail-title').textContent = session.title || session.url || id;
  document.getElementById('detail-url').textContent = session.url || '';

  const ec2 = session.error_count || 0;
  const nc2 = session.network_failure_count || 0;
  const sc2 = session.slow_request_count || 0;
  const isLive = session.status === 'recording';
  const browserInfoLabel = formatBrowserInfo(session.browser_info);

  document.getElementById('detail-meta').innerHTML = `
    <span class="meta-chip" data-tip="Session started at ${formatDate(session.started_at)}">
      <span class="chip-icon">${icon('clock', 12)}</span>${formatDate(session.started_at)}
    </span>
    ${browserInfoLabel
      ? `<span class="meta-chip" data-tip="Browser environment this session was recorded in"><span class="chip-icon">${icon('infoCircle', 12)}</span>${esc(browserInfoLabel)}</span>`
      : ''
    }
    <span class="meta-chip" data-tip="Total recording duration">
      <span class="chip-icon">${icon('clock', 12)}</span>${formatDuration(session.duration_ms)}
    </span>
    <span class="meta-chip" data-tip="Total events captured during this session (clicks, network, console, etc.)">
      <span class="chip-icon">${icon('clipboard', 12)}</span>${session.event_count || 0} events
    </span>
    ${ec2 > 0
      ? `<span class="meta-chip chip-danger" data-tip="${ec2} JavaScript error${ec2 !== 1 ? 's' : ''} or uncaught exception${ec2 !== 1 ? 's' : ''} were recorded. Check the Triage tab."><span class="chip-icon">${icon('alertTriangle', 12)}</span>${ec2} JS error${ec2 !== 1 ? 's' : ''}</span>`
      : `<span class="meta-chip chip-success" data-tip="No JavaScript errors detected in this session"><span class="chip-icon">${icon('checkCircle', 12)}</span>No JS errors</span>`
    }
    ${nc2 > 0
      ? `<span class="meta-chip chip-warn" data-tip="${nc2} API/network request${nc2 !== 1 ? 's' : ''} failed (CORS, timeout, or server error). Check the Triage tab."><span class="chip-icon">${icon('globe', 12)}</span>${nc2} net failure${nc2 !== 1 ? 's' : ''}</span>`
      : ''
    }
    ${sc2 > 0
      ? `<span class="meta-chip chip-warn" data-tip="${sc2} request${sc2 !== 1 ? 's' : ''} took longer than 2 seconds — potential performance issue."><span class="chip-icon">${icon('clock', 12)}</span>${sc2} slow req${sc2 !== 1 ? 's' : ''}</span>`
      : ''
    }
    ${isLive
      ? `<span class="meta-chip chip-live" data-tip="This session is actively being recorded"><span class="chip-icon">●</span>Live</span>`
      : `<span class="meta-chip chip-success" data-tip="Recording has finished"><span class="chip-icon">${icon('checkCircle', 12)}</span>Done</span>`
    }
  `;
  document.getElementById('download-btn').href = `${API}/sessions/${id}/download`;

  // Update tab badges
  const triageBadge = document.getElementById('tab-triage-badge');
  const ec = session.error_count || 0;
  const nfc = session.network_failure_count || 0;
  if (ec + nfc > 0) {
    triageBadge.textContent = ec + nfc;
    triageBadge.style.display = '';
  } else {
    triageBadge.style.display = 'none';
  }

  const eventsBadge = document.getElementById('tab-events-badge');
  if (session.event_count > 0) {
    eventsBadge.textContent = session.event_count;
    eventsBadge.style.display = '';
  } else {
    eventsBadge.style.display = 'none';
  }

  renderOverview(session, summary);
  if (currentTab === 'triage') loadTriage();
  else if (currentTab === 'input') loadInputTrack();
  else if (currentTab === 'events') loadEvents();
  else if (currentTab === 'video') loadVideo();
  else if (currentTab === 'repro') loadReproSteps();
}

// ── Overview ──────────────────────────────────────────────────────────────────
function renderOverview(session, summary) {
  const ec = session.error_count || 0;
  const nc = session.network_failure_count || 0;
  const sc = session.slow_request_count || 0;
  const totalIssues = ec + nc + sc;
  const overallOk = ec === 0 && nc === 0;

  // ── Stats grid: icons · trend chips · tooltips · priority banners ──────────
  // priorityBanner: { level: 'critical'|'moderate', text: string } | null
  function statCard({ variant, iconName, label, value, valueCls, trend, trendCls, sub, tip, priorityBanner, ariaLabel }) {
    const iconSvg = icon(iconName, 16);
    const banner = priorityBanner
      ? `<div class="stat-priority-banner ${priorityBanner.level}" role="status" aria-label="${priorityBanner.text}">
           <span aria-hidden="true" style="display:inline-flex;flex-shrink:0;margin-top:2px;">${icon(priorityBanner.level === 'critical' ? 'alertOctagon' : 'alertTriangle', 11)}</span>
           ${priorityBanner.text}
         </div>`
      : '';
    return `
      <div class="stat-card ${variant}" data-tip="${tip}" role="region" aria-label="${ariaLabel || label + ': ' + value}">
        <div class="stat-icon-bg" aria-hidden="true">${icon(iconName, 40)}</div>
        <div class="stat-header">
          <span class="stat-icon" aria-hidden="true" style="display:inline-flex;">${iconSvg}</span>
          <span class="stat-label">${label}</span>
          ${trend ? `<span class="stat-trend ${trendCls}" aria-label="${trend}">${trend}</span>` : ''}
        </div>
        <div class="stat-value ${valueCls}" aria-live="polite">${value}</div>
        <div class="stat-sub">${sub}</div>
        ${banner}
      </div>`;
  }

  document.getElementById('overview-stats').innerHTML = [
    statCard({
      variant: 'accent', iconName: 'clock', label: 'Duration',
      value: formatDuration(session.duration_ms), valueCls: 'accent',
      trend: '', trendCls: '',
      sub: 'Total session length',
      tip: 'How long the recording ran from start to stop.',
      ariaLabel: `Session duration: ${formatDuration(session.duration_ms)}`,
    }),
    statCard({
      variant: ec > 0 ? 'danger' : 'success',
      iconName: ec > 0 ? 'alertOctagon' : 'checkCircle',
      label: 'JS Errors',
      value: ec, valueCls: ec > 0 ? 'danger' : 'success',
      trend: ec > 0 ? '⚠ Action needed' : '✓ Clean',
      trendCls: ec > 0 ? 'bad' : 'ok',
      sub: ec > 0 ? `${ec} uncaught exception${ec !== 1 ? 's' : ''}` : 'No exceptions detected',
      tip: 'console.error events and uncaught runtime exceptions. Each one indicates broken code that ran during the session.',
      priorityBanner: ec > 0
        ? { level: 'critical', text: `CRITICAL — ${ec} error${ec !== 1 ? 's' : ''} require attention` }
        : null,
      ariaLabel: ec > 0
        ? `JS Errors: ${ec}, critical — action needed`
        : 'JS Errors: 0, session is clean',
    }),
    statCard({
      variant: nc > 0 ? 'warn' : 'success',
      iconName: nc > 0 ? 'globe' : 'checkCircle',
      label: 'Net Failures',
      value: nc, valueCls: nc > 0 ? 'warn' : 'success',
      trend: nc > 0 ? '⚠ Check Triage' : '✓ All OK',
      trendCls: nc > 0 ? 'mid' : 'ok',
      sub: nc > 0 ? `${nc} failed request${nc !== 1 ? 's' : ''}` : 'All requests succeeded',
      tip: 'Network requests that failed due to CORS, DNS errors, timeouts, or 5xx server errors. Each failure could block a feature.',
      priorityBanner: nc > 0
        ? { level: 'moderate', text: `WARNING — ${nc} request${nc !== 1 ? 's' : ''} failed` }
        : null,
      ariaLabel: nc > 0
        ? `Network Failures: ${nc}, warning — check Triage tab`
        : 'Network Failures: 0, all requests succeeded',
    }),
    statCard({
      variant: sc > 0 ? 'warn' : 'success',
      iconName: sc > 0 ? 'clock' : 'zap',
      label: 'Slow Reqs (>2s)',
      value: sc, valueCls: sc > 0 ? 'warn' : 'success',
      trend: sc > 0 ? 'Perf issue' : '✓ Fast',
      trendCls: sc > 0 ? 'mid' : 'ok',
      sub: sc > 0 ? 'Requests over 2 s threshold' : 'All responses fast',
      tip: 'API calls that took longer than 2 seconds. Slow requests degrade user experience and may indicate backend bottlenecks.',
      priorityBanner: sc > 0
        ? { level: 'moderate', text: `SLOW — ${sc} request${sc !== 1 ? 's' : ''} exceeded 2 s` }
        : null,
      ariaLabel: sc > 0
        ? `Slow requests: ${sc}, performance warning`
        : 'Slow requests: 0, all responses fast',
    }),
    statCard({
      variant: '', iconName: 'clipboard', label: 'Total Events',
      value: session.event_count || 0, valueCls: '',
      trend: '', trendCls: '',
      sub: 'Clicks, network, console…',
      tip: 'Every captured event in this session: user actions, network requests, console logs, and markers.',
      ariaLabel: `Total events captured: ${session.event_count || 0}`,
    }),
  ].join('');

  // ── Health score ring ──
  const score = Math.max(0, 100 - ec * 25 - nc * 15 - sc * 5);
  const scoreColor = score >= 80 ? '#10b981' : score >= 50 ? '#f59e0b' : '#ef4444';
  const scoreLabel = score >= 80 ? 'Good' : score >= 50 ? 'Fair' : 'Poor';
  const circumference = 2 * Math.PI * 30;
  const offset = circumference - (score / 100) * circumference;

  const healthTip = overallOk
    ? 'Score 100: No errors or failures — this session is clean.'
    : `Score ${score}/100 — deducted: ${ec > 0 ? `${ec * 25}pts for JS errors` : ''} ${nc > 0 ? `${nc * 15}pts for net failures` : ''} ${sc > 0 ? `${sc * 5}pts for slow reqs` : ''}.`.replace(/\s+/g,' ').trim();

  document.getElementById('health-score-card').innerHTML = `
    <div class="hs-ring-wrap" data-tip="${esc(healthTip)}">
      <svg class="hs-ring" viewBox="0 0 72 72">
        <circle class="hs-ring-bg" cx="36" cy="36" r="30"/>
        <circle class="hs-ring-arc" cx="36" cy="36" r="30"
          stroke="${scoreColor}"
          stroke-dasharray="${circumference}"
          stroke-dashoffset="${offset}"/>
      </svg>
      <div class="hs-label" style="color:${scoreColor}">${score}</div>
    </div>
    <div class="hs-info">
      <div class="hs-title">Session Health Score
        <span style="font-size:11px;font-weight:400;color:var(--text-dim);margin-left:6px;">(${scoreLabel})</span>
      </div>
      <div class="hs-desc">
        ${overallOk
          ? `<span style="color:var(--success);display:inline-flex;vertical-align:-2px;">${icon('checkCircle', 13)}</span> This session is clean — no errors or API failures detected.`
          : `Found <strong>${totalIssues} issue${totalIssues !== 1 ? 's' : ''}</strong>: ${[
              ec > 0 ? `<span style="color:var(--danger)">⚠ ${ec} JS error${ec !== 1 ? 's' : ''}</span>` : '',
              nc > 0 ? `<span style="color:var(--warn)">🌐 ${nc} net failure${nc !== 1 ? 's' : ''}</span>` : '',
              sc > 0 ? `<span style="color:var(--warn)">🐢 ${sc} slow request${sc !== 1 ? 's' : ''}</span>` : '',
            ].filter(Boolean).join(' · ')}.`
        }
      </div>
      <div style="margin-top:8px;font-size:11px;color:var(--text-dim);">Hover each card above for details · Check Triage tab for actionable events</div>
    </div>
  `;

  // Error clusters
  const clustersEl = document.getElementById('error-clusters');
  const clusterData = summary?.top_error_clusters || [];
  document.getElementById('error-cluster-count').textContent = clusterData.length || '';
  clustersEl.innerHTML = clusterData.length
    ? clusterData.map(c => `
      <div class="cluster-item">
        <span class="cluster-count">×${c.count}</span>
        <div>
          <div class="cluster-msg">${esc(c.sample_message || c.signature)}</div>
          <div class="cluster-meta">${esc(c.type)} — first at ${formatTs(c.first_ts, sessionStartMs)}</div>
        </div>
      </div>`)
      .join('')
    : '<div class="empty-list">No error clusters — clean! 🎉</div>';

  // Failed endpoints
  const failedEl = document.getElementById('failed-endpoints');
  const failedData = summary?.failed_endpoints || [];
  document.getElementById('failed-endpoint-count').textContent = failedData.length || '';
  failedEl.innerHTML = failedData.length
    ? failedData.map(e => `
      <div class="cluster-item">
        <span class="cluster-count">×${e.count}</span>
        <div class="cluster-msg">${esc(e.key)}</div>
      </div>`)
      .join('')
    : '<div class="empty-list">No failed endpoints</div>';

  // Slow endpoints with visual bar
  const slowEl = document.getElementById('slow-endpoints');
  const slowData = summary?.slow_endpoints || [];
  document.getElementById('slow-endpoint-count').textContent = slowData.length || '';
  const maxMs = slowData.length ? Math.max(...slowData.map(e => e.max_ms)) : 1;
  slowEl.innerHTML = slowData.length
    ? slowData.map(e => `
      <div class="cluster-item">
        <div class="timing-bar-wrap">
          <div class="cluster-msg">${esc(e.url)}</div>
          <div class="timing-bar-bg">
            <div class="timing-bar-fill" style="width:${Math.min(100, (e.p95_ms / maxMs) * 100)}%"></div>
          </div>
        </div>
        <div class="timing-label">p95: ${e.p95_ms}ms</div>
      </div>`)
      .join('')
    : '<div class="empty-list">No slow endpoints</div>';

  // Draw mini timeline if we have a session with duration
  if (session.duration_ms > 0) drawTimeline(session, summary);
}

// ── Interactive Timeline ──────────────────────────────────────────────────────
let _tlState = { zoom: 1, offsetMs: 0, dur: 0, events: [], startMs: 0, buckets: [] };

window.tlZoomIn = () => { if (_tlState.zoom < 16) { _tlState.zoom *= 2; constrainTlOffset(); renderTlCanvas(); } };
window.tlZoomOut = () => { if (_tlState.zoom > 1) { _tlState.zoom /= 2; constrainTlOffset(); renderTlCanvas(); } };
window.tlResetZoom = () => { _tlState.zoom = 1; _tlState.offsetMs = 0; renderTlCanvas(); };

function constrainTlOffset() {
  const visibleDur = _tlState.dur / _tlState.zoom;
  _tlState.offsetMs = Math.max(0, Math.min(_tlState.dur - visibleDur, _tlState.offsetMs));
}

async function drawTimeline(session, summary) {
  const wrap = document.getElementById('timeline-wrap');
  try {
    const res = await fetch(`${API}/sessions/${session.id}/events?types=network.request,console.error,runtime.exception,console.warn,network.failure&limit=5000`);
    const { events: rawEvents } = await res.json();
    const events = normalizeEventList(rawEvents);
    if (!events || !events.length) { wrap.style.display = 'none'; return; }

    _tlState.events = events;
    _tlState.dur = session.duration_ms;
    _tlState.startMs = session.started_at;
    tlResetZoom();
    wrap.style.display = '';
  } catch {
    wrap.style.display = 'none';
  }
}

function renderTlCanvas() {
  const canvas = document.getElementById('timeline-canvas');
  const labelsEl = document.getElementById('timeline-labels');
  const infoEl = document.getElementById('tl-zoom-info');
  if(!canvas) return;

  if (infoEl) infoEl.textContent = Math.round(_tlState.zoom * 100) + '%';
  const dur = _tlState.dur;
  const visibleDur = dur / _tlState.zoom;
  const startVis = _tlState.offsetMs;
  const endVis = startVis + visibleDur;

  const W = canvas.offsetWidth || 600;
  const H = canvas.offsetHeight || 80;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const BUCKETS = 60;
  const bucketMs = visibleDur / BUCKETS;
  const counts = new Array(BUCKETS).fill(0);
  const errCounts = new Array(BUCKETS).fill(0);
  const bucketEvs = Array.from({length: BUCKETS}, () => []);

  for (const ev of _tlState.events) {
    const relMs = ev.ts_epoch_ms - _tlState.startMs;
    if (relMs >= startVis && relMs <= endVis) {
      const idx = Math.min(BUCKETS - 1, Math.max(0, Math.floor((relMs - startVis) / bucketMs)));
      counts[idx]++;
      bucketEvs[idx].push(ev);
      if (['console.error', 'runtime.exception', 'network.failure', 'network.ws_error'].includes(ev.type)) errCounts[idx]++;
    }
  }

  const maxCount = Math.max(1, ...counts);
  const barW = (W / BUCKETS) - 1.5;
  const isDark = document.documentElement.dataset.theme === 'dark';
  const normalColor = isDark ? '#6366f1' : '#4f46e5';
  const errorColor = '#ef4444';

  _tlState.buckets = [];

  for (let i = 0; i < BUCKETS; i++) {
    if (counts[i] === 0) continue;
    const x = i * (W / BUCKETS);
    const h = Math.max(4, (counts[i] / maxCount) * (H - 4));
    const y = H - h;
    
    ctx.fillStyle = errCounts[i] > 0 ? errorColor : normalColor;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(x, y, barW, h);

    _tlState.buckets.push({
      x, y, w: barW, h,
      events: bucketEvs[i],
      errors: errCounts[i],
      timeStr: fmtShortTime(startVis + i*bucketMs)
    });
  }

  labelsEl.innerHTML = `<span>+${fmtShortTime(startVis)}</span><span>+${fmtShortTime(startVis + visibleDur/2)}</span><span>+${fmtShortTime(endVis)}</span>`;
}

function fmtShortTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s%60}s` : `${s}s`;
}

// ── Timeline Interactions (Pan, Hover, Click) ─────────────────────────────────
let _tlDragging = false;
let _tlStartX = 0;
let _tlStartOffset = 0;

document.addEventListener('mousedown', e => {
  if (e.target.id === 'timeline-canvas' && _tlState.zoom > 1) {
    _tlDragging = true;
    _tlStartX = e.clientX;
    _tlStartOffset = _tlState.offsetMs;
    e.target.style.cursor = 'grabbing';
  }
});

document.addEventListener('mousemove', e => {
  const canvas = document.getElementById('timeline-canvas');
  const tooltip = document.getElementById('tl-tooltip');
  if (!canvas || !tooltip) return;

  if (_tlDragging) {
    const dx = e.clientX - _tlStartX;
    const msPerPx = (_tlState.dur / _tlState.zoom) / canvas.offsetWidth;
    _tlState.offsetMs = _tlStartOffset - (dx * msPerPx);
    const visibleDur = _tlState.dur / _tlState.zoom;
    _tlState.offsetMs = Math.max(0, Math.min(_tlState.dur - visibleDur, _tlState.offsetMs));
    renderTlCanvas();
    tooltip.classList.remove('visible');
    return;
  }

  if (e.target === canvas) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    const bucket = _tlState.buckets.find(b => x >= b.x && x <= b.x + b.w);
    if (bucket && y >= bucket.y) {
      canvas.style.cursor = 'pointer';
      tooltip.innerHTML = `
        <div style="font-weight:700;margin-bottom:4px">${bucket.timeStr}</div>
        <div>${bucket.events.length} events logged</div>
        ${bucket.errors > 0 ? `<div style="color:#fca5a5;margin-top:2px;font-weight:600">⚠ ${bucket.errors} critical errors</div>` : ''}
        <div style="color:#94a3b8;font-size:9px;margin-top:5px;border-top:1px solid #334155;padding-top:4px;">(Click to view in Triage)</div>
      `;
      tooltip.style.left = e.clientX + 'px';
      tooltip.style.top = (e.clientY - 15) + 'px';
      tooltip.style.transform = 'translate(-50%, -100%)';
      tooltip.classList.add('visible');
    } else {
      canvas.style.cursor = _tlState.zoom > 1 ? 'grab' : 'crosshair';
      tooltip.classList.remove('visible');
    }
  } else {
    tooltip.classList.remove('visible');
  }
});

document.addEventListener('mouseup', () => {
  if (_tlDragging) {
    _tlDragging = false;
    const canvas = document.getElementById('timeline-canvas');
    if (canvas) canvas.style.cursor = _tlState.zoom > 1 ? 'grab' : 'crosshair';
  }
});

document.addEventListener('click', e => {
  if (e.target.id === 'timeline-canvas' && !_tlDragging) {
    const rect = e.target.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const bucket = _tlState.buckets.find(b => x >= b.x && x <= b.x + b.w);
    if (bucket && y >= bucket.y && bucket.events.length > 0) {
      // Find the first error or first event
      const targetEv = bucket.events.find(ev => ['console.error','runtime.exception','network.failure'].includes(ev.type)) || bucket.events[0];
      
      // Jump to Triage tab
      document.querySelector('[onclick="switchTab(\'triage\')"]')?.click();
      
      setTimeout(() => {
        // Attempt to find the specific element in the triage list
        const rows = document.querySelectorAll('.triage-event');
        let matched = false;
        const searchStr = (targetEv.data?.message || targetEv.data?.text || targetEv.type).toLowerCase();
        
        for (const row of rows) {
          if (row.textContent.toLowerCase().includes(searchStr)) {
            row.scrollIntoView({behavior: 'smooth', block: 'center'});
            row.classList.remove('tl-flash');
            void row.offsetWidth; // trigger reflow
            row.classList.add('tl-flash');
            matched = true;
            break;
          }
        }
      }, 150); // slight delay to allow Triage tab to render
    }
  }
});

// ── Triage State ──────────────────────────────────────────────────────────────
let triageEventsCache = [];
let _triageShowCache = []; // safe index array – avoids passing event objects via onclick attrs

window.triageIgnoreByIdx = function(idx) {
  const ev = _triageShowCache[Number(idx)];
  if (ev) ignoreEvent(ev, currentSessionId);
};

window.triagreCopyByIdx = function(idx) {
  const ev = _triageShowCache[Number(idx)];
  if (!ev) return;
  const d = ev.data || {};
  const msg = d.message || d.text || d.text_snippet || '';
  const stack = d.stack || d.stackTrace || '';
  copyEventText(`[${ev.type}] ${msg} ${stack}`.trim());
};

// ── Ignored Errors ────────────────────────────────────────────────────────────
async function refreshIgnoredSignatures() {
  try {
    const res = await fetch(`${API}/ignored-errors`);
    const { ignored } = await res.json();
    ignoredSignatures = new Set(ignored.map(e => e.signature));
    return ignored;
  } catch {
    return [];
  }
}

function eventSignature(ev) {
  const d = ev.data || {};
  if (ev.type === 'network.failure') {
    const url = d.url_sanitized || d.url_full || 'unknown_url';
    return `network.failure::${url}`;
  }
  if (ev.type === 'network.ws_error') {
    return `network.ws_error::${d.url_sanitized || 'unknown_url'}::${d.errorMessage || ''}`;
  }
  const msg = d.message || d.text || '';
  return `${ev.type}::${msg.slice(0, 120)}`;
}

async function ignoreEvent(ev, sessionId) {
  const sig = eventSignature(ev);
  const d = ev.data || {};
  const label = `[${ev.type}] ${(d.message || d.text || d.url_sanitized || '').slice(0, 80)}`;
  // See renderTriage()'s matchCount comment: console/runtime types are already
  // deduped server-side, so their real count lives in _triage.dedup_count.
  const matchCount = ev._triage?.dedup_count || triageEventsCache.filter(e => eventSignature(e) === sig).length;
  try {
    await fetch(`${API}/ignored-errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature: sig, label, source_session_id: sessionId }),
    });
    ignoredSignatures.add(sig);
    showToast(
      matchCount > 1 ? `Muted ${matchCount} matching errors — hidden here and in future sessions` : 'Error muted — hidden here and in future sessions',
      'success'
    );
    renderTriage(triageEventsCache);  // re-render in-place; muted rows drop out by default
    loadDashboardIgnored();           // refresh the dashboard panel
  } catch {
    showToast('Failed to mute error', 'error');
  }
}

async function restoreIgnored(id) {
  try {
    await fetch(`${API}/ignored-errors/${id}`, { method: 'DELETE' });
    await refreshIgnoredSignatures();
    renderTriage(triageEventsCache);
    loadDashboardIgnored();
    showToast('Error restored', 'success');
  } catch {
    showToast('Failed to restore error', 'error');
  }
}

async function loadDashboardIgnored() {
  const panel = document.getElementById('dashboard-ignored-panel');
  if (!panel) return;
  const list = document.getElementById('dashboard-ignored-list');
  const ignored = await refreshIgnoredSignatures();
  const countEl = document.getElementById('dashboard-ignored-count');
  if (countEl) countEl.textContent = ignored.length || '';

  if (!ignored.length) {
    list.innerHTML = '<div class="empty-list" style="padding:20px;text-align:center;color:var(--text-dim);">No muted errors — all issues are active.</div>';
    return;
  }
  list.innerHTML = ignored.map(e => `
    <div style="display:flex; align-items:flex-start; gap:12px; padding:12px 16px; border-bottom:1px solid var(--border);">
      <div style="flex:1; min-width:0;">
        <div style="font-size:12px; font-weight:600; color:var(--text); word-break:break-all; margin-bottom:4px;">${esc(e.label)}</div>
        <div style="font-size:10px; color:var(--text-dim);">Muted ${formatDate(e.ignored_at)}${e.source_session_id ? ` · from session <code>${e.source_session_id.slice(0,8)}</code>` : ''}</div>
      </div>
      <button onclick="restoreIgnored('${esc(e.id)}')" style="flex-shrink:0; background:none; border:1px solid var(--border); color:var(--text-muted); border-radius:5px; padding:4px 10px; font-size:11px; cursor:pointer;" title="Restore this error">${icon('eye', 12)} Restore</button>
    </div>`).join('');
}

async function loadTriage() {
  if (!currentSessionId) return;
  const listEl = document.getElementById('triage-list');
  listEl.innerHTML = '<div class="loading-row"><span class="spinner"></span> Loading triage…</div>';

  // Pre-load ignored signatures so rendering is synchronous
  await refreshIgnoredSignatures();

  const res = await fetch(`${API}/sessions/${currentSessionId}/triage`);
  const { events: rawEvents } = await res.json();
  const events = normalizeEventList(rawEvents);
  triageEventsCache = events;
  renderTriage(events);
}

const TRIAGE_CRITICAL_TYPES = ['console.error', 'runtime.exception', 'network.failure', 'network.ws_error'];

function updateMutedToggleLabel(mutedCount) {
  const btn = document.getElementById('triage-toggle-muted');
  if (!btn) return;
  btn.textContent = triageHideMuted
    ? `Show Muted${mutedCount ? ` (${mutedCount})` : ''}`
    : 'Hide Muted';
}

function toggleMutedVisibility() {
  triageHideMuted = !triageHideMuted;
  renderTriage(triageEventsCache);
}

function renderTriage(events) {
  const listEl = document.getElementById('triage-list');
  document.getElementById('triage-count').textContent = `${events.length} events`;

  if (!events.length) {
    listEl.innerHTML = '<div class="empty-list">No triage events — session is clean! 🎉</div>';
    updateMutedToggleLabel(0);
    return;
  }

  // Count occurrences per signature across the whole session so the mute button
  // can say "Mute all N" — one click mutes every matching occurrence (by content
  // signature, not event id), here and in every future session, since the ignore
  // list is global. This is the mass-mute affordance in place of a multi-select UI.
  const sigCounts = {};
  for (const ev of events) {
    if (!TRIAGE_CRITICAL_TYPES.includes(ev.type)) continue;
    const sig = eventSignature(ev);
    sigCounts[sig] = (sigCounts[sig] || 0) + 1;
  }

  let show = triageFilter === 'errors'
    ? events.filter(ev => TRIAGE_CRITICAL_TYPES.includes(ev.type))
    : events;

  // Muted errors are hidden by default (not just dimmed) — that's what makes
  // "mute" actually declutter the list instead of leaving it there forever.
  const mutedCount = show.filter(ev => ignoredSignatures.has(eventSignature(ev))).length;
  if (triageHideMuted) show = show.filter(ev => !ignoredSignatures.has(eventSignature(ev)));
  updateMutedToggleLabel(mutedCount);

  _triageShowCache = show; // update safe index reference

  if (!show.length) {
    listEl.innerHTML = mutedCount > 0
      ? `<div class="empty-list">All ${mutedCount} matching event(s) are muted — click "Show Muted" to review them.</div>`
      : '<div class="empty-list">No triage events — session is clean! 🎉</div>';
    return;
  }

  listEl.innerHTML = show.map((ev, i) => {
    const d = ev.data || {};
    const sig = eventSignature(ev);
    const isIgnored = ignoredSignatures.has(sig);
    const isCritical = TRIAGE_CRITICAL_TYPES.includes(ev.type);
    // console.error/warn/runtime.exception are already deduped server-side (filter.js),
    // so their true occurrence count lives in _triage.dedup_count, not in sigCounts
    // (which only sees the one surviving entry for those types). network.failure and
    // network.ws_error aren't deduped server-side, so sigCounts is accurate for them.
    const matchCount = ev._triage?.dedup_count || sigCounts[sig] || 1;
    let msg = d.message || d.text || d.text_snippet || '';
    const stack = d.stack || d.stackTrace || null;
    const dedup = ev._triage?.dedup_count > 1 ? `<span class="dedup-badge">×${ev._triage.dedup_count}</span>` : '';
    const diagnosis = analyzeTriageEvent(ev);

    if (!msg) msg = summarizeEvent(ev);
    const isHtml = typeof msg === 'string' && msg.includes('<details');
    if (!isHtml) msg = esc(msg.slice(0, 300));

    const diagHtml = diagnosis && !isIgnored
      ? `<div class="triage-diagnosis ${diagnosis.cls}">${diagnosis.msg}</div>`
      : '';

    const ignoredBadge = isIgnored
      ? `<span style="font-size:10px;background:var(--surface3);color:var(--text-dim);border-radius:99px;padding:1px 8px;font-weight:600;display:inline-flex;align-items:center;gap:3px;">${icon('eyeOff', 10)} Muted</span>`
      : '';

    // Use data-idx to avoid embedding event JSON in onclick attrs (breaks on special chars)
    const ignoreBtn = isCritical && !isIgnored
      ? `<button class="copy-btn" data-idx="${i}" onclick="triageIgnoreByIdx(this.dataset.idx)" title="Mute this error signature — hides all ${matchCount} matching occurrence(s) here, and any future ones, everywhere">${icon('eyeOff', 11)} ${matchCount > 1 ? `Mute all ${matchCount}` : 'Mute'}</button>`
      : '';
    const copyBtn = `<button class="copy-btn" data-idx="${i}" onclick="triagreCopyByIdx(this.dataset.idx)" title="Copy">${icon('copy', 11)}</button>`;
    const slackBtn = ev.type === 'marker.bug'
      ? `<button class="copy-btn" data-idx="${i}" onclick="sendBugMarkerToSlack(this.dataset.idx)" title="Send this bug to Slack">${icon('slack', 11)} Slack</button>`
      : '';

    return `
      <div class="triage-event ${isIgnored ? '' : getTriageClass(ev.type)}" id="trev-${i}" style="${isIgnored ? 'opacity:0.45;' : ''}">
        <span class="type-chip ${getTypeClass(ev.type)}">${esc(ev.type)}</span>
        <div class="triage-event-body">
          <div class="triage-ts">${formatTs(ev.ts_epoch_ms, sessionStartMs)} ${ignoredBadge}</div>
          <div class="triage-msg">${msg}${dedup}</div>
          ${diagHtml}
          ${stack ? `
            <pre class="triage-stack" id="stack-${i}">${esc(String(stack).slice(0, 500))}</pre>
            <button class="copy-btn" data-idx="${i}" onclick="resolveStackByIdx(this.dataset.idx)" title="Resolve minified stack via source maps" style="margin-top:4px;">${icon('search', 11)} Resolve source map</button>
          ` : ''}
          ${d.storage_snapshot ? makePayloadAccordion('Storage at time of error', JSON.stringify(d.storage_snapshot), false) : ''}
        </div>
        <div class="triage-actions">
          ${ignoreBtn}
          ${slackBtn}
          ${copyBtn}
        </div>
      </div>`;
  }).join('');
}

window.resolveStackByIdx = async function (idx) {
  const ev = _triageShowCache[Number(idx)];
  if (!ev) return;
  const stack = ev.data?.stack || ev.data?.stackTrace;
  if (!stack) return;
  const pre = document.getElementById(`stack-${idx}`);
  const original = pre.textContent;
  pre.textContent = 'Resolving…';
  try {
    const res = await fetch(`${API}/sessions/${currentSessionId}/resolve-stack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack }),
    });
    const data = await res.json();
    const resolvedFrames = (data.frames || []).filter(f => f.resolved);
    if (!resolvedFrames.length) {
      pre.textContent = original;
      showToast('No source map found for this stack', 'info');
      return;
    }
    pre.textContent = data.frames.map(f => {
      if (!f.resolved) return f.raw;
      const r = f.resolved;
      return `${f.raw}\n    → ${r.source}:${r.line}:${r.column}${r.name ? ` (${r.name})` : ''}`;
    }).join('\n');
    showToast(`Resolved ${resolvedFrames.length} frame${resolvedFrames.length !== 1 ? 's' : ''}`, 'success');
  } catch {
    pre.textContent = original;
    showToast('Failed to resolve stack trace', 'error');
  }
};

function filterTriage(mode) {
  triageFilter = mode;
  document.getElementById('triage-filter-errors').style.display = mode === 'errors' ? 'none' : '';
  document.getElementById('triage-filter-all').style.display = mode === 'all' ? 'none' : '';
  renderTriage(triageEventsCache);
}

function expandAllTriage(open) {
  document.querySelectorAll('#triage-list details').forEach(d => { d.open = open; });
}

// ── Events Table ──────────────────────────────────────────────────────────────
async function loadEvents() {
  if (!currentSessionId) return;
  const tbody = document.getElementById('events-tbody');
  tbody.innerHTML = '<tr><td colspan="3"><div class="loading-row"><span class="spinner"></span> Loading…</div></td></tr>';

  const type = document.getElementById('type-filter').value;
  const params = new URLSearchParams({ limit: 500 });
  if (type) params.set('type', type);

  const res = await fetch(`${API}/sessions/${currentSessionId}/events?${params}`);
  const { events: rawEvents, total } = await res.json();
  const events = normalizeEventList(rawEvents);
  allEventsCache = events;
  document.getElementById('events-total').textContent = `${events.length} / ${total} events`;
  renderEventsTable(events);
}

function filterEventsTable() {
  const q = (document.getElementById('events-search').value || '').toLowerCase();
  if (!q) { renderEventsTable(allEventsCache); return; }
  const filtered = allEventsCache.filter(ev => {
    const s = summarizeEvent(ev);
    return (ev.type || '').toLowerCase().includes(q) ||
      (typeof s === 'string' ? s : '').toLowerCase().includes(q);
  });
  renderEventsTable(filtered);
}

function renderEventsTable(events) {
  const hasPayload = ev => {
    const d = ev.data || {};
    return d.request_body || d.response_body || d.request_headers || d.response_headers || d.storage_snapshot;
  };

  document.getElementById('events-tbody').innerHTML = events.map((ev, i) => {
    const d = ev.data || {};
    const isError = ['console.error', 'runtime.exception', 'network.failure', 'network.ws_error'].includes(ev.type);
    const isNetworkRow = ev.type.startsWith('network.');

    // Build the brief one-line summary (no HTML)
    let brief = '';
    switch (ev.type) {
      case 'action.click': brief = `Click: ${d.text_snippet || ''} (${d.selector || ''})`; break;
      case 'action.scroll': brief = `Scroll Δ${d.deltaY}`; break;
      case 'action.navigation': brief = `Nav → ${d.to_url || ''}`; break;
      case 'network.request': brief = `${d.method || 'GET'} ${d.url_full || d.url_sanitized || ''}`; break;
      case 'network.response': brief = `HTTP ${d.status} ${d.mimeType || ''} — ${d.url_full || d.url_sanitized || ''}`; break;
      case 'network.failure': brief = `FAILED ${d.errorText || ''} — ${d.url_full || d.url_sanitized || ''}`; break;
      case 'network.timing': brief = `${d.method || ''} ${d.response_status ? d.response_status + ' ↩ ' : ''}${d.duration_ms}ms — ${d.url_full || d.url_sanitized || ''}`; break;
      case 'network.ws_open': brief = `WS OPEN ${d.url_full || d.url_sanitized || ''}`; break;
      case 'network.ws_handshake': brief = `WS HANDSHAKE ${d.status || ''} ${d.statusText || ''} — ${d.url_sanitized || ''}`; break;
      case 'network.ws_frame': brief = `WS ${d.direction === 'sent' ? '↑' : '↓'} ${d.size ?? ''}B — ${d.url_sanitized || ''}`; break;
      case 'network.ws_error': brief = `WS ERROR: ${d.errorMessage || ''} — ${d.url_sanitized || ''}`; break;
      case 'network.ws_tail': brief = `WS TAIL: recovered ${d.frames?.length || 0} frame(s) leading up to ${d.reason || 'event'} — ${d.url_sanitized || ''}`; break;
      case 'network.ws_close': brief = `WS CLOSE ${d.frames_sent || 0}↑/${d.frames_received || 0}↓ frames — ${d.url_sanitized || ''}`; break;
      case 'console.warn': brief = `WARN: ${d.message || d.text || ''}`; break;
      case 'console.error': brief = `ERROR: ${d.message || d.text || ''}`; break;
      case 'runtime.exception': brief = `EXC: ${d.message || ''}`; break;
      case 'marker.bug': brief = `🐛 ${d.note || ''}`; break;
      case 'system.warning': brief = `⚠️ ${d.message || ''}`; break;
      case 'action.input': brief = `Fill: ${d.selector || ''}${d.is_sensitive ? ' = ***' : d.final_value ? ` = '${d.final_value}'` : ''}`; break;
      case 'action.select': brief = `Select: ${d.selected_text || d.selected_value || ''} (${d.selector || ''})`; break;
      case 'action.keydown': brief = `Key: ${d.key || ''} (${d.selector || ''})`; break;
      case 'dom.state_change': brief = `${d.kind ? d.kind[0].toUpperCase() + d.kind.slice(1) : 'DOM change'}${d.role ? ` (${d.role})` : ''}${d.text ? `: ${d.text}` : ''}`; break;
      default: brief = ev.type || 'Unknown event';
    }

    // Build expandable payload section
    let payloads = '';
    if (hasPayload(ev)) {
      payloads += makePayloadAccordion('Request Body', d.request_body, false);
      payloads += makeHeadersAccordion('Request Headers', d.request_headers);
      payloads += makePayloadAccordion('Response Body', d.response_body, isError);
      payloads += makeHeadersAccordion('Response Headers', d.response_headers);
      if (d.storage_snapshot) payloads += makePayloadAccordion('Storage at time of error', JSON.stringify(d.storage_snapshot), false);
    }

    const payloadCell = payloads
      ? `<details class="event-detail-accordion"><summary class="event-detail-trigger">Details</summary><div class="event-detail-body">${payloads}</div></details>`
      : '';

    const stack = d.stack ? `<pre class="triage-stack" style="margin-top:4px;">${esc(String(d.stack).slice(0, 400))}</pre>` : '';

    return `
    <tr class="${isError ? 'highlight-row' : ''}">
      <td class="ts-cell">${formatTs(ev.ts_epoch_ms, sessionStartMs)}</td>
      <td><span class="type-chip ${getTypeClass(ev.type)}">${esc(ev.type)}</span></td>
      <td class="summary-cell">
        <div class="event-brief">${esc(brief.slice(0, 300))}</div>
        ${stack}
        ${payloadCell}
      </td>
    </tr>`;
  }).join('');
}

// ── WebSocket Connections ───────────────────────────────────────────────────────
// Groups the flat network.ws_* event stream by request_id into one row per
// connection (open→close), with an expandable frame timeline — the flat
// event list makes reconstructing "what did this one socket say over its
// lifetime" a manual scan; this view does that grouping for you.
const WS_EVENT_TYPES = [
  'network.ws_open', 'network.ws_handshake', 'network.ws_frame',
  'network.ws_error', 'network.ws_tail', 'network.ws_close',
];

function buildWsConnections(events) {
  const conns = new Map(); // request_id → connection
  const order = [];

  for (const ev of events) {
    const d = ev.data || {};
    const reqId = d.request_id;
    if (!reqId) continue;

    let conn = conns.get(reqId);
    if (!conn) {
      conn = {
        requestId: reqId,
        url: d.url_full || d.url_sanitized || 'unknown',
        openTs: ev.ts_epoch_ms,
        closeTs: null,
        status: 'open',
        framesSent: 0,
        framesReceived: 0,
        bytesSent: 0,
        bytesReceived: 0,
        hasError: false,
        timeline: [],
      };
      conns.set(reqId, conn);
      order.push(reqId);
    }

    conn.timeline.push(ev);
    if (d.url_sanitized || d.url_full) conn.url = d.url_full || d.url_sanitized;

    if (ev.type === 'network.ws_error') conn.hasError = true;
    if (ev.type === 'network.ws_close') {
      conn.status = conn.hasError ? 'error' : 'closed';
      conn.closeTs = ev.ts_epoch_ms;
      conn.framesSent = d.frames_sent || 0;
      conn.framesReceived = d.frames_received || 0;
      conn.bytesSent = d.bytes_sent || 0;
      conn.bytesReceived = d.bytes_received || 0;
    }
  }

  // Most-recent-first, like the rest of the dashboard's event views
  return order.reverse().map(id => conns.get(id));
}

async function loadWsConnections() {
  if (!currentSessionId) return;
  const listEl = document.getElementById('ws-conn-list');
  listEl.innerHTML = '<div class="loading-row"><span class="spinner"></span> Loading…</div>';

  const params = new URLSearchParams({ limit: 5000, types: WS_EVENT_TYPES.join(',') });
  const res = await fetch(`${API}/sessions/${currentSessionId}/events?${params}`);
  const { events: rawEvents } = await res.json();
  const events = normalizeEventList(rawEvents);
  allWsConnectionsCache = buildWsConnections(events);

  const errorCount = allWsConnectionsCache.filter(c => c.hasError).length;
  const badge = document.getElementById('tab-ws-badge');
  if (errorCount > 0) { badge.textContent = errorCount; badge.style.display = ''; }
  else badge.style.display = 'none';

  renderWsConnections(allWsConnectionsCache);
}

function filterWsBy(mode) {
  wsFilter = mode;
  document.getElementById('ws-filter-errors').style.display = mode === 'errors' ? 'none' : '';
  document.getElementById('ws-filter-all').style.display = mode === 'all' ? 'none' : '';
  filterWsConnections();
}

function filterWsConnections() {
  const q = (document.getElementById('ws-search').value || '').toLowerCase();
  let conns = allWsConnectionsCache;
  if (wsFilter === 'errors') conns = conns.filter(c => c.hasError);
  if (q) conns = conns.filter(c => c.url.toLowerCase().includes(q));
  renderWsConnections(conns);
}

function wsFrameRowHtml(ev) {
  const d = ev.data || {};
  const ts = formatTs(ev.ts_epoch_ms, sessionStartMs);
  switch (ev.type) {
    case 'network.ws_open':
      return `<div class="ws-frame-row">${ts} — OPEN</div>`;
    case 'network.ws_handshake':
      return `<div class="ws-frame-row">${ts} — HANDSHAKE ${esc(String(d.status || ''))} ${esc(d.statusText || '')}</div>`;
    case 'network.ws_frame': {
      const arrow = d.direction === 'sent' ? '↑' : '↓';
      const omitted = !d.payload || d.payload.startsWith('[omitted');
      const payloadHtml = omitted
        ? (d.payload ? ` — <span style="opacity:0.7">${esc(d.payload)}</span>` : '')
        : ` ${makePayloadAccordion('Payload', d.payload, false)}`;
      return `<div class="ws-frame-row">${ts} — ${arrow} ${d.size ?? ''}B${payloadHtml}</div>`;
    }
    case 'network.ws_error':
      return `<div class="ws-frame-row is-error">${ts} — ERROR: ${esc(d.errorMessage || '')}</div>`;
    case 'network.ws_tail': {
      const frames = (d.frames || []).map(f => {
        const arrow = f.direction === 'sent' ? '↑' : '↓';
        return makePayloadAccordion(`Recovered frame ${arrow} (${f.size ?? '?'}B, #${f.frame_index})`, f.payload, false);
      }).join('');
      return `<div class="ws-frame-row is-tail">${ts} — TAIL: ${d.frames?.length || 0} frame(s) recovered before ${esc(d.reason || 'event')} (fell outside the head sample)${frames}</div>`;
    }
    case 'network.ws_close':
      return `<div class="ws-frame-row">${ts} — CLOSE (${d.frames_sent || 0}↑/${d.frames_received || 0}↓ frames, ${d.bytes_sent || 0}↑/${d.bytes_received || 0}↓ bytes)</div>`;
    default:
      return '';
  }
}

function renderWsConnections(conns) {
  const listEl = document.getElementById('ws-conn-list');
  document.getElementById('ws-total').textContent = `${conns.length} connection${conns.length !== 1 ? 's' : ''}`;

  if (!conns.length) {
    listEl.innerHTML = '<div class="empty-list">No WebSocket activity captured in this session.</div>';
    return;
  }

  listEl.innerHTML = conns.map(conn => {
    const duration = conn.closeTs ? `${((conn.closeTs - conn.openTs) / 1000).toFixed(1)}s` : 'still open';
    const dotClass = conn.hasError ? 'error' : (conn.status === 'open' ? 'open' : 'closed');
    const timelineHtml = conn.timeline.map(wsFrameRowHtml).join('');

    return `
      <details class="ws-conn-card ${conn.hasError ? 'has-error' : ''}">
        <summary class="ws-conn-summary">
          <span class="ws-status-dot ${dotClass}" title="${esc(conn.status)}"></span>
          <span class="ws-conn-url">${esc(conn.url)}</span>
          <span class="ws-conn-stat">${formatTs(conn.openTs, sessionStartMs)} · ${duration}</span>
          <span class="ws-conn-stat">${conn.framesSent}↑/${conn.framesReceived}↓ frames</span>
          <span class="ws-conn-stat">${conn.bytesSent}↑/${conn.bytesReceived}↓ bytes</span>
        </summary>
        <div class="ws-conn-body">${timelineHtml}</div>
      </details>`;
  }).join('');
}

// ── User Actions ──────────────────────────────────────────────────────────────
async function loadInputTrack() {
  if (!currentSessionId) return;
  const tbody = document.getElementById('input-tbody');
  tbody.innerHTML = '<tr><td colspan="3"><div class="loading-row"><span class="spinner"></span> Loading…</div></td></tr>';

  const typeFilter = document.getElementById('input-type-filter').value;
  const params = new URLSearchParams({ limit: 1000 });
  if (typeFilter) {
    params.set('type', typeFilter);
  } else {
    params.set('types', 'action.click,action.scroll,action.navigation');
  }

  const res = await fetch(`${API}/sessions/${currentSessionId}/events?${params}`);
  const { events: rawEvents } = await res.json();
  const events = normalizeEventList(rawEvents);
  allInputEventsCache = events;

  const clickCount = events.filter(e => e.type === 'action.click').length;
  const scrollCount = events.filter(e => e.type === 'action.scroll').length;
  const navCount = events.filter(e => e.type === 'action.navigation').length;

  document.getElementById('input-total').textContent = `${events.length} interactions`;

  const badge = document.getElementById('tab-input-badge');
  if (events.length > 0) { badge.textContent = events.length; badge.style.display = ''; }
  else badge.style.display = 'none';

  document.getElementById('input-stat-row').innerHTML = [
    `<div class="input-stat-chip chip-click"><span class="chip-val">${clickCount}</span>&nbsp;Clicks</div>`,
    `<div class="input-stat-chip chip-scroll"><span class="chip-val">${scrollCount}</span>&nbsp;Scrolls</div>`,
    `<div class="input-stat-chip chip-nav"><span class="chip-val">${navCount}</span>&nbsp;Navigations</div>`,
  ].join('');

  renderInputTable(events);
}

function filterInputTable() {
  const q = (document.getElementById('input-search').value || '').toLowerCase();
  if (!q) { renderInputTable(allInputEventsCache); return; }
  const filtered = allInputEventsCache.filter(ev => {
    const d = ev.data || {};
    const haystack = [
      ev.type,
      d.text_snippet || '',
      d.selector || '',
      d.to_url || '',
      d.from_url || '',
      String(d.deltaY || ''),
    ].join(' ').toLowerCase();
    return haystack.includes(q);
  });
  renderInputTable(filtered);
}

function renderInputTable(events) {
  // Scale scroll delta bars relative to the max in this result set
  const scrollEvents = events.filter(e => e.type === 'action.scroll');
  const maxDelta = scrollEvents.length
    ? Math.max(1, ...scrollEvents.map(e => Math.abs((e.data || {}).deltaY || 0)))
    : 1;

  document.getElementById('input-tbody').innerHTML = events.map(ev => {
    const d = ev.data || {};
    let detailHtml = '';

    switch (ev.type) {
      case 'action.click': {
        const text = d.text_snippet
          ? `<span style="font-weight:600;">${esc(d.text_snippet.slice(0, 80))}</span>`
          : '<em style="color:var(--text-dim)">no text</em>';
        const sel = d.selector
          ? `<div class="input-selector">${esc(d.selector.slice(0, 120))}</div>`
          : '';
        detailHtml = `<div class="input-detail-cell" style="display:flex;align-items:center;gap:5px;">${icon('mousePointer', 12)} ${text}${sel}</div>`;
        break;
      }
      case 'action.scroll': {
        const dy = d.deltaY || 0;
        const dir = dy > 0 ? `${icon('arrowDown', 11)} Down` : `${icon('arrowUp', 11)} Up`;
        const pct = Math.min(100, (Math.abs(dy) / maxDelta) * 100);
        const barHtml = `<span class="scroll-delta-bar-bg"><span class="scroll-delta-bar-fill" style="width:${pct}%"></span></span>`;
        detailHtml = `<div class="input-detail-cell">${dir} <span style="color:var(--accent2);font-weight:600;">${Math.abs(dy).toFixed(0)}px</span>${barHtml}</div>`;
        break;
      }
      case 'action.navigation': {
        const from = d.from_url
          ? `<span style="color:var(--text-dim);">${esc(d.from_url.slice(0, 60))}</span>`
          : '';
        const to = d.to_url
          ? `<span style="color:var(--success);font-weight:600;">${esc(d.to_url.slice(0, 80))}</span>`
          : '<em>unknown</em>';
        const arrow = from ? `<span class="input-nav-arrow">→</span>` : '';
        detailHtml = `<div class="input-detail-cell" style="display:flex;align-items:center;gap:5px;">${icon('link', 12)} ${from}${arrow}${to}</div>`;
        break;
      }
      default:
        detailHtml = `<div class="input-detail-cell">${esc(JSON.stringify(d).slice(0, 120))}</div>`;
    }

    return `
    <tr>
      <td class="ts-cell">${formatTs(ev.ts_epoch_ms, sessionStartMs)}</td>
      <td><span class="type-chip ${getTypeClass(ev.type)}">${esc(ev.type)}</span></td>
      <td>${detailHtml}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="3" class="empty-list">No interactions recorded</td></tr>';
}

// ── Video ─────────────────────────────────────────────────────────────────────
let _videoSideEvents = [];   // persisted so filter buttons can re-render without re-fetching
let _videoFilter = 'all';    // 'all' | 'input' | 'system'

async function loadVideo() {
  if (!currentSessionId) return;
  const container   = document.getElementById('video-container');
  const sidebar     = document.getElementById('video-sidebar');
  const scrubberEl  = document.getElementById('video-scrubber-wrap');
  const controlsEl  = document.getElementById('video-custom-controls');

  container.innerHTML  = '<div class="no-video"><span class="spinner"></span> Loading video…</div>';
  scrubberEl.innerHTML = '';
  controlsEl.innerHTML = '';
  sidebar.innerHTML    = '<div class="video-sidebar-title">Activity Feed</div><div class="no-video"><span class="spinner"></span></div>';
  _videoFilter = 'all';

  try {
    const res = await fetch(`${API}/sessions/${currentSessionId}/video?list=1`);
    const { chunks } = await res.json();

    if (!chunks || !chunks.length) {
      container.innerHTML = `<div class="no-video">${icon('film', 34)}<div class="no-video-title">No video recorded</div><div class="no-video-sub">This session doesn't have a screen capture attached.</div></div>`;
      sidebar.innerHTML   = `<div class="video-sidebar-title">Activity Feed</div><div class="no-video" style="padding:30px 20px;">${icon('film', 26)}<div class="no-video-sub">No video</div></div>`;
      return;
    }

    // ── Video element ─────────────────────────────────────────────
    container.innerHTML = `
      <video preload="metadata" id="session-video" style="width:100%;max-height:100%;display:block;outline:none;">
        <source src="${API}/sessions/${currentSessionId}/video" type="video/webm" />
      </video>`;

    const video = document.getElementById('session-video');

    // Fix infinite WebM duration
    video.addEventListener('loadedmetadata', () => {
      if (video.duration === Infinity || isNaN(video.duration)) {
        video.currentTime = 1e10;
        video.addEventListener('timeupdate', function hack() {
          video.currentTime = 0;
          video.removeEventListener('timeupdate', hack);
        });
      }
      rebuildScrubber(video, _videoSideEvents);
    });

    // ── Helper: format seconds → m:ss ─────────────────────────────
    function fmtSec(s) {
      if (!isFinite(s) || s < 0) return '0:00';
      const m = Math.floor(s / 60);
      const ss = Math.floor(s % 60);
      return `${m}:${ss.toString().padStart(2, '0')}`;
    }

    // ── Custom Controls bar ───────────────────────────────────────
    const speeds = [0.5, 1, 1.5, 2];
    let currentSpeed = 1;

    function buildControls() {
      const playerRoot = document.getElementById('video-player-root');
      controlsEl.className = 'video-custom-controls';
      controlsEl.innerHTML = `
        <button class="vctrl-btn" id="vctrl-play" title="Play / Pause (Space)" onclick="window._videoTogglePlay()">${icon('play', 13)}</button>
        <span class="vctrl-time" id="vctrl-time">0:00 / 0:00</span>
        <span class="vctrl-spacer"></span>
        <div class="vctrl-marker-legend">
          <span><span class="legend-dot" style="background:#ef4444"></span> Error</span>
          <span><span class="legend-dot" style="background:#f59e0b"></span> Warn</span>
          <span><span class="legend-dot" style="background:#6366f1"></span> Action</span>
          <span><span class="legend-dot" style="background:#10b981"></span> Marker</span>
        </div>
        <div class="speed-group" id="vctrl-speed-group">
          ${speeds.map(s => `<button class="speed-btn ${s === 1 ? 'active' : ''}" onclick="window._videoSetSpeed(${s})">${s}×</button>`).join('')}
        </div>
        <button class="vctrl-btn" title="Fullscreen (F)" onclick="window._videoFullscreen()">${icon('maximize', 13)}</button>`;
    }
    buildControls();

    // Global helpers for inline onclick
    window._videoTogglePlay = () => { video.paused ? video.play() : video.pause(); };
    window._videoFullscreen = () => {
      const root = document.getElementById('video-player-root');
      if (document.fullscreenElement) document.exitFullscreen();
      else root.requestFullscreen?.() || root.webkitRequestFullscreen?.();
    };
    window._videoSetSpeed = (s) => {
      currentSpeed = s;
      video.playbackRate = s;
      document.querySelectorAll('.speed-btn').forEach(b => {
        b.classList.toggle('active', parseFloat(b.textContent) === s);
      });
    };

    // Keyboard shortcuts
    const kbHandler = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === ' ') { e.preventDefault(); window._videoTogglePlay(); }
      if (e.key === 'ArrowLeft')  video.currentTime = Math.max(0, video.currentTime - 5);
      if (e.key === 'ArrowRight') video.currentTime = Math.min(video.duration || 0, video.currentTime + 5);
      if (e.key === 'f' || e.key === 'F') window._videoFullscreen();
    };
    // Remove previous handler if re-loading video tab
    document.removeEventListener('keydown', window._videoKbHandler);
    window._videoKbHandler = kbHandler;
    document.addEventListener('keydown', kbHandler);

    // Play/pause icon sync
    video.addEventListener('play',  () => { const b = document.getElementById('vctrl-play'); if (b) b.innerHTML = icon('pause', 13); });
    video.addEventListener('pause', () => { const b = document.getElementById('vctrl-play'); if (b) b.innerHTML = icon('play', 13); });

    // ── Scrubber builder ──────────────────────────────────────────
    // Called once metadata is loaded (so video.duration is known)
    function rebuildScrubber(vid, events) {
      const dur = vid.duration;
      if (!isFinite(dur) || dur <= 0) return;

      // Marker kind classifier
      function markerKind(type) {
        if (['console.error', 'runtime.exception'].includes(type)) return 'error';
        if (type === 'console.warn') return 'warn';
        if (type.startsWith('action.')) return 'action';
        if (type.startsWith('marker.')) return 'marker';
        return null;
      }

      const markerDots = (events || []).map(ev => {
        const kind = markerKind(ev.type);
        if (!kind) return '';
        const pct = Math.min(100, ((ev.ts_epoch_ms - sessionStartMs) / (dur * 1000)) * 100);
        const brief = String(summarizeEvent(ev) || ev.type).replace(/<[^>]+>/g, '').slice(0, 50);
        const ts = fmtSec((ev.ts_epoch_ms - sessionStartMs) / 1000);
        return `<div class="scrubber-marker" data-kind="${kind}"
                     data-tip="${esc(ts + ' — ' + brief)}"
                     style="left:${pct}%"
                     onclick="seekVideo(${ev.ts_epoch_ms})"></div>`;
      }).join('');

      scrubberEl.className = 'video-scrubber-wrap';
      scrubberEl.innerHTML = `
        <div class="video-scrubber-track" id="vscrub-track">
          <div class="video-scrubber-fill" id="vscrub-fill"></div>
          <div class="video-scrubber-thumb" id="vscrub-thumb"></div>
          ${markerDots}
        </div>`;

      // Click-to-seek on the scrubber track
      scrubberEl.addEventListener('click', (e) => {
        const rect = scrubberEl.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        vid.currentTime = pct * dur;
      });
    }

    // ── timeupdate: scrubber fill + sidebar highlight ─────────────
    video.addEventListener('timeupdate', () => {
      const dur = video.duration;
      const cur = video.currentTime;

      // Update time label
      const timeEl = document.getElementById('vctrl-time');
      if (timeEl) timeEl.textContent = `${fmtSec(cur)} / ${fmtSec(dur)}`;

      // Update scrubber fill + thumb
      if (isFinite(dur) && dur > 0) {
        const pct = (cur / dur) * 100;
        const fill  = document.getElementById('vscrub-fill');
        const thumb = document.getElementById('vscrub-thumb');
        if (fill)  fill.style.width = pct + '%';
        if (thumb) thumb.style.left = pct + '%';
      }

      // Sidebar: highlight nearest event
      const absoluteMs = sessionStartMs + cur * 1000;
      let activeRef = -1;
      for (let i = 0; i < _videoSideEvents.length; i++) {
        if (_videoSideEvents[i].ts_epoch_ms <= absoluteMs) activeRef = i; else break;
      }
      document.querySelectorAll('.video-event').forEach(el => el.classList.remove('active'));
      if (activeRef !== -1) {
        const el = document.getElementById(`vev-${activeRef}`);
        if (el) { el.classList.add('active'); el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
      }
    });

    // ── Load side events ──────────────────────────────────────────
    const reqTypes = 'action.click,action.scroll,action.navigation,console.warn,console.error,runtime.exception,marker.bug,system.warning';
    const evRes = await fetch(`${API}/sessions/${currentSessionId}/events?types=${reqTypes}&limit=5000`);
    const { events: rawSideEvents } = await evRes.json();
    const sideEvents = normalizeEventList(rawSideEvents);
    _videoSideEvents = sideEvents;

    // If metadata already loaded, build the scrubber now
    if (isFinite(video.duration) && video.duration > 0) {
      rebuildScrubber(video, sideEvents);
    }
    // else: loadedmetadata event above will call rebuildScrubber

    renderVideoFeed('all');

  } catch (err) {
    container.innerHTML = `<div class="no-video">${icon('alertTriangle', 30)}<div class="no-video-title">Error loading video</div></div>`;
    sidebar.innerHTML   = '<div class="video-sidebar-title">Activity Feed</div>';
  }
}


const INPUT_TYPES = new Set(['action.click', 'action.scroll', 'action.navigation']);
const SYSTEM_TYPES = new Set(['console.warn', 'console.error', 'runtime.exception', 'marker.bug', 'system.warning']);

function renderVideoFeed(filter) {
  _videoFilter = filter;
  const sidebar = document.getElementById('video-sidebar');
  if (!sidebar) return;

  const filtered = filter === 'input'
    ? _videoSideEvents.filter(ev => INPUT_TYPES.has(ev.type))
    : filter === 'system'
      ? _videoSideEvents.filter(ev => SYSTEM_TYPES.has(ev.type))
      : _videoSideEvents;

  const pills = [
    { id: 'all', label: 'All', iconName: 'list' },
    { id: 'input', label: 'Interactions', iconName: 'mousePointer' },
    { id: 'system', label: 'Errors', iconName: 'alertTriangle' },
  ].map(p => `
    <button class="vfeed-pill ${filter === p.id ? 'active' : ''}" onclick="renderVideoFeed('${p.id}')">
      ${icon(p.iconName, 11)} ${p.label}
    </button>`).join('');

  const inputCount = _videoSideEvents.filter(ev => INPUT_TYPES.has(ev.type)).length;
  const systemCount = _videoSideEvents.filter(ev => SYSTEM_TYPES.has(ev.type)).length;

  let html = `
    <div class="video-sidebar-title">Activity Feed</div>
    <div class="vfeed-pills">${pills}</div>
    <div class="vfeed-counts">
      <span style="display:inline-flex;align-items:center;gap:3px;">${icon('mousePointer', 10)} ${inputCount} interactions</span>
      <span style="display:inline-flex;align-items:center;gap:3px;">${icon('alertTriangle', 10)} ${systemCount} system</span>
    </div>`;

  if (!filtered.length) {
    html += '<div class="no-video" style="font-size:12px;">No events in this category.</div>';
  } else {
    html += filtered.map((ev, i) => {
      // use original index so timeupdate highlight still works
      const origIdx = _videoSideEvents.indexOf(ev);
      const isInput = INPUT_TYPES.has(ev.type);
      const brief = String(summarizeEvent(ev) || '').replace(/<[^>]+>/g, '').slice(0, 80);
      return `
        <div class="video-event ${isInput ? 'vev-input' : 'vev-system'}" id="vev-${origIdx}" onclick="seekVideo(${ev.ts_epoch_ms})">
          <div class="video-event-ts">${formatTs(ev.ts_epoch_ms, sessionStartMs)}</div>
          <span class="type-chip ${getTypeClass(ev.type)}">${esc(ev.type)}</span>
          <div class="video-event-summary">${esc(brief)}</div>
        </div>`;
    }).join('');
  }

  sidebar.innerHTML = html;
}

window.renderVideoFeed = renderVideoFeed;


function setPlaybackSpeed() {
  const video = document.getElementById('session-video');
  const speed = parseFloat(document.getElementById('playback-speed').value);
  if (video) video.playbackRate = speed;
}

window.seekVideo = function (epochMs) {
  const video = document.getElementById('session-video');
  if (!video) return;
  video.currentTime = Math.max(0, (epochMs - sessionStartMs) / 1000);
};

// ── Tabs ──────────────────────────────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  ['overview', 'triage', 'video', 'repro', 'input', 'events', 'ws'].forEach(t => {
    document.getElementById(`tab-${t}`)?.classList.toggle('active', t === tab);
    document.getElementById(`panel-${t}`)?.classList.toggle('active', t === tab);
  });
  updateUrlHash();
  if (tab === 'triage') loadTriage();
  else if (tab === 'input') loadInputTrack();
  else if (tab === 'events') loadEvents();
  else if (tab === 'video') loadVideo();
  else if (tab === 'repro') loadReproSteps();
  else if (tab === 'ws') loadWsConnections();
}

// ── Shareable Deep Links ─────────────────────────────────────────────────────
// #/session/<id>/<tab> — lets a QA tester paste a direct link to a session
// (and tab) for a developer to open straight away.
function updateUrlHash() {
  if (!currentSessionId) return;
  history.replaceState(null, '', `#/session/${currentSessionId}/${currentTab}`);
}

function applyHashRoute() {
  const m = location.hash.match(/^#\/session\/([^/]+)(?:\/([a-z]+))?/);
  if (!m) return;
  const [, id, tab] = m;
  if (!allSessionsCache.some(s => s.id === id)) return;
  selectSession(id).then(() => {
    if (tab && tab !== 'overview') switchTab(tab);
  });
}

async function copySessionLink() {
  if (!currentSessionId) return;
  await copyEventText(location.href);
}

// ── Repro Steps ───────────────────────────────────────────────────────────────
const REPRO_STEP_ICONS = {
  navigate: 'link', click: 'mousePointer', fill_field: 'edit', submit_form: 'checkCircle',
  select_option: 'list', press_key: 'zap', scroll: 'arrowDown', observe_toast: 'infoCircle',
  raw_action: 'activity',
};

async function loadReproSteps() {
  if (!currentSessionId) return;
  const listEl = document.getElementById('repro-list');
  const countEl = document.getElementById('repro-count');
  listEl.innerHTML = '<div class="loading-row"><span class="spinner"></span> Loading…</div>';
  try {
    const res = await fetch(`${API}/sessions/${currentSessionId}/normalized`);
    if (res.status === 404) {
      countEl.textContent = '';
      listEl.innerHTML = `
        <div class="empty-list" style="padding:32px; display:flex; flex-direction:column; align-items:center; gap:10px;">
          <span style="color:var(--text-dim);display:inline-flex;">${icon('list', 30)}</span>
          <div>No repro steps generated yet for this session.</div>
          <button class="btn btn-primary" onclick="generateReproSteps()">Generate Repro Steps</button>
        </div>`;
      return;
    }
    if (!res.ok) throw new Error();
    const data = await res.json();
    renderReproSteps(data);
  } catch {
    countEl.textContent = '';
    listEl.innerHTML = '<div class="empty-list" style="color:var(--danger)">Failed to load repro steps</div>';
  }
}

function renderReproSteps(data) {
  const listEl = document.getElementById('repro-list');
  const countEl = document.getElementById('repro-count');
  const steps = data?.steps || [];
  countEl.textContent = steps.length ? `${steps.length} steps` : '';

  if (!steps.length) {
    listEl.innerHTML = '<div class="empty-list">No steps found — try a session with more recorded activity.</div>';
    return;
  }

  listEl.innerHTML = steps.map(s => `
    <div class="repro-step">
      <div class="repro-step-dot">${icon(REPRO_STEP_ICONS[s.step_type] || 'activity', 13)}</div>
      <div class="repro-step-body">
        <div class="repro-step-label">${esc(s.label || s.step_type)}</div>
        <div class="repro-step-meta">${formatTs(s.start_ts, sessionStartMs)}${s.selector ? ` · ${esc(s.selector)}` : ''}</div>
      </div>
    </div>`).join('');
}

async function generateReproSteps() {
  if (!currentSessionId) return;
  const btn = document.getElementById('repro-generate-btn');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> …`;
  try {
    const res = await fetch(`${API}/sessions/${currentSessionId}/normalize`, { method: 'POST' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Failed');
    showToast(`Generated ${data.step_count} repro steps`, 'success');
    await loadReproSteps();
  } catch (err) {
    showToast('Failed to generate repro steps', 'error');
  }
  btn.disabled = false;
  btn.innerHTML = original;
}

// ── Regen Views ───────────────────────────────────────────────────────────────
async function regenerateViews() {
  if (!currentSessionId) return;
  const btn = document.getElementById('regen-btn');
  btn.disabled = true; btn.innerHTML = `<span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> …`;
  try {
    const res = await fetch(`${API}/sessions/${currentSessionId}/regenerate-views`, { method: 'POST' });
    const data = await res.json();
    showToast(`Views regenerated: ${data.triageEventCount} triage events`, 'success');
    if (currentTab === 'triage') loadTriage();
  } catch {
    showToast('Failed to regenerate views', 'error');
  }
  btn.disabled = false; btn.innerHTML = `${icon('refresh', 13)} Regen`;
}

// ── Slack Integration ────────────────────────────────────────────────────────
let _slackConfigCache = null; // { configured, defaultChannel, savedChannels, savedThreads }

function closeModal(id) {
  document.getElementById(id)?.classList.remove('show');
}

function openModal(id) {
  document.getElementById(id)?.classList.add('show');
}

document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.remove('show');
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.show').forEach(o => o.classList.remove('show'));
  }
});

function sessionDeepLink(id, tab) {
  return `${location.origin}${location.pathname}#/session/${id}/${tab}`;
}

async function fetchSlackConfig() {
  try {
    const res = await fetch(`${API}/integrations/slack/config`);
    _slackConfigCache = await res.json();
  } catch {
    _slackConfigCache = { configured: false, defaultChannel: null, savedChannels: [], savedThreads: [] };
  }
  return _slackConfigCache;
}

// ── Top-level nav: Sessions | Bug Manager | Integrations ───────────────────────
// Integrations owns Slack *connection config* (bot token, which channels/
// threads exist) — Bug Manager owns *browsing/managing the bugs* reported
// into those channels/threads. They used to be one combined "Integrations"
// hub; kept as two separate main-content views (settings-view / bugmanager-
// view) so neither is buried inside the other.
function switchSidebar(tab) {
  ['sessions', 'bugs', 'settings'].forEach(t => {
    document.getElementById(`sidebar-${t}`).style.display = t === tab ? 'flex' : 'none';
    const btn = document.getElementById(`nav-btn-${t}`);
    btn.style.borderBottomColor = t === tab ? 'var(--accent)' : 'transparent';
    btn.style.color = t === tab ? 'var(--accent)' : 'var(--text-muted)';
  });

  document.getElementById('settings-view').style.display = tab === 'settings' ? 'flex' : 'none';
  document.getElementById('bugmanager-view').style.display = tab === 'bugs' ? 'flex' : 'none';

  if (tab === 'settings' || tab === 'bugs') {
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('session-detail').style.display = 'none';
    if (tab === 'settings') showIntegrationsHub();
    else showBugManagerHub();
  } else {
    if (currentSessionId) {
      document.getElementById('session-detail').style.display = 'flex';
    } else {
      document.getElementById('empty-state').style.display = '';
    }
    loadSessions();
  }
}

// One bot token per user/team ("universal" — set once, applies to every
// channel), so it lives in its own small modal instead of inside the
// channel-management page. Both sidebars list channels (Integrations for
// connection config, Bug Manager as a read-only picker into bug data) —
// same list-then-detail pattern as Sessions, applied deeper still in Bug
// Manager so each channel drills into its threads, and each thread drills
// into the bugs reported into it — mirroring how Slack itself organizes a
// channel into threads.
let _selectedChannelId = null;
let _selectedThreadId = null;
let _selectedBugId = null;

async function showIntegrationsHub() {
  _selectedChannelId = null;
  document.getElementById('integrations-hub-view').style.display = 'flex';
  document.getElementById('integrations-channel-detail').style.display = 'none';
  await renderIntegrationsSidebarList();
}

// ── Bug Manager: same channel data as Integrations, but a read-only
// picker into bugs rather than connection config. ──────────────────────────
async function showBugManagerHub() {
  _selectedChannelId = null;
  _selectedThreadId = null;
  _selectedBugId = null;
  document.getElementById('bugmanager-hub-view').style.display = 'flex';
  document.getElementById('bm-channel-detail').style.display = 'none';
  document.getElementById('thread-bug-list-view').style.display = 'none';
  document.getElementById('bug-detail').style.display = 'none';
  await renderBugManagerSidebarList();
}

async function renderBugManagerSidebarList() {
  const cfg = await fetchSlackConfig();
  const channels = cfg.savedChannels || [];
  const status = document.getElementById('bugmanager-status-filter')?.value || '';

  const res = await fetch(`${API}/bugs${status ? `?status=${encodeURIComponent(status)}` : ''}`);
  const data = await res.json();
  const allBugs = data.bugs || [];

  document.getElementById('bugmanager-count').textContent =
    `${allBugs.length} bug${allBugs.length !== 1 ? 's' : ''}`;

  const list = document.getElementById('bugmanager-channel-list');
  if (!channels.length) {
    list.innerHTML = '<div class="field-sub" style="padding:12px 16px;">No channels connected yet — add one from the Integrations tab.</div>';
    return;
  }
  list.innerHTML = channels.map(c => {
    const isActive = c.id === _selectedChannelId;
    const bugCount = allBugs.filter(b => b.channel === c.id).length;
    return `
      <div class="session-item ${isActive ? 'active' : ''}" onclick="selectBugManagerChannel('${esc(c.id)}')">
        <div class="session-item-top" style="align-items:center; gap:8px;">
          <div class="session-title" style="flex:1;">${esc(c.name)}</div>
          ${bugCount ? `<span class="badge badge-warn">${bugCount}</span>` : ''}
        </div>
        <div class="session-meta">
          <span class="mono" style="font-family:'JetBrains Mono',monospace;">${esc(c.id)}</span>
        </div>
      </div>`;
  }).join('');
}

function selectBugManagerChannel(channelId) {
  _selectedChannelId = channelId;
  _selectedThreadId = null;
  _selectedBugId = null;
  renderBugManagerSidebarList();
  document.getElementById('bugmanager-hub-view').style.display = 'none';
  document.getElementById('thread-bug-list-view').style.display = 'none';
  document.getElementById('bug-detail').style.display = 'none';
  document.getElementById('bm-channel-detail').style.display = 'flex';
  renderBugManagerChannelDetail(channelId);
}

// Level 2 (Bug Manager): a channel's threads (bug-count badges, clickable)
// + bugs reported straight to the channel with no matching saved thread.
async function renderBugManagerChannelDetail(channelId) {
  const cfg = _slackConfigCache || {};
  const channel = (cfg.savedChannels || []).find(c => c.id === channelId);
  if (!channel) { showBugManagerHub(); return; }

  document.getElementById('bm-channel-breadcrumb').innerHTML =
    `<span class="crumb" onclick="showBugManagerHub()">Channels</span><span class="crumb-sep">›</span><span class="crumb current">${esc(channel.name)}</span>`;
  document.getElementById('bm-channel-detail-title').textContent = channel.name;
  document.getElementById('bm-channel-detail-id').textContent = channel.id;

  const threads = (cfg.savedThreads || []).filter(t => t.channel === channelId);
  const status = document.getElementById('bugmanager-status-filter')?.value || '';

  const res = await fetch(`${API}/bugs?channel=${encodeURIComponent(channelId)}${status ? `&status=${encodeURIComponent(status)}` : ''}`);
  const data = await res.json();
  const channelBugs = data.bugs || [];
  const threadLinks = new Set(threads.map(t => t.link));

  const list = document.getElementById('bm-channel-threads-list');
  list.innerHTML = threads.length
    ? threads.map(t => {
        const bugCount = channelBugs.filter(b => b.thread_link === t.link).length;
        return `
        <div class="thread-row" onclick="selectThread('${esc(channelId)}', '${esc(t.id)}')">
          <span class="thread-row-name">${esc(t.name)}</span>
          ${bugCount ? `<span class="badge badge-warn">${bugCount} bug${bugCount !== 1 ? 's' : ''}</span>` : '<span class="field-sub">No bugs yet</span>'}
        </div>`;
      }).join('')
    : '<div class="field-sub">No saved threads in this channel yet — add one from the Integrations tab.</div>';

  const channelLevelBugs = channelBugs.filter(b => !b.thread_link || !threadLinks.has(b.thread_link));
  const bugsWrap = document.getElementById('bm-channel-level-bugs-wrap');
  const bugsList = document.getElementById('bm-channel-level-bugs-list');
  if (channelLevelBugs.length) {
    bugsWrap.style.display = '';
    bugsList.innerHTML = channelLevelBugs.map(renderBugRow).join('');
  } else {
    bugsWrap.style.display = 'none';
  }
}

async function renderIntegrationsSidebarList() {
  const cfg = await fetchSlackConfig();
  const channels = cfg.savedChannels || [];
  const threads = cfg.savedThreads || [];

  document.getElementById('integrations-count').textContent =
    `${channels.length} channel${channels.length !== 1 ? 's' : ''}`;

  // Bot Token strip — always visible above the channel list.
  document.getElementById('slack-token-strip').innerHTML = `
    <div style="display:flex; align-items:center; gap:8px; padding:10px 16px; border-bottom:1px solid var(--border); font-size:12px; flex-shrink:0;">
      <span style="color:var(--text-dim); display:flex;">${icon('slack', 14)}</span>
      <span style="flex:1; font-weight:600;">Bot Token</span>
      <span class="badge ${cfg.configured ? 'badge-success' : 'badge-warn'}">${cfg.configured ? '✓ Configured' : 'Not set'}</span>
      <button class="icon-btn" onclick="openSlackTokenModal()" title="Edit Bot Token">${icon('edit', 13)}</button>
    </div>`;

  const list = document.getElementById('integrations-list');
  if (!channels.length) {
    list.innerHTML = '<div class="field-sub" style="padding:12px 16px;">No channels yet — click "+ New Channel" above to add one.</div>';
  } else {
    list.innerHTML = channels.map(c => {
      const isDefault = cfg.defaultChannel === c.id;
      const isActive = c.id === _selectedChannelId;
      const threadCount = threads.filter(t => t.channel === c.id).length;
      return `
      <div class="session-item ${isActive ? 'active' : ''}" onclick="selectChannel('${esc(c.id)}')">
        <div class="session-item-top" style="align-items:center; gap:8px;">
          <button class="saved-row-star ${isDefault ? 'is-default' : ''}" onclick="event.stopPropagation(); setDefaultSlackChannel('${esc(c.id)}')" title="${isDefault ? 'Default channel' : 'Set as default'}">${icon('star', 13)}</button>
          <div class="session-title" style="flex:1;">${esc(c.name)}</div>
          <button class="saved-row-del" onclick="event.stopPropagation(); duplicateSlackChannel('${esc(c.id)}')" title="Duplicate">${icon('copy', 12)}</button>
          <button class="saved-row-del" style="margin-left:0;" onclick="event.stopPropagation(); deleteSlackChannel('${esc(c.id)}')" title="Remove">${icon('x', 12)}</button>
        </div>
        <div class="session-meta">
          <span class="mono" style="font-family:'JetBrains Mono',monospace;">${esc(c.id)}</span>
          <span>${threadCount} thread${threadCount !== 1 ? 's' : ''}</span>
        </div>
      </div>`;
    }).join('');
  }

  // Threads whose channel isn't (or no longer is) in the saved-channels list
  // still need to be visible somewhere rather than silently vanishing —
  // shown on the landing state, since there's no channel to nest them under.
  const savedChannelIds = new Set(channels.map(c => c.id));
  const orphanThreads = threads.filter(t => !savedChannelIds.has(t.channel));
  const orphanWrap = document.getElementById('slack-orphan-threads-wrap');
  const orphanList = document.getElementById('slack-orphan-threads-list');
  if (orphanThreads.length) {
    orphanWrap.style.display = '';
    orphanList.innerHTML = orphanThreads.map(t => `
      <div class="saved-row">
        <div style="min-width:0; flex:1;">
          <div class="saved-row-name">${esc(t.name)}</div>
          <div class="saved-row-sub">${esc(t.channel)}</div>
        </div>
        <button class="saved-row-del" onclick="deleteSlackThread('${esc(t.id)}')" title="Remove">${icon('x', 13)}</button>
      </div>`).join('');
  } else {
    orphanWrap.style.display = 'none';
  }
}

function selectChannel(channelId) {
  _selectedChannelId = channelId;
  renderIntegrationsSidebarList();
  document.getElementById('integrations-hub-view').style.display = 'none';
  document.getElementById('integrations-channel-detail').style.display = 'flex';
  renderChannelDetail(channelId);
}

// Level 2 (Integrations): a channel's threads — connection config only, so
// this is deliberately just names + delete, not clickable into bugs. Bug
// counts/browsing live in the Bug Manager tab's parallel
// renderBugManagerChannelDetail(), which fetches /bugs; this one doesn't
// need to.
function renderChannelDetail(channelId) {
  const cfg = _slackConfigCache || {};
  const channel = (cfg.savedChannels || []).find(c => c.id === channelId);
  if (!channel) { showIntegrationsHub(); return; }

  document.getElementById('channel-breadcrumb').innerHTML =
    `<span class="crumb" onclick="showIntegrationsHub()">Channels</span><span class="crumb-sep">›</span><span class="crumb current">${esc(channel.name)}</span>`;
  document.getElementById('channel-detail-title').textContent = channel.name;
  document.getElementById('channel-detail-id').textContent = channel.id;

  const threads = (cfg.savedThreads || []).filter(t => t.channel === channelId);

  const list = document.getElementById('channel-threads-list');
  list.innerHTML = threads.length
    ? threads.map(t => `
        <div class="thread-row">
          <span class="thread-row-name">${esc(t.name)}</span>
          <button class="saved-row-del" style="margin-left:0;" onclick="event.stopPropagation(); deleteSlackThread('${esc(t.id)}')" title="Remove">${icon('x', 12)}</button>
        </div>`).join('')
    : '<div class="field-sub">No saved threads in this channel yet — add one above.</div>';

  document.getElementById('channel-thread-link').value = '';
  document.getElementById('channel-thread-name').value = '';
}

function confirmAddThreadForSelectedChannel() {
  if (_selectedChannelId) confirmAddThreadForChannel(_selectedChannelId);
}

async function confirmAddThreadForChannel(channelId) {
  const linkInput = document.getElementById('channel-thread-link');
  const nameInput = document.getElementById('channel-thread-name');
  const link = linkInput.value.trim();
  const name = nameInput.value.trim();
  if (!link) { showToast('Paste a Slack message link first', 'error'); return; }

  try {
    const res = await fetch(`${API}/integrations/slack/threads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, link }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.message || 'Failed to save thread');
    _slackConfigCache.savedThreads = data.savedThreads;
    renderChannelDetail(channelId);
    renderIntegrationsSidebarList();
    showToast('Thread saved', 'success');
  } catch (e) {
    showToast(e.message || 'Failed to save thread — check the link', 'error');
  }
}

// "Duplicate" doesn't create a second row sharing the same Slack channel ID
// (the ID is the natural unique key) — it pre-fills the New Channel modal so
// you can quickly spin up a similarly-named entry pointed at a different
// channel/ID instead of retyping everything from scratch.
function duplicateSlackChannel(channelId) {
  const cfg = _slackConfigCache || {};
  const c = (cfg.savedChannels || []).find(ch => ch.id === channelId);
  if (!c) return;
  openNewChannelModal();
  document.getElementById('slack-new-channel-id').value = c.id;
  document.getElementById('slack-new-channel-name').value = `${c.name} (copy)`;
  const idInput = document.getElementById('slack-new-channel-id');
  idInput.focus();
  idInput.select();
  showToast('Edit the Channel ID (and name if you like), then click Create', 'info');
}

function openNewChannelModal() {
  document.getElementById('slack-new-channel-id').value = '';
  document.getElementById('slack-new-channel-name').value = '';
  openModal('new-channel-modal');
  document.getElementById('slack-new-channel-name').focus();
}

async function confirmNewChannel() {
  const id = document.getElementById('slack-new-channel-id').value.trim();
  const name = document.getElementById('slack-new-channel-name').value.trim();
  if (!id) { showToast('Enter a channel ID', 'error'); return; }
  try {
    const res = await fetch(`${API}/integrations/slack/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error();
    _slackConfigCache.savedChannels = data.savedChannels;
    _slackConfigCache.defaultChannel = data.defaultChannel;
    closeModal('new-channel-modal');
    renderIntegrationsSidebarList();
    showToast('Channel created', 'success');
  } catch {
    showToast('Failed to save channel', 'error');
  }
}

async function deleteSlackChannel(id) {
  try {
    const res = await fetch(`${API}/integrations/slack/channels/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.ok) throw new Error();
    _slackConfigCache.savedChannels = data.savedChannels;
    _slackConfigCache.defaultChannel = data.defaultChannel;
    if (_selectedChannelId === id) showIntegrationsHub();
    else renderIntegrationsSidebarList();
  } catch {
    showToast('Failed to remove channel', 'error');
  }
}

async function setDefaultSlackChannel(id) {
  try {
    const res = await fetch(`${API}/integrations/slack/channels/${encodeURIComponent(id)}/default`, { method: 'POST' });
    const data = await res.json();
    if (!data.ok) throw new Error();
    _slackConfigCache.defaultChannel = data.defaultChannel;
    renderIntegrationsSidebarList();
  } catch {
    showToast('Failed to set default channel', 'error');
  }
}

async function deleteSlackThread(id) {
  try {
    const res = await fetch(`${API}/integrations/slack/threads/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.ok) throw new Error();
    _slackConfigCache.savedThreads = data.savedThreads;
    if (_selectedChannelId) renderChannelDetail(_selectedChannelId);
    renderIntegrationsSidebarList();
  } catch {
    showToast('Failed to remove thread', 'error');
  }
}

function openSlackTokenModal() {
  const cfg = _slackConfigCache || {};
  const tokenInput = document.getElementById('slack-bot-token');
  tokenInput.value = '';
  tokenInput.placeholder = cfg.configured ? 'Already set — leave blank to keep it' : 'xoxb-…';
  document.getElementById('slack-token-status').textContent = cfg.configured
    ? '✓ A Bot Token is configured.'
    : 'Not configured yet — paste a Bot Token (xoxb-…) from your Slack App.';
  openModal('slack-token-modal');
  tokenInput.focus();
}

async function saveSlackSettings() {
  const btn = document.getElementById('slack-settings-save-btn');
  const tokenInput = document.getElementById('slack-bot-token').value.trim();
  if (!tokenInput) { showToast('Enter a Bot Token to save', 'error'); return; }

  btn.disabled = true;
  try {
    const res = await fetch(`${API}/integrations/slack/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botToken: tokenInput }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error();
    _slackConfigCache = data;
    showToast('Slack token saved', 'success');
    closeModal('slack-token-modal');
    renderIntegrationsSidebarList();
  } catch {
    showToast('Failed to save Slack token', 'error');
  }
  btn.disabled = false;
}

// ── Bug Tracker ─────────────────────────────────────────────────────────────
// Reporting to Slack (session report, bug marker, screenshot) is otherwise
// fire-and-forget — the server auto-creates a bug record on every successful
// send (see /integrations/slack/send[-screenshot]). Bugs are organized the
// same way Slack itself organizes them: under the channel, and within that,
// under the specific thread they were reported into — Channel > Thread >
// Bugs > bug detail, all inside Integrations, rather than a separate flat
// "Bugs" tab (levels 2-4 of the same drill-down `selectChannel()` starts).
const BUG_STATUS_META = {
  open: { label: 'Open', badgeClass: 'badge-warn' },
  fixed: { label: 'Fixed', badgeClass: 'badge-success' },
  next_release: { label: 'Next Release', badgeClass: 'badge-info' },
  wont_fix: { label: "Won't Fix", badgeClass: 'badge' },
};
const BUG_SOURCE_LABELS = {
  session_report: 'Session Report',
  bug_marker: 'Bug Marker',
  screenshot: 'Screenshot',
  manual: 'Manual',
};

function renderBugRow(bug) {
  const meta = BUG_STATUS_META[bug.status] || BUG_STATUS_META.open;
  return `
    <div class="saved-row" style="cursor:pointer;" onclick="selectBug('${esc(bug.id)}')">
      <div style="min-width:0; flex:1;">
        <div class="saved-row-name">${esc(bug.description.slice(0, 90))}</div>
      </div>
      <span class="badge ${meta.badgeClass}">${meta.label}</span>
    </div>`;
}

// Level 3 (Bug Manager): bugs reported into one specific thread.
async function selectThread(channelId, threadId) {
  _selectedChannelId = channelId;
  _selectedThreadId = threadId;
  _selectedBugId = null;
  document.getElementById('bugmanager-hub-view').style.display = 'none';
  document.getElementById('bm-channel-detail').style.display = 'none';
  document.getElementById('bug-detail').style.display = 'none';
  document.getElementById('thread-bug-list-view').style.display = 'flex';
  await renderThreadBugList();
}

async function renderThreadBugList() {
  const cfg = _slackConfigCache || {};
  const channel = (cfg.savedChannels || []).find(c => c.id === _selectedChannelId);
  const thread = (cfg.savedThreads || []).find(t => t.id === _selectedThreadId);
  if (!channel || !thread) { showBugManagerHub(); return; }

  document.getElementById('thread-breadcrumb').innerHTML =
    `<span class="crumb" onclick="showBugManagerHub()">Channels</span><span class="crumb-sep">›</span>` +
    `<span class="crumb" onclick="selectBugManagerChannel('${esc(channel.id)}')">${esc(channel.name)}</span><span class="crumb-sep">›</span>` +
    `<span class="crumb current">${esc(thread.name)}</span>`;
  document.getElementById('thread-detail-title').textContent = thread.name;

  const res = await fetch(`${API}/bugs?channel=${encodeURIComponent(channel.id)}`);
  const data = await res.json();
  const bugs = (data.bugs || []).filter(b => b.thread_link === thread.link);

  document.getElementById('thread-bugs-list').innerHTML = bugs.length
    ? bugs.map(renderBugRow).join('')
    : '<div class="field-sub">No bugs reported into this thread yet.</div>';
}

// Level 4 (Bug Manager): a single bug's full detail — reachable from either
// the channel-level bugs list or a thread's bug list, so the breadcrumb is
// derived from the bug's own channel/thread_link rather than assumed
// navigation history.
async function selectBug(id) {
  _selectedBugId = id;
  document.getElementById('bugmanager-hub-view').style.display = 'none';
  document.getElementById('bm-channel-detail').style.display = 'none';
  document.getElementById('thread-bug-list-view').style.display = 'none';
  document.getElementById('bug-detail').style.display = 'flex';

  const res = await fetch(`${API}/bugs/${encodeURIComponent(id)}`);
  const data = await res.json();
  if (!data.ok) { showBugManagerHub(); return; }
  renderBugDetail(data.bug);
}

let _currentBugDetail = null;

function renderBugDetail(bug) {
  _currentBugDetail = bug;
  const cfg = _slackConfigCache || {};
  const channel = (cfg.savedChannels || []).find(c => c.id === bug.channel);
  const thread = bug.thread_link ? (cfg.savedThreads || []).find(t => t.link === bug.thread_link) : null;

  let crumbHtml = `<span class="crumb" onclick="showBugManagerHub()">Channels</span>`;
  if (channel) {
    crumbHtml += `<span class="crumb-sep">›</span><span class="crumb" onclick="selectBugManagerChannel('${esc(channel.id)}')">${esc(channel.name)}</span>`;
    if (thread) {
      crumbHtml += `<span class="crumb-sep">›</span><span class="crumb" onclick="selectThread('${esc(channel.id)}', '${esc(thread.id)}')">${esc(thread.name)}</span>`;
    }
  }
  crumbHtml += `<span class="crumb-sep">›</span><span class="crumb current">Bug</span>`;
  document.getElementById('bug-breadcrumb').innerHTML = crumbHtml;

  // description is the note the reporter actually wrote — kept separate from
  // the read-only page/URL/health context below, instead of the two being
  // concatenated into one wall of text (see confirmSendToSlack()).
  document.getElementById('bug-detail-description').textContent = bug.description;

  const contextWrap = document.getElementById('bug-detail-context-wrap');
  if (bug.context) {
    contextWrap.style.display = '';
    document.getElementById('bug-detail-context').textContent = bug.context;
  } else {
    contextWrap.style.display = 'none';
  }

  const metaParts = [BUG_SOURCE_LABELS[bug.source] || bug.source, formatDate(bug.created_at)];
  let metaHtml = esc(metaParts.join(' · '));
  if (bug.session_id) {
    metaHtml += ` · <a href="${esc(sessionDeepLink(bug.session_id, 'overview'))}" style="color:var(--accent);">View session</a>` +
      ` · <button class="copy-btn" style="padding:1px 6px;" onclick="copyEventText('${esc(sessionDeepLink(bug.session_id, 'overview'))}')" title="Copy a shareable link to the session">${icon('copy', 10)} Copy session link</button>`;
  }
  if (bug.permalink) {
    metaHtml += ` · <a href="${esc(bug.permalink)}" target="_blank" rel="noopener" style="color:var(--accent);">View in Slack</a>`;
  }
  document.getElementById('bug-detail-meta').innerHTML = metaHtml;

  const pills = document.getElementById('bug-status-pills');
  pills.innerHTML = Object.entries(BUG_STATUS_META).map(([status, meta]) => `
    <button class="bug-status-pill status-${status} ${bug.status === status ? 'active' : ''}" onclick="openBugStatusModal('${status}')" ${bug.status === status ? 'disabled' : ''}>${meta.label}</button>
  `).join('');

  // Unified timeline: plain comments and status transitions share one list,
  // newest last, so a status change and the reason for it read together
  // instead of living in two disconnected places.
  const notesList = document.getElementById('bug-notes-list');
  notesList.innerHTML = bug.notes.length
    ? bug.notes.map(n => {
        if (n.type === 'status_change') {
          const fromMeta = BUG_STATUS_META[n.from] || { label: n.from };
          const toMeta = BUG_STATUS_META[n.to] || { label: n.to };
          return `
          <div class="bug-note-item bug-note-status">
            <div class="bug-note-ts">${formatDate(n.ts)}</div>
            <div class="bug-note-status-line">Status: ${esc(fromMeta.label)} → <strong>${esc(toMeta.label)}</strong></div>
            ${n.text ? `<div>${esc(n.text)}</div>` : ''}
          </div>`;
        }
        return `
      <div class="bug-note-item">
        <div class="bug-note-ts">${formatDate(n.ts)}</div>
        <div>${esc(n.text)}</div>
      </div>`;
      }).join('')
    : '<div class="field-sub">No activity yet.</div>';

  document.getElementById('bug-note-input').value = '';
}

// Every status change goes through this small modal instead of firing the
// PATCH immediately on click — gives the reporter a place to say *why* it's
// Won't Fix / Next Release / etc, without forcing one (comment is optional).
let _pendingBugStatus = null;

function openBugStatusModal(status) {
  if (!_selectedBugId || (_currentBugDetail && _currentBugDetail.status === status)) return;
  _pendingBugStatus = status;
  const meta = BUG_STATUS_META[status] || { label: status };
  document.getElementById('bug-status-comment-title').textContent = `Move to "${meta.label}"`;
  document.getElementById('bug-status-comment-input').value = '';
  openModal('bug-status-comment-modal');
  document.getElementById('bug-status-comment-input').focus();
}

async function confirmBugStatusChange() {
  if (!_selectedBugId || !_pendingBugStatus) return;
  const comment = document.getElementById('bug-status-comment-input').value.trim();
  try {
    const res = await fetch(`${API}/bugs/${encodeURIComponent(_selectedBugId)}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: _pendingBugStatus, comment }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error();
    closeModal('bug-status-comment-modal');
    renderBugDetail(data.bug);
    showToast('Status updated', 'success');
  } catch {
    showToast('Failed to update status', 'error');
  }
  _pendingBugStatus = null;
}

async function confirmAddBugNote() {
  if (!_selectedBugId) return;
  const input = document.getElementById('bug-note-input');
  const text = input.value.trim();
  if (!text) { showToast('Write a note first', 'error'); return; }
  try {
    const res = await fetch(`${API}/bugs/${encodeURIComponent(_selectedBugId)}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error();
    renderBugDetail(data.bug);
    showToast('Note added', 'success');
  } catch {
    showToast('Failed to add note', 'error');
  }
}

// Scoped to whichever thread you're currently viewing (level 3) — the
// created bug's channel/thread_link are pre-filled from that context so it
// immediately shows up in the right place instead of needing a separate
// "assign to thread" step.
function openNewBugModal() {
  document.getElementById('new-bug-description').value = '';
  openModal('new-bug-modal');
  document.getElementById('new-bug-description').focus();
}

async function confirmNewBug() {
  const description = document.getElementById('new-bug-description').value.trim();
  if (!description) { showToast('Enter a description', 'error'); return; }
  const cfg = _slackConfigCache || {};
  const channel = (cfg.savedChannels || []).find(c => c.id === _selectedChannelId);
  const thread = (cfg.savedThreads || []).find(t => t.id === _selectedThreadId);
  try {
    const res = await fetch(`${API}/bugs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description,
        session_id: currentSessionId || null,
        channel: channel ? channel.id : null,
        channel_name: channel ? channel.name : null,
        thread_link: thread ? thread.link : null,
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error();
    closeModal('new-bug-modal');
    if (_selectedThreadId) renderThreadBugList();
    showToast('Bug created', 'success');
  } catch {
    showToast('Failed to create bug', 'error');
  }
}

// Returns to wherever the bug was opened from — a thread's bug list, a
// channel's channel-level bugs, or (fallback) the channel list — rather
// than a single fixed "back to hub" target.
async function confirmDeleteBug() {
  if (!_selectedBugId) return;
  if (!confirm('Delete this bug? This cannot be undone.')) return;
  try {
    const res = await fetch(`${API}/bugs/${encodeURIComponent(_selectedBugId)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.ok) throw new Error();
    showToast('Bug deleted', 'success');
    if (_selectedThreadId) selectThread(_selectedChannelId, _selectedThreadId);
    else if (_selectedChannelId) selectBugManagerChannel(_selectedChannelId);
    else showBugManagerHub();
  } catch {
    showToast('Failed to delete bug', 'error');
  }
}

// Plain-English session health, no jargon — used in the read-only context
// preview so a non-technical reader can tell at a glance if this is serious.
function sessionHealthSummary(s) {
  const ec = s.error_count || 0;
  const nc = s.network_failure_count || 0;
  const sc = s.slow_request_count || 0;
  if (ec === 0 && nc === 0 && sc === 0) return 'No issues detected — clean session.';
  const parts = [];
  if (ec > 0) parts.push(`${ec} JS error${ec !== 1 ? 's' : ''}`);
  if (nc > 0) parts.push(`${nc} network failure${nc !== 1 ? 's' : ''}`);
  if (sc > 0) parts.push(`${sc} slow request${sc !== 1 ? 's' : ''}`);
  return `Found ${parts.join(', ')}.`;
}

function buildSlackContext(s, tab) {
  return [
    `Page: ${s.title || s.url || s.id}`,
    s.url ? `URL: ${s.url}` : null,
    `Health: ${sessionHealthSummary(s)}`,
    `Link: ${sessionDeepLink(s.id, tab)}`,
  ].filter(Boolean).join('\n');
}

let _slackContextText = '';

function toggleSlackContextPreview() {
  const checked = document.getElementById('slack-send-include-context').checked;
  document.getElementById('slack-send-context-preview').style.opacity = checked ? '1' : '0.4';
}

// ── Send modal: channel/thread dropdowns fed by saved shortcuts ───────────────
function renderSlackChannelSelect() {
  const cfg = _slackConfigCache || {};
  const select = document.getElementById('slack-send-channel-select');
  const channels = cfg.savedChannels || [];
  const options = channels.map(c => `<option value="${esc(c.id)}">${esc(c.name)} (${esc(c.id)})</option>`).join('');
  select.innerHTML = options + `<option value="__new__">+ Add new channel…</option>`;
  if (cfg.defaultChannel && channels.some(c => c.id === cfg.defaultChannel)) {
    select.value = cfg.defaultChannel;
  } else if (channels.length) {
    select.value = channels[0].id;
  }
  document.getElementById('slack-new-channel-inline').style.display = 'none';
}

// Only shows threads that belong to whichever channel is currently selected
// above — picking a channel first, then a thread scoped to it, matches how
// the Settings tab nests threads under their channel.
function renderSlackThreadSelect() {
  const cfg = _slackConfigCache || {};
  const select = document.getElementById('slack-send-thread-select');
  const channelId = document.getElementById('slack-send-channel-select').value;
  const threads = (cfg.savedThreads || []).filter(t => t.channel === channelId);
  const options = threads.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  select.innerHTML = `<option value="">No thread — new message</option>` + options + `<option value="__new__">+ Add new thread…</option>`;
  select.value = '';
  document.getElementById('slack-new-thread-inline').style.display = 'none';
}

function onSlackChannelSelectChange() {
  const select = document.getElementById('slack-send-channel-select');
  document.getElementById('slack-new-channel-inline').style.display = select.value === '__new__' ? 'flex' : 'none';
  renderSlackThreadSelect();
}

function onSlackThreadSelectChange() {
  const select = document.getElementById('slack-send-thread-select');
  document.getElementById('slack-new-thread-inline').style.display = select.value === '__new__' ? 'flex' : 'none';
}

async function confirmInlineAddChannel() {
  const id = document.getElementById('slack-inline-channel-id').value.trim();
  const name = document.getElementById('slack-inline-channel-name').value.trim();
  if (!id) { showToast('Enter a channel ID', 'error'); return; }
  try {
    const res = await fetch(`${API}/integrations/slack/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error();
    _slackConfigCache.savedChannels = data.savedChannels;
    _slackConfigCache.defaultChannel = data.defaultChannel;
    document.getElementById('slack-inline-channel-id').value = '';
    document.getElementById('slack-inline-channel-name').value = '';
    renderSlackChannelSelect();
    // Select the channel we just saved — read its id back from the server
    // response rather than the raw input, since the server strips a pasted
    // URL down to the bare channel ID before saving.
    const savedChannel = data.savedChannels[data.savedChannels.length - 1];
    document.getElementById('slack-send-channel-select').value = savedChannel.id;
    renderSlackThreadSelect();
    showToast('Channel saved', 'success');
  } catch {
    showToast('Failed to save channel', 'error');
  }
}

async function confirmInlineAddThread() {
  const link = document.getElementById('slack-inline-thread-link').value.trim();
  const name = document.getElementById('slack-inline-thread-name').value.trim();
  if (!link) { showToast('Paste a Slack message link', 'error'); return; }
  try {
    const res = await fetch(`${API}/integrations/slack/threads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ link, name }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.message || 'Failed');
    _slackConfigCache.savedThreads = data.savedThreads;
    document.getElementById('slack-inline-thread-link').value = '';
    document.getElementById('slack-inline-thread-name').value = '';
    const newest = data.savedThreads[data.savedThreads.length - 1];
    // The thread select is scoped to whatever channel is picked above — make
    // sure that's the thread's actual channel first, or it'd be filtered out
    // right after we just added it.
    const channelSelect = document.getElementById('slack-send-channel-select');
    if (channelSelect.value !== newest.channel && [...channelSelect.options].some(o => o.value === newest.channel)) {
      channelSelect.value = newest.channel;
    }
    renderSlackThreadSelect();
    document.getElementById('slack-send-thread-select').value = newest.id;
    showToast('Thread saved', 'success');
  } catch (err) {
    showToast(`Could not save that link: ${err.message}`, 'error');
  }
}

// `text` is the free-text box the user types/edits directly (the actual bug
// description). `context` is a separate, plain-language, read-only summary
// (page/health/link) shown below with a checkbox to include or drop it — kept
// apart from `text` so the two never get jumbled into one wall of markdown.
let _slackSendSource = 'session_report';

async function openSlackSendModal(title, text, context, source) {
  const cfg = _slackConfigCache || await fetchSlackConfig();
  if (!cfg.configured) {
    showToast('Set up your Bot Token first', 'info');
    switchSidebar('settings');
    openSlackTokenModal();
    return;
  }
  _slackSendSource = source || 'session_report';
  document.getElementById('slack-send-title').textContent = title;
  document.getElementById('slack-send-text').value = text || '';
  _slackContextText = context || '';
  document.getElementById('slack-send-context-preview').textContent = _slackContextText;
  document.getElementById('slack-send-include-context').checked = true;
  toggleSlackContextPreview();
  renderSlackChannelSelect();
  renderSlackThreadSelect();
  openModal('slack-send-modal');
}

async function confirmSendToSlack() {
  const btn = document.getElementById('slack-send-confirm-btn');
  const channel = document.getElementById('slack-send-channel-select').value;
  const threadId = document.getElementById('slack-send-thread-select').value;
  const includeContext = document.getElementById('slack-send-include-context').checked;
  const noteText = document.getElementById('slack-send-text').value.trim();
  const text = [noteText, includeContext ? _slackContextText : ''].filter(Boolean).join('\n\n');

  if (!channel || channel === '__new__') { showToast('Choose or add a channel', 'error'); return; }
  if (threadId === '__new__') { showToast('Finish adding the thread, or choose "No thread"', 'error'); return; }
  if (!text) { showToast('Write a description or include session details', 'error'); return; }

  const savedThread = threadId ? (_slackConfigCache.savedThreads || []).find(t => t.id === threadId) : null;
  const threadLink = savedThread ? savedThread.link : undefined;

  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Sending…';
  try {
    const res = await fetch(`${API}/integrations/slack/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `text` is the full message actually posted to Slack; `note`/`context`
      // are the same content kept separate so the Bug Manager's tracker
      // record gets a clean description instead of the two concatenated —
      // see createBug()/updateBugStatus() in bugs.js.
      body: JSON.stringify({
        channel, threadLink, text,
        note: noteText,
        context: includeContext ? _slackContextText : '',
        session_id: currentSessionId || null,
        source: _slackSendSource,
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.message || 'Failed to send');
    showToast(threadLink ? 'Replied in Slack thread' : 'Sent to Slack', 'success');
    closeModal('slack-send-modal');
  } catch (err) {
    showToast(`Failed to send: ${err.message}`, 'error');
  }
  btn.disabled = false;
  btn.textContent = original;
}

function reportSessionToSlack() {
  if (!currentSessionData) return;
  openSlackSendModal('Report Session to Slack', '', buildSlackContext(currentSessionData, 'overview'), 'session_report');
}

window.sendBugMarkerToSlack = function (idx) {
  const ev = _triageShowCache[Number(idx)];
  if (!ev) return;
  const d = ev.data || {};
  const context = currentSessionData
    ? buildSlackContext(currentSessionData, 'triage')
    : `Link: ${sessionDeepLink(currentSessionId, 'triage')}`;
  openSlackSendModal('Send Bug to Slack', d.note || '', context, 'bug_marker');
};

// ── Init ──────────────────────────────────────────────────────────────────────
loadSessions().then(applyHashRoute);

// Auto-refresh every 8s if there are live sessions
setInterval(async () => {
  try {
    const res = await fetch(`${API}/sessions?status=recording&limit=1`);
    const { sessions } = await res.json();
    if (sessions.length > 0) await loadSessions();
    else await loadGlobalStats();
  } catch { /* server offline */ }
}, 8000);
