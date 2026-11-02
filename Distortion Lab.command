#!/bin/bash
# macOS launcher: double-click in Finder. (First time: right-click > Open to approve.)
cd "$(dirname "$0")" || exit 1
# If this folder is a git clone, fetch the latest version first (skip with DISTORTION_LAB_NO_UPDATE=1).
if [ -d .git ] && [ -z "$DISTORTION_LAB_NO_UPDATE" ] && command -v git >/dev/null 2>&1; then
  echo "Checking for updates..."
  if git pull --ff-only --quiet 2>/dev/null; then
    echo "Up to date: $(git log -1 --format='%h %s (%cr)')"
  else
    echo "Could not update (offline, or local changes). Starting the current version."
  fi
fi
if command -v python3 >/dev/null 2>&1; then
  exec python3 run.py "$@"
else
  echo "python3 was not found. Install Python 3.9+ (e.g. from python.org) and try again."
  read -r -p "Press Return to close."
fi
