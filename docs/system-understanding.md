# QA Flight Recorder — Complete System Understanding

> **⚠️ Partially outdated.** This document describes the Sanity Runs / Flow /
> automated-replay subsystem (Playwright-based replay, Flow CRUD, releases,
> failure clustering) that has since been **removed** — the tool is now a
> pure session-recording + debugging-capture tool. Sections on recording,
> triage, ingestion, and the normalization/Repro-Steps pipeline are still
> accurate. See `CLAUDE.md` at the repo root for the current architecture.

## What This System Is

QA Flight Recorder is a **local-first manual QA session recording and replay tool** built for FlytBase (a drone-fleet software company). It runs entirely on the tester's machine — nothing leaves the local machine. No cloud dependency.

The core loop: a QA tester does manual testing in Chrome → the tool records everything that happens (actions, network calls, console errors, video) → the tester reviews it in a local web viewer → the team can re-run the same session automatically using Playwright.

The goal is to make manual QA reproducible and observable without requiring test engineers to write test scripts up front.

---

## Two-Component Architecture

```
┌──────────────────────────────────────┐     HTTP       ┌──────────────────────────────────┐
│   Chrome Extension (MV3)             │  ──────────►  │   Node.js Server (port 17890)    │
│                                      │               │                                  │
│  background.js  — service worker     │               │  server.js     — Express API      │
│  content.js     — DOM capture        │               │  db.js         — SQLite (sql.js)  │
│  offscreen.js   — video recorder     │               │  filter.js     — triage logic     │
│  popup.js       — UI controls        │               │  public/       — viewer web app   │
└──────────────────────────────────────┘               └──────────────────────────────────┘
                                                                       │
                                                        ~/.qa-flight-recorder/
                                                        ├── index.db
                                                        └── sessions/<uuid>/
                                                            ├── raw/events.ndjson
                                                            ├── views/triage_view.ndjson
                                                            ├── normalized.json
                                                            └── video/chunk_*.webm
```

---

## What Gets Captured

The extension captures four categories of data simultaneously:

| Category | Source | Examples |
|---|---|---|
| **User actions** | content.js (DOM events) | clicks, text input, selects, Enter/Escape/Tab, scrolls, SPA navigation, modal appearances |
| **Network telemetry** | background.js (CDP) | request URL/method/headers, response status, timing, failure errors, GraphQL operation names |
| **Console signals** | background.js (CDP) | console.warn/error, uncaught JS exceptions, CORS/CSP violations |
| **Screen video** | offscreen.js (tabCapture) | WebM video at 15fps, 1.5Mbps, chunked every 5 seconds |

**Privacy built-in:** URL query params stripped (only `scheme://host/path` stored), auth/cookie headers redacted to `[REDACTED]`, password field values replaced with `***`, typed input values never sent for sensitive fields.

---

## Complete Recording Flow (Step by Step)

### 1. User Starts Recording (popup.js → background.js)

User clicks "● Start Recording" or "● Start Sanity" in the extension popup, or presses `Ctrl+Shift+S`.

For **sanity flows**, the popup asks for a `flowName` and optional `moduleName` — these tag the session as `recording_type: 'sanity'` so it appears in the Sanity tab.

### 2. background.js Initializes (background.js)

```
POST /session/start  →  server creates session, returns session_id + started_at
attachCDP(tabId)     →  enables Network, Runtime, Log, Audits CDP domains
executeScript        →  injects content.js into the page
startVideoCapture    →  tabCapture → offscreen.html → MediaRecorder
setInterval(flushEvents, 2000)  →  batch timer starts
```

State stored in `background.js`:
- `state.sessionId`, `state.tabId`, `state.startedAt`
- `state.eventBuffer[]` — events accumulating before flush
- `state.pendingRequests{}` — request_id → request metadata (for timing correlation)

### 3. Events Are Captured in Parallel

