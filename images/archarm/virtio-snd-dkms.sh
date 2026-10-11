#!/usr/bin/env bash
# Builds and checks the virtio-snd-dkms package (images/archarm/virtio-snd-dkms/PKGBUILD; docs/plans/audio.md §10.11)
# in rootless Podman, natively on arm64, as a user of Arch Linux ARM would: in a container of localhost/archarm-base
# (imported from images/archarm/build.sh's download), the system upgraded with base-devel, dkms and
# linux-aarch64-headers from the mirror, `makepkg` as an unprivileged user, `pacman -U`. DKMS's pacman hook then builds
# the module for the headers' kernel: the check is `dkms status` saying installed and the module's vermagic being that
# kernel's. On demand only: not part of images/build.sh, CI or any test. See docs/images.md "Arch Linux ARM".
#
#   images/archarm/virtio-snd-dkms.sh
#
# Result: target/archarm/pkg/virtio-snd-dkms-<pkgver>-<pkgrel>-any.pkg.tar.xz (images/archarm/desktop.sh installs it).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=$ROOT/target/archarm
TAR=$W/ArchLinuxARM-aarch64-latest.tar.gz
URL=http://os.archlinuxarm.org/os/ArchLinuxARM-aarch64-latest.tar.gz
[ $# -eq 0 ] || { echo "usage: $0" >&2; exit 2; }
for t in podman curl; do command -v "$t" >/dev/null || { echo "missing host tool: $t" >&2; exit 1; }; done

mkdir -p "$W/pkg"
if [ ! -f "$TAR" ]; then
  WANT=$(curl -fsSL "$URL.md5" | cut -d' ' -f1)
  curl -fL --retry 3 -o "$TAR" "$URL"
  [ "$(md5sum "$TAR" | cut -d' ' -f1)" = "$WANT" ] || { echo "md5 mismatch" >&2; exit 1; }
fi
podman image exists localhost/archarm-base || podman import --os linux --arch arm64 "$TAR" localhost/archarm-base >/dev/null

WORK=$W/virtio-snd-dkms-work
rm -rf "$WORK"; mkdir -p "$WORK/src"
trap 'rm -rf "$WORK"' EXIT
cp "$ROOT"/images/archarm/virtio-snd-dkms/{PKGBUILD,dkms.conf} "$WORK/src/"

cat > "$WORK/inner.sh" <<'INNER'
set -eu
sed -i -e 's/^#DisableSandbox/DisableSandbox/' -e 's/^DownloadUser/#DownloadUser/' /etc/pacman.conf
pacman-key --init >/dev/null 2>&1 && pacman-key --populate archlinuxarm >/dev/null 2>&1
pacman -Syu --noconfirm --noprogressbar --needed base-devel dkms linux-aarch64-headers >/dev/null 2>&1 || { echo "pacman failed" >&2; exit 1; }
pacman -Q dkms linux-aarch64-headers
useradd -m builder
cp -r /out/src /home/builder/pkg && chown -R builder /home/builder/pkg
su builder -c 'cd ~/pkg && makepkg --noconfirm 2>&1 | tail -4'
pkg=$(ls /home/builder/pkg/virtio-snd-dkms-*.pkg.tar.*)
echo "== pacman -U $(basename "$pkg")"
pacman -U --noconfirm "$pkg" 2>&1 | grep -i -E "dkms|virtio|error" || true
K=$(for d in /usr/lib/modules/*/build; do basename "$(dirname "$d")"; done)
echo "== dkms status"; dkms status
dkms status | grep -q "virtio-snd/.*, $K, aarch64: installed" || { echo "not installed for $K" >&2; exit 1; }
m=$(find /usr/lib/modules/$K -name 'virtio_snd.ko*')
echo "module $m: vermagic $(modinfo -F vermagic "$m")"
[ "$(modinfo -F vermagic "$m" | cut -d' ' -f1)" = "$K" ] || { echo "vermagic isn't $K" >&2; exit 1; }
cp "$pkg" /out/
INNER

echo "== container: makepkg, pacman -U, DKMS"
podman run --rm -v "$WORK:/out:Z" localhost/archarm-base bash /out/inner.sh
cp "$WORK"/virtio-snd-dkms-*.pkg.tar.* "$W/pkg/"
ls -l "$W"/pkg/virtio-snd-dkms-*
