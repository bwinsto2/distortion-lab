"""Python mirror of web/js/core.js: schema, validation, deterministic renderers,
structured-operation validation and a dependency-free PNG encoder.

Compatible with Python 3.9+. Standard library only.  The renderers follow the same
arithmetic as the browser so that a saved session reproduces the same pixels
(see tests/test_parity.py for the measured agreement).
"""
from __future__ import annotations

import json
import math
import os
import struct
import zlib

from . import SESSION_SCHEMA, VERSION

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

with open(os.path.join(ROOT, "shared", "parameters.json"), encoding="utf-8") as _f:
    PARAMS = json.load(_f)
with open(os.path.join(ROOT, "shared", "legacy-presets.json"), encoding="utf-8") as _f:
    LEGACY_PRESETS = json.load(_f)

SEM = PARAMS["renderers"]["semantic-grating"]
LEG = PARAMS["renderers"]["legacy-rectified"]
SEM_DEFS = {d["key"]: d for d in SEM["params"]}
LEG_DEFS = {d["key"]: d for d in LEG["componentParams"]}
REF_DEFS = {d["key"]: d for d in PARAMS["reference"]}
OUTCOMES = ["matched", "approximate", "unmatchable", "unstable", "cannot-tell", "not-visible"]
MAX_UNDO = 500


class ValidationError(ValueError):
    pass


def _fail(msg):
    raise ValidationError(msg)


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _clamp(v, lo, hi):
    return min(hi, max(lo, v))


def js_round(v):
    """JavaScript Math.round semantics (round half up)."""
    return math.floor(v + 0.5)


def quantize(d, v):
    if d.get("type") != "number":
        return v
    x = _clamp(v, d["min"], d["max"])
    q = d["min"] + js_round((x - d["min"]) / d["step"]) * d["step"]
    q = float("%.6f" % _clamp(q, d["min"], d["max"]))
    if d.get("integer"):
        q = js_round(q)
    if q == int(q):
        q = int(q) if abs(q) < 2 ** 53 else q
    return q


def hash01(n, seed):
    """Mirror of core.js hash01 (32-bit integer mixing)."""
    m = 0xFFFFFFFF
    h = ((n * 374761393) + (seed * 668265263)) & m
    h = (h ^ (h >> 13)) & m
    h = (h * 1274126177) & m
    h = (h ^ (h >> 16)) & m
    return h / 4294967296.0


# --------------------------------------------------------------------------- renderers
def _legacy_signal(x, y, comps):
    s = 0.0
    for p in comps:
        if p["enabled"]:
            a = p["orientation"] * math.pi / 180
            g = math.cos(2 * math.pi * p["frequency"] * (-x * math.sin(a) + y * math.cos(a)) + p["phase"] * math.pi / 180)
            s += p["weight"] * _clamp(g + p["duty"], -p["threshold"], p["threshold"])
    return _clamp(s, -1.0, 1.0)


def _envelope(x, y, g):
    if x * x + y * y > g["diameter"] * g["diameter"] / 4:
        return 0.0
    if g.get("aperture") == "gaussian":
        return math.exp(-(x * x + y * y) / (2 * g["sigma"] * g["sigma"]))
    return 1.0


TAU = 2 * math.pi
DEG = math.pi / 180
STEP_NORM = math.tanh(12)


def _profile(g, sharp):
    if sharp <= 0:
        return g
    k = 20 * sharp
    return math.tanh(k * g) / math.tanh(k)


def _tri(t):
    return (2 / math.pi) * math.asin(_clamp(math.sin(TAU * t), -1.0, 1.0))


def _step(t):
    return math.tanh(12 * math.sin(TAU * t)) / STEP_NORM


def _semantic_prepare(p):
    q = dict(p)
    a = p["orientation"] * math.pi / 180
    b = (p["orientation"] + p["crossAngle"]) * DEG
    oa = p["offsetAngle"] * DEG
    ha = p["holeAngle"] * DEG
    q["usesSides"] = any(p.get(k) in ("upper", "lower") for k in ("bendSide", "zigSide", "fragSide", "crossSide"))
    q.update(sa=math.sin(a), ca=math.cos(a), phr=p["phase"] * math.pi / 180, sb=math.sin(b), cb=math.cos(b),
             soa=math.sin(oa), coa=math.cos(oa), sh=math.sin(ha), ch=math.cos(ha),
             br=[(math.cos(ha + i * 2 * math.pi / 3), math.sin(ha + i * 2 * math.pi / 3)) for i in range(3)])
    return q


