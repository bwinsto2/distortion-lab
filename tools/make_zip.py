#!/usr/bin/env python3
"""Build dist/distortion-lab-<version>.zip from tracked files (git ls-files) or the tree."""
import os
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from distortion_lab import VERSION  # noqa: E402

try:
    files = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split("\n")
    files = [f for f in files if f]
except Exception:
    files = []
    for d, _, fs in os.walk(ROOT):
        if any(p in d for p in (".git", "data", "dist", "__pycache__", "node_modules")):
            continue
        files += [os.path.relpath(os.path.join(d, f), ROOT) for f in fs]
os.makedirs(os.path.join(ROOT, "dist"), exist_ok=True)
out = os.path.join(ROOT, "dist", "distortion-lab-%s.zip" % VERSION)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(files):
        full = os.path.join(ROOT, f)
        if not os.path.isfile(full):
            continue
        info = zipfile.ZipInfo.from_file(full, "distortion-lab/" + f)
        if f.endswith((".command", ".sh")) or f == "run.py":
            info.external_attr = (0o755 << 16)
        with open(full, "rb") as fh:
            z.writestr(info, fh.read(), zipfile.ZIP_DEFLATED)
print("wrote", os.path.relpath(out, ROOT), len(files), "files")
