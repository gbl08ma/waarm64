#!/usr/bin/env bash
# The block interpreter's yardstick (M8-INTERP): its MIPS on the small guests and the boots, alone
# (`VmConfig.jit` 4 / `jit_new` never compiling), in Chromium, one benchmark per bench/run.ts call
# (each under a memory cap and a timeout).
#   [CONFIG=liftoff-only] [QUICK=1] bench/interp/yardstick.sh <outdir> <label> [<core.wasm>] [bench...]
# writes <outdir>/<label>-<bench>.json. A core given is copied over the served one first (and left
# there: copy the build you mean back before CI). The default benches are the interpreter's; with
# CONFIG=liftoff-only, the same guests under the JIT on Liftoff alone, the reference.
set -euo pipefail
cd "$(dirname "$0")/../.."
out=$1 label=$2; shift 2
CORE=target/wasm32-unknown-unknown/release/webpc_core.wasm
if [[ $# -gt 0 && $1 == *.wasm ]]; then
  cp "$1" "$CORE"; cmp "$1" "$CORE"; shift
fi
config=${CONFIG:-default}
if [[ $# -eq 0 ]]; then
  if [[ $config == liftoff-only ]]; then
    set -- jit_mips vm_jit_flat_mips vm_jit_mmu_mips boot_mips_jit boot_alpine_mips_jit
  else
    set -- dec_mips vm_dec_flat_mips vm_dec_mmu_mips boot_dec boot_alpine_dec
  fi
fi
mkdir -p "$out"
# A memory cap where there is a systemd user bus (not in a cloud session: docs/cloud.md).
cap=(systemd-run --user --scope -q -p MemoryMax=8G -p MemorySwapMax=0 --)
"${cap[@]}" true 2>/dev/null || cap=()
for b in "$@"; do
  case $b in boot* | alpine_* | smp_* | coremark_vm* | gl_*) page=bench/boot/index.html ;; *) page=bench/interp/index.html ;; esac
  "${cap[@]}" timeout 590 \
    node --disable-warning=ExperimentalWarning bench/run.ts ${QUICK:+--quick} --config "$config" --page "$page" --only "$b" \
    --out "$out/$label-$b.json" 2>&1 | grep -E '^[a-z_]+ +[{(].*±|MIPS \(warm-up\)|Error' | sed -E 's/ \{.*\}//' || true
done
