#!/usr/bin/env bash
# An A/B of core builds on the block interpreter's yardstick (bench/interp/yardstick.sh), the arms
# alternated each round, in one session; then the served core is the first arm's again.
#   [CONFIG=…] [QUICK=1] bench/interp/ab.sh <outdir> <rounds> <name>=<core.wasm>... [-- bench...]
# writes <outdir>/r<round>-<name>-<bench>.json; `node bench/interp/ab-summary.ts <outdir>` sums them up.
set -euo pipefail
cd "$(dirname "$0")/../.."
out=$1 rounds=$2; shift 2
arms=()
while [[ $# -gt 0 && $1 != -- ]]; do arms+=("$1"); shift; done
[[ ${1:-} == -- ]] && shift
for ((i = 1; i <= rounds; i++)); do
  for a in "${arms[@]}"; do
    echo "== round $i: ${a%%=*}"
    bench/interp/yardstick.sh "$out" "r$i-${a%%=*}" "${a#*=}" "$@"
  done
done
first=${arms[0]}
cp "${first#*=}" target/wasm32-unknown-unknown/release/waarm64_core.wasm
