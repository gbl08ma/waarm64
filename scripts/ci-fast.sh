#!/usr/bin/env bash
# The fast lane (T1, docs/testing.md "Tiers"): after every change, before scripts/ci.sh at a push. For the changes
# (tools/ci-select.ts: the commits since the merge base with the upstream, the index, the working tree, untracked
# files; --since REV, --files F..., --all), from the areas map (tests/areas.ts):
#   the static checks at once (tsc, svelte-check, the page's linters, the i18n checks, third-party, the harness pages'
#   imports, the areas map's check), and the wasm core and net/ts's modules when stale;
#   then, beside each other: the areas' crates (clippy and cargo test; TestFloat for floating point; the agent's) and
#   the JS tests: the smoke set (every test file that is neither heavy nor topic-only), the areas' heavy files and the
#   changed tests, WAARM64_FAST_JOBS files at a time (default 4), reduced (no Alpine, no long runs, one parallel run,
#   jit-diff at 512 words a class).
# A docs-only change runs nothing but the catalog's check when it quotes the page. --dry-run prints the selection.
# Takes the machine's CI lock shared (scripts/ci-lock.sh): fast lanes run beside each other, not beside scripts/ci.sh
# or a topic script. Each run appends a line to bench/results/local/ci-history.jsonl. Run it under a memory cap
# (docs/testing.md "Tiers": 6G) in the background, like the other scripts.
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s (at %d s)\n' "$*" "$SECONDS"; }
node=(node --disable-warning=ExperimentalWarning)

dry=; args=()
for a in "$@"; do [ "$a" = --dry-run ] && dry=1 || args+=("$a"); done
eval "$("${node[@]}" tools/ci-select.ts "${args[@]}")"

printf 'fast lane: %d changed file(s); areas: %s\n' "${#CHANGED[@]}" "${AREAS[*]:-none}"
((${#OUTSIDE[@]})) && printf 'outside every area (the smoke set only; add them to tests/areas.ts): %s\n' "${OUTSIDE[*]}"
((ALL)) && printf 'a dependency, toolchain or build change: every heavy file runs; scripts/ci.sh is its tier\n'
printf 'tests: %d file(s) (%d smoke, %d for the areas and the changed tests); crates: %s\n' \
  "${#TESTS[@]}" "$SMOKE" $((${#TESTS[@]} - SMOKE)) "${CARGO[*]:-none}"
if [ -n "$dry" ]; then printf '  %s\n' "${TESTS[@]:-}"; exit 0; fi

source scripts/ci-lock.sh
ci_lock shared

if ((DOCS_ONLY)); then
  if ((UI_QUOTES)); then step i18n; "${node[@]}" tools/i18n-check.ts; fi
  printf '\nCI-FAST OK: docs only (%d s)\n' "$SECONDS"
  exit 0
fi

# The Rust tests run under cargo-nextest (.config/nextest.toml).
cargo nextest --version > /dev/null 2>&1 || { echo 'cargo-nextest is missing: cargo +stable install --locked cargo-nextest@0.9.152 (docs/devenv.md)' >&2; exit 1; }
has() { local x; for x in "${CARGO[@]:-}"; do [ "$x" = "$1" ] && return 0; done; return 1; }
source scripts/ci-group.sh
CI_GROUP_TAIL=40
logs=$ci_group_logs

step rust fmt; cargo fmt --all --check
step npm deps; [ node_modules/.package-lock.json -nt package-lock.json ] || npm ci --no-fund --no-audit
[ tools/lint/node_modules/.package-lock.json -nt tools/lint/package-lock.json ] || npm ci --prefix tools/lint --no-fund --no-audit
step 'static checks and builds'
group "typecheck::npx tsc --noEmit" \
  "svelte-check::npm run -s svelte-check" \
  "lint::npm run -s lint" \
  "i18n::${node[*]} tools/i18n-check.ts" \
  "third-party::${node[*]} tools/third-party.ts" \
  "harness-imports::${node[*]} tools/harness-imports.ts" \
  "areas::${node[*]} tools/ci-select.ts --check" \
  "builds::scripts/build-wasm.sh -q && net/ts/build.sh && net/ts/build.sh --test-params"

# The crates beside the JS tests (cargo serializes on target/'s lock, so one job, in order).
rust() {
  local -a pkgs=()
  has core && pkgs+=(-p waarm64-core)
  has ts && pkgs+=(-p waarm64_ts)
  if ((${#pkgs[@]})); then
    echo "clippy ${pkgs[*]}"; cargo clippy -q --all-targets "${pkgs[@]}" -- -D warnings
    echo "cargo nextest run ${pkgs[*]}"; cargo nextest run --cargo-quiet "${pkgs[@]}"
  fi
  if has testfloat; then scripts/testfloat.sh; fi
  if has agent; then (cd agent && cargo fmt --check && cargo clippy --all-targets -q -- -D warnings && cargo test -q); fi
}
step "crates (${CARGO[*]:-none}) beside the JS tests (${#TESTS[@]} files, ${WAARM64_FAST_JOBS:-4} at a time)"
rust > "$logs/rust.log" 2>&1 &
rust_pid=$!
mkdir -p target/ci
js=0
env -u WAARM64_DISTROS -u WAARM64_LONG_TESTS WAARM64_PARALLEL_RUNS=1 WAARM64_JIT_DIFF=512 \
  "${node[@]}" --test --test-concurrency="${WAARM64_FAST_JOBS:-4}" \
  --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter=./tools/test-timings.ts --test-reporter-destination=target/ci/fast-timings.json "${TESTS[@]}" || js=$?
rust_rc=0; wait "$rust_pid" || rust_rc=$?
step "crates (ran beside the JS tests): $( ((rust_rc)) && echo FAILED || echo ok)"
cat "$logs/rust.log"

"${node[@]}" tools/ci-select.ts --record target/ci/fast-timings.json "$js" "$rust_rc" "$SECONDS" "${CHANGED[@]}" || true
before=(scripts/ci.sh "${PUSH[@]/#/scripts/}")
if (( js || rust_rc )); then printf '\nCI-FAST FAILED: js tests %d, crates %d (%d s)\n' "$js" "$rust_rc" "$SECONDS"; exit 1; fi
printf '\nCI-FAST OK (%d s). Before a push: %s\n' "$SECONDS" "${before[*]}"
((${#END[@]})) && printf 'At a track'"'"'s end, also: %s\n' "${END[*]/#/scripts/}"
exit 0
