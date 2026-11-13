#!/usr/bin/env bash
# dEQP-VK on the page (docs/testing.md "dEQP-VK"): run it, besides scripts/ci.sh, when a change touches Vulkan: the
# renderer's driver or translator (vk/), the GPU worker's WebGPU side (web/venus-gpu.ts), Venus's device; and at the end
# of a Vulkan track. Under a 14 GiB `MemoryMax` (on 18 GiB of RAM): an eighth of the direct set's pass list (tests/deqp/vk.txt), a
# sample whose seed each run draws and prints (WAARM64_DEQP_VK_SEED=<n> runs it again; --full the whole list, ~47 min at 58,906 cases), on two machines at once, and the YCbCr one
# (tests/deqp/vk-ycbcr.txt: YCbCr is on by default since VK3 L7.3), a second; then the programs'
# captures replayed against lavapipe's frames (tests/page-venus.test.ts, also scripts/ci-graphics.sh's: VK3 L6c, vkQuake's
# first frame went 80% wrong over three loops that ran only this script). Needs the wasm core (scripts/ci.sh builds it),
# the renderer (vk/build.sh), images/deqp/build.sh vk's dEQP-VK disk and guest (on demand, ~25 min once),
# images/debian-vulkan/build.sh's Debian and images/vkframes/build.sh's disk. Skips where the page has no WebGPU adapter.
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s (at %d s)\n' "$*" "$SECONDS"; }

for f in target/deqp/deqp-vk.ext4 target/deqp/guest-vk.qcow2 target/vk/venus.wasm target/images/debian-vulkan/disk.qcow2 target/vkframes/vkframes.ext4; do
  [ -f "$f" ] || { echo "ci-deqp-vk: $f is missing (images/deqp/build.sh vk; vk/build.sh; images/debian-vulkan/build.sh; images/vkframes/build.sh)"; exit 1; }
done
export WAARM64_DEQP_VK=1
# --full: the whole pass list (track ends, before NVIDIA runs, changes across groups); else a seeded sample of it.
# --full --phases M [DIR]: the whole list in M slices, one boot each, each slice's result a checkpoint DIR/phase-N.json
# (default bench/results/local/deqp-vk-full); a slice whose checkpoint is there is skipped (a run resumed), one that
# fails doesn't stop the next; then YCbCr's list (its own test) and the replays as without phases.
if [ "${1:-}" = --full ]; then export WAARM64_DEQP_VK_FULL=1; fi
phases=; dir=
if [ "${2:-}" = --phases ]; then phases=${3:?--phases M}; dir=${4:-bench/results/local/deqp-vk-full}; mkdir -p "$dir"; fi
what='a sample'; [ "${WAARM64_DEQP_VK_FULL:-}" = 1 ] && what='the whole list'
if [ -n "$phases" ]; then
  failed=0
  for n in $(seq 1 "$phases"); do
    if [ -f "$dir/phase-$n.json" ]; then echo "phase $n/$phases: $dir/phase-$n.json is there, skipped"; continue; fi
    step "dEQP-VK on the page (the whole list, phase $n/$phases)"
    WAARM64_DEQP_VK_PHASE=$n/$phases WAARM64_DEQP_VK_CHECKPOINT=$dir/phase-$n.json \
      node --disable-warning=ExperimentalWarning --test --test-name-pattern="^dEQP-VK's pass list" tests/page-deqp-vk.test.ts || failed=1
  done
  step "dEQP-VK on the page (YCbCr's list)"
  node --disable-warning=ExperimentalWarning --test --test-name-pattern="YCbCr" tests/page-deqp-vk.test.ts || failed=1
  [ "$failed" = 0 ] || { printf '\nci-deqp-vk: a phase failed (its checkpoint in %s)\n' "$dir"; exit 1; }
else
  step "dEQP-VK on the page ($what)"
  node --disable-warning=ExperimentalWarning --test tests/page-deqp-vk.test.ts
fi
step 'The programs replayed through Venus on the page'
WAARM64_DISTROS=debian node --disable-warning=ExperimentalWarning --test tests/page-venus.test.ts
printf '\nCI-DEQP-VK OK (%d s)\n' "$SECONDS"