def _hole_distance(x, y, q):
    dx = x - q["holeX"]
    dy = y - q["holeY"]
    if q["holeShape"] == "disc":
        return math.sqrt(dx * dx + dy * dy) - q["holeSize"]
    if q["holeShape"] == "band":
        return abs(-dx * q["sh"] + dy * q["ch"]) - q["holeSize"]
    best = float("inf")
    for c, s in q["br"]:
        along = dx * c + dy * s
        d = abs(-dx * s + dy * c) if along >= 0 else math.sqrt(dx * dx + dy * dy)
        best = min(best, d)
    return best - q["holeSize"]


def _side_weight(side, H):
    return H if side == "upper" else (1 - H if side == "lower" else 1)


def _semantic_signal(x, y, q):
    u = -x * q["sa"] + y * q["ca"]
    v = x * q["ca"] + y * q["sa"]
    d = 0.0
    H = 1.0
    if q["offsetAmount"] != 0 or q["usesSides"]:
        w = v * q["coa"] + u * q["soa"] - q["offsetPosition"]
        if q["offsetSoftness"] > 0:
            H = 0.5 * (1 + math.tanh(w / q["offsetSoftness"]))
        else:
            H = 1.0 if w >= 0 else 0.0
    if q["bendAmount"] != 0:
        d += _side_weight(q.get("bendSide"), H) * q["bendAmount"] * math.sin(TAU * v / q["bendSpacing"] + q["bendPhase"] * DEG)
    if q["zigAmount"] != 0:
        t = v / q["zigSpacing"] + q["zigPhase"] / 360
        d += _side_weight(q.get("zigSide"), H) * q["zigAmount"] * ((1 - q["zigShape"]) * _tri(t) + q["zigShape"] * _step(t))
    if q["offsetAmount"] != 0:
        d += q["offsetAmount"] * (H - 0.5)
    s = u + d
    P = _profile(math.cos(2 * math.pi * q["frequency"] * s + q["phr"]), q["sharpness"])
    if q["fragExtent"] > 0:
        n = math.floor(q["frequency"] * s + q["phase"] / 360)
        tt = v / q["fragLength"] + q["fragJitter"] * hash01(n, int(q["fragSeed"]))
        if tt - math.floor(tt) < q["fragExtent"]:
            wf = _side_weight(q.get("fragSide"), H)
            if wf == 1:
                P = q["gapFill"]
            elif wf > 0:
                P = P + wf * (q["gapFill"] - P)
    if q["crossStrength"] > 0:
        wc = _side_weight(q.get("crossSide"), H)
        if wc > 0:
            gc = math.cos(TAU * (-x * q["sb"] + y * q["cb"]) / q["crossSpacing"] + q["crossPhase"] * DEG)
            P = _clamp(P + wc * q["crossStrength"] * _profile(gc, q["sharpness"]), -1.0, 1.0)
    if q["holeSize"] > 0:
        dist = _hole_distance(x, y, q)
        if q["holeSoftness"] > 0:
            m = _clamp(0.5 - dist / q["holeSoftness"], 0.0, 1.0)
        else:
            m = 1.0 if dist <= 0 else 0.0
        if m > 0:
            P = P + m * (1 - q["holeResidual"]) * (q["gapFill"] - P)
    return P


def signal_for(recon):
    if recon["renderer"] == "legacy-rectified":
        comps = recon["params"]["components"]
        return recon["params"]["contrast"], (lambda x, y: _legacy_signal(x, y, comps))
    if recon["renderer"] == "semantic-grating":
        q = _semantic_prepare(recon["params"])
        return recon["params"]["contrast"], (lambda x, y: _semantic_signal(x, y, q))
    _fail("Unknown renderer %r" % recon.get("renderer"))


