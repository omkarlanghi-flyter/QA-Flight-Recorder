# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start server (port 17890)
cd server && npm start

# Share the dashboard on your LAN (no auth layer — trusted networks only)
cd server && HOST=0.0.0.0 npm start

# Dev mode with auto-restart
cd server && npm run dev

# Syntax check a file (no linter exists)
node --check server/<file>.js

# Run tests (all run from server/ directory)
cd server
node test_ingestion.js                   # schema + ingestion pipeline
node test_normalization.js               # repro-step generation pipeline
npm run test:triage-diagnosis            # triage diagnosis classification
npm run test:event-types                 # event type normalization
```

Tests are standalone Node scripts — no test framework, no lint/typecheck commands.

## What this is

QA Flight Recorder is a **pure session-recording + debugging-capture tool**:
record a manual QA session in Chrome, capture everything a developer would
need to debug an issue (full network bodies, console/exception traces,
browser env, storage snapshots), and hand off a **link** to the dashboard.
There is no automated replay/regression system — that subsystem
(Sanity Runs / Flows / Playwright replay) was deliberately removed; see git
history before this point if you need to reference how it worked.

## Architecture Overview

Two independent components talk via HTTP:

**Chrome Extension (MV3)** — captures and streams events to the server
- `extension/background.js` — service worker: CDP telemetry, event routing, v2 batch flush with legacy fallback
- `extension/content.js` — DOM action capture, video recording via `tabCapture`
- `extension/offscreen.js` — offscreen document for MediaRecorder
- `extension/popup.js` — Start/Stop/Bug Marker UI, capture-mode toggles

**Node Server** (`server/`) — stores sessions, serves the viewer UI
- `server/server.js` — Express app on `127.0.0.1:17890` by default (`HOST` env var to change); all API routes defined here
- `server/db.js` — `sql.js` SQLite index at `~/.qa-flight-recorder/index.db`
- `server/filter.js` — triage view generation logic
- `server/debug/sourcemap.js` — on-demand stack trace → original source resolution
- `server/public/` — static viewer UI (HTML/JS, served by Express)

### Data Pipeline

```
Extension capture
  → batch flush (v2 /events/batch → legacy /event fallback)
  → IngestionContext (validate → enrich → dedup → NDJSON append → DB index)
  → ~/.qa-flight-recorder/sessions/<id>/raw/events.ndjson

On session stop:
  → filter.js → views/triage_view.ndjson (triage)

On demand (POST /sessions/:id/normalize):
  → normalization/normalizer.js → normalized.json
       (event_grouper → step_builder → assertion_extractor)
       surfaced in the UI as the "Repro Steps" tab — human-readable
       steps like "Click \"Submit\"", not tied to any replay engine

On demand (POST /sessions/:id/resolve-stack):
  → debug/sourcemap.js fetches the page's JS + its sourceMappingURL,
    resolves original file/line/column for a captured stack trace
```

### Key Modules

| Module | Purpose |
|--------|---------|
| `server/event_type.js` | Single source of truth for event type — always use `getEventType(event)`, never read `event.type` or `event.event_type` directly |
| `server/ingestion/ingestion.js` | Per-session `IngestionContext`; dual dedup: in-memory `seenIds` Set + persistent `event_dedup` DB table |
| `server/normalization/normalizer.js` | Orchestrates raw events → semantic "Repro Steps" pipeline |
| `server/debug/sourcemap.js` | Fetches/parses source maps on demand and resolves stack frames; results cached per JS file URL for the process lifetime |

### Storage Layout

```
~/.qa-flight-recorder/
├── index.db                          # sql.js SQLite index
├── ignored_errors.json               # persisted ignored error signatures
└── sessions/<session_id>/
    ├── meta.json                     # includes browser_info (UA/OS/viewport/ext version)
    ├── raw/events.ndjson             # append-only; never overwritten
    ├── normalized.json               # derived Repro Steps (generated on demand)
    ├── views/
    │   ├── triage_view.ndjson
    │   └── view_manifest.json
    ├── summary.json
    └── video/chunk_000000.webm …
```

## Key Conventions

- **Event type access:** Always use `getEventType(event)` from `server/event_type.js`. On the frontend use the same function from `server/public/app.js`. Direct reads of `event.type` or `event.event_type` are a bug.
- **API endpoints:** v2 batch endpoint (`/sessions/:id/events/batch`) is preferred; legacy (`/session/:id/event`) exists as fallback. Both are active.
- **API error envelope:** All error responses use `sendApiError(res, status, code, message, details)` → `{ ok: false, code, message, details }`.
- **Capture depth:** Request/response bodies are captured by default for API calls, not just failures — see `extension/background.js` `shouldCaptureBody`. Error responses (≥400) always get a full body. Successful calls are *sampled*: only the first `BODY_SAMPLE_LIMIT` (3) calls to a given `method + sanitized-url` per recording get a full body fetched via CDP (`shouldSampleBody`/`_pathSampleCounts`) — this exists specifically to stop polling/telemetry endpoints from flooding `Network.getResponseBody` calls and visibly slowing the recorded page. `Network.getResponseBody` dispatch is also concurrency-limited (`runBodyFetch`, `MAX_CONCURRENT_BODY_FETCHES = 4`). The popup's "Lite capture" toggle (`state.liteCapture`) opts further into errors-only capture (no sampling needed since almost nothing gets fetched).
- **WebSocket capture:** Chrome emits WS lifecycle/frame events as part of the `Network` domain (no separate CDP domain to enable). Connection lifecycle (`network.ws_open`, `network.ws_handshake`, `network.ws_error`, `network.ws_close`) is always captured in full — cheap and high-signal. Frame payloads (`network.ws_frame`) follow the same sampling philosophy as HTTP bodies but *per connection* rather than per endpoint: the first `WS_FRAME_SAMPLE_LIMIT` (5) frames per direction per socket get a full (redacted) payload, later frames are just counted/sized (`_wsConnections` map in `background.js`) — this avoids flooding capture on a live telemetry/status socket that pushes many frames per second. `network.ws_close` always reports total frame counts/bytes for the connection even when individual payloads were sampled out, so volume is never lost. `network.ws_error` is treated as a triage anchor in `filter.js`, same tier as `network.failure`.
- **Redaction is client-side only:** headers (`redactHeaders`), bodies (`redactBodyText`/`_redactJsonValue`), and storage snapshots (`_redactStorageObj`) are all scrubbed inside the extension before anything is sent to the server — there is no server-side redaction. Extend the relevant regex/function in `background.js` rather than adding scrubbing on the server.
- **Privacy:** URL query params are stripped from the sanitized URL field (raw URL kept separately). Auth headers and password field values are never captured. Server binds to `127.0.0.1` unless `HOST` is explicitly set.
- **NDJSON:** `raw/events.ndjson` is append-only and never overwritten. Triage/summary/normalized are derived artifacts that can be regenerated.
- **Tests run from `server/`:** `npm run test:*` scripts must be run from inside `server/`, not the repo root.
