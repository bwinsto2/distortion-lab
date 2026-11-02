#!/bin/bash
# Same as "Distortion Lab.command", with AI suggestions through Claude Code signed in to your
# Claude plan (no API key, no extra billing beyond your plan's included usage).
# One-time setup: install Claude Code and run `claude` once in Terminal to sign in with your Claude account.
export DISTORTION_LAB_AI=claude-code
exec "$(dirname "$0")/Distortion Lab.command" "$@"