def render_gray(recon, n, geometry):
    """Return n*n bytes of 8-bit grey levels (row-major, top row first)."""
    contrast, f = signal_for(recon)
    out = bytearray(n * n)
    D = geometry["diameter"]
    k = 0
    for j in range(n):
        y = (0.5 - (j + 0.5) / n) * D
        for i in range(n):
            x = ((i + 0.5) / n - 0.5) * D
            e = _envelope(x, y, geometry)
            if e == 0:
                v = 128
            else:
                v = js_round(127.5 * (1 + contrast * e * f(x, y)))
                v = 0 if v < 0 else (255 if v > 255 else v)
            out[k] = v
            k += 1
    return bytes(out)


def reference_recon(reference):
    return {"renderer": "legacy-rectified", "rendererVersion": LEG["version"],
            "params": {"contrast": reference["contrast"], "components": [{
                "id": 1, "enabled": True, "orientation": reference["orientation"], "frequency": reference["frequency"],
                "phase": reference["phase"], "duty": 0, "threshold": 1, "weight": 1}]}}


def encode_png_gray(gray, width, height, text=None):
    """Minimal 8-bit greyscale PNG encoder (optional tEXt metadata)."""
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    raw = bytearray()
    for r in range(height):
        raw.append(0)
        raw.extend(gray[r * width:(r + 1) * width])
    out = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0))
    for k, v in (text or {}).items():
        out += chunk(b"tEXt", k.encode("latin-1") + b"\x00" + v.encode("latin-1", "replace"))
    out += chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
    return out


def render_png(recon, n, geometry, metadata=None):
    return encode_png_gray(render_gray(recon, n, geometry), n, n, metadata)


# --------------------------------------------------------------------------- validation
def _obj(o, where):
    if not isinstance(o, dict):
        _fail("%s must be an object" % where)
    return o


def _no_extra(o, allowed, where):
    for k in o:
        if k not in allowed:
            _fail("%s: unexpected field %s" % (where, k))


def _num(d, v, where):
    if not _is_num(v):
        _fail("%s: %s must be a finite number" % (where, d["label"]))
    if v < d["min"] or v > d["max"]:
        _fail("%s: %s out of range [%s, %s]" % (where, d["label"], d["min"], d["max"]))
    if d.get("integer") and int(v) != v:
        _fail("%s: %s must be an integer" % (where, d["label"]))
    return v


def validate_reference(r):
    _obj(r, "reference")
    _no_extra(r, REF_DEFS, "reference")
    return {k: _num(d, r.get(k), "reference") for k, d in REF_DEFS.items()}


def default_layout():
    L = PARAMS["layout"]
    out = dict(L["defaults"])
    out.update({k: v["default"] for k, v in L["numbers"].items()})
    out.update(L["booleans"])
    return out


def validate_layout(l, fill_defaults=False):
    _obj(l, "layout")
    L = PARAMS["layout"]
    allowed = list(L["choices"]) + list(L["numbers"]) + list(L["booleans"])
    _no_extra(l, allowed, "layout")
    d = default_layout()
    out = {}
    for k, ch in L["choices"].items():
        if k not in l and fill_defaults:
            out[k] = d[k]
        elif l.get(k) not in ch:
            _fail("layout: invalid %s" % k)
        else:
            out[k] = l[k]
    for k, n in L["numbers"].items():
        if k not in l and fill_defaults:
            out[k] = d[k]
        elif not _is_num(l.get(k)) or l[k] < n["min"] or l[k] > n["max"]:
            _fail("layout: %s out of range" % k)
        else:
            out[k] = l[k]
    for k in L["booleans"]:
        if k not in l and fill_defaults:
            out[k] = d[k]
        elif not isinstance(l.get(k), bool):
            _fail("layout: %s must be boolean" % k)
        else:
            out[k] = l[k]
    return out


