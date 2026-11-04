# Tests and results

## How to run

```bash
sh tools/run_tests.sh
```

This needs Python 3.9+. Node.js is optional and adds the core tests and the Python↔browser parity test.
Playwright with Chromium is also optional and adds the end-to-end browser test.

Individual suites:

```bash
python3 -m unittest discover -s tests -v
```

```bash
node --test tests/core.test.js
```

```bash
node tests/e2e.js
```

To save screenshots from the end-to-end test:

```bash
SCREENSHOTS=docs/screenshots node tests/e2e.js
```

There is also an **in-app check**: Experimenter → *Run built-in checks* runs 7 quick checks in the browser.

## Results of this build (2026-11-02)

Environment: Linux, Python 3.13.18 and Python 3.9.25 (backend suite run under both), Node 22, Chromium via Playwright.

| Suite | Result |
|---|---|
| `tools/build_data.py --check` (generated browser data matches `shared/`) | up to date |
| Python `unittest` (backend, model, AI bridge incl. Claude Code provider via a stand-in CLI, startup/port handling, renderer and layout migration, presentation boundary, parity): 26 tests | **OK** under 3.13 and 3.9 |
| Node core tests: 31 tests (incl. nulling, layout migration), plus MIDI controller decoding/learning: 5 tests | **36 pass, 0 fail** |
| Browser end-to-end (Playwright/Chromium against the real backend): 22 steps | **22/22 pass** |

### What is covered

| Requirement | Where checked |
|---|---|
| Undo/redo restores exact states (manual edits, gallery, pins, proposals, combinations, legacy add/mix) | core `undo/redo restore exact states…`; e2e keyboard and drag steps; undo after reload |
| Slider drags coalesce into one undo step | core `slider drags coalesce…`; e2e mouse drag |
| Pins are never changed by proposals, gallery, combinations, AI operations or dials; impossible cases are refused with an explanation and no state change | core randomised pin test (25 trials × 6 foci × 2 scales); e2e pinned slider, refused legacy switch, dial on pinned field; backend mock-AI test |
| Coarse/fine spacing and repeated smaller neighbourhoods | core `coarse vs fine…` (measured mean step ≈1×, ≈0.25×, ≈0.36× at round 2); e2e repeat round |
| Deterministic seeded alternatives, reproducible from recorded settings | core `seeded proposals are deterministic…` |
| Keep current changes nothing; choosing updates the reconstruction and sliders; preview shows a candidate large without changing anything; undo allows a different choice | core and e2e |
| Combined features (two families; overlap explained) | core `combining two feature families…`; e2e more-than-one |
| Controls do what they advertise (bend, zigzag/step, offset, gap size/position/residual/shape, breaks, crossing, global) | core equation-level checks against docs/MODEL.md |
| Semantic "unchanged reference" equals the reference grating pixel for pixel | core and in-app check |
| All ten original presets render/import; the original PNGs are reproduced exactly | Python parity (all 10 at 512 px, 0 differing pixels); core import of all 10 session files; e2e import via file chooser |
| JS and Python renderers agree | parity: 60 cases (35 gallery tiles + 25 random settings covering every control), 311,040 pixels, **0 differ** |
| Autosave and reload/resume | e2e (browser storage + server file + SQLite present, exact state and undo history restored) |
| Backend persistence, revisions, restart, export bundle PNGs equal the renderer | backend tests |
| Malformed input rejected (JSON, schema, ranges, types, unknown pins, ids, path traversal, host/origin, control messages) | backend `test_malformed_input_rejected` and others; core `malformed input is rejected` |
| Description capture is verbatim, with AI disconnected and offline | core; e2e (server without AI, and file:// browser-only mode) |
| AI context excludes participant identity; AI operations are validated; the mock is labelled not-AI | core `AI context excludes…`; backend `TestMockAI`, `TestBridgeUnit`; e2e AI step |
| Stimulus window mirrors the console; optics kept across form changes | e2e |
| Fusion box, nonius fixation and alignment keys (move, vertical, contrast 4/6, L/R + 7/9 rotation, 0 reset, Enter), keys from the stimulus window, logged result, side-by-side positions | e2e alignment step; screenshots 13-14. Visual check against FixBorders() geometry |
| Nulling: reverse construction (bend displacement exactly negated; plaid = 2S − P before clipping; breaks/gaps reported), records, other-eye check, repeats, monocular fellow-eye nulling, stimulus roles, restore | core nulling tests; e2e nulling step |
| Participant controls: eye switching, in-stereoscope menu, knob/press/mode/new alternatives/undo by keyboard (console and stimulus window), by mouse (wheel, left/right/middle click, hold) and by simulated MIDI messages including the setup steps | e2e; `tests/controller.test.js` for MIDI encodings. No physical controller was available, so real hardware is untested |
| Browser-only fallback states what is unavailable | e2e |

### Visual inspection

Representative outputs were inspected as rendered images. These include `examples/semantic-contact-sheet.png`
(reference, tilted, wavy, zigzag, stepped, offset, broken, crossing, round gap, missing band, branching gap and two
combinations) and the console screenshots in `docs/screenshots/`. Inspection led to two changes to the gallery
templates: the "stepped" and "offset" amplitudes were reduced. Near half a stripe cycle they had looked like a phase
inversion rather than a step or shift.

### What the tests do not show

Software tests check behaviour and image/parameter consistency. They do **not** establish perceptual validity,
uniqueness of a match, faithful replication of published drawings, display gamma or timing accuracy. The Claude Code
provider was also run live: a connection check, and the two-step suggestion flow on a "zigzag only below the break"
description (26 s; 14 candidates considered; all 4 returned did what was asked).
The OpenAI provider was not called live (no credentials). The PsychoPy example was only syntax-checked. Its data boundary
(`distortion_lab/presentation.py`) is unit-tested. The UI was exercised in Chromium only; Safari and Firefox were not
tested.
