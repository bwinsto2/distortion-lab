#!/bin/sh
# Linux/macOS terminal launcher. Set DISTORTION_LAB_AI=claude-code to enable Claude suggestions.
cd "$(dirname "$0")" || exit 1
if [ -d .git ] && [ -z "$DISTORTION_LAB_NO_UPDATE" ] && command -v git >/dev/null 2>&1; then
  git pull --ff-only --quiet 2>/dev/null || echo "Could not update; starting the current version."
fi
exec python3 run.py "$@"
