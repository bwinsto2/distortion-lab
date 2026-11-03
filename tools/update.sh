#!/bin/sh
# Fetch the latest version before starting, without ever blocking the start:
#  - never asks for a password or passphrase (fails instead),
#  - gives up after DISTORTION_LAB_UPDATE_TIMEOUT seconds (default 10),
#  - skipped entirely with DISTORTION_LAB_NO_UPDATE=1 or when this folder is not a git clone.
# Run from the distortion-lab folder. Always exits 0 so the app starts either way.
[ -d .git ] || exit 0
[ -z "$DISTORTION_LAB_NO_UPDATE" ] || exit 0
command -v git >/dev/null 2>&1 || exit 0

limit="${DISTORTION_LAB_UPDATE_TIMEOUT:-10}"
echo "Checking for updates (up to ${limit} s)..."
log="${TMPDIR:-/tmp}/distortion-lab-update.$$.log"

GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=echo SSH_ASKPASS=echo \
GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=5" \
  git -c credential.interactive=never pull --ff-only --quiet </dev/null >"$log" 2>&1 &
pid=$!

ticks=0
while kill -0 "$pid" 2>/dev/null; do
  if [ "$ticks" -ge $((limit * 2)) ]; then
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    echo "Update check took too long (slow network or waiting for a GitHub login). Starting the current version."
    echo "To update by hand: open Terminal in this folder and run: git pull"
    rm -f "$log"
    exit 0
  fi
  sleep 0.5
  ticks=$((ticks + 1))
done

if wait "$pid"; then
  echo "Up to date: $(git log -1 --format='%h %s (%cr)')"
else
  echo "Could not update ($(tail -n 1 "$log" 2>/dev/null)). Starting the current version."
  echo "To update by hand: open Terminal in this folder and run: git pull"
fi
rm -f "$log"
exit 0
