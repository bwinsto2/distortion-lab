#!/usr/bin/env python3
"""Stand-in for the `claude` CLI used by tests (no network). Fails loudly if it would bill an API key."""
import json
import os
import sys

args = sys.argv[1:]
prompt = sys.stdin.read()
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
if problems:
    print(json.dumps({"type": "result", "is_error": True, "result": "; ".join(problems)}))
    sys.exit(1)
if "Reply with exactly: OK" in prompt:
    print(json.dumps({"type": "result", "is_error": False, "result": "OK", "modelUsage": {"fake-model": {}}}))
    sys.exit(0)
assert "--json-schema" in args
out = {"candidates": [
    {"label": "fake: more bend", "rationale": "test", "operations": [{"path": "bendAmount", "op": "set", "value": 0.2}]},
    {"label": "fake: pinned", "rationale": "test", "operations": [{"path": "holeSize", "op": "set", "value": 0.1}]},
]}
print(json.dumps({"type": "result", "is_error": False, "result": json.dumps(out), "structured_output": out, "modelUsage": {"fake-model": {}}}))