**From content.js (injected into the page, source: `'content'`):**
- `click` → `action.click` with selector, selector_strategies[], text_snippet, x/y coordinates
- `input` (debounced 600ms) → `action.input` with final_value, input_type, is_sensitive
- `change` on SELECT → `action.select` with selected_value, selected_text
- `keydown` for Enter/Escape/Tab → `action.keydown` with key, selector
- `scroll` (throttled 500ms) → `action.scroll` with scrollY/X, deltaY/X
- `pushState`/`replaceState`/`hashchange`/`popstate` → `action.navigation` from_url, to_url
- MutationObserver on body → `dom.state_change` when modals/toasts/alerts appear (role=dialog/alert, class=modal/toast/snackbar/notification/etc.)

**From background.js CDP (source: `'cdp'`, `'cdp-log'`, `'cdp-runtime'`, `'cdp-audits'`):**
- `Network.requestWillBeSent` → `network.request` (skips static assets: images, fonts, media; keeps .js and .css)
- `Network.responseReceived` → `network.response` with status, headers (response body captured async for 4xx/5xx only)
- `Network.loadingFinished` → `network.timing` with duration_ms, request+response body
- `Network.loadingFailed` → `network.failure` with errorText
- `Log.entryAdded` (warn/error) → `console.warn` / `console.error` with breadcrumbs
- `Runtime.consoleAPICalled` (warn/error) → `console.warn` / `console.error`
- `Runtime.exceptionThrown` → `runtime.exception` with message, stack, line/column
- `Audits.issueAdded` (CORS/CSP) → `browser.audit_violation`

**From background.js tabs listener (source: `'browser'`):**
- `chrome.tabs.onUpdated` with `changeInfo.url` → `action.navigation` (this is the browser-sourced duplicate, filtered out during replay)

**From background.js user actions (source: `'user'`):**
- Bug marker via popup → `marker.bug` with note

Each event has a `correlation_id` linking it to the last action event within 1500ms (network/console events get tagged with the action that triggered them).

### 4. Events Batch to Server

Every 2 seconds (or when buffer hits 50 events), `flushEvents()` sends to:
- **Primary:** `POST /sessions/:id/events/batch` (v2 — validates, enriches, deduplicates atomically)
- **Fallback:** `POST /session/:id/event` (legacy — still works, no schema validation)

On the server, each event goes through `IngestionContext`:
1. `validate()` — checks required fields, event_type namespace, source validity
2. `enrich()` — stamps `event_id` (UUID if missing), `schema_version: '2.0'`, canonicalizes field names
3. In-memory dedup via `seenIds` Set (per session context, lives until `POST /session/stop`)
4. Persistent dedup via `event_dedup` DB table (survives server restarts)
5. NDJSON append to `raw/events.ndjson`
6. High-signal types indexed in `events_index` DB table

**High-signal types indexed:** `console.error`, `console.warn`, `runtime.exception`, `network.failure`, `marker.bug`, `action.navigation`

### 5. Video Chunks Uploaded

`offscreen.js` MediaRecorder fires `ondataavailable` every 5 seconds → binary chunk posted to `POST /session/:id/video-chunk` → server writes to `sessions/<id>/video/chunk_NNNNNN.webm`.

### 6. User Stops Recording

`STOP_RECORDING` message → background.js:
1. Stops batch timer
2. Final `flushEvents()` (drains remaining buffer)
3. `stopVideoCapture()` → stops MediaRecorder and closes offscreen document
4. `detachCDP(tabId)` — disables all CDP domains
5. Resets `state.*` immediately (badge removed)
6. `POST /session/:id/stop` → server finalizes session

**On the server at stop:**
1. Computes stats (event_count, error_count, network_failure_count, slow_request_count)
2. Updates session in DB as `status: 'done'`
3. Destroys `IngestionContext` (frees in-memory dedup set)
4. **Generates triage view** (filter.js)
5. **Runs normalization** if requested or available

---

## Triage View Generation (filter.js)

Runs automatically when a session stops. Produces `views/triage_view.ndjson`, `views/view_manifest.json`, `summary.json`.

**3-pass algorithm:**

**Pass 1 — Anchor collection:**
- Group network events by `request_id`
- Include as anchors: console.warn, console.error, runtime.exception, network.failure, HTTP status ≥ 400, slow requests (>2000ms), marker.bug
- Each anchor timestamp goes into `anchorTimestamps`

**Pass 2 — Context window:**
- For each anchor, include all `action.*` events within ±30 seconds
- Overlapping windows are merged

