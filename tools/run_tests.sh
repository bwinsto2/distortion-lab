#!/bin/sh
# Run every automated check. Python is required; Node.js and Playwright are optional.
cd "$(dirname "$0")/.." || exit 1
set -e
python3 tools/build_data.py --check
echo "== Python backend, model and parity tests"
python3 -m unittest discover -s tests -v
if command -v node >/dev/null 2>&1; then
  echo "== Browser core tests (Node)"
  node --test tests/core.test.js tests/controller.test.js
  echo "== Browser end-to-end tests (Playwright, skipped if not installed)"
  node tests/e2e.js
else
  echo "Node.js not found: skipped core.test.js and e2e.js (the Python parity test also needs Node)"
fi
