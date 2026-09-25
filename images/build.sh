#!/usr/bin/env bash
# Builds the guest images in rootless Podman, never on the host (PLAN.md §7 M3).
#   images/build.sh [name...]      names: linux (default)
#   images/build.sh --check        exit 0 if target/images is current, else say how to rebuild
# linux: Buildroot's BusyBox initramfs (target/images/linux/rootfs.cpio) and a
# Linux Image built from allnoconfig + linux.fragment with Buildroot's Bootlin
# toolchain. Downloads are cached in target/images/dl/. Output hashes are
# compared with images/SHA256SUMS (a mismatch warns: reproducibility is best-effort).
set -euo pipefail

BUILDROOT_TAG=2026.08
BUILDROOT_COMMIT=d5180309b1b66ef3b8eaccca70ad69be8e0729a1
LINUX=6.18.54
LINUX_SHA256=9df30b02dd8102bbd0be52556288ef6889ddbe7f1ddb96fbf847d0becf3eacac
export SOURCE_DATE_EPOCH=1788220800 # 2026-09-01T00:00:00Z

cd "$(dirname "$0")/.."
root=$PWD
out=target/images

# Everything that decides an image's contents; a change means a clean rebuild.
inputs() { cat images/Containerfile images/build.sh images/buildroot.defconfig images/linux.fragment \
  $(find images/overlay -type f | sort) | sha256sum | cut -c1-16; }

# --check: are the built images current? Prints the rebuild command if not.
if [ "${1:-}" = --check ]; then
  if [ ! -f "$out/linux/Image" ]; then
    echo "no images: run images/build.sh"
    exit 2
  elif [ "$(cat "$out/linux/.inputs" 2>/dev/null)" != "$(inputs)" ]; then
    echo "images are stale (inputs changed): run images/build.sh linux"
    exit 1
  fi
  exit 0
fi

if [ -z "${WEBPC_IN_CONTAINER:-}" ]; then
  tag=webpc-images:$(sha256sum images/Containerfile | cut -c1-12)
  podman image exists "$tag" || podman build -t "$tag" -f images/Containerfile images
  mkdir -p "$out"
  exec podman run --rm --userns=keep-id -v "$root:$root:z" -w "$root" \
    -e WEBPC_IN_CONTAINER=1 "$tag" images/build.sh "$@"
fi

jobs=$(nproc)
build_linux() {
  local dst=$out/linux br=$out/dl/buildroot-$BUILDROOT_TAG bro=$out/build/buildroot key
  key=$(inputs)
  if [ "$(cat "$dst/.inputs" 2>/dev/null)" != "$key" ]; then
    rm -rf "$bro" "$out/build/linux" "$dst"
  fi
  mkdir -p "$out/dl" "$dst"

  # Buildroot, pinned by tag and checked against the commit.
  [ -d "$br" ] || git clone -q --depth 1 --branch "$BUILDROOT_TAG" https://gitlab.com/buildroot.org/buildroot.git "$br"
  [ "$(git -C "$br" rev-parse HEAD)" = "$BUILDROOT_COMMIT" ] || { echo "buildroot: not $BUILDROOT_COMMIT" >&2; exit 1; }
  export WEBPC_IMAGES=$root/images
  make -s -C "$br" O="$root/$bro" BR2_DL_DIR="$root/$out/dl" BR2_DEFCONFIG="$root/images/buildroot.defconfig" defconfig
  make -s -C "$br" O="$root/$bro" BR2_DL_DIR="$root/$out/dl" -j"$jobs"
  cp "$bro/images/rootfs.cpio" "$dst/"

  # Linux: allnoconfig + the fragment, every fragment line checked.
  local tar=$out/dl/linux-$LINUX.tar.xz src=$out/build/linux-$LINUX obj=$out/build/linux
  [ -f "$tar" ] || wget -q -O "$tar" "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-$LINUX.tar.xz"
  echo "$LINUX_SHA256  $tar" | sha256sum -c --quiet
  [ -d "$src" ] || tar -xf "$tar" -C "$out/build"
  local kmake=(make -s -C "$src" O="$root/$obj" ARCH=arm64 CROSS_COMPILE="$root/$bro/host/bin/aarch64-linux-"
    KBUILD_BUILD_TIMESTAMP=@$SOURCE_DATE_EPOCH KBUILD_BUILD_USER=webpc KBUILD_BUILD_HOST=webpc)
  mkdir -p "$obj"
  "${kmake[@]}" KCONFIG_ALLCONFIG="$root/images/linux.fragment" allnoconfig
  local missing
  missing=$(grep '^CONFIG_' images/linux.fragment | grep -vxFf "$obj/.config" || true)
  [ -z "$missing" ] || { echo "linux.fragment: not applied:" >&2; echo "$missing" >&2; exit 1; }
  "${kmake[@]}" -j"$jobs" Image
  cp "$obj/arch/arm64/boot/Image" "$obj/System.map" "$dst/"
  cp "$obj/.config" "$dst/config"
  echo "$key" > "$dst/.inputs"
}

for name in "${@:-linux}"; do
  case $name in
    linux) build_linux ;;
    *) echo "unknown image $name" >&2; exit 1 ;;
  esac
  sums=$( (cd "$out" && sha256sum "$name"/Image "$name"/rootfs.cpio) )
  echo "$sums"
  grep -qxF "$sums" images/SHA256SUMS 2>/dev/null ||
    echo "WARNING: $name differs from images/SHA256SUMS (update it if the inputs changed on purpose)" >&2
done