**Pass 3 — Error deduplication:**
- Repeated console errors with same message prefix (first 120 chars) → only first occurrence kept, annotated with `_triage.dedup_count`

**Diagnosis labels** (triage_diagnosis.js):
- `network.failure` → "CRITICAL: endpoint crashed or CORS blocked"
- HTTP 5xx → "CRITICAL BUG: backend crashed"
- HTTP 401/403 → "AUTHENTICATION BUG"
- HTTP 404 → "NOT FOUND"
- HTTP 400/422 → "VALIDATION BUG: invalid request payload"
- `runtime.exception` → "CRITICAL APP CRASH: JS error halted app"

**summary.json** contains: top error clusters (by frequency), failed endpoints, slow endpoints with p95 timing, likely trigger action (last user action before first error).

---

## Normalization Pipeline (server/normalization/)

Converts raw flat event stream into semantic, named test steps. Runs via `POST /sessions/:id/normalize`. Output: `normalized.json`.

**Pipeline:**

```
raw events (events.ndjson)
    ↓
event_grouper.js  →  action groups
    ↓
step_builder.js   →  semantic steps
    ↓
assertion_extractor.js  →  assertions attached to steps
    ↓
normalized.json
```

**event_grouper.js — grouping rules:**
- `navigate` — standalone navigation event
- `scroll` — consecutive scrolls (gap < 3s merged)
- `fill` — consecutive `action.input` events (form fill)
- `form_submit` — fill sequence followed by Enter within 2s
- `click` — standalone click
- `open_modal` — click followed by `dom.state_change` with role=dialog within 1.5s
- `click_with_toast` — click followed by toast/alert `dom.state_change`
- `select_option` — `action.select`
- `keypress` — `action.keydown`
- `toast` — standalone `dom.state_change` with alert/toast role

Each group has `context_events` = network/console events within 1.5s after the group.

**step_builder.js — step types:**
- `navigate`, `click`, `fill_field`, `submit_form`, `select_option`, `press_key`, `scroll`, `observe_toast`, `raw_action`
- Each step gets: `step_id`, `label` (human-readable), `selector`, `value`/`url`/`key`, `source_event_ids`, timestamps

**assertion_extractor.js — inferred assertions (±2500ms after step):**
- `assert_toast` (hard) — toast/alert appeared with specific text/role
- `assert_modal_open` (hard) — dialog appeared
- `assert_modal_closed` (soft) — dialog was removed
- `assert_api_success` (soft) — network response 2xx
- `assert_no_js_errors` (soft) — no console.error/runtime.exception
- `assert_no_net_failure` (hard) — no network.failure when API calls were present

Soft assertions warn but don't fail the step during replay.

---

## Flow System (server/flows/)

A **Flow** is a normalized, versioned, named sequence of steps that can be replayed deterministically and tracked over time.

**Creating a Flow:**
1. Record a session → normalize it → `POST /sessions/:id/promote`
2. `flow_store.js` calls `flowFromNormalized()` which enriches steps with:
   - `selectors[]` — priority-ordered CSS/text/coordinate selectors
   - `fallback_strategy` — what to do if all selectors fail (coordinate_click / text_match / skip / throw)
   - Default `wait_strategy` per step type
3. Flow + steps persisted to DB (flows + flow_steps tables)

**Flow metadata:** `flow_name`, `module`, `feature`, `priority` (low/medium/high/critical), `criticality` (normal/blocker/smoke), `tags[]`, `owner`, `version` (auto-incremented on update), `source_session_id`

---

## Replay Planner (server/engine/planner.js)

Converts a stored Flow into an **ExecutionPlan** the Playwright engine can run.

Per step, the plan adds:
- `selector_chain[]` — priority-sorted list of selectors to try (data-testid first, then aria-label, name, CSS path, text, coordinates)
- `wait_strategy` — e.g., `navigate` → `network_idle`, `submit_form` → `network_settle`, click with modal → `dom_change`
- `retry_config` — `navigate`/`submit_form`: max_attempts=1 (idempotency risk); `click`/`fill_field`/`select_option`: max_attempts=3; `press_key`: max_attempts=2
- `assertions[]` — copied from flow step
- `fallback` — strategy if all selectors fail
- `wait_layers[]` — layered wait sequence (dom_ready, element_visible, network_idle, timeout_fallback)

