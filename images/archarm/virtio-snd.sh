#!/usr/bin/env bash
# virtio_snd for Arch Linux ARM's linux-aarch64, which doesn't build CONFIG_SND_VIRTIO (docs/audio.md, S0).
# On demand only: not part of images/build.sh, CI or any test. See docs/images.md "Arch Linux ARM".
#
#   images/archarm/virtio-snd.sh [--kernel 7.2.9-1]
#
# Builds the module out of tree, natively in rootless Podman from Arch's own tarball (localhost/archarm-base, imported
# from images/archarm/build.sh's download as images/deqp/build.sh does), against linux-aarch64-headers from Arch Linux
# ARM's mirror: the current one (the mirror keeps only the latest), which is what build.sh --packages installs on the
# same day. --kernel asserts the headers' package version and fails if the mirror has moved on.
# The driver's source is sound/virtio/ of the matching upstream release, from kernel.org's tarball (sha256 checked
# against kernel.org's sha256sums.asc; cached in target/archarm/). ALARM's linux-aarch64 X.Y.Z-N is upstream X.Y.Z plus
# device-tree, serial and pps patches (none in sound/). GPL-2.0 kernel code, built for the guest, never copied into
# the repo. ALARM's config has no module signing and no modversions, and builds snd, snd-pcm and virtio in: the module
# needs only the exact kernel release (its vermagic).
# Result: target/archarm/virtio-snd/<uname -r>/virtio_snd.ko; images/archarm/build.sh --modules <that dir> puts it
# into an image (under /usr/lib/modules/<uname -r>/updates, depmod'ed: udev loads it when the device is there).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=$ROOT/target/archarm
TAR=$W/ArchLinuxARM-aarch64-latest.tar.gz
URL=http://os.archlinuxarm.org/os/ArchLinuxARM-aarch64-latest.tar.gz
WANT_KERNEL=
while [ $# -gt 0 ]; do
  case $1 in
    --kernel) WANT_KERNEL=$2; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
for t in podman curl; do command -v "$t" >/dev/null || { echo "missing host tool: $t" >&2; exit 1; }; done

mkdir -p "$W"
if [ ! -f "$TAR" ]; then
  WANT=$(curl -fsSL "$URL.md5" | cut -d' ' -f1)
  curl -fL --retry 3 -o "$TAR" "$URL"
  [ "$(md5sum "$TAR" | cut -d' ' -f1)" = "$WANT" ] || { echo "md5 mismatch" >&2; exit 1; }
fi
podman image exists localhost/archarm-base || podman import --os linux --arch arm64 "$TAR" localhost/archarm-base >/dev/null

WORK=$W/virtio-snd-work
rm -rf "$WORK"; mkdir -p "$WORK/src"
trap 'rm -rf "$WORK"' EXIT

# The headers and the toolchain (the container is thrown away; the result is the module alone).
cat > "$WORK/headers.sh" <<'INNER'
set -eu
sed -i -e 's/^#DisableSandbox/DisableSandbox/' -e 's/^DownloadUser/#DownloadUser/' /etc/pacman.conf
pacman-key --init >/dev/null 2>&1 && pacman-key --populate archlinuxarm >/dev/null 2>&1
pacman -Sy --noconfirm --noprogressbar --needed linux-aarch64-headers gcc make >/dev/null 2>&1 || { echo "pacman failed" >&2; exit 1; }
pacman -Q linux-aarch64-headers | cut -d' ' -f2 > /out/pkgver
# the base image has its own (older) kernel too: the headers decide
for d in /usr/lib/modules/*/build; do basename "$(dirname "$d")"; done > /out/kernel
INNER

echo "== container: linux-aarch64-headers"
CTR=webpc-virtio-snd-$$
podman rm -f "$CTR" >/dev/null 2>&1 || true
trap 'rm -rf "$WORK"; podman rm -f "$CTR" >/dev/null 2>&1 || true' EXIT
podman run -d --name "$CTR" -v "$WORK:/out:Z" localhost/archarm-base sleep infinity >/dev/null
podman exec "$CTR" bash /out/headers.sh
PKGVER=$(cat "$WORK/pkgver")      # e.g. 7.2.9-1
KERNEL=$(cat "$WORK/kernel")       # e.g. 7.2.9-1-aarch64-ARCH
echo "linux-aarch64-headers $PKGVER ($KERNEL)"
[ "$(wc -l < "$WORK/kernel")" = 1 ] || { echo "not one set of headers in /usr/lib/modules" >&2; exit 1; }
if [ -n "$WANT_KERNEL" ] && [ "$WANT_KERNEL" != "$PKGVER" ]; then
  echo "the mirror has linux-aarch64-headers $PKGVER, not $WANT_KERNEL" >&2; exit 1
fi
UP=${PKGVER%-*}                     # the upstream release, 7.2.9
MAJOR=${UP%%.*}

echo "== kernel.org: linux-$UP"
KTAR=$W/linux-$UP.tar.xz
KURL=https://cdn.kernel.org/pub/linux/kernel/v$MAJOR.x
SUM=$(curl -fsSL "$KURL/sha256sums.asc" | awk -v f="linux-$UP.tar.xz" '$2 == f { print $1 }')
[ -n "$SUM" ] || { echo "linux-$UP.tar.xz isn't in kernel.org's sha256sums.asc" >&2; exit 1; }
if [ ! -f "$KTAR" ] || [ "$(sha256sum "$KTAR" | cut -d' ' -f1)" != "$SUM" ]; then
  curl -fL --retry 3 -o "$KTAR.part" "$KURL/linux-$UP.tar.xz"
  [ "$(sha256sum "$KTAR.part" | cut -d' ' -f1)" = "$SUM" ] || { echo "sha256 mismatch" >&2; exit 1; }
  mv "$KTAR.part" "$KTAR"
fi
tar -xJf "$KTAR" -C "$WORK/src" --strip-components=3 "linux-$UP/sound/virtio"
ls "$WORK/src"

echo "== build"
podman exec "$CTR" bash -euc '
  cd /out/src
  K=$(cat /out/kernel)
  grep -E "^CONFIG_(SND|SND_PCM|VIRTIO)=y|^# CONFIG_(MODULE_SIG|MODVERSIONS) is not set" /usr/lib/modules/$K/build/.config
  make -s -C /usr/lib/modules/$K/build M=/out/src CONFIG_SND_VIRTIO=m modules -j"$(nproc)"
  modinfo -F vermagic virtio_snd.ko'
OUT=$W/virtio-snd/$KERNEL
mkdir -p "$OUT"
cp "$WORK/src/virtio_snd.ko" "$OUT/"
ls -l "$OUT/virtio_snd.ko"
