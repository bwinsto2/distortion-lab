#!/bin/sh
# Linux/macOS terminal launcher. Set DISTORTION_LAB_AI=claude-code to enable Claude suggestions.
cd "$(dirname "$0")" || exit 1
sh tools/update.sh   # at most 10 s, never waits for a login (skip with DISTORTION_LAB_NO_UPDATE=1)
exec python3 run.py "$@"