Plan cached as `~/.qa-flight-recorder/flows/<flow_id>/latest_plan.json`.

---

## Replay Engine (server/engine/replay.js)

Two replay modes, one class (`ReplayEngine`):

### Mode 1: `engine.run()` — Raw Session Replay

Used by: `POST /sessions/:id/replay` (what the Sanity tab "▶ Run" button calls)

- Takes ALL events from `events.ndjson`
- Filters: `action.*` events with `source === 'content'|'user'`; `action.navigation` must be `source === 'content'`; `action.input` skips checkbox/radio
- Dedup by key `type::selector::ts_epoch_ms`
- Builds `_networkIndex` (for each step, which API paths fired within 1500ms after it)
- Builds `_timingsByPath` (historical p50 timing per API path for adaptive timeouts)
- Runs steps sequentially in Playwright
- Retries: click=3 attempts, navigation=3, keydown=2, input/scroll=2

### Mode 2: `engine.runPlan()` — Plan-Based Replay

Used by: `POST /flows/:id/run`

- Takes an ExecutionPlan (curated steps with selector chains, wait strategies, assertions)
- Each step: resolve locator via `_resolveLocatorFromChain()`, execute action, `_waitLayers()`, evaluate assertions
- Hard assertion failures flip step from passed → failed and capture debug artifacts (screenshot + debug.json)
- Captures per-step screenshots and debug context to `runs/<run_id>/artifacts/step-N/`

### Common behavior for both modes:
- Connects to existing Chrome via CDP (port 9223) — uses the user's actual Chrome profile/session (auth cookies etc.)
- If Chrome not open, launches it with `--remote-debugging-port=9223`
- Closes stray pages/popups that open during replay
- Collects runtime telemetry (network events, console events) tagged by `activeStepIndex`
- `abortOnFailure: false` by default → continues through all steps even after failure
- Per-step timeout: `stepBudget: 15000ms`

### Selector resolution strategy (`_resolveLocatorFromChain`):
Priority order: data-testid → id → aria-label/name/placeholder → CSS path → tag+class → text match → coordinates fallback

### Network-aware waiting (both modes):
For `run()`: Before each step, registers `waitForResponse` promises for correlated API paths (from `_networkIndex`). After the action, awaits those promises with adaptive timeouts based on historical timing. Then `_postActionSettle()` (network settled + 1s padding).

### Assertions evaluated during `runPlan()`:
```
assert_element_visible  — locator visible
assert_modal_open       — dialog selector visible
assert_api_called       — URL matches in runtime network events
assert_status_ok        — response status in expected range
assert_latency_lt       — response duration < threshold
assert_no_js_errors     — no console.error in runtime events
assert_no_console_errors— no console.error in runtime events
assert_business_event   — label match in runtime events (placeholder)
```

---

## Failure Clustering (server/engine/failure_clusterer.js)

After each `runPlan()` run, failed steps are classified into clusters:

| Signature pattern | Cluster class |
|---|---|
| "element not found" / "clickable element" | `selector_issue` |
| "timeout" + "navigation" | `environment_mismatch` |
| "auth" / "login" | `auth_session` |
| network failure / "http" in error | `backend_failure` |
| anything else | `unknown` |

Signature: `step_type|error_text|network_failure|selector` (normalized, 120 char limit). Clusters persisted in `failure_clusters` DB table, upserted on each occurrence (`count` incremented, `last_seen` updated). Each run step gets a `cluster_id`.

---

## Database Schema (db.js — sql.js pure-JS SQLite)

File: `~/.qa-flight-recorder/index.db`

| Table | Purpose |
|---|---|
| `sessions` | Recording sessions: id, started_at, url, title, status, recording_type, flow_name, module_name, error_count, etc. |
| `events_index` | High-signal events only: console.error/warn, runtime.exception, network.failure, marker.bug, action.navigation |
| `event_dedup` | Persistent dedup store: (session_id, event_id) pairs |
| `flows` | Named test flows: flow_id, flow_name, module, priority, criticality, version |
| `flow_steps` | Individual steps per flow: step_type, selectors, assertions, wait_strategy, meta |
| `runs` | Playwright replay executions: run_id, flow_id, score (passed/total), timings |
| `run_steps` | Per-step result of a run: status, retry_count, assertion_failures, cluster_id, timings |
| `failure_clusters` | Grouped failure signatures: signature, failure_class, count, first/last seen |
| `modules` | Module registry |
| `releases` | Release tracking: version, risk_score, modules[] |

