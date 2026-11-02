#!/usr/bin/env python3
"""Stand-in for the `claude` CLI used by tests (no network). Fails loudly if it would bill an API key,
if tools are enabled, or if it is not run in an empty folder. Speaks --input/--output-format stream-json."""
import json
import os
import re
import sys

args = sys.argv[1:]
raw = sys.stdin.read()
problems = []
for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK"):
    if k in os.environ:
        problems.append("billing variable %s was passed" % k)
for flag in ("-p", "--no-session-persistence", "--strict-mcp-config"):
    if flag not in args:
        problems.append("missing " + flag)
if "--tools" not in args or args[args.index("--tools") + 1] != "":
    problems.append("tools not disabled")
if os.listdir("."):
    problems.append("working directory not empty")
msg = json.loads(raw.strip().splitlines()[0])
content = msg["message"]["content"]
text = "\n".join(c["text"] for c in content if c["type"] == "text")
n_images = sum(1 for c in content if c["type"] == "image")


def emit(result_obj=None, text_result=None, error=None):
    ev = {"type": "result", "is_error": bool(error), "result": error or text_result or json.dumps(result_obj),
          "modelUsage": {"fake-model": {}}}
    if result_obj is not None:
        ev["structured_output"] = result_obj
    print(json.dumps({"type": "system", "subtype": "init"}))
    print(json.dumps(ev))


if problems:
    emit(error="; ".join(problems))
    sys.exit(1)
if "Reply with exactly: OK" in text:
    emit(text_result="OK")
elif "You are checking candidate pictures" in text:
    ids = re.findall(r"Image (C\d+):", text)
    assert n_images >= len(ids) + 1, "candidate images missing"
    # prefer the last candidate first, to show the ranking (not proposal order) decides what is shown
    emit({"ranking": [{"id": i, "reason": "fake judge saw %d images" % n_images} for i in reversed(ids)][:4],
          "notes": "fake notes"})
else:
    assert n_images == 2 and "Image CURRENT:" in text, "reference/current images missing"
    emit({"limitations": "fake: cannot do X", "candidates": [
        {"label": "fake: more bend", "rationale": "test", "operations": [{"path": "bendAmount", "op": "set", "value": 0.2}]},
        {"label": "fake: pinned", "rationale": "test", "operations": [{"path": "holeSize", "op": "set", "value": 0.1}]},
    ]})
