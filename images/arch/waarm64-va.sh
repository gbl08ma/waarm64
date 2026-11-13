#!/usr/bin/env bash
# Builds and checks the waarm64-va package (images/arch/waarm64-va/PKGBUILD; docs/graphics.md "Video's design") in rootless Podman,
# natively on arm64, as an Arch user would: a container of localhost/arch-base (images/arch/base.sh), the system
# upgraded with base-devel, libva and mesa from the mirror, `makepkg` as an unprivileged user, `pacman -U`. The check:
# the driver's entry point is libva's, it finds Mesa's virgl driver's, and LIBVA_DRIVER_NAME=waarm64 is set for sessions.
# On demand only: not part of images/build.sh, CI or any test.
#
#   images/arch/waarm64-va.sh
#
# Result: target/arch/pkg/waarm64-va-<pkgver>-<pkgrel>-aarch64.pkg.tar.* (images/arch/desktop.sh installs it).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=$ROOT/target/arch
[ $# -eq 0 ] || { echo "usage: $0" >&2; exit 2; }
for t in podman; do command -v "$t" >/dev/null || { echo "missing host tool: $t" >&2; exit 1; }; done

mkdir -p "$W/pkg"
"$ROOT/images/arch/base.sh"

WORK=$W/waarm64-va-work
rm -rf "$WORK"; mkdir -p "$WORK/src"
trap 'rm -rf "$WORK"' EXIT
cp "$ROOT"/images/arch/waarm64-va/{PKGBUILD,waarm64_drv_video.c} "$WORK/src/"

cat > "$WORK/inner.sh" <<'INNER'
set -eu
pacman -Syu --noconfirm --noprogressbar --needed base-devel libva mesa >/dev/null 2>&1 || { echo "pacman failed" >&2; exit 1; }
pacman -Q libva mesa
useradd -m builder
cp -r /out/src /home/builder/pkg && chown -R builder /home/builder/pkg
su builder -c 'cd ~/pkg && makepkg --noconfirm 2>&1 | tail -3'
pkg=$(ls /home/builder/pkg/waarm64-va-*.pkg.tar.*)
echo "== pacman -U $(basename "$pkg")"
pacman -U --noconfirm "$pkg" >/dev/null 2>&1
nm -D /usr/lib/dri/waarm64_drv_video.so | grep -q " T __vaDriverInit_1_$(pkg-config --modversion libva | cut -d. -f2)\$" || { echo "the entry point isn't libva's" >&2; exit 1; }
nm -D /usr/lib/dri/virtio_gpu_drv_video.so | grep -q "__vaDriverInit_1_" || { echo "no Mesa virgl driver" >&2; exit 1; }
grep -q '^LIBVA_DRIVER_NAME=waarm64$' /etc/environment.d/50-waarm64-va.conf
bash -lc 'echo "LIBVA_DRIVER_NAME=$LIBVA_DRIVER_NAME"'
cp "$pkg" /out/
INNER

echo "== container: makepkg, pacman -U"
podman run --rm -v "$WORK:/out:Z" localhost/arch-base bash /out/inner.sh
cp "$WORK"/waarm64-va-*.pkg.tar.* "$W/pkg/"
ls -l "$W"/pkg/waarm64-va-*
