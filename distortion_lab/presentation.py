"""Renderer/state boundary for external presentation software (e.g. PsychoPy).

`stimulus_plan(session, window_w, window_h)` turns a saved session into plain data:
which stimulus goes where (CSS/window pixels), its size, and its grey-level raster from
the same Python reference renderer used for exports. It has no PsychoPy dependency, so
it is unit-tested here; psychopy/adapter_example.py shows one way to display it.

Not validated for timing, gamma or hardware presentation.
"""
from __future__ import annotations

import math

from .model import validate_session, render_gray, reference_recon


def stimulus_plan(session, window_w, window_h, raster_scale=1.0):
    s = validate_session(session)
    L = s["layout"]
    d = L["diameter"] * L["ppd"]                      # nominal pixels
    n = max(8, min(2048, int(math.ceil(d * raster_scale))))
    geom = {"diameter": L["diameter"], "sigma": L["sigma"], "aperture": L["aperture"]}
    centres = {"left": (window_w * (0.5 - L["separation"] / 200.0), window_h / 2.0),
               "right": (window_w * (0.5 + L["separation"] / 200.0), window_h / 2.0 + L["vertical"])}
    roles = {}
    if L["comparison"] == "simultaneous":
        roles[L["referenceSide"]] = "reference"
        roles["right" if L["referenceSide"] == "left" else "left"] = "reconstruction"
    else:
        roles[L["comparisonSide"]] = "alternating" if L["comparison"] == "sequential" else L["toggleShowing"]
    rasters = {"reference": render_gray(reference_recon(s["reference"]), n, geom),
               "reconstruction": render_gray(s["work"]["recon"], n, geom)}
    panels = []
    for side in ("left", "right"):
        role = roles.get(side)
        visible = role is not None and L["visibility"] in ("both", side)
        cx, cy = centres[side]
        panels.append({"side": side, "role": role, "visible": visible, "eye": L[side + "Eye"],
                       "centre_px_from_top_left": (cx, cy), "diameter_px": d})
    return {"raster_size": n, "rasters": rasters, "panels": panels, "fixation": L["fixation"],
            "sequence_ms": L["sequenceMs"], "comparison": L["comparison"],
            "note": "Nominal geometry; eye isolation is provided by the stereoscope, not by screen position."}
