#!/usr/bin/env bash
# bench/interp/ab.sh on the Mac host's Chromium (bench/run-mac.sh: no explicit bounds checks there),
# the arms alternated each round; results in bench/results/local/mac/<prefix>-r<round>-<arm>-<bench>.json.
#   bench/interp/ab-mac.sh <prefix> <rounds> <name>=<core.wasm>... [-- bench...]
set -euo pipefail
cd "$(dirname "$0")/../.."
prefix=$1 rounds=$2; shift 2
arms=()
while [[ $# -gt 0 && $1 != -- ]]; do arms+=("$1"); shift; done
[[ ${1:-} == -- ]] && shift
benches=("$@")
[[ ${#benches[@]} -gt 0 ]] || benches=(dec_mips vm_dec_mmu_mips boot_dec boot_alpine_dec)
for ((i = 1; i <= rounds; i++)); do
  for a in "${arms[@]}"; do
    for b in "${benches[@]}"; do
      case $b in boot* | alpine_* | smp_* | coremark_vm*) page=bench/boot/index.html ;; *) page=bench/interp/index.html ;; esac
      WASM=${a#*=} timeout 590 bench/run-mac.sh "$prefix-r$i-${a%%=*}-$b" --page "$page" --only "$b" 2>&1 |
        grep -E '^[a-z_]+ +[{(].*±|Error' | sed -E 's/ \{.*\}//' || true
    done
  done
done
