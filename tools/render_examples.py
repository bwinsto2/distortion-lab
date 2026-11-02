#!/usr/bin/env python3
"""Render example PNGs with the Python reference renderer (examples/images/).
Optionally builds a labelled contact sheet if Pillow is installed."""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from distortion_lab import model as M  # noqa: E402

OUT = os.path.join(ROOT, "examples", "images")
GEOM = {"diameter": 3.2, "sigma": 0.53, "aperture": "circle"}
PICK = ["reference", "misorientation:strong", "bend:strong", "zigzag:strong", "stepped:strong", "offset:strong",
        "fragment:strong", "cross:strong", "hole:strong", "band:strong", "branch:strong",
        "combo:bend:mild+hole:mild", "combo:cross:mild+fragment:mild"]


def main(size=256):
    os.makedirs(OUT, exist_ok=True)
    gal = json.load(open(os.path.join(ROOT, "examples", "semantic-gallery.json"), encoding="utf-8"))
    items = {i["id"]: i for i in gal["items"]}
    made = []
    for k in PICK:
        it = items[k]
        name = "semantic-" + k.replace(":", "-").replace("+", "_") + ".png"
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(M.render_png(it["recon"], size, GEOM, {"Software": "Distortion Lab " + M.VERSION, "Item": k}))
        made.append((name, it["label"]))
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        print("Pillow not installed; skipped contact sheet")
        return
    cols, cell = 5, 220
    rows = (len(made) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell, rows * (cell + 34) + 40), (242, 244, 247))
    d = ImageDraw.Draw(sheet)
    d.text((10, 10), "Semantic generator examples (deterministic illustrative appearances; not validated percepts)", fill=(30, 40, 50))
    for i, (name, label) in enumerate(made):
        im = Image.open(os.path.join(OUT, name)).resize((cell - 20, cell - 20))
        x, y = (i % cols) * cell + 10, (i // cols) * (cell + 34) + 40
        sheet.paste(im, (x, y))
        d.text((x, y + cell - 16), label[:40], fill=(30, 40, 50))
    sheet.save(os.path.join(ROOT, "examples", "semantic-contact-sheet.png"))
    print("wrote", len(made), "images and examples/semantic-contact-sheet.png")


if __name__ == "__main__":
    main()