def validate_recon(r):
    _obj(r, "reconstruction")
    _no_extra(r, ("renderer", "rendererVersion", "params"), "reconstruction")
    p = _obj(r.get("params"), "reconstruction.params")
    if r.get("renderer") == "semantic-grating":
        if r.get("rendererVersion") == "1.0.0":  # migrate: side-limited features added ('whole' is pixel-identical)
            up = dict(p)
            for k in ("bendSide", "zigSide", "fragSide", "crossSide"):
                up.setdefault(k, "whole")
            r, p = {"renderer": r["renderer"], "rendererVersion": SEM["version"], "params": up}, up
        if r.get("rendererVersion") != SEM["version"]:
            _fail("Unsupported semantic-grating version %r" % r.get("rendererVersion"))
        _no_extra(p, SEM_DEFS, "semantic params")
        out = {}
        for k, d in SEM_DEFS.items():
            if d["type"] == "enum":
                if p.get(k) not in d["choices"]:
                    _fail("semantic params: invalid %s" % k)
                out[k] = p[k]
            else:
                out[k] = _num(d, p.get(k), "semantic params")
        return {"renderer": r["renderer"], "rendererVersion": r["rendererVersion"], "params": out}
    if r.get("renderer") == "legacy-rectified":
        if r.get("rendererVersion") != LEG["version"]:
            _fail("Unsupported legacy-rectified version %r" % r.get("rendererVersion"))
        _no_extra(p, ("contrast", "components"), "legacy params")
        cs = p.get("components")
        if not isinstance(cs, list) or not 1 <= len(cs) <= LEG["maxComponents"]:
            _fail("Expected 1-%d components" % LEG["maxComponents"])
        ids = set()
        comps = []
        for c in cs:
            _obj(c, "component")
            _no_extra(c, ["id", "enabled"] + list(LEG_DEFS), "component")
            cid = c.get("id")
            if not (_is_num(cid) and int(cid) == cid and 1 <= cid < 1e9) or cid in ids:
                _fail("Invalid or duplicate component id")
            ids.add(cid)
            if not isinstance(c.get("enabled"), bool):
                _fail("Component enabled flag must be boolean")
            o = {"id": cid, "enabled": c["enabled"]}
            for k, d in LEG_DEFS.items():
                o[k] = _num(d, c.get(k), "component %s" % cid)
            comps.append(o)
        return {"renderer": r["renderer"], "rendererVersion": r["rendererVersion"],
                "params": {"contrast": _num(LEG["contrast"], p.get("contrast"), "legacy params"), "components": comps}}
    _fail("Unknown renderer %r" % r.get("renderer"))


def parse_path(recon, path):
    """Return (container, key, definition) for a parameter path."""
    if not isinstance(path, str):
        _fail("Parameter path must be a string")
    if recon["renderer"] == "semantic-grating":
        if path not in SEM_DEFS:
            _fail("Unknown parameter %s for semantic-grating" % path)
        return recon["params"], path, SEM_DEFS[path]
    if path == "contrast":
        return recon["params"], "contrast", LEG["contrast"]
    import re
    m = re.match(r"^c(\d+)\.(\w+)$", path)
    if not m:
        _fail("Unknown parameter %s for legacy-rectified" % path)
    cid = int(m.group(1))
    comp = next((c for c in recon["params"]["components"] if c["id"] == cid), None)
    if comp is None:
        _fail("Component %d does not exist" % cid)
    if m.group(2) == "enabled":
        return comp, "enabled", {"key": "enabled", "type": "boolean", "label": "Enabled"}
    if m.group(2) not in LEG_DEFS:
        _fail("Unknown component field %s" % m.group(2))
    return comp, m.group(2), LEG_DEFS[m.group(2)]


def validate_work(w):
    _obj(w, "work")
    _no_extra(w, ("recon", "pins", "origin"), "work")
    recon = validate_recon(w.get("recon"))
    pins = w.get("pins")
    if not isinstance(pins, list):
        _fail("pins must be an array")
    if len(set(map(str, pins))) != len(pins):
        _fail("Duplicate pin")
    for p in pins:
        parse_path(recon, p)
    out = {"recon": recon, "pins": list(pins)}
    if "origin" in w:
        out["origin"] = w["origin"]
    return out


def _str(v, mx, where):
    if not isinstance(v, str) or len(v) > mx:
        _fail("%s must be a string of at most %d characters" % (where, mx))
    return v


