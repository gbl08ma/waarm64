#!/usr/bin/env bash
# Builds the simdutf36-compat package (images/arch/simdutf36/PKGBUILD) in rootless Podman, natively on arm64, as
# waarm64-va.sh builds its own. Why: the port (arch.bens.haus) moved simdutf to 9.3 (libsimdutf.so.37) on 2026-11-24
# before rebuilding Chromium (156.0.8078.79-1 links libsimdutf.so.36), so its Chromium doesn't start. images/arch/
# desktop-setup.sh installs the package only while Chromium still needs that library; remove this once the mirror's
# Chromium links the current simdutf (desktop-setup.sh then says so).
#
#   images/arch/simdutf36.sh
#
# Result: target/arch/pkg/simdutf36-compat-<pkgver>-<pkgrel>-aarch64.pkg.tar.* (images/arch/desktop.sh copies it).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=$ROOT/target/arch
[ $# -eq 0 ] || { echo "usage: $0" >&2; exit 2; }
command -v podman >/dev/null || { echo "missing host tool: podman" >&2; exit 1; }

mkdir -p "$W/pkg"
"$ROOT/images/arch/base.sh"

WORK=$W/simdutf36-work
rm -rf "$WORK"; mkdir -p "$WORK/src"
trap 'rm -rf "$WORK"' EXIT
cp "$ROOT"/images/arch/simdutf36/PKGBUILD "$WORK/src/"

cat > "$WORK/inner.sh" <<'INNER'
set -eu
pacman -Syu --noconfirm --noprogressbar --needed base-devel cmake git >/dev/null 2>&1 || { echo "pacman failed" >&2; exit 1; }
useradd -m builder
cp -r /out/src /home/builder/pkg && chown -R builder /home/builder/pkg
su builder -c 'cd ~/pkg && makepkg --noconfirm 2>&1 | tail -3'
pkg=$(ls /home/builder/pkg/simdutf36-compat-*.pkg.tar.*)
pacman -Qlp "$pkg" | grep -q '/usr/lib/libsimdutf.so.36$' || { echo "no libsimdutf.so.36 in the package" >&2; exit 1; }
cp "$pkg" /out/
INNER

echo "== container: makepkg"
podman run --rm -v "$WORK:/out:Z" localhost/arch-base bash /out/inner.sh
rm -f "$W"/pkg/simdutf36-compat-*
cp "$WORK"/simdutf36-compat-*.pkg.tar.* "$W/pkg/"
ls -l "$W"/pkg/simdutf36-compat-*
