# Optional AI bridge

Distortion Lab works fully without AI or a network connection. Matching, rendering, comparisons, saving and
description capture all work offline. The AI bridge is **off by default**.

## What it does

When the participant has described a remaining difference, the experimenter can press **Ask AI for suggestions**.

1. The description is saved first, verbatim, whether or not the AI call succeeds.
2. The browser sends `/api/ai/propose` the current reconstruction, pins, focus and **only** this task context:
   renderer, parameters, pins, reference grating, description text, marked region and selected properties.
   Participant label, condition, notes and session history are never sent. The backend refuses any context containing
   other fields (tested).
3. The provider may only return **structured operations**: `{path, op: "set" | "delta", value}`, at most 6 per
   candidate, over the current renderer's existing controls.
4. The backend validates every operation (`model.apply_operations`). Unknown paths, pinned paths, non-finite values and
   out-of-range values are rejected. The browser re-validates with `DLCore.applyOperations`.
5. Valid candidates appear in **Compare** with their source labelled. **Nothing changes until someone chooses one.**
   Each set is recorded in `proposals` with `source: "ai"`, the provider and model, and any rejected operations.

No generated code is executed, the live experiment is not altered, and the renderer stays deterministic.

## Enabling OpenAI (opt-in)

Set these in the environment of the **backend** process. The key is never placed in browser JavaScript.

```bash
export DISTORTION_LAB_AI=openai
export OPENAI_API_KEY=...                      # your own key, managed by you
export DISTORTION_LAB_OPENAI_MODEL=gpt-4.1-mini   # optional; must support JSON-schema structured output
python3 run.py
```

The status pill then reads **"AI configured (not yet verified)"**. **Check AI connection** (Experimenter tab) calls
the provider's model endpoint and changes the pill to "AI connected (OpenAI …)" or "AI connection failed" with the
reason. The bridge uses `POST {DISTORTION_LAB_OPENAI_BASE}/chat/completions` with
`response_format: json_schema` (strict). Set `DISTORTION_LAB_OPENAI_BASE` for a compatible endpoint.

**Not tested live.** The build environment had no credentials, so the OpenAI path has not been exercised against the
real service. Its request and validation logic is shared with the tested mock path. Verify it with **Check AI
connection** and a synthetic description before relying on it.

Descriptions are research data. Sending one to a provider is an explicit, per-request action. Check that it is
consistent with your ethics approval and consent forms.

## Test mock

`DISTORTION_LAB_AI=mock` enables a deterministic rule-based stand-in used by the automated tests. It is labelled
**"Test mock (not AI)"** in the status pill, in the Compare tab and in recorded sets (`isAI: false`). Do not use it
for data collection.

## Codex / other agents

The same bridge interface (`Bridge.status/check/propose` in `distortion_lab/ai_bridge.py`) can host another provider,
such as a Codex SDK or app-server adapter, as long as it returns the same structured operations. No such adapter is
included, and none is claimed to be connected. For development work on missing controls, use **Export development
request** (see [API.md](API.md)). It packages the unsupported description, state, pins, versions and images into a
self-contained JSON file for a developer or a Codex task.
