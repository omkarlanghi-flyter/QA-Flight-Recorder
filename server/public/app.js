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
  let summary = '';
  const isNetworkError = event.type === 'network.failure' ||
    (event.type === 'network.response' && d.status >= 400);

  switch (event.type) {
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
  const d = ev.data || {};
  const critStyle = 'critical';
  const warnStyle = 'warning';

  if (ev.type === 'network.failure') {
    return { cls: critStyle, msg: '🚨 CRITICAL: The API endpoint crashed or was blocked by CORS. The server did not respond.' };
  }
  if (ev.type.startsWith('network.status_')) {
    const s = d.status;
    if (s >= 500) return { cls: critStyle, msg: '🚨 CRITICAL BUG: Backend server crashed (5xx). Check server logs.' };
    if (s === 401 || s === 403) return { cls: warnStyle, msg: '⚠ AUTHENTICATION BUG: User is not logged in or lacks permissions (40x).' };
    if (s === 404) return { cls: warnStyle, msg: '⚠ NOT FOUND: The application requested a resource that does not exist (404).' };
    if (s === 400 || s === 422) return { cls: warnStyle, msg: '⚠ VALIDATION BUG: Frontend sent an invalid request payload (400/422). Check request body.' };
  }
  if (ev.type === 'runtime.exception') {
    return { cls: critStyle, msg: '🚨 CRITICAL APP CRASH: A JavaScript error halted the application thread. See stack trace.' };
  }
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
  } catch {
    document.getElementById('status-dot').className = 'status-dot offline';
    document.getElementById('server-status-text').textContent = 'Server Offline';
  }
  const now = new Date();
  document.getElementById('last-refresh').textContent =
    `Updated ${now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
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
    return `
    <div class="session-item ${s.id === currentSessionId ? 'active' : ''}"
         onclick="selectSession('${esc(s.id)}')" data-id="${esc(s.id)}">
      <div class="session-item-top">
        <div class="session-title" title="${esc(s.title || s.url || s.id)}">${esc(s.title || s.url || s.id)}</div>
        <button class="session-delete-btn" onclick="deleteSession(event,'${esc(s.id)}')" title="Delete session">✕</button>
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
    </div>`;
  }).join('');
}

// ── Delete Session ────────────────────────────────────────────────────────────
async function deleteSession(e, id) {
  e.stopPropagation();
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
  } catch {
    showToast('Failed to delete session', 'error');
  }
}

// ── Session Detail ────────────────────────────────────────────────────────────
let sessionStartMs = null;

async function selectSession(id) {
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

  const statusBadge = session.status === 'recording'
    ? `<span class="badge badge-recording">● Live</span>`
    : `<span class="badge badge-success">✓ Done</span>`;
  document.getElementById('detail-meta').innerHTML = `
    <span>🕐 ${formatDate(session.started_at)}</span>
    <span>⏱ ${formatDuration(session.duration_ms)}</span>
    <span>📝 ${session.event_count || 0} events</span>
    ${statusBadge}
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

  // Stats grid
  document.getElementById('overview-stats').innerHTML = `
    <div class="stat-card accent">
      <div class="stat-label">Duration</div>
      <div class="stat-value accent">${formatDuration(session.duration_ms)}</div>
      <div class="stat-sub">Session length</div>
    </div>
    <div class="stat-card ${ec > 0 ? 'danger' : 'success'}">
      <div class="stat-label">JS Errors</div>
      <div class="stat-value ${ec > 0 ? 'danger' : 'success'}">${ec}</div>
      <div class="stat-sub">${ec > 0 ? 'Needs attention' : 'No errors'}</div>
    </div>
    <div class="stat-card ${nc > 0 ? 'warn' : 'success'}">
      <div class="stat-label">Net Failures</div>
      <div class="stat-value ${nc > 0 ? 'warn' : 'success'}">${nc}</div>
      <div class="stat-sub">${nc > 0 ? 'Failed requests' : 'All OK'}</div>
    </div>
    <div class="stat-card ${sc > 0 ? 'warn' : 'success'}">
      <div class="stat-label">Slow Reqs (>2s)</div>
      <div class="stat-value ${sc > 0 ? 'warn' : 'success'}">${sc}</div>
      <div class="stat-sub">${sc > 0 ? 'Performance issues' : 'Fast'}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Events</div>
      <div class="stat-value">${session.event_count || 0}</div>
      <div class="stat-sub">Captured</div>
    </div>
  `;

  // Health score (0–100)
  const score = Math.max(0, 100 - ec * 25 - nc * 15 - sc * 5);
  const scoreColor = score >= 80 ? '#10b981' : score >= 50 ? '#f59e0b' : '#ef4444';
  const circumference = 2 * Math.PI * 30;
  const offset = circumference - (score / 100) * circumference;

  document.getElementById('health-score-card').innerHTML = `
    <div class="hs-ring-wrap">
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
      <div class="hs-title">Session Health Score</div>
      <div class="hs-desc">
        ${overallOk
      ? '✅ This session is clean — no errors or API failures detected.'
      : `Found ${totalIssues} issue${totalIssues !== 1 ? 's' : ''}: ${ec > 0 ? `${ec} JS error${ec !== 1 ? 's' : ''}` : ''} ${nc > 0 ? `${nc} network failure${nc !== 1 ? 's' : ''}` : ''} ${sc > 0 ? `${sc} slow request${sc !== 1 ? 's' : ''}` : ''}.`.replace(/\s+/g, ' ').trim()
    }
      </div>
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

// ── Mini Timeline ─────────────────────────────────────────────────────────────
async function drawTimeline(session, summary) {
  const wrap = document.getElementById('timeline-wrap');
  const canvas = document.getElementById('timeline-canvas');
  const labelsEl = document.getElementById('timeline-labels');

  // Fetch events to build bucketed timeline
  try {
    const res = await fetch(`${API}/sessions/${session.id}/events?types=network.request,console.error,runtime.exception,console.warn&limit=2000`);
    const { events } = await res.json();
    if (!events.length) { wrap.style.display = 'none'; return; }

    const BUCKETS = 40;
    const dur = session.duration_ms;
    const bucketMs = dur / BUCKETS;
    const counts = new Array(BUCKETS).fill(0);
    const errorBuckets = new Array(BUCKETS).fill(0);

    for (const ev of events) {
      const idx = Math.min(BUCKETS - 1, Math.floor((ev.ts_epoch_ms - session.started_at) / bucketMs));
      if (idx >= 0) {
        counts[idx]++;
        if (['console.error', 'runtime.exception'].includes(ev.type)) errorBuckets[idx]++;
      }
    }

    const maxCount = Math.max(1, ...counts);
    const W = canvas.offsetWidth || 600;
    const H = 60;
    canvas.width = W;
    canvas.height = H;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const barW = W / BUCKETS - 1;
    const isDark = document.documentElement.dataset.theme === 'dark';
    const normalColor = isDark ? '#6366f1' : '#4f46e5';
    const errorColor = '#ef4444';

    for (let i = 0; i < BUCKETS; i++) {
      const x = i * (W / BUCKETS);
      const h = Math.max(2, (counts[i] / maxCount) * (H - 4));
      ctx.fillStyle = errorBuckets[i] > 0 ? errorColor : normalColor;
      ctx.globalAlpha = 0.7;
      ctx.fillRect(x, H - h, barW, h);
    }
    ctx.globalAlpha = 1;

    // Labels
    labelsEl.innerHTML = `<span>+0s</span><span>+${formatDuration(dur / 2)}</span><span>+${formatDuration(dur)}</span>`;
    wrap.style.display = '';
  } catch {
    wrap.style.display = 'none';
  }
}

// ── Triage ────────────────────────────────────────────────────────────────────
let triageEventsCache = [];

async function loadTriage() {
  if (!currentSessionId) return;
  const listEl = document.getElementById('triage-list');
  listEl.innerHTML = '<div class="loading-row"><span class="spinner"></span> Loading triage…</div>';

  const res = await fetch(`${API}/sessions/${currentSessionId}/triage`);
  const { events } = await res.json();
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

  listEl.innerHTML = show.map((ev, i) => {
    const d = ev.data || {};
    let msg = d.message || d.text || d.text_snippet || '';
    const stack = d.stack || d.stackTrace || null;
    const dedup = ev._triage?.dedup_count > 1 ? `<span class="dedup-badge">×${ev._triage.dedup_count}</span>` : '';
    const diagnosis = analyzeTriageEvent(ev);
    const rawText = `[${ev.type}] ${msg} ${stack || ''}`.trim();

    if (!msg) msg = summarizeEvent(ev);
    const isHtml = typeof msg === 'string' && msg.includes('<details');
    if (!isHtml) msg = esc(msg.slice(0, 300));

    const diagHtml = diagnosis
      ? `<div class="triage-diagnosis ${diagnosis.cls}">${diagnosis.msg}</div>`
      : '';

    return `
      <div class="triage-event ${getTriageClass(ev.type)}" id="trev-${i}">
        <span class="type-chip ${getTypeClass(ev.type)}">${esc(ev.type)}</span>
        <div class="triage-event-body">
          <div class="triage-ts">${formatTs(ev.ts_epoch_ms, sessionStartMs)}</div>
          <div class="triage-msg">${msg}${dedup}</div>
          ${diagHtml}
          ${stack ? `<pre class="triage-stack">${esc(String(stack).slice(0, 500))}</pre>` : ''}
        </div>
        <div class="triage-actions">
          <button class="copy-btn" onclick="copyEventText(${JSON.stringify(rawText)})" title="Copy">📋</button>
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
  const { events, total } = await res.json();
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
  const { events } = await res.json();
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
  const container = document.getElementById('video-container');
  const sidebar = document.getElementById('video-sidebar');

  container.innerHTML = '<div class="no-video"><span class="spinner"></span> Loading video…</div>';
  sidebar.innerHTML = '<div class="video-sidebar-title">Activity Feed</div><div class="no-video"><span class="spinner"></span></div>';
  _videoFilter = 'all';

  try {
    const res = await fetch(`${API}/sessions/${currentSessionId}/video?list=1`);
    const { chunks } = await res.json();

    if (!chunks || !chunks.length) {
      container.innerHTML = '<div class="no-video">No video recorded for this session</div>';
      sidebar.innerHTML = '<div class="video-sidebar-title">Activity Feed</div><div class="no-video">No video</div>';
      return;
    }

    container.innerHTML = `
      <video controls preload="metadata" id="session-video">
        <source src="${API}/sessions/${currentSessionId}/video" type="video/webm" />
        Your browser does not support video playback.
      </video>`;

    const video = document.getElementById('session-video');

    // Fix infinite duration for WebM
    video.addEventListener('loadedmetadata', () => {
      if (video.duration === Infinity || isNaN(video.duration)) {
        video.currentTime = 1e10;
        video.addEventListener('timeupdate', function hack() {
          video.currentTime = 0;
          video.removeEventListener('timeupdate', hack);
        });
      }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (!video) return;
      if (e.key === 'ArrowLeft') video.currentTime = Math.max(0, video.currentTime - 5);
      if (e.key === 'ArrowRight') video.currentTime = Math.min(video.duration, video.currentTime + 5);
      if (e.key === 'f' || e.key === 'F') video.requestFullscreen?.();
    }, { once: false });

    // Load side events (all relevant types)
    const reqTypes = 'action.click,action.scroll,action.navigation,console.warn,console.error,runtime.exception,marker.bug';
    const evRes = await fetch(`${API}/sessions/${currentSessionId}/events?types=${reqTypes}&limit=5000`);
    const { events: sideEvents } = await evRes.json();
    _videoSideEvents = sideEvents;

    // Attach timeupdate handler once (uses _videoSideEvents so filter doesn't matter)
    video.addEventListener('timeupdate', () => {
      const absoluteMs = sessionStartMs + video.currentTime * 1000;
      let activeRef = -1;
      for (let i = 0; i < _videoSideEvents.length; i++) {
        if (_videoSideEvents[i].ts_epoch_ms <= absoluteMs) activeRef = i; else break;
      }
      document.querySelectorAll('.video-event').forEach(el => el.classList.remove('active'));
      if (activeRef !== -1) {
        // find the rendered element for this event (may be filtered out)
        const el = document.getElementById(`vev-${activeRef}`);
        if (el) { el.classList.add('active'); el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
      }
    });

    renderVideoFeed('all');
  } catch {
    container.innerHTML = '<div class="no-video">Error loading video</div>';
    sidebar.innerHTML = '<div class="video-sidebar-title">Activity Feed</div>';
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
  ['overview', 'triage', 'input', 'events', 'video'].forEach(t => {
    document.getElementById(`tab-${t}`)?.classList.toggle('active', t === tab);
    document.getElementById(`panel-${t}`)?.classList.toggle('active', t === tab);
  });
  if (tab === 'triage') loadTriage();
  else if (tab === 'input') loadInputTrack();
  else if (tab === 'events') loadEvents();
  else if (tab === 'video') loadVideo();
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