`sql.js` keeps the entire DB in memory and calls `persistDb()` (writes full binary) after every write. No WAL, no transactions — each write is immediate.

---

## Viewer Web App (server/public/)

Single-page app served from `http://127.0.0.1:17890`.

**Left sidebar:**
- Sessions tab — all sessions, searchable, health color-coded (green=clean, amber=net failures, red=errors)
- Sanity tab — one row per unique flow_name/module_name (latest recording), "▶ Run" button

**Session detail (right panel):**
- **Overview** — duration, event/error counts, top error clusters, failed endpoints, slow endpoints
- **Triage** — anchor events + context actions, diagnosis labels, per-error ignore/unignore, filter by type
- **All Events** — paginated raw event stream with payload accordions
- **Video** — concatenated WebM playback
- **Runs** — history of both manual recordings and automated replays for this flow

**Ignored errors:** signatures stored in `~/.qa-flight-recorder/ignored_errors.json`. Ignored errors are excluded from triage view and summary.

---

## Sanity Flow Concept (How It's Used)

The "sanity flow" is the primary regression testing workflow:

1. QA tester clicks "Start Sanity" in popup → enters flow name (e.g., "Login") + module
2. Records the entire happy-path flow manually
3. Stops recording → session tagged `recording_type: 'sanity'`, `flow_name: 'Login'`
4. Session appears in the Sanity sidebar tab
5. Anytime they want to verify the same flow works → click "▶ Run"
6. Playwright opens Chrome, replays all recorded actions, reports pass/fail per step

The UI shows the **latest recording** per flow_name/module_name combination. Old recordings of the same flow are retained in the DB but only the newest appears as the "live" sanity definition.

---

## Releases (Grouping Runs)

Flows can be associated with a `release_id` when running (`POST /flows/:id/run` body). This allows grouping all replay results for a specific release, computing a `risk_score` per release (passed / total steps), and tracking which modules are covered.

---

## API Surface

### Session lifecycle
| Method | Path | Purpose |
|---|---|---|
| POST | `/session/start` | Start session, returns session_id |
| POST | `/sessions/:id/events/batch` | v2 batch ingest (preferred) |
| POST | `/session/:id/event` | Legacy event ingest (fallback) |
| POST | `/session/:id/video-chunk` | Upload video binary chunk |
| POST | `/session/:id/stop` | Stop, generate triage |
| GET | `/sessions` | List sessions |
| GET | `/sessions/:id` | Session meta + summary |
| GET | `/sessions/:id/triage` | Triage events |
| GET | `/sessions/:id/events` | Paginated raw events |
| GET | `/sessions/:id/video` | Concatenated video stream |
| GET | `/sessions/:id/download` | ZIP bundle |
| POST | `/sessions/:id/regenerate-views` | Re-run triage |
| POST | `/sessions/:id/normalize` | Run normalization pipeline |
| POST | `/sessions/:id/promote` | Promote session to Flow |
| POST | `/sessions/:id/replay` | Playwright replay (raw events) |
| POST | `/sessions/:id/replay/stop` | Stop active replay |
| GET | `/sessions/:id/replays` | Replay run history |

### Flows & runs
| Method | Path | Purpose |
|---|---|---|
| GET | `/sanity-flows` | Latest sanity session per flow name |
| GET | `/flows` | List flows |
| POST | `/flows` | Create flow |
| GET | `/flows/:id` | Get flow with steps |
| PATCH | `/flows/:id` | Update flow metadata |
| DELETE | `/flows/:id` | Delete flow |
| POST | `/flows/:id/plan` | Generate/cache execution plan |
| GET | `/flows/:id/plan` | Get execution plan |
| POST | `/flows/:id/run` | Run flow with Playwright |
| GET | `/runs` | List runs |
| GET | `/runs/:id` | Get run with step results |
| GET | `/failure-clusters` | List failure clusters |

