#!/usr/bin/env bash
# Everything CI runs; works the same locally. CHROMIUM overrides the browser binary.
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s\n' "$*"; }

step rust fmt;    cargo fmt --all --check
step rust clippy; cargo clippy --all-targets -q -- -D warnings
step rust test;   cargo test -q
step testfloat;   scripts/testfloat.sh
step wasm build;  scripts/build-wasm.sh -q
step npm deps;    [ -d node_modules ] || npm ci --no-fund --no-audit
step typecheck;   npx tsc --noEmit
step js tests;    npm test --silent
printf '\nCI OK\n'
