#!/bin/sh
# Linux/macOS: start with AI suggestions through Claude Code signed in to your Claude plan.
export DISTORTION_LAB_AI=claude-code
exec "$(dirname "$0")/start.sh" "$@"
