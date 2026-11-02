"""Optional AI bridge.

The bridge is OFF unless explicitly enabled with environment variables:

    DISTORTION_LAB_AI=openai          enable the OpenAI provider (opt-in)
    OPENAI_API_KEY=...                credential, read only by this backend process
    DISTORTION_LAB_OPENAI_MODEL=...   model name (default below; check your account)
    DISTORTION_LAB_OPENAI_BASE=...    API base URL (default https://api.openai.com/v1)

    DISTORTION_LAB_AI=mock            deterministic TEST provider used by the automated
                                      tests. It is labelled "test mock (not AI)" everywhere.

The provider may only return bounded structured operations over existing tested
controls. Every operation is validated by model.apply_operations (pins enforced,
ranges enforced, no code execution); the participant must still choose a candidate.
Only task context is sent: renderer, parameters, pins, focus and the description text.
No participant label, condition, notes or session history is sent.
"""
from __future__ import annotations

import json
import os
import ssl
import urllib.error
import urllib.request

from .model import param_summary, ValidationError

DEFAULT_OPENAI_MODEL = "gpt-4.1-mini"

RESPONSE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["candidates"],
    "properties": {
        "candidates": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["label", "rationale", "operations"],
                "properties": {
                    "label": {"type": "string"},
                    "rationale": {"type": "string"},
                    "operations": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["path", "op", "value"],
                            "properties": {
                                "path": {"type": "string"},
                                "op": {"type": "string", "enum": ["set", "delta"]},
                                "value": {"anyOf": [{"type": "number"}, {"type": "string"}]},
                            },
                        },
                    },
                },
            },
        }
    },
}

ALLOWED_CONTEXT_KEYS = {"softwareVersion", "renderer", "rendererVersion", "reference", "params", "pins", "focus", "description"}


def sanitize_context(ctx):
    """Keep only task context; reject anything that looks like participant identity."""
    if not isinstance(ctx, dict):
        raise ValidationError("context must be an object")
    extra = set(ctx) - ALLOWED_CONTEXT_KEYS
    if extra:
        raise ValidationError("context contains fields that are not sent to AI providers: %s" % ", ".join(sorted(extra)))
    d = ctx.get("description") or {}
    if not isinstance(d, dict) or not isinstance(d.get("text", ""), str) or len(d.get("text", "")) > 4000:
        raise ValidationError("description.text must be a string of at most 4000 characters")
    return {k: ctx[k] for k in ALLOWED_CONTEXT_KEYS if k in ctx}


def build_messages(ctx, count):
    system = (
        "You help a vision researcher match a participant's verbal description of a perceived grating distortion. "
        "You may ONLY propose bounded parameter operations over the listed controls of the current renderer. "
        "Never change pinned paths. Never invent paths. Values must lie within the listed min/max. "
        "Use op 'set' for absolute values or 'delta' for changes. Use at most 4 operations per candidate. "
        "Return %d distinct candidates, each a plausible small step toward the description. "
        "Label each candidate neutrally (e.g. 'more bending, wider spacing'). Do not diagnose." % count)
    user = {
        "controls": param_summary(ctx["renderer"]),
        "renderer": ctx["renderer"],
        "current": ctx["params"],
        "pinned_paths_do_not_change": ctx.get("pins", []),
        "focus": ctx.get("focus", "auto"),
        "reference_grating": ctx.get("reference"),
        "participant_description_verbatim": (ctx.get("description") or {}).get("text", ""),
        "marked_region_deg": (ctx.get("description") or {}).get("region"),
        "properties_selected": (ctx.get("description") or {}).get("properties", []),
        "coordinates": "nominal degrees, origin at aperture centre, y positive upward",
    }
    return [{"role": "system", "content": system}, {"role": "user", "content": json.dumps(user)}]


