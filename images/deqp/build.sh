#!/usr/bin/env bash
# dEQP for G4's conformance subset (docs/plans/graphics.md; the G4 kickoff's decision 3): VK-GL-CTS
# opengl-es-cts-3.2.14.1 (Apache-2.0: a workload, built and run, nothing copied), deqp-gles2 and deqp-gles3 on EGL's
# surfaceless platform, built natively for Arch Linux (arch.bens.haus's aarch64 port: the desktop guest's
# distribution) in rootless Podman from localhost/arch-base (images/arch/base.sh). On demand only: not in
# images/build.sh, SHA256SUMS or CI. Results:
#   target/deqp/deqp.ext4   the two binaries, their data and the GLES mustpass lists in /deqp (ext4, label deqp): the
#                           page's second disk (?disk2=), which the guest mounts (bench/gpu/deqp-run.ts)
#   target/deqp/guest.qcow2 the guest that runs them on the page: Arch Linux with mesa and libpng
#                           (images/arch/build.sh --packages; ~4 min more), scripts/ci-deqp.sh's
#   localhost/webpc-deqp    the build's image: the same binaries on Mesa's virpipe against the vtest oracle
#                           (tools/virgl-oracle/deqp.sh), for the expected results
#   images/deqp/build.sh [--guest-only]
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=$ROOT/target/deqp
mkdir -p "$W"
guest() { "$ROOT/images/arch/build.sh" --packages "mesa libpng" --out "$W/guest.qcow2"; }
if [ "${1-}" = --guest-only ]; then guest; exit; fi
"$ROOT/images/arch/base.sh"
podman build -q -t localhost/webpc-deqp "$ROOT/images/deqp" >/dev/null
rm -rf "$W/tree"; mkdir -p "$W/tree"
podman run --rm -v "$W:/out:Z" localhost/webpc-deqp sh -euc '
  d=/out/tree/deqp
  for m in gles2 gles3; do
    mkdir -p $d/$m
    cp /build/modules/$m/deqp-$m $d/$m/
    cp -r /build/modules/$m/$m $d/$m/ 2>/dev/null || cp -r /cts/data/$m $d/$m/$m
  done
  cp /cts/external/openglcts/data/gl_cts/data/mustpass/gles/aosp_mustpass/main/gles2-main.txt \
     /cts/external/openglcts/data/gl_cts/data/mustpass/gles/aosp_mustpass/main/gles3-main.txt $d/
  du -sm $d | cut -f1 > /out/size
  truncate -s $(( $(cat /out/size) * 13 / 10 + 64 ))M /out/deqp.ext4.new
  mke2fs -q -t ext4 -L deqp -d /out/tree /out/deqp.ext4.new
  mv /out/deqp.ext4.new /out/deqp.ext4'
rm -rf "$W/tree" "$W/size"
ls -l "$W/deqp.ext4"
guest
