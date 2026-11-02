# Optional AI bridge

Distortion Lab works fully without AI or a network connection. Matching, rendering, comparisons, saving and
description capture all work offline. The AI bridge is **off by default**.

## What it does

When the participant has described a remaining difference, the experimenter presses **Ask AI for suggestions**.

1. The description is saved first, verbatim, whether or not the AI call succeeds.
2. **Propose.** The backend sends the AI the description, the current parameters and pins, the earlier descriptions in
   this session, and plain-language notes on what the numbers mean visually. For example: "a quarter stripe period is
   0.078°; half a period swaps black and white". When the provider can see images (Claude), the message also includes
   the **reference** and **current** pictures. The AI returns up to 6 candidates as bounded operations
   `{path, op: "set" | "delta", value}`. It must also state in `limitations` anything in the request the controls
   cannot produce.
3. **Validate.** Every operation is checked (`model.apply_operations`). Unknown paths, pinned paths, non-finite values
   and out-of-range values are rejected.
4. **Look and pick** (image-capable providers). The browser also sends up to 8 seeded alternatives. The backend renders
   every valid candidate, shows the AI the reference, the current picture and all candidates, and asks it to rank the 4
   that best show the described change and nothing else, with a one-sentence reason each. It excludes ones that look
   unchanged or change the wrong thing.
5. The chosen candidates appear in **Compare** with the AI's reasons, its stated limitations and its notes. **Nothing
   changes until someone chooses one.** Each set is recorded in `proposals` with `source: "ai"`, the provider and model,
   the limitations and notes, how many candidates were considered, and the seed of the seeded pool.

Only task context is sent: renderer, parameters, pins, reference grating, geometry, the description (text, region,
ticked properties) and up to 5 earlier description texts. Participant label, condition and notes are never sent, and
the backend refuses context containing other fields (tested). No generated code is executed, and the renderer stays
deterministic.

## Recommended: Claude through your Claude plan (no API key, no extra billing)

This uses **Claude Code**, Anthropic's command-line tool, signed in with your Claude Pro or Max account. Requests count
against your plan's included usage, like using Claude in the app. When you reach the plan's usage limit, suggestions
stop until it resets. Nothing is billed unless you have turned on paid extra usage in your Claude account settings.

**One-time setup on the lab Mac**

1. Install Claude Code: see https://docs.anthropic.com/en/docs/claude-code (the native installer needs no other tools).
2. In Terminal, run `claude` once and sign in with **your Claude account** (the subscription option, not an API/Console key). Then type `/exit`.

**Use**: double-click **`Distortion Lab (with Claude).command`**, or run `DISTORTION_LAB_AI=claude-code python3 run.py`.
In the Experimenter tab, press **Check AI connection**. The pill should read **"AI connected (Claude, your plan)"**.

What the backend does on each request (`distortion_lab/ai_bridge.py`):

- It runs `claude -p` non-interactively, in an empty temporary folder.
- **All tools are disabled** (`--tools ""`), and MCP servers, settings files and session saving are turned off. Claude
  can only read the prompt and answer.
- The answer must match the operations JSON schema (`--json-schema`), and the app then validates it as described above.
- `ANTHROPIC_API_KEY` and similar variables are **removed** from Claude Code's environment, so it uses your plan
  sign-in rather than an API key, even if one happens to be set on the computer.
- It times out after 3 minutes. Typical replies take 10–40 s.
- Optional settings: `DISTORTION_LAB_CLAUDE_MODEL` (e.g. `sonnet`) chooses the model. `DISTORTION_LAB_CLAUDE_BIN` sets
  the path to `claude` if it isn't found automatically.

Tested on 2026-11-02 with Claude Code 2.1.316. Live test of the two-step flow: the description "below the break the
lines are zig zagged, but above the break they are straight" took 26 s. Claude considered 14 rendered candidates and
returned four. All four limited the zigzag to the lower side of the break, at different strengths, and the excluded
ones were explained. A request makes two Claude calls, so it uses roughly twice the plan usage of a single chat message
with images. An offline stand-in (`tests/fake_claude.py`) checks the flags, the empty
folder and the removal of API-key variables in the automated tests.

Privacy: descriptions go to Anthropic under your personal account's terms. Check your Claude privacy settings (for
example, whether chats may be used for model training) and your ethics approval before using it with participants.

The same approach would work with **Codex** signed in with ChatGPT Plus (`codex exec`). It isn't implemented yet; ask
if you want it.

## Enabling OpenAI API (opt-in, billed separately)

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