### Ignored errors
| Method | Path | Purpose |
|---|---|---|
| GET | `/ignored-errors` | List ignored error signatures |
| POST | `/ignored-errors` | Add signature to ignore list |
| DELETE | `/ignored-errors/:sig` | Remove from ignore list |

---

## Key Invariants and Conventions

1. **Event type access:** Always `getEventType(event)` from `event_type.js` — never `event.type` or `event.event_type` directly. Both are normalized by `normalizeEventType()`.

2. **Replay accounting:** `summary.passed + summary.failed === summary.total_steps` must always hold. `run()` sets `total_steps` before the loop; `runPlan()` resets the report with `total_steps = plan.steps.length`.

3. **NDJSON is append-only:** `raw/events.ndjson` is never overwritten. Triage view, normalized.json, and summary are always derived artifacts that can be regenerated.

4. **Dual endpoint model:** v2 batch endpoint (`/sessions/:id/events/batch`) is preferred; the extension falls back to legacy (`/session/:id/event`) if v2 fails. Both write to the same NDJSON file.

5. **Error envelope:** All API errors follow `{ ok: false, code, message, details }` via `sendApiError()`.

6. **CDP filter for replay:** `action.navigation` must have `source === 'content'` to be replayed (the browser-sourced duplicate from `chrome.tabs.onUpdated` is excluded). Checkbox/radio `action.input` events are excluded from replay (they're auto-generated duplicates from the change handler).

7. **Plan caching:** Plans are cached at `flows/<flow_id>/latest_plan.json`. Passing `regenerate: true` in the run body forces regeneration. Without it, the cached plan is used even if flow steps were updated.

8. **sql.js persistence:** Every DB write calls `persistDb()` which exports the full in-memory database to disk. This is a full-file write, not incremental.

---

## Known Bugs (Identified in Code)

1. **`firstActionTs` filter is a no-op** (replay.js:238-244): The filter meant to exclude pre-recording events from `run()` computes `firstActionTs = min(all rawStep timestamps)` then filters `rawSteps` to `ts >= that minimum` — which is always true. Pre-recording stray events are never excluded.

2. **`abortOnFailure` not exposed for sanity flows** (server.js:393-406): `validateReplayBody` only accepts `profileDir` and `stepDelay`. `abortOnFailure` is hardcoded to `false` — when a step fails the replay always continues to subsequent steps regardless. Compare: `runPlan()` accepts any body fields via `...body` spread so `abortOnFailure` works there.

3. **`activeStepIndex` not updated in `runPlan()`** (replay.js constructor vs loop): `activeStepIndex` stays at `-1` during `runPlan()` runs because the loop never sets it. All runtime console/network events during `runPlan()` are attributed to `step_index: null` in the runtime telemetry.

4. **Stale plan cache** (server.js:1258-1262): If a flow's steps are updated but a cached plan exists, `POST /flows/:id/run` without `regenerate: true` uses the old plan with potentially outdated steps.

5. **Abort in `run()` pushes phantom step** (replay.js:270-297): `stepReport` is pushed to `report.steps` BEFORE the abort check. When `this.aborted` is true, one extra step record appears in the report with `status: 'failed'` and error "Replay aborted by user", inflating `report.steps.length` vs the actual `total_steps` set earlier.

---

## Development Context

- **Project:** Built for FlytBase (drone fleet management software) for QA testing their web apps
- **Branch:** `chore/reliability-step0-baseline` — a reliability hardening branch
- **Reliability goals:** Fixing replay accounting invariant, improving ingestion dedup, improving triage diagnosis correctness
- **Test data:** 12 existing sessions recorded against FlytBase staging/testing/production URLs
- **Tests:** All standalone Node scripts in `server/`, no framework. Run from `server/` directory.
- **Chrome profile for replay:** `~/.qa-flight-recorder-profile` (separate from user's main profile, but can be configured via `profileDir` option — allows using a real logged-in session)
- **GraphQL:** The system specifically handles GraphQL POST bodies to extract `operationName` and operation type — relevant for FlytBase's API layer