class Bridge:
    def __init__(self, env=None):
        env = os.environ if env is None else env
        self.provider = (env.get("DISTORTION_LAB_AI") or "none").strip().lower()
        self.key = env.get("OPENAI_API_KEY") or ""
        self.model = env.get("DISTORTION_LAB_OPENAI_MODEL") or DEFAULT_OPENAI_MODEL
        self.base = (env.get("DISTORTION_LAB_OPENAI_BASE") or "https://api.openai.com/v1").rstrip("/")
        self.verified = None  # None = not checked, True/False after check()
        self.last_error = None

    def status(self):
        if self.provider == "mock":
            return {"provider": "mock", "connected": True, "isAI": False, "label": "Test mock (not AI)",
                    "detail": "Deterministic test provider. It is not an AI model and must not be used for data collection."}
        if self.provider == "openai":
            if not self.key:
                return {"provider": "openai", "connected": False, "isAI": True, "label": "AI not connected",
                        "detail": "DISTORTION_LAB_AI=openai is set but OPENAI_API_KEY is missing in the backend environment."}
            if self.verified is True:
                return {"provider": "openai", "connected": True, "isAI": True, "label": "AI connected (OpenAI %s)" % self.model,
                        "detail": "Connection verified by the backend."}
            if self.verified is False:
                return {"provider": "openai", "connected": False, "isAI": True, "label": "AI connection failed",
                        "detail": self.last_error or "Check failed."}
            return {"provider": "openai", "connected": None, "isAI": True, "label": "AI configured (not yet verified)",
                    "detail": "Credentials are configured; press Check connection to verify."}
        return {"provider": "none", "connected": False, "isAI": False, "label": "AI off",
                "detail": "Optional. Set DISTORTION_LAB_AI=openai and OPENAI_API_KEY before starting the backend to enable."}

    # -------------------------------------------------------------- transport
    def _request(self, method, path, body=None, timeout=60):
        req = urllib.request.Request(self.base + path, method=method,
                                     data=None if body is None else json.dumps(body).encode("utf-8"),
                                     headers={"Authorization": "Bearer " + self.key, "Content-Type": "application/json"})
        ctx = ssl.create_default_context()
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            return json.loads(r.read().decode("utf-8"))

    def check(self):
        if self.provider == "mock":
            return self.status()
        if self.provider != "openai" or not self.key:
            return self.status()
        try:
            self._request("GET", "/models/" + self.model, timeout=20)
            self.verified, self.last_error = True, None
        except urllib.error.HTTPError as e:
            self.verified, self.last_error = False, "HTTP %s from provider" % e.code
        except Exception as e:  # network errors, DNS, TLS
            self.verified, self.last_error = False, "%s: %s" % (type(e).__name__, e)
        return self.status()

    def propose(self, ctx, count=4):
        ctx = sanitize_context(ctx)
        count = max(1, min(6, int(count)))
        if self.provider == "mock":
            return self._mock(ctx, count)
        if self.provider != "openai" or not self.key:
            raise RuntimeError("AI bridge is not connected")
        body = {"model": self.model, "messages": build_messages(ctx, count), "temperature": 0.4,
                "response_format": {"type": "json_schema", "json_schema": {"name": "operations", "strict": True, "schema": RESPONSE_SCHEMA}}}
        try:
            resp = self._request("POST", "/chat/completions", body)
            self.verified = True
        except urllib.error.HTTPError as e:
            self.verified, self.last_error = False, "HTTP %s from provider" % e.code
            raise RuntimeError(self.last_error)
        text = resp["choices"][0]["message"]["content"]
        out = json.loads(text)
        if not isinstance(out, dict) or not isinstance(out.get("candidates"), list):
            raise RuntimeError("Provider returned an unexpected structure")
        return {"provider": "openai", "model": self.model, "candidates": out["candidates"][:count]}

    @staticmethod
    def _mock(ctx, count):
        """Deterministic stand-in used only by tests. Not AI."""
        text = ctx["description"].get("text", "").lower()
        if ctx["renderer"] != "semantic-grating":
            ops = [[{"path": "contrast", "op": "delta", "value": -0.1}]]
        else:
            ops = []
            if "wav" in text or "bend" in text:
                ops.append([{"path": "bendAmount", "op": "set", "value": 0.1}])
                ops.append([{"path": "bendAmount", "op": "set", "value": 0.2}, {"path": "bendSpacing", "op": "set", "value": 0.8}])
            if "hole" in text or "missing" in text:
                ops.append([{"path": "holeSize", "op": "set", "value": 0.6}])
            ops.append([{"path": "orientation", "op": "delta", "value": 5}])
            ops.append([{"path": "bendAmount", "op": "set", "value": 9}])  # deliberately out of range: must be rejected
        return {"provider": "mock", "model": "mock", "candidates": [
            {"label": "mock candidate %d" % (i + 1), "rationale": "deterministic test rule", "operations": o}
            for i, o in enumerate(ops[:count])]}
