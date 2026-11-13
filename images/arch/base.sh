#!/usr/bin/env bash
# The Arch base container, localhost/arch-base: Arch Linux for aarch64 from arch.bens.haus (an unofficial port of
# Arch's own packages to ARMv8.0-A and later, listed on https://ports.archlinux.page/aarch64/; docs/images.md "Arch
# Linux"), which images/arch/build.sh, waarm64-va.sh and images/deqp's Containerfile start from. Made once and kept
# (--rebuild remakes it, e.g. for a newer bootstrap tarball).
#
#   images/arch/base.sh [--rebuild]
#
# Downloads the port's latest bootstrap tarball (named on its home page with its SHA256, which is checked; a cached
# copy with that SHA256 is reused, in target/arch), imports its root.aarch64/ as a rootless Podman image (it runs
# natively on arm64) and in it: the mirror (the port's [core] and [extra]), pacman's keyring with Arch's keys and the
# port's own (images/arch/bens.haus.asc: it signs every arch=aarch64 package; arch=any ones keep Arch's signatures),
# pinned by fingerprint and locally signed; pacman's download sandbox off (it doesn't work in a rootless container:
# images/arch/build.sh turns it back on in the image); then the system upgraded and every package reinstalled from the
# mirror, which puts back the file capabilities the import loses (the tarball keeps them as libarchive xattrs, which
# GNU tar and Podman drop).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=$ROOT/target/arch
MIRROR=https://arch.bens.haus
KEY_FPR=C43E3B9B9CE3F35E97AEF93873556FFF735F691D
IMG=localhost/arch-base
case ${1-} in
  --rebuild) podman rmi -f "$IMG" >/dev/null 2>&1 || true ;;
  '') ;;
  *) echo "usage: $0 [--rebuild]" >&2; exit 2 ;;
esac
podman image exists "$IMG" && exit 0
for t in podman curl sha256sum zstd; do command -v "$t" >/dev/null || { echo "missing host tool: $t" >&2; exit 1; }; done

mkdir -p "$W"
PAGE=$(curl -fsSL "$MIRROR/")
NAME=$(grep -oE 'archlinux-bootstrap-[0-9.]+-aarch64\.tar\.zst' <<<"$PAGE" | head -1)
WANT=$(sed -n "/$NAME/,\$p" <<<"$PAGE" | grep -oE '\b[0-9a-f]{64}\b' | head -1)
[ -n "$NAME" ] && [ -n "$WANT" ] || { echo "no bootstrap tarball or SHA256 on $MIRROR/" >&2; exit 1; }
TAR=$W/$NAME
if [ ! -f "$TAR" ] || [ "$(sha256sum "$TAR" | cut -d' ' -f1)" != "$WANT" ]; then
  curl -fL --retry 3 -o "$TAR.part" "$MIRROR/iso/$NAME"
  [ "$(sha256sum "$TAR.part" | cut -d' ' -f1)" = "$WANT" ] || { echo "sha256 mismatch for $NAME" >&2; exit 1; }
  mv "$TAR.part" "$TAR"
fi
echo "$NAME sha256 $WANT"

echo "== import"
SCRATCH=localhost/arch-bootstrap
# root.aarch64/ becomes the image's root: unpacked as root in Podman's user namespace (owners kept), packed again.
X=$W/bootstrap-work
podman unshare rm -rf "$X"; mkdir -p "$X"
trap 'podman unshare rm -rf "$X"; podman rmi -f "$SCRATCH" >/dev/null 2>&1 || true' EXIT
podman unshare tar --zstd -xpf "$TAR" -C "$X" --warning=no-unknown-keyword
podman unshare tar -C "$X/root.aarch64" --numeric-owner -cf - . | podman import -q --os linux --arch arm64 - "$SCRATCH" >/dev/null

echo "== keyring, upgrade, reinstall"
podman rm -f arch-base-work >/dev/null 2>&1 || true
podman run --name arch-base-work -e MIRROR="$MIRROR" -e KEY_FPR="$KEY_FPR" \
  -v "$ROOT/images/arch/bens.haus.asc:/tmp/key.asc:ro,Z" "$SCRATCH" bash -euc '
  echo "Server = $MIRROR/repos/\$repo/os/\$arch" > /etc/pacman.d/mirrorlist
  sed -i -e "s/^#DisableSandbox/DisableSandbox/" -e "s/^DownloadUser/#DownloadUser/" /etc/pacman.conf
  pacman-key --init >/dev/null 2>&1
  pacman-key --populate archlinux >/dev/null 2>&1
  got=$(gpg --with-colons --show-keys /tmp/key.asc 2>/dev/null | awk -F: "/^fpr/ {print \$10; exit}")
  [ "$got" = "$KEY_FPR" ] || { echo "the key is $got, not $KEY_FPR" >&2; exit 1; }
  pacman-key --add /tmp/key.asc >/dev/null 2>&1
  pacman-key --lsign-key "$KEY_FPR" >/dev/null 2>&1
  pacman -Syu --noconfirm --noprogressbar >/dev/null 2>&1 || { echo "pacman -Syu failed" >&2; exit 1; }
  pacman -S --noconfirm --noprogressbar $(pacman -Qnq) >/dev/null 2>&1 || { echo "the reinstall failed" >&2; exit 1; }
  pacman -Scc --noconfirm >/dev/null 2>&1
  rm -f /var/lib/pacman/sync/*.db.sig
  pacman -Q pacman archlinux-keyring | tr "\n" " "; echo'
podman commit -q arch-base-work "$IMG" >/dev/null
podman rm -f arch-base-work >/dev/null
echo "$IMG ready"
