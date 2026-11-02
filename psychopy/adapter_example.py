"""EXAMPLE ONLY - not tested with PsychoPy or stereoscope hardware.

Displays a saved Distortion Lab session in a PsychoPy window using the same Python
renderer as the exports. PsychoPy was not available in the environment where this
was written, so treat this as a starting point to validate (geometry, gamma, timing,
monitor calibration) before any data collection.

    python psychopy/adapter_example.py path/to/session.json
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from distortion_lab.presentation import stimulus_plan  # noqa: E402


def main(path):
    import numpy as np
    from psychopy import core, event, visual

    with open(path, encoding="utf-8") as f:
        session = json.load(f)
    win = visual.Window(fullscr=True, units="pix", color=[0, 0, 0], colorSpace="rgb")  # 0 = mid grey in PsychoPy rgb
    W, H = win.size
    plan = stimulus_plan(session, W, H)
    n = plan["raster_size"]

    def to_img(gray):
        a = np.frombuffer(gray, dtype=np.uint8).reshape(n, n).astype(float)
        return np.flipud(a / 127.5 - 1.0)  # PsychoPy images are bottom-up, range -1..1

    imgs = {k: to_img(v) for k, v in plan["rasters"].items()}
    stims = []
    for p in plan["panels"]:
        if not p["visible"] or p["role"] is None:
            continue
        cx, cy = p["centre_px_from_top_left"]
        pos = (cx - W / 2.0, H / 2.0 - cy)
        role = p["role"]
        stims.append((role, pos, p["diameter_px"]))
    clock = core.Clock()
    while not event.getKeys(["escape"]):
        for role, pos, d in stims:
            if role == "alternating":
                role = "reference" if int(clock.getTime() * 1000 / plan["sequence_ms"]) % 2 == 0 else "reconstruction"
            visual.ImageStim(win, image=imgs[role], pos=pos, size=(d, d), units="pix").draw()
            if plan["fixation"]:
                visual.ShapeStim(win, vertices="cross", size=10, pos=pos, lineColor="black", fillColor="black").draw()
        win.flip()
    win.close()
    core.quit()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
