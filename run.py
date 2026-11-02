#!/usr/bin/env python3
"""Start Distortion Lab:  python3 run.py   (options: --port 8765 --data ./data --no-browser)"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
if sys.version_info < (3, 9):
    sys.exit("Distortion Lab needs Python 3.9 or newer (found %s)" % sys.version.split()[0])
from distortion_lab.server import main  # noqa: E402

main()
