#!/usr/bin/env bash
# dEQP for G4's conformance subset (docs/plans/graphics.md; the G4 kickoff's decision 3): VK-GL-CTS
# opengl-es-cts-3.2.14.1 (Apache-2.0: a workload, built and run, nothing copied), deqp-gles2 and deqp-gles3 on EGL's
# surfaceless platform, built natively for Arch Linux ARM (the user's guest image's distribution) in rootless Podman
# from Arch's own tarball (images/archarm/build.sh's download, cached in target/archarm). On demand only: not in
# images/build.sh, SHA256SUMS or CI. Results:
#   target/deqp/deqp.ext4   the two binaries, their data and the GLES mustpass lists in /deqp (ext4, label deqp): the
#                           page's second disk (?disk2=), which the guest mounts (bench/gpu/deqp-run.ts)
#   localhost/webpc-deqp    the build's image: the same binaries on Mesa's virpipe against the vtest oracle
#                           (tools/virgl-oracle/deqp.sh), for the expected results
#   images/deqp/build.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=$ROOT/target/deqp
TAR=$ROOT/target/archarm/ArchLinuxARM-aarch64-latest.tar.gz
URL=http://os.archlinuxarm.org/os/ArchLinuxARM-aarch64-latest.tar.gz
mkdir -p "$W" "$(dirname "$TAR")"
if [ ! -f "$TAR" ]; then
  WANT=$(curl -fsSL "$URL.md5" | cut -d' ' -f1)
  curl -fL --retry 3 -o "$TAR" "$URL"
  [ "$(md5sum "$TAR" | cut -d' ' -f1)" = "$WANT" ] || { echo "md5 mismatch" >&2; exit 1; }
fi
podman image exists localhost/archarm-base || podman import --os linux --arch arm64 "$TAR" localhost/archarm-base >/dev/null
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
