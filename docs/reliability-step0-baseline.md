# Reliability Step 0 Baseline

This document captures the Step 0 baseline for reliability hardening.

## Snapshot

- Captured at (UTC): `2026-05-13T05:40:52Z`
- Branch: `chore/reliability-step0-baseline`
- Base commit: `6e68070`
- Runtime target: local Chrome extension + local Node server (`127.0.0.1:17890`)

## Step 0 Goals

1. Establish baseline reliability metrics before any fixes.
2. Add a repeatable manual smoke checklist.
3. Define pass/fail gates for each future implementation step.

## Baseline Metrics (Current)

Status legend:

- `measured`: value captured from run data.
- `pending`: value not captured yet in a clean measurement run.

| Metric | Definition | Current | Status | Notes |
| --- | --- | --- | --- | --- |
| Replay accounting correctness | `summary.passed + summary.failed == summary.total_steps` for each replay report | Pending | pending | Will be measured using one clean replay run from `POST /sessions/:id/replay` and one flow run from `POST /flows/:id/run`. |
| Ingest v2 success rate | `% of event batches accepted by /sessions/:id/events/batch` | Pending | pending | Extension currently has fallback to legacy endpoint; record both success and fallback count. |
| Legacy fallback rate | `% of batches that required legacy /session/:id/event path` | Pending | pending | Add collection from server logs and viewer stats checks. |
| Triage diagnosis correctness | Correct mapping for known HTTP status classes (401/403/404/422/5xx) in triage UI | Pending | pending | Validate with one fixture/session containing each class. |

## Baseline Collection Protocol

Run this once before Step 1 code changes:

1. Start server: `npm run dev` in `server/`.
2. Start extension recording from popup.
3. Perform deterministic test script in browser:
   - 1 click action
   - 1 input action
   - 1 API call expected to return 200
   - 1 API call expected to return 4xx or 5xx
4. Stop recording and open viewer.
5. Capture these artifacts:
   - `GET /sessions/:id`
   - `GET /sessions/:id/triage`
   - replay output from `POST /sessions/:id/replay`
6. Fill metric table above with measured values.

## Per-Step Acceptance Gates

- **Gate A (Accounting):** every replay report satisfies `passed + failed == total_steps`.
- **Gate B (Ingestion):** no silent drops; fallback rate is visible and explainable.
- **Gate C (Triage):** expected diagnosis labels match status-code classes.
- **Gate D (Regression):** smoke checklist in `docs/reliability-smoke-checklist.md` passes end-to-end.

## Notes

- Repository currently contains unrelated working-tree changes in server files.
- This Step 0 commit intentionally adds baseline documentation only.
