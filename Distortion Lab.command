#!/bin/bash
# macOS launcher: double-click in Finder. (First time: right-click > Open to approve.)
cd "$(dirname "$0")" || exit 1
# If this folder is a git clone, fetch the latest version first: at most 10 s, never waits for a login
# (skip with DISTORTION_LAB_NO_UPDATE=1).
sh tools/update.sh
if command -v python3 >/dev/null 2>&1; then
  exec python3 run.py "$@"
else
  echo "python3 was not found. Install Python 3.9+ (e.g. from python.org) and try again."
  read -r -p "Press Return to close."
fi
