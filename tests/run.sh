#!/usr/bin/env bash
# Full test: build, install mock modules, install+smoke the zip via foundry-test, enable mocks, run the Playwright suite.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; MOD="$(dirname "$HERE")"; FT="${FT:-$MOD/../foundry-test}"
"$MOD/build.sh" >/dev/null
for d in "$HERE"/mocks/*/; do id=$(basename "$d"); rm -rf "$FT/data/Data/modules/$id"; cp -a "$d" "$FT/data/Data/modules/$id"; done
"$FT/tests/test-module.sh" "$MOD/dist/module.zip"
for id in tkug-mock-safe tkug-mock-old tkug-mock-untested tkug-mock-max tkug-mock-sys; do (cd "$FT/tests" && node enable-module.mjs "$id"); done
FOUNDRY_TESTS="$FT/tests" node "$HERE/upgrade-guardian.test.mjs"
