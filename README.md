# 🛩️ QA Flight Recorder

A **local-first** manual QA session recorder for Chrome. Captures:

- 🎬 Screen video (tab capture, low FPS)
- 🖱️ User interactions (click, scroll, navigation)
- 🌐 Network metadata (via Chrome DevTools Protocol)
- ⚠️ Console errors/warnings and JS exceptions
- 🐛 Manual bug markers

All data is stored **locally** on your machine. Nothing goes to the cloud.

---

## Project Structure

```
QA Flight Recorder/
├── server/             ← Node.js local server + viewer UI
│   ├── server.js       ← Express API (port 17890)
│   ├── db.js           ← SQLite sessions index
│   ├── filter.js       ← Triage view generation
│   └── public/         ← Viewer UI (HTML/JS)
├── extension/          ← Chrome Extension (MV3)
│   ├── manifest.json
│   ├── background.js   ← Service worker: CDP + event routing
│   ├── content.js      ← DOM action capture + video recorder
│   ├── popup.html/.js  ← Extension popup UI
│   └── icon*.png
└── README.md
```

Data is persisted to `~/.qa-flight-recorder/`:
```
~/.qa-flight-recorder/
├── index.db                              ← SQLite index
└── sessions/<session_id>/
    ├── meta.json
    ├── raw/events.ndjson                 ← Append-only raw log
    ├── views/
    │   ├── triage_view.ndjson            ← Filtered AI view
    │   └── view_manifest.json
    ├── summary.json
    └── video/chunk_000000.webm …
```

---

## 1. Run the Local Server

```bash
cd server
npm install
npm start
```

The server starts on **http://127.0.0.1:17890**

Open the viewer in your browser: [http://127.0.0.1:17890](http://127.0.0.1:17890)

> **Tip:** Use `npm run dev` (with nodemon) for auto-restart during development.

---

## 2. Install the Chrome Extension

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle top-right)
3. Click **"Load unpacked"**
4. Select the `extension/` folder in this repo

The 🛩️ QA Flight Recorder icon will appear in your toolbar.

> **Important:** Chrome will show a yellow "debugger" banner on the recorded tab while recording. This is expected — it's how CDP telemetry works.

---

## 3. Quick Manual Test Checklist

- [ ] Start the server (`npm start` in `server/`)
- [ ] Load the extension as unpacked in `chrome://extensions`
- [ ] Navigate to any website in Chrome (e.g. a dashboard or app)
- [ ] Click the 🛩️ extension icon → **Start Recording**
- [ ] Perform some actions:
  - Click some buttons
  - Trigger a 404/500 network request if possible
  - Open the browser console and run `console.error("test error")`
  - Add a **Bug Marker** from the popup
- [ ] Click **Stop Recording**
- [ ] Open [http://127.0.0.1:17890](http://127.0.0.1:17890)
- [ ] Verify your session appears in the list
- [ ] Click the session → check **Overview**, **Triage**, **All Events**, **Video** tabs
- [ ] Click **⬇ Download** to get the ZIP bundle

**Keyboard Shortcuts:**
- `Ctrl+Shift+S` — Start / Stop recording
- `Ctrl+Shift+M` — Add Bug Marker

---

## 4. API Reference

| Method | Path | Description |
|--------|------|-------------|
| POST | `/session/start` | Start a new session |
| POST | `/session/:id/event` | Append events (NDJSON batch) |
| POST | `/session/:id/video-chunk` | Upload a video chunk (binary) |
| POST | `/session/:id/stop` | Stop + generate triage views |
| GET  | `/sessions` | List sessions |
| GET  | `/sessions/:id` | Session meta + summary |
| GET  | `/sessions/:id/triage` | Triage view events |
| GET  | `/sessions/:id/events` | All raw events (paginated) |
| GET  | `/sessions/:id/video` | Serve concatenated video |
| GET  | `/sessions/:id/download` | ZIP bundle download |
| POST | `/sessions/:id/regenerate-views` | Re-run triage generation |

---

## 5. Triage View Logic

When a session stops, the server generates `views/triage_view.ndjson` using these rules:

| Rule | Events Included |
|------|----------------|
| `console_errors` | All `console.warn`, `console.error`, `runtime.exception` |
| `network_failures` | All `network.failure` events |
| `http_errors` | HTTP responses with status ≥ 400 |
| `slow_requests` | Requests taking > 2000ms |
| `action_context` | User actions within ±30s of any included event |
| `bug_markers` | All manual bug markers |

Repeated console errors are **deduplicated** by signature (only first occurrence kept, with a count).

---

## 6. Privacy & Redaction

- **URL query params are stripped** by default (only `scheme://host/path` is stored)
- **Auth headers** (`Authorization`, `Cookie`, `Set-Cookie`) are **never captured**
- **Typed input values** are **never captured** (only element selectors and non-input text labels)
- Raw NDJSON is **never overwritten** — only filtered **view** files are generated

---

## 7. Limitations & Roadmap

### Current Limitations
- Video playback may have a slight delay since chunks are concatenated on the fly
- CDP `tabCapture` requires user gesture (clicking popup) to initiate stream
- Chrome's CDP debugger banner appears during recording — this is a Chrome limitation
- Service worker may be suspended between events; avoid very long sessions without activity

### Roadmap
- **Pattern mining**: ML-based error clustering and root-cause suggestions
- **Multi-agent analysis**: Feed triage view to LLMs via local tool calling
- **Timeline scrubbing**: Sync video playback with event timeline
- **Multi-tab recording**: Record across multiple tabs simultaneously
- **Custom redaction rules**: Configure per-domain URL/header redaction
- **Cloud export**: Optional S3/GCS export for team sharing
- **GitLab/GitHub integration**: Auto-create issues from bug markers