def validate_session(s):
    """Strict structural validation of a distortion-lab/session/2 document."""
    _obj(s, "session")
    if s.get("schema") != SESSION_SCHEMA:
        _fail("Unsupported session schema %r" % s.get("schema"))
    _str(s.get("sessionId"), 200, "sessionId")
    if not all(ch.isalnum() or ch in "-_." for ch in s["sessionId"]) or not s["sessionId"]:
        _fail("sessionId may contain only letters, digits, '-', '_' and '.'")
    for k in ("softwareVersion", "createdAt", "updatedAt"):
        _str(s.get(k), 40, k)
    _str(s.get("participant"), 120, "participant")
    _str(s.get("condition"), 120, "condition")
    _str(s.get("notes"), 20000, "notes")
    validate_reference(s.get("reference"))
    validate_layout(s.get("layout"))
    validate_work(s.get("work"))
    for k in ("undo", "redo", "proposals", "descriptions", "accepted", "actions"):
        if not isinstance(s.get(k), list):
            _fail("%s must be an array" % k)
    if len(s["undo"]) > MAX_UNDO or len(s["redo"]) > MAX_UNDO:
        _fail("Undo/redo history too long")
    for e in s["undo"] + s["redo"]:
        _obj(e, "history entry")
        validate_work(e.get("work"))
    for d in s["descriptions"]:
        _obj(d, "description")
        _str(d.get("text"), 20000, "description text")
    if s.get("outcome") is not None:
        _obj(s["outcome"], "outcome")
        if s["outcome"].get("status") not in OUTCOMES:
            _fail("Invalid outcome status")
    _obj(s.get("settings"), "settings")
    if "nulls" in s and not isinstance(s["nulls"], list):
        _fail("nulls must be an array")
    if s.get("task") is not None:
        _obj(s["task"], "task")
        if s["task"].get("kind") != "null":
            _fail("Unknown task")
        validate_work(s["task"].get("matchWork"))
    return s


def apply_operations(work, ops):
    """Validate bounded structured operations (mirror of core.js applyOperations)."""
    import copy
    if not isinstance(ops, list):
        _fail("operations must be an array")
    if len(ops) > 6:
        _fail("At most 6 operations per candidate")
    recon = copy.deepcopy(work["recon"])
    applied, rejected = [], []
    for op in ops:
        try:
            _obj(op, "operation")
            _no_extra(op, ("path", "op", "value"), "operation")
            if op.get("op") not in ("set", "delta"):
                _fail("op must be set or delta")
            obj, key, d = parse_path(recon, op.get("path"))
            if op["path"] in work["pins"]:
                _fail("%s is pinned" % op["path"])
            if d["type"] == "boolean":
                _fail("%s is not an adjustable control" % op["path"])
            if d["type"] == "enum":
                if op["op"] != "set" or op.get("value") not in d["choices"]:
                    _fail("invalid value for %s" % op["path"])
                v = op["value"]
            else:
                if not _is_num(op.get("value")):
                    _fail("value must be a finite number")
                raw = op["value"] if op["op"] == "set" else obj[key] + op["value"]
                if raw < d["min"] or raw > d["max"]:
                    _fail("%s would leave its range [%s, %s]" % (op["path"], d["min"], d["max"]))
                v = quantize(d, raw)
            applied.append({"path": op["path"], "from": obj[key], "to": v})
            obj[key] = v
        except ValidationError as e:
            rejected.append({"op": op, "reason": str(e)})
    return {"recon": recon, "applied": applied, "rejected": rejected}


def param_summary(renderer):
    """Compact description of adjustable controls (used in AI prompts)."""
    if renderer == "semantic-grating":
        return [{k: d[k] for k in ("key", "family", "label", "type", "min", "max", "choices", "unit") if k in d}
                for d in SEM["params"]]
    return {"contrast": LEG["contrast"], "componentParams": LEG["componentParams"],
            "pathFormat": "contrast or c<ID>.<field>"}


__all__ = ["VERSION", "SESSION_SCHEMA", "ValidationError", "validate_session", "validate_work", "validate_recon",
           "validate_reference", "validate_layout", "render_gray", "render_png", "encode_png_gray",
           "reference_recon", "apply_operations", "hash01", "quantize", "LEGACY_PRESETS", "PARAMS"]
