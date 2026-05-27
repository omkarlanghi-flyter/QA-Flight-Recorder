/**
 * app.js - QA Flight Recorder Viewer UI Logic (v2)
 */
const API = 'http://127.0.0.1:17890';
let currentSessionId = null;
let currentTab = 'overview';
let allSessionsCache = [];
let allEventsCache = [];
let allInputEventsCache = [];
let triageFilter = 'all';
let ignoredSignatures = new Set(); // globally muted error sigs

// ── Theme ─────────────────────────────────────────────────────────────────────
function toggleTheme() {
  const html = document.documentElement;
  const isDark = html.dataset.theme === 'dark';
  html.dataset.theme = isDark ? 'light' : 'dark';
  document.getElementById('theme-toggle').textContent = isDark ? '🌙' : '☀️';
  localStorage.setItem('qa-theme', html.dataset.theme);
}

; (function initTheme() {
  const saved = localStorage.getItem('qa-theme') || 'light';
  document.documentElement.dataset.theme = saved;
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = saved === 'dark' ? '☀️' : '🌙';
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
  const icon = type === 'error' ? '❌' : type === 'success' ? '✅' : 'ℹ️';
  toast.innerHTML = `<span>${icon}</span><span>${esc(msg)}</span>`;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

function getTypeClass(type) {
  if (!type) return '';
  if (type.startsWith('action.')) return 'type-action';
  if (type === 'network.failure') return 'type-network-fail';
  if (type.startsWith('network.')) return 'type-network';
  if (type === 'console.error' || type === 'runtime.exception') return 'type-error';
  if (type.startsWith('console.')) return 'type-console';
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
    case 'console.warn': summary = `WARN: ${d.message || d.text || ''}`; break;
    case 'console.error': summary = `ERROR: ${d.message || d.text || ''}`; break;
    case 'runtime.exception': summary = `EXC: ${d.message || ''}`; break;
    case 'marker.bug': summary = `🐛 Bug Marker: ${d.note || ''}`; break;
    default: summary = JSON.stringify(d).slice(0, 80);
  }

  // Build accordions for payloads and headers
  let payloadHtml = '';
  payloadHtml += makePayloadAccordion('📤 Request Body', d.request_body, false);
  payloadHtml += makeHeadersAccordion('📋 Request Headers', d.request_headers);
  payloadHtml += makePayloadAccordion('📥 Response Body', d.response_body, isNetworkError);
  payloadHtml += makeHeadersAccordion('📋 Response Headers', d.response_headers);

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
let isBulkMode = { sessions: false, sanity: false };
let bulkSelected = { sessions: new Set(), sanity: new Set() };

function toggleBulkMode(type) {
  isBulkMode[type] = !isBulkMode[type];
  bulkSelected[type].clear();
  
  const controls = document.getElementById(`bulk-controls-${type}`);
  if (controls) controls.style.display = isBulkMode[type] ? 'flex' : 'none';
  
  if (type === 'sessions') renderSessionList(allSessionsCache);
  if (type === 'sanity') renderSanityList(allSanityCache);
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
    await loadSanityFlows();
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
        ? `<button class="session-delete-btn" onclick="deleteSession(event,'${esc(s.id)}')" title="Delete session">✕</button>`
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

// ── Sanity Runs List ──────────────────────────────────────────────────────────
function switchSidebar(tab) {
  document.getElementById('sidebar-sessions').style.display = tab === 'sessions' ? 'flex' : 'none';
  document.getElementById('sidebar-sanity').style.display = tab === 'sanity' ? 'flex' : 'none';
  document.getElementById('nav-btn-sessions').style.borderBottomColor = tab === 'sessions' ? 'var(--accent)' : 'transparent';
  document.getElementById('nav-btn-sessions').style.color = tab === 'sessions' ? 'var(--accent)' : 'var(--text-muted)';
  document.getElementById('nav-btn-sanity').style.borderBottomColor = tab === 'sanity' ? 'var(--accent)' : 'transparent';
  document.getElementById('nav-btn-sanity').style.color = tab === 'sanity' ? 'var(--accent)' : 'var(--text-muted)';
  
  if (tab === 'sanity') {
    loadSanityFlows();
  } else {
    loadSessions();
  }
}

let allSanityCache = [];

async function loadSanityFlows() {
  const listEl = document.getElementById('sanity-list');
  listEl.innerHTML = '<div class="loading-row"><span class="spinner"></span> Loading…</div>';
  try {
    const res = await fetch(`${API}/sanity-flows`);
    const { flows } = await res.json();
    allSanityCache = flows;
    document.getElementById('sanity-count').textContent = flows.length;
    renderSanityList(flows);
  } catch {
    listEl.innerHTML = `<div class="loading-row" style="color:var(--danger)">⚠ Cannot connect to server</div>`;
  }
}

function filterSanity() {
  const q = (document.getElementById('sanity-search').value || '').toLowerCase();
  if (!q) return renderSanityList(allSanityCache);
  const filtered = allSanityCache.filter(f => 
    (f.flow_name || '').toLowerCase().includes(q) ||
    (f.module_name || '').toLowerCase().includes(q)
  );
  renderSanityList(filtered);
}

async function runSanityFlow(e, sessionId, flowName, moduleName) {
  e.stopPropagation();
  const btn = e.currentTarget;
  
  if (btn.dataset.running === 'true') {
    // Stop it
    btn.disabled = true;
    btn.textContent = 'Stopping...';
    try {
      await fetch(`${API}/sessions/${sessionId}/replay/stop`, { method: 'POST' });
    } catch (e) {}
    return;
  }
  
  btn.dataset.running = 'true';
  btn.textContent = '⏹ Stop';
  btn.style.backgroundColor = '#ef4444';
  btn.style.borderColor = '#ef4444';
  
  try {
    const pdir = document.getElementById('sanity-profile-dir')?.value || '';
    const sdelay = document.getElementById('sanity-step-delay')?.value || '';
    
    let bodyObj = { profileDir: pdir };
    if (sdelay) bodyObj.stepDelay = parseInt(sdelay, 10);

    const res = await fetch(`${API}/sessions/${sessionId}/replay`, { 
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj)
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const { report } = data;
    
    // Check if the engine completely crashed or failed to connect
    const engineCrash = report.failures.ui.find(e => e.type === 'engine_crash');
    if (engineCrash) throw new Error(engineCrash.message);
    const wasAborted = report.failures.ui.find(e => e.type === 'engine_aborted');
    if (wasAborted) {
      alert('Replay was stopped manually.');
    } else {
      const errCount = report.failures.ui.length + report.failures.js_errors.length;
      alert(`Replay Finished!\nPassed: ${report.summary.passed}\nFailed: ${report.summary.failed}\nErrors: ${errCount}\nNet Fails: ${report.failures.network.length}`);
    }

    if (currentTab === 'runs' && currentSessionId === sessionId) {
      loadRuns();
    }
  } catch (err) {
    alert(`Replay Error: ${err.message}`);
  } finally {
    btn.dataset.running = 'false';
    btn.disabled = false;
    btn.textContent = '▶ Run';
    btn.style.backgroundColor = '';
    btn.style.borderColor = '';
  }
}

function renderSanityList(flows) {
  const listEl = document.getElementById('sanity-list');
  if (!flows.length) {
    listEl.innerHTML = '<div class="empty-list">No sanity runs found</div>';
    return;
  }

  // 1. Group by module
  const groups = {};
  for (const f of flows) {
    const mod = f.module_name || 'Uncategorized';
    if (!groups[mod]) groups[mod] = [];
    groups[mod].push(f);
  }

  // 2. Render groups as <details> accordions
  let html = '';
  // Sort keys so Uncategorized is last, others alphabetical
  const sortedKeys = Object.keys(groups).sort((a,b) => {
    if (a === 'Uncategorized') return 1;
    if (b === 'Uncategorized') return -1;
    return a.localeCompare(b);
  });

  for (const mod of sortedKeys) {
    const modFlows = groups[mod];
    
    // Check if any flow in this module is currently active
    const hasActive = modFlows.some(f => f.id === currentSessionId);
    
    const flowsHtml = modFlows.map(f => {
      const health = sessionHealthColor(f);
      const isClean = (f.error_count || 0) === 0 && (f.network_failure_count || 0) === 0;

      const clickAction = isBulkMode.sanity
          ? `toggleBulkSelect('sanity', '${esc(f.id)}', !this.querySelector('input').checked, event); const cb = this.querySelector('input'); cb.checked = !cb.checked;`
          : `selectSession('${esc(f.id)}')`;

      const checkboxHtml = isBulkMode.sanity
          ? `<input type="checkbox" style="margin-right:10px; pointer-events:none;" ${bulkSelected.sanity.has(f.id) ? 'checked' : ''} />` 
          : '';

      const actionsHtml = !isBulkMode.sanity
          ? `<button class="btn btn-primary sanity-run-btn" style="padding: 4px 8px; font-size: 10px;" onclick="runSanityFlow(event, '${esc(f.id)}', '${esc(f.flow_name)}', '${esc(f.module_name || '')}')">▶ Run</button>
             <button class="session-delete-btn" style="margin-left: 4px;" onclick="deleteSession(event,'${esc(f.id)}')" title="Delete sanity run">✕</button>`
          : '';

      return `
      <div class="session-item ${f.id === currentSessionId ? 'active' : ''}" style="border-left: 3px solid transparent; padding-left: 24px; ${isBulkMode.sanity ? 'cursor:pointer;' : ''}"
           onclick="${clickAction}" data-id="${esc(f.id)}">
        ${checkboxHtml}
        <div style="flex:1; min-width:0;">
            <div class="session-item-top">
              <div style="flex:1; min-width:0; display:flex; flex-direction:column; gap:4px;">
                 <div class="session-title" title="${esc(f.flow_name)}">${esc(f.flow_name)}</div>
              </div>
              ${actionsHtml}
            </div>
            <div class="session-meta">
              <span>${formatDate(f.created_at)}</span>
              <span>${formatDuration(f.duration_ms)}</span>
            </div>
        <div class="session-badges">
          ${f.last_run_status === 'recording' ? '<span class="badge badge-recording">● Live</span>' : ''}
          ${(f.error_count || 0) > 0 ? `<span class="badge badge-error">⚠ ${f.error_count} err</span>` : ''}
          ${(f.network_failure_count || 0) > 0 ? `<span class="badge badge-warn">${f.network_failure_count} net fail</span>` : ''}
          ${isClean && f.last_run_status !== 'recording' ? '<span class="badge badge-success">✓ Clean</span>' : ''}
        </div>
        <div class="health-bar-wrap">
          <div class="health-bar" style="background:${health};width:${isClean ? 100 : Math.max(10, 100 - (f.error_count || 0) * 15 - (f.network_failure_count || 0) * 10)}%"></div>
        </div>
      </div>
      </div>`;
    }).join('');

    html += `
    <details class="module-group" style="border-bottom: 1px solid var(--border);" ${hasActive ? 'open' : ''}>
      <summary style="padding: 12px 16px; cursor: pointer; font-size: 12px; font-weight: 700; color: var(--text); background: var(--surface); display: flex; align-items: center; gap: 8px; user-select: none; outline: none;">
        📁 ${esc(mod)} <span class="session-count" style="margin-left:auto; background: var(--surface3); color: var(--text-dim);">${modFlows.length}</span>
      </summary>
      <div class="module-flows" style="background: var(--surface2);">
        ${flowsHtml}
      </div>
    </details>`;
  }

  listEl.innerHTML = html;
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
    await loadSanityFlows();
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

async function selectSession(id) {
  // Toggle: clicking the already-selected session closes it and shows the dashboard
  if (currentSessionId === id) {
    currentSessionId = null;
    document.querySelectorAll('.session-item').forEach(el => el.classList.remove('active'));
    document.getElementById('empty-state').style.display = '';
    document.getElementById('session-detail').style.display = 'none';
    loadDashboardIgnored();
    return;
  }

  currentSessionId = id;
  document.querySelectorAll('.session-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
  });

  document.getElementById('empty-state').style.display = 'none';
  const detail = document.getElementById('session-detail');
  detail.style.display = 'flex';

  const res = await fetch(`${API}/sessions/${id}`);
  const { session, summary } = await res.json();
  sessionStartMs = session.started_at;

  document.getElementById('detail-title').textContent = session.title || session.url || id;
  document.getElementById('detail-url').textContent = session.url || '';

  const ec2 = session.error_count || 0;
  const nc2 = session.network_failure_count || 0;
  const sc2 = session.slow_request_count || 0;
  const isLive = session.status === 'recording';

  document.getElementById('detail-meta').innerHTML = `
    <span class="meta-chip" data-tip="Session started at ${formatDate(session.started_at)}">
      <span class="chip-icon">🕐</span>${formatDate(session.started_at)}
    </span>
    <span class="meta-chip" data-tip="Total recording duration">
      <span class="chip-icon">⏱</span>${formatDuration(session.duration_ms)}
    </span>
    <span class="meta-chip" data-tip="Total events captured during this session (clicks, network, console, etc.)">
      <span class="chip-icon">📝</span>${session.event_count || 0} events
    </span>
    ${ec2 > 0
      ? `<span class="meta-chip chip-danger" data-tip="${ec2} JavaScript error${ec2 !== 1 ? 's' : ''} or uncaught exception${ec2 !== 1 ? 's' : ''} were recorded. Check the Triage tab."><span class="chip-icon">⚠️</span>${ec2} JS error${ec2 !== 1 ? 's' : ''}</span>`
      : `<span class="meta-chip chip-success" data-tip="No JavaScript errors detected in this session"><span class="chip-icon">✅</span>No JS errors</span>`
    }
    ${nc2 > 0
      ? `<span class="meta-chip chip-warn" data-tip="${nc2} API/network request${nc2 !== 1 ? 's' : ''} failed (CORS, timeout, or server error). Check the Triage tab."><span class="chip-icon">🌐</span>${nc2} net failure${nc2 !== 1 ? 's' : ''}</span>`
      : ''
    }
    ${sc2 > 0
      ? `<span class="meta-chip chip-warn" data-tip="${sc2} request${sc2 !== 1 ? 's' : ''} took longer than 2 seconds — potential performance issue."><span class="chip-icon">🐢</span>${sc2} slow req${sc2 !== 1 ? 's' : ''}</span>`
      : ''
    }
    ${isLive
      ? `<span class="meta-chip chip-live" data-tip="This session is actively being recorded"><span class="chip-icon">●</span>Live</span>`
      : `<span class="meta-chip chip-success" data-tip="Recording has finished"><span class="chip-icon">✓</span>Done</span>`
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
  function statCard({ variant, icon, label, value, valueCls, trend, trendCls, sub, tip, priorityBanner, ariaLabel }) {
    const banner = priorityBanner
      ? `<div class="stat-priority-banner ${priorityBanner.level}" role="status" aria-label="${priorityBanner.text}">
           <span aria-hidden="true">${priorityBanner.level === 'critical' ? '⛔' : '⚠'}</span>
           ${priorityBanner.text}
         </div>`
      : '';
    return `
      <div class="stat-card ${variant}" data-tip="${tip}" role="region" aria-label="${ariaLabel || label + ': ' + value}">
        <div class="stat-icon-bg" aria-hidden="true">${icon}</div>
        <div class="stat-header">
          <span class="stat-icon" aria-hidden="true">${icon}</span>
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
      variant: 'accent', icon: '⏱', label: 'Duration',
      value: formatDuration(session.duration_ms), valueCls: 'accent',
      trend: '', trendCls: '',
      sub: 'Total session length',
      tip: 'How long the recording ran from start to stop.',
      ariaLabel: `Session duration: ${formatDuration(session.duration_ms)}`,
    }),
    statCard({
      variant: ec > 0 ? 'danger' : 'success',
      icon: ec > 0 ? '🚨' : '✅',
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
      icon: nc > 0 ? '🌐' : '✅',
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
      icon: sc > 0 ? '🐢' : '⚡',
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
      variant: '', icon: '📋', label: 'Total Events',
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
          ? '✅ This session is clean — no errors or API failures detected.'
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
      if (['console.error', 'runtime.exception', 'network.failure'].includes(ev.type)) errCounts[idx]++;
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
  const msg = d.message || d.text || '';
  return `${ev.type}::${msg.slice(0, 120)}`;
}

async function ignoreEvent(ev, sessionId) {
  const sig = eventSignature(ev);
  const d = ev.data || {};
  const label = `[${ev.type}] ${(d.message || d.text || d.url_sanitized || '').slice(0, 80)}`;
  try {
    await fetch(`${API}/ignored-errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature: sig, label, source_session_id: sessionId }),
    });
    ignoredSignatures.add(sig);
    showToast('Error muted globally 🙈', 'success');
    renderTriage(triageEventsCache);  // re-render in-place with greyed-out state
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
    showToast('Error restored ✅', 'success');
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
      <button onclick="restoreIgnored('${esc(e.id)}')" style="flex-shrink:0; background:none; border:1px solid var(--border); color:var(--text-muted); border-radius:5px; padding:4px 10px; font-size:11px; cursor:pointer;" title="Restore this error">👁️ Restore</button>
    </div>`);
    list.innerHTML += ignored.length > 0 ? '' : '';
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

function renderTriage(events) {
  const listEl = document.getElementById('triage-list');
  document.getElementById('triage-count').textContent = `${events.length} events`;

  if (!events.length) {
    listEl.innerHTML = '<div class="empty-list">No triage events — session is clean! 🎉</div>';
    return;
  }

  const show = triageFilter === 'errors'
    ? events.filter(ev => ['console.error', 'runtime.exception', 'network.failure'].includes(ev.type))
    : events;

  _triageShowCache = show; // update safe index reference

  listEl.innerHTML = show.map((ev, i) => {
    const d = ev.data || {};
    const sig = eventSignature(ev);
    const isIgnored = ignoredSignatures.has(sig);
    const isCritical = ['console.error', 'runtime.exception', 'network.failure'].includes(ev.type);
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
      ? `<span style="font-size:10px;background:var(--surface3);color:var(--text-dim);border-radius:99px;padding:1px 8px;font-weight:600;">🙈 Muted</span>`
      : '';

    // Use data-idx to avoid embedding event JSON in onclick attrs (breaks on special chars)
    const ignoreBtn = isCritical && !isIgnored
      ? `<button class="copy-btn" data-idx="${i}" onclick="triageIgnoreByIdx(this.dataset.idx)" title="Mute this error globally">🙈 Ignore</button>`
      : '';
    const copyBtn = `<button class="copy-btn" data-idx="${i}" onclick="triagreCopyByIdx(this.dataset.idx)" title="Copy">📋</button>`;

    return `
      <div class="triage-event ${isIgnored ? '' : getTriageClass(ev.type)}" id="trev-${i}" style="${isIgnored ? 'opacity:0.45;' : ''}">
        <span class="type-chip ${getTypeClass(ev.type)}">${esc(ev.type)}</span>
        <div class="triage-event-body">
          <div class="triage-ts">${formatTs(ev.ts_epoch_ms, sessionStartMs)} ${ignoredBadge}</div>
          <div class="triage-msg">${msg}${dedup}</div>
          ${diagHtml}
          ${stack ? `<pre class="triage-stack">${esc(String(stack).slice(0, 500))}</pre>` : ''}
        </div>
        <div class="triage-actions">
          ${ignoreBtn}
          ${copyBtn}
        </div>
      </div>`;
  }).join('');
}

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
    return d.request_body || d.response_body || d.request_headers || d.response_headers;
  };

  document.getElementById('events-tbody').innerHTML = events.map((ev, i) => {
    const d = ev.data || {};
    const isError = ['console.error', 'runtime.exception', 'network.failure'].includes(ev.type);
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
      case 'console.warn': brief = `WARN: ${d.message || d.text || ''}`; break;
      case 'console.error': brief = `ERROR: ${d.message || d.text || ''}`; break;
      case 'runtime.exception': brief = `EXC: ${d.message || ''}`; break;
      case 'marker.bug': brief = `🐛 ${d.note || ''}`; break;
      default: brief = JSON.stringify(d).slice(0, 120);
    }

    // Build expandable payload section
    let payloads = '';
    if (hasPayload(ev)) {
      payloads += makePayloadAccordion('📤 Request Body', d.request_body, false);
      payloads += makeHeadersAccordion('📋 Request Headers', d.request_headers);
      payloads += makePayloadAccordion('📥 Response Body', d.response_body, isError);
      payloads += makeHeadersAccordion('📋 Response Headers', d.response_headers);
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

// ── Input Track ───────────────────────────────────────────────────────────────
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
        detailHtml = `<div class="input-detail-cell">🖱️ ${text}${sel}</div>`;
        break;
      }
      case 'action.scroll': {
        const dy = d.deltaY || 0;
        const dir = dy > 0 ? '↓ Down' : '↑ Up';
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
        detailHtml = `<div class="input-detail-cell">🔗 ${from}${arrow}${to}</div>`;
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
      container.innerHTML = '<div class="no-video">No video recorded for this session</div>';
      sidebar.innerHTML   = '<div class="video-sidebar-title">Activity Feed</div><div class="no-video">No video</div>';
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
        <button class="vctrl-btn" id="vctrl-play" title="Play / Pause (Space)" onclick="window._videoTogglePlay()">▶</button>
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
        <button class="vctrl-btn" title="Fullscreen (F)" onclick="window._videoFullscreen()">⛶</button>`;
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
    video.addEventListener('play',  () => { const b = document.getElementById('vctrl-play'); if (b) b.textContent = '⏸'; });
    video.addEventListener('pause', () => { const b = document.getElementById('vctrl-play'); if (b) b.textContent = '▶'; });

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
    const reqTypes = 'action.click,action.scroll,action.navigation,console.warn,console.error,runtime.exception,marker.bug';
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
    container.innerHTML = '<div class="no-video">Error loading video</div>';
    sidebar.innerHTML   = '<div class="video-sidebar-title">Activity Feed</div>';
  }
}


const INPUT_TYPES = new Set(['action.click', 'action.scroll', 'action.navigation']);
const SYSTEM_TYPES = new Set(['console.warn', 'console.error', 'runtime.exception', 'marker.bug']);

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
    { id: 'all', label: 'All', icon: '📋' },
    { id: 'input', label: 'Interactions', icon: '🖱️' },
    { id: 'system', label: 'Errors', icon: '⚠️' },
  ].map(p => `
    <button class="vfeed-pill ${filter === p.id ? 'active' : ''}" onclick="renderVideoFeed('${p.id}')">
      ${p.icon} ${p.label}
    </button>`).join('');

  const inputCount = _videoSideEvents.filter(ev => INPUT_TYPES.has(ev.type)).length;
  const systemCount = _videoSideEvents.filter(ev => SYSTEM_TYPES.has(ev.type)).length;

  let html = `
    <div class="video-sidebar-title">Activity Feed</div>
    <div class="vfeed-pills">${pills}</div>
    <div class="vfeed-counts">
      <span>🖱️ ${inputCount} interactions</span>
      <span>⚠️ ${systemCount} system</span>
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
  ['overview', 'triage', 'input', 'events', 'video', 'runs'].forEach(t => {
    document.getElementById(`tab-${t}`)?.classList.toggle('active', t === tab);
    document.getElementById(`panel-${t}`)?.classList.toggle('active', t === tab);
  });
  if (tab === 'triage') loadTriage();
  else if (tab === 'input') loadInputTrack();
  else if (tab === 'events') loadEvents();
  else if (tab === 'video') loadVideo();
  else if (tab === 'runs') loadRuns();
}

async function loadRuns() {
  if (!currentSessionId) return;
  const listEl = document.getElementById('runs-list');
  listEl.innerHTML = '<div class="loading-row"><span class="spinner"></span> Loading…</div>';
  try {
    const res = await fetch(`${API}/sessions/${currentSessionId}/replays`);
    const { replays } = await res.json();
    if (!replays || !replays.length) {
      listEl.innerHTML = '<div class="empty-list">No execution history found.</div>';
      return;
    }
    
    listEl.innerHTML = replays.map(r => {
      if (r.type === 'manual_recording') {
        const isClean = r.error_count === 0 && r.network_failure_count === 0;
        return `
        <div class="cluster-item" style="display:flex; gap:10px; align-items:center; border-left: 3px solid var(--accent); background: var(--surface2);">
            <span style="font-size:16px;">🎥</span>
            <span style="font-weight:600; font-size:12px;">Manual Recording</span>
            <span style="font-size:11px; color:var(--text-dim);">${formatDate(r.timestamp)}</span>
            <div style="margin-left:auto; display:flex; gap:6px; align-items:center;">
               ${!isClean ? `<span class="badge badge-warn">⚠ ${r.error_count + r.network_failure_count} initial issues</span>` : '<span class="badge badge-success">✓ Clean record</span>'}
               <span style="font-size:10px; color:var(--text-muted); font-family:monospace;" title="Version UUID">v_${esc(r.session_id).slice(0, 8)}</span>
            </div>
        </div>`;
      } else {
        const errCount = (r.failures?.ui?.length || 0) + (r.failures?.js_errors?.length || 0);
        const isClean = errCount === 0 && (r.failures?.network?.length || 0) === 0;
        return `
        <details class="cluster-item" style="display:block; cursor:pointer;">
            <summary style="display:flex; gap:10px; align-items:center; list-style:none;">
                <span style="font-size:16px;">🤖</span>
                <span style="font-weight:600; font-size:12px;">Automated Replay</span>
                <span style="font-size:11px; color:var(--text-dim);">${formatDate(r.timestamp)}</span>
                ${isClean ? '<span class="badge badge-success">✓ Passed</span>' : `<span class="badge badge-error">⚠ ${errCount} Issues</span>`}
                <div style="margin-left:auto; display:flex; gap:10px; align-items:center;">
                  <span style="font-size:11px; color:var(--text-muted)">Pass rate: ${r.summary?.passed || 0}/${r.summary?.total_steps || 0}</span>
                  <span style="font-size:10px; color:var(--text-muted); opacity:0.6; font-family:monospace;" title="Replayed against version">src: v_${esc(r.source_session_id || '').slice(0, 8)}</span>
                </div>
            </summary>
            <div style="margin-top:10px; padding-top:10px; border-top:1px solid var(--border);">
                <div style="font-size:11px; margin-bottom:6px;"><strong>Execution Report:</strong></div>
                <pre style="font-size:10px; background:var(--surface); padding:8px; border-radius:4px; max-height:200px; overflow:auto; color:var(--text); white-space:pre-wrap;">${esc(JSON.stringify(r, null, 2))}</pre>
            </div>
        </details>
        `;
      }
    }).join('');
  } catch {
    listEl.innerHTML = '<div class="empty-list" style="color:var(--danger)">Failed to load runs</div>';
  }
}

// ── Regen Views ───────────────────────────────────────────────────────────────
async function regenerateViews() {
  if (!currentSessionId) return;
  const btn = document.getElementById('regen-btn');
  btn.disabled = true; btn.textContent = '⚙ …';
  try {
    const res = await fetch(`${API}/sessions/${currentSessionId}/regenerate-views`, { method: 'POST' });
    const data = await res.json();
    showToast(`Views regenerated: ${data.triageEventCount} triage events`, 'success');
    if (currentTab === 'triage') loadTriage();
  } catch {
    showToast('Failed to regenerate views', 'error');
  }
  btn.disabled = false; btn.textContent = '⚙ Regen';
}

// ── Init ──────────────────────────────────────────────────────────────────────
loadSessions();

// Auto-refresh every 8s if there are live sessions
setInterval(async () => {
  try {
    const res = await fetch(`${API}/sessions?status=recording&limit=1`);
    const { sessions } = await res.json();
    if (sessions.length > 0) await loadSessions();
    else await loadGlobalStats();
  } catch { /* server offline */ }
}, 8000);
