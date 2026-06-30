# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start server (port 17890)
cd server && npm start

# Dev mode with auto-restart
cd server && npm run dev

# Syntax check a file (no linter exists)
node --check server/<file>.js

# Run tests (all run from server/ directory)
cd server
node test_ingestion.js                   # schema + ingestion pipeline
npm run test:replay-accounting           # replay pass/fail accounting
npm run test:triage-diagnosis            # triage diagnosis classification
npm run test:event-types                 # event type normalization
npm run test:assertions                  # assertion evaluator
```

Tests are standalone Node scripts — no test framework, no lint/typecheck commands.

## Architecture Overview

Two independent components talk via HTTP:

**Chrome Extension (MV3)** — captures and streams events to the server
- `extension/background.js` — service worker: CDP telemetry, event routing, v2 batch flush with legacy fallback
- `extension/content.js` — DOM action capture, video recording via `tabCapture`
- `extension/offscreen.js` — offscreen document for MediaRecorder
- `extension/popup.js` — Start/Stop/Bug Marker UI

**Node Server** (`server/`) — stores sessions, serves the viewer UI
- `server/server.js` — Express app on `127.0.0.1:17890`; all API routes defined here
- `server/db.js` — `sql.js` SQLite index at `~/.qa-flight-recorder/index.db`
- `server/filter.js` — triage view generation logic
- `server/public/` — static viewer UI (HTML/JS, served by Express)

### Data Pipeline

```
Extension capture
  → batch flush (v2 /events/batch → legacy /event fallback)
  → IngestionContext (validate → enrich → dedup → NDJSON append → DB index)
  → ~/ .qa-flight-recorder/sessions/<id>/raw/events.ndjson

On session stop:
  → filter.js → views/triage_view.ndjson
  → normalization/normalizer.js → normalized.json
       (event_grouper → step_builder → assertion_extractor)
  → flows/flow_store.js → Flow record in DB
  → engine/planner.js → ExecutionPlan
  → engine/replay.js (Playwright) → replay report
```

### Key Modules

| Module | Purpose |
|--------|---------|
| `server/event_type.js` | Single source of truth for event type — always use `getEventType(event)`, never read `event.type` or `event.event_type` directly |
| `server/ingestion/ingestion.js` | Per-session `IngestionContext`; dual dedup: in-memory `seenIds` Set + persistent `event_dedup` DB table |
| `server/normalization/normalizer.js` | Orchestrates raw events → semantic steps pipeline |
| `server/engine/assertions.js` | Assertion evaluator; uses runtime telemetry (`report.runtime.network_events`, `report.runtime.console_events`) |
| `server/engine/replay.js` | `ReplayEngine` class using Playwright; writes per-step debug artifacts (screenshot + debug JSON) on failure |
| `server/engine/planner.js` | Converts Flow steps into `ExecutionPlan` with selector chains, wait strategies, retry configs |
| `server/flows/flow_model.js` | Flow/FlowStep schema: `STEP_TYPES`, `PRIORITY_LEVELS`, `CRITICALITY_LEVELS`, `FALLBACK_STRATEGIES` |

### Storage Layout

```
~/.qa-flight-recorder/
├── index.db                          # sql.js SQLite index
├── ignored_errors.json               # persisted ignored error signatures
└── sessions/<session_id>/
    ├── meta.json
    ├── raw/events.ndjson             # append-only; never overwritten
    ├── normalized.json               # derived from raw events
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
- **Replay accounting invariant:** `summary.passed + summary.failed === summary.total_steps` must always hold. Verify this when modifying replay or step-counting logic.
- **Privacy:** URL query params are stripped (only `scheme://host/path` stored). Auth headers and typed input values are never captured.
- **NDJSON:** `raw/events.ndjson` is append-only and never overwritten. Triage/summary/normalized are derived artifacts that can be regenerated.
- **Tests run from `server/`:** `npm run test:*` scripts must be run from inside `server/`, not the repo root.
