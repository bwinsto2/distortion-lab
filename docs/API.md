# Controller API, backend API, dials and file formats

## One controller for mouse, keyboard, dials and scripts

Every state change goes through `DLCore` functions (`web/js/core.js`). They validate inputs, quantise values to the
step grid, enforce pins and record undo entries and the action log. The console exposes the same entry points as
`window.DistortionLab`:

```js
DistortionLab.set('bendAmount', 0.12, { source: 'dial-1', coalesce: 'dial:bendAmount' })
DistortionLab.nudge('phase', +3, { source: 'dial-1', stepMode: 'fine' })   // steps of the fine/coarse step size
DistortionLab.endEdit()                         // end a coalesced drag/turn: next change is a new undo entry
DistortionLab.pin('holeSize'); DistortionLab.unpin('holeSize'); DistortionLab.togglePin('c2.weight')
DistortionLab.undo(); DistortionLab.redo()
DistortionLab.chooseGallery('combo:bend:mild+hole:mild')
DistortionLab.requestAlternatives({ focus: 'bend', repeat: false })        // returns the recorded proposal set
DistortionLab.choose('set3', 'p1')              // or 'keep'
DistortionLab.combine('cross', 'fragment')
DistortionLab.setLayout('visibility', 'left'); DistortionLab.setReference('frequency', 3.2)
DistortionLab.getSession(); DistortionLab.getWork(); DistortionLab.reconPNG(512)
```

Parameter paths are the semantic keys (`bendAmount`, `holeShape`, …), or for the original renderer `contrast` and
`c<ID>.<field>` (for example `c3.weight`). Invalid values throw. Pinned fields throw a `CannotApply` error with an
explanation, and nothing is changed. **Coalescing**: changes that share a `coalesce` key within 1.5 s form one undo
entry. Slider drags use `slider:<path>`, and a drag ends on the slider's `change` event.

## External dials (via the backend)

Hardware dials or other local programs can drive the same controller by POSTing to the backend. The console subscribes
over Server-Sent Events and applies each message through the functions above, so pins, ranges and undo all apply.

```bash
curl -s -X POST http://127.0.0.1:8765/api/control -H 'Content-Type: application/json' \
     -d '{"op":"nudge","path":"bendAmount","steps":1,"stepMode":"fine","source":"dial-1"}'
```

| op | fields |
|---|---|
| `set` | `path`, `value` |
| `nudge` | `path`, `steps` (number), optional `stepMode` `fine`/`coarse` |
| `endEdit` | ends the current coalesced edit |
| `undo`, `redo` | |
| `pin`, `unpin` | `path` |

`source` (≤ 40 characters) is recorded in the action log. Unknown fields or ops are rejected with HTTP 400. The relay
lives in the backend process, which is bound to 127.0.0.1 and refuses other hosts and origins. A device driver
(serial, MIDI, HID) is not included; see `tests/test_backend.py::test_control_relay` for a minimal client.

## Backend HTTP API (127.0.0.1 only)

| Method & path | Purpose |
|---|---|
| `GET /api/status` | version, data folder, Python version, AI status |
| `GET /api/sessions` | session index (SQLite) |
| `GET/PUT /api/sessions/<id>` | load / validate and save (atomic write, previous revision kept as `.prev.json`) |
| `GET /api/sessions/<id>/revisions` | revision log with SHA-256 and size |
| `POST /api/sessions/<id>/export` | writes `data/exports/<id>/<stamp>/`: session.json, manifest.json, reference.png, reconstruction-current.png, accepted-NNN.png (Python renderer), plus browser PNGs for cross-checking |
| `POST /api/render` | `{recon, size, geometry}` → PNG |
| `POST /api/validate/operations` | `{work, operations}` → applied/rejected |
| `GET /api/ai/status`, `POST /api/ai/check`, `POST /api/ai/propose` | optional AI bridge ([AI_BRIDGE.md](AI_BRIDGE.md)) |
| `POST /api/dev-request` | stores a development request in `data/dev-requests/` |
| `POST /api/control`, `GET /api/control/stream` | dial relay |

Malformed JSON, schema violations, out-of-range values, unknown fields, bad ids and oversize bodies are rejected with
HTTP 400 and `{ok: false, error}`.

## Session file: `distortion-lab/session/2`

| Field | Content |
|---|---|
| `schema`, `softwareVersion`, `sessionId`, `createdAt`, `updatedAt` | identity and versions |
| `participant`, `condition`, `notes` | optional **pseudonymous** labels and free notes |
| `reference` | target grating `{orientation, frequency, phase, contrast}` |
| `layout` | optics and routing: `referenceSide`, `leftEye`/`rightEye` (AE/FE/unassigned), `linked`, `aperture`, `diameter`, `sigma`, `ppd`, `separation`, `vertical`, `fixation`, `visibility` (both/left/right/blank), `comparison` (simultaneous/sequential/toggle), `comparisonSide`, `sequenceMs`, `toggleShowing` |
| `work` | current reconstruction `{recon: {renderer, rendererVersion, params}, pins: [paths], origin}` |
| `undo`, `redo` | full prior/next `work` snapshots with labels and times (max 500) |
| `settings` | slider step (fine/coarse), proposal spacing, shrink settings, revealed control families, labels |
| `proposals` | every alternatives/combination/AI set: seed, settings, base, candidates, choice and times |
| `descriptions` | verbatim text, optional region (deg, y up), selected properties, context, the work at capture, renderer/software version, AI status |
| `accepted` | recorded reconstructions with status, reference, layout and versions |
| `outcome` | `matched`, `approximate`, `unmatchable`, `unstable`, `cannot-tell` or `not-visible`, with the work at that time |
| `actions` | append-only action log, including undo/redo, gallery responses, layout changes and dial sources |
| `provenance` | creator; for imports, the original schema, ids, times, `presetOrigin`, trials and history |

Downloaded JSON also contains `exportImages` (browser-rendered 512 px PNGs). These are a convenience copy; the
parameters are canonical, and the Python export renders PNGs from them.

**Import**: `distortion-lab/session/1` files (and bare `distortion-lab/1` states) from the original prototype import
into the `legacy-rectified` renderer. Reference, layout, visibility, labels and notes are carried over. The original
trials, history, ids and `presetOrigin` are preserved under `provenance.imported`.

## Development (Codex) requests

"Export development request" (Describe tab, researcher only) writes `distortion-lab/dev-request/1` JSON. It contains
the description, the current state and pins, the renderer and software versions, the renderer's parameter schema, and
256 px PNGs of the reconstruction and reference. It contains no participant label, condition or notes. Hand it to a
developer or a Codex session to design and test a new control. Nothing in the running app executes generated code.
