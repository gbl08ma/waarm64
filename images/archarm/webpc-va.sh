#!/usr/bin/env bash
# Builds and checks the webpc-va package (images/archarm/webpc-va/PKGBUILD; docs/plans/video.md §1) in rootless Podman,
# natively on arm64, as a user of Arch Linux ARM would: a container of localhost/archarm-base (imported from
# images/archarm/build.sh's download), the system upgraded with base-devel, libva and mesa from the mirror, `makepkg`
# as an unprivileged user, `pacman -U`. The check: the driver's entry point is libva's, it finds Mesa's virgl driver's,
# and LIBVA_DRIVER_NAME=webpc is set for sessions. On demand only: not part of images/build.sh, CI or any test.
#
#   images/archarm/webpc-va.sh
#
# Result: target/archarm/pkg/webpc-va-<pkgver>-<pkgrel>-aarch64.pkg.tar.xz (images/archarm/desktop.sh installs it).
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

WORK=$W/webpc-va-work
rm -rf "$WORK"; mkdir -p "$WORK/src"
trap 'rm -rf "$WORK"' EXIT
cp "$ROOT"/images/archarm/webpc-va/{PKGBUILD,webpc_drv_video.c} "$WORK/src/"

cat > "$WORK/inner.sh" <<'INNER'
set -eu
sed -i -e 's/^#DisableSandbox/DisableSandbox/' -e 's/^DownloadUser/#DownloadUser/' /etc/pacman.conf
pacman-key --init >/dev/null 2>&1 && pacman-key --populate archlinuxarm >/dev/null 2>&1
pacman -Syu --noconfirm --noprogressbar --needed base-devel libva mesa >/dev/null 2>&1 || { echo "pacman failed" >&2; exit 1; }
pacman -Q libva mesa
useradd -m builder
cp -r /out/src /home/builder/pkg && chown -R builder /home/builder/pkg
su builder -c 'cd ~/pkg && makepkg --noconfirm 2>&1 | tail -3'
pkg=$(ls /home/builder/pkg/webpc-va-*.pkg.tar.*)
echo "== pacman -U $(basename "$pkg")"
pacman -U --noconfirm "$pkg" >/dev/null 2>&1
nm -D /usr/lib/dri/webpc_drv_video.so | grep -q " T __vaDriverInit_1_$(pkg-config --modversion libva | cut -d. -f2)\$" || { echo "the entry point isn't libva's" >&2; exit 1; }
nm -D /usr/lib/dri/virtio_gpu_drv_video.so | grep -q "__vaDriverInit_1_" || { echo "no Mesa virgl driver" >&2; exit 1; }
grep -q '^LIBVA_DRIVER_NAME=webpc$' /etc/environment.d/50-webpc-va.conf
bash -lc 'echo "LIBVA_DRIVER_NAME=$LIBVA_DRIVER_NAME"'
cp "$pkg" /out/
INNER

echo "== container: makepkg, pacman -U"
podman run --rm -v "$WORK:/out:Z" localhost/archarm-base bash /out/inner.sh
cp "$WORK"/webpc-va-*.pkg.tar.* "$W/pkg/"
ls -l "$W"/pkg/webpc-va-*
