# QA Flight Recorder — Agent Guide

## Quick Start

```bash
cd server
npm install
npm start                    # http://127.0.0.1:17890
npm run dev                  # nodemon auto-restart
```

## Test Commands

All tests are standalone Node scripts (no test framework).

```bash
cd server
node test_ingestion.js          # schema + ingestion pipeline
npm run test:replay-accounting  # replay pass/fail accounting
npm run test:triage-diagnosis   # triage diagnosis classification
npm run test:event-types        # event type normalization
npm run test:assertions         # assertion evaluator
```

No lint or typecheck commands exist. Use `node --check <file>` for syntax validation.

## Architecture

- **Chrome Extension (MV3):** `extension/background.js` (service worker), `content.js` (DOM capture), `offscreen.js` (video)
- **Node Server:** `server/server.js` (Express, port 17890), local-only binding (`127.0.0.1`)
- **Storage:** `~/.qa-flight-recorder/` — NDJSON artifacts + `sql.js` SQLite index (`index.db`)

Entrypoint: `server/server.js:1216` — `db.init()` then `app.listen(PORT, '127.0.0.1')`

## Key Conventions

- **Dual API model:** v2 batch endpoints preferred (`/sessions/:id/events/batch`); legacy (`/session/:id/event`) exists as fallback
- **Event types:** Never read `event.type` or `event.event_type` directly. Always use `getEventType(event)` from `server/event_type.js` (or `server/public/app.js` on the frontend)
- **API error envelope:** All responses follow `{ ok: false, code, message, details }` via `sendApiError(res, status, code, message, details)`
- **Assertions:** Placeholder assertions in `server/engine/assertions.js:61-64` are now implemented with real checks using runtime telemetry
- **NDJSON:** Raw events are append-only NDJSON; triage/summary are derived artifacts
- **Ingestion dedup:** Both in-memory (`this.seenIds`) and persistent DB (`event_dedup` table) with rollback on write failure

## Common Pitfalls

- Replay summary counted passes twice before Step 1 fix — if adding new replay code, verify `summary.passed + summary.failed === summary.total_steps`
- Repo often has unrelated working tree changes in `server/db.js`, `server/server.js`, `server/engine/replay.js` — do not commit them unless asked
- No remote configured by default — set origin before pushing
- `npm run test:*` scripts all live inside `server/` — run them from there, not root

## Data Flow

```
Extension capture → batch flush (v2 → legacy fallback) → NDJSON write → index DB
                                                  ↓
                                        Triage generation ← filter.js
                                                  ↓
                                        Normalization → Flow → Plan → Replay (Playwright)
```
