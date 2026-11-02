#!/bin/bash
# macOS launcher: double-click in Finder. (First time: right-click > Open to approve.)
cd "$(dirname "$0")" || exit 1
if command -v python3 >/dev/null 2>&1; then
  exec python3 run.py "$@"
else
  echo "python3 was not found. Install Python 3.9+ (e.g. from python.org) and try again."
  read -r -p "Press Return to close."
fi
