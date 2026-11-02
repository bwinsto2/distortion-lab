#!/usr/bin/env python3
"""Build a single-file, browser-only preview (dist/preview/distortion-lab-preview.html).

Inlines the CSS and scripts of web/index.html. Useful for a quick look on any device;
backend features (server autosave, export bundles, AI bridge, dials) and the separate
stimulus window are not available in it.
"""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web")
NOTE = ("<strong>Preview build (browser only).</strong> This single-file preview shows the matching console with all "
        "rendering, gallery, sliders, pins, comparisons, undo/redo and description capture. Not available here: the Python "
        "backend (server autosave, SQLite, export bundles), the AI bridge, external dials, the separate stimulus window, and "
        "file downloads. For laboratory use, run the full app with <code>python3 run.py</code>.")


def read(*p):
    with open(os.path.join(WEB, *p), encoding="utf-8") as f:
        return f.read()


def main():
    html = read("index.html")
    html = re.sub(r"<!doctype html>\s*<html[^>]*>\s*<head>.*?</head>\s*<body>", "", html, flags=re.S | re.I)
    html = re.sub(r"</body>\s*</html>\s*$", "", html, flags=re.I)
    css = read("css", "app.css")
    head = ('<title>Distortion Lab</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n'
            "<style>\n" + css + "\n</style>\n"
            "<script>window.DL_PREVIEW_NOTE = " + repr(NOTE).replace("'", '"') + ";\n"
            "window.confirm = function () { return true; };</script>\n")

    def inline(m):
        src = read(*m.group(1).split("/"))
        assert "</script" not in src.lower(), m.group(1)
        return "<script>\n" + src + "\n</script>"
    html = re.sub(r'<script src="([^"]+)"></script>', inline, html)
    out_dir = os.path.join(ROOT, "dist", "preview")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, "distortion-lab-preview.html")
    with open(out, "w", encoding="utf-8") as f:
        f.write(head + html)
    print("wrote", os.path.relpath(out, ROOT), os.path.getsize(out), "bytes")


if __name__ == "__main__":
    main()
