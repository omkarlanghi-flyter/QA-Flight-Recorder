# Reliability Smoke Checklist

Use this checklist before and after each reliability step.

## Preconditions

- Server running on `127.0.0.1:17890`.
- Chrome extension loaded and popup visible.
- Viewer accessible.

## Recording Flow

1. Click `Start Recording` in popup.
2. In a target app page, perform:
   - one click on an interactive element
   - one input into a text field
   - one navigation (if applicable)
3. Trigger one known warning/error condition (console or network failure) if test app supports it.
4. Optionally add one bug marker from popup.
5. Click `Stop Recording`.

## Viewer Validation

1. Open latest session from sidebar.
2. Verify Overview cards load and counts are non-empty.
3. Open Triage tab and confirm triage rows render.
4. Open Events tab and confirm action/network entries exist.
5. If video was enabled, open Video tab and confirm playback loads.

## Replay Validation

1. Run `POST /sessions/:id/replay` for the captured session.
2. Verify replay report exists and includes `summary` + `steps`.
3. Confirm accounting invariant:
   - `summary.passed + summary.failed == summary.total_steps`
4. Confirm at least one step has timing and status fields populated.

## Pass Criteria

- No server crash during record/stop/replay cycle.
- Session artifacts are created (`meta.json`, `raw/events.ndjson`, `views/*`, optional `video/*`).
- Viewer tabs render without fatal errors.
- Replay report invariant holds.

## Failure Logging Template

- Date/Time (UTC):
- Branch/Commit:
- Session ID:
- Step failed:
- Observed behavior:
- Expected behavior:
- Logs/artifacts:
