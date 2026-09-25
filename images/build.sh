#!/usr/bin/env bash
# Builds the guest images in rootless Podman, never on the host (PLAN.md §7 M3).
#   images/build.sh [name...]      names: linux, kvm-unit-tests (default: both)
#   images/build.sh --check name   exit 0 if target/images/<name> is current, else say how to rebuild
# linux: Buildroot's BusyBox initramfs (rootfs.cpio) and a Linux Image built from
#   allnoconfig + linux.fragment with Buildroot's Bootlin toolchain.
# kvm-unit-tests: the arm64 tests (*.flat) and their unittests.cfg, built with
#   Debian's gcc-aarch64-linux-gnu.
# Outputs go to target/images/<name>/, downloads to target/images/dl/. Output
# hashes are compared with images/SHA256SUMS (a mismatch warns: reproducibility
# is best-effort).
set -euo pipefail

BUILDROOT_TAG=2026.08
BUILDROOT_COMMIT=d5180309b1b66ef3b8eaccca70ad69be8e0729a1
LINUX=6.18.54
LINUX_SHA256=9df30b02dd8102bbd0be52556288ef6889ddbe7f1ddb96fbf847d0becf3eacac
KUT_COMMIT=5a221342a025948fa7d84f0c404748f6ba57f3ad # kvm-unit-tests master, 2026-09-08
export SOURCE_DATE_EPOCH=1788220800 # 2026-09-01T00:00:00Z

cd "$(dirname "$0")/.."
root=$PWD
out=target/images
NAMES=(linux kvm-unit-tests)

build_linux() {
  local dst=$out/linux br=$out/dl/buildroot-$BUILDROOT_TAG bro=$out/build/buildroot
  rm -rf "$bro" "$out/build/linux" "$dst"
  mkdir -p "$out/dl" "$dst"

  # Buildroot, pinned by tag and checked against the commit.
  [ -d "$br" ] || git clone -q --depth 1 --branch "$BUILDROOT_TAG" https://gitlab.com/buildroot.org/buildroot.git "$br"
  [ "$(git -C "$br" rev-parse HEAD)" = "$BUILDROOT_COMMIT" ] || { echo "buildroot: not $BUILDROOT_COMMIT" >&2; exit 1; }
  export WEBPC_IMAGES=$root/images
  make -s -C "$br" O="$root/$bro" BR2_DL_DIR="$root/$out/dl" BR2_DEFCONFIG="$root/images/buildroot.defconfig" defconfig
  make -s -C "$br" O="$root/$bro" BR2_DL_DIR="$root/$out/dl" -j"$(nproc)"
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
  "${kmake[@]}" -j"$(nproc)" Image
  cp "$obj/arch/arm64/boot/Image" "$obj/System.map" "$dst/"
  cp "$obj/.config" "$dst/config"
}

build_kvm-unit-tests() {
  local dst=$out/kvm-unit-tests src=$out/build/kvm-unit-tests
  rm -rf "$src" "$dst"
  mkdir -p "$src" "$dst"
  git -C "$src" init -q
  git -C "$src" fetch -q --depth 1 https://gitlab.com/kvm-unit-tests/kvm-unit-tests.git "$KUT_COMMIT"
  git -C "$src" checkout -q FETCH_HEAD
  (cd "$src" && ./configure --arch=arm64 --cross-prefix=aarch64-linux-gnu- >/dev/null && make -s -j"$(nproc)")
  cp "$src"/arm/*.flat "$src"/arm/unittests.cfg "$dst/"
}

# What decides an image's contents: its files, the pins, and its build steps.
inputs() {
  local files=(images/Containerfile)
  [ "$1" = linux ] && files+=(images/buildroot.defconfig images/linux.fragment $(find images/overlay -type f | sort))
  { cat "${files[@]}"; grep -E '^(BUILDROOT|LINUX|KUT|export SOURCE)' images/build.sh; declare -f "build_$1"; } |
    sha256sum | cut -c1-16
}

outputs() {
  case $1 in
    linux) echo linux/Image linux/rootfs.cpio ;;
    kvm-unit-tests) echo kvm-unit-tests/*.flat ;; # run from $out
  esac
}

if [ "${1:-}" = --check ]; then
  name=${2:?--check needs an image name}
  if [ ! -f "$out/$name/.inputs" ]; then
    echo "no $name image: run images/build.sh $name"
    exit 2
  elif [ "$(cat "$out/$name/.inputs")" != "$(inputs "$name")" ]; then
    echo "$name image is stale (inputs changed): run images/build.sh $name"
    exit 1
  fi
  exit 0
fi

if [ -z "${WEBPC_IN_CONTAINER:-}" ]; then
  tag=webpc-images:$(sha256sum images/Containerfile | cut -c1-12)
  podman image exists "$tag" || podman build -t "$tag" -f images/Containerfile images
  mkdir -p "$out"
  exec podman run --rm --userns=keep-id -v "$root:$root:z" -w "$root" \
    -e WEBPC_IN_CONTAINER=1 -e HOME=/tmp "$tag" images/build.sh "$@"
fi

for name in "${@:-${NAMES[@]}}"; do
  [[ " ${NAMES[*]} " == *" $name "* ]] || { echo "unknown image $name" >&2; exit 1; }
  key=$(inputs "$name")
  if [ "$(cat "$out/$name/.inputs" 2>/dev/null)" = "$key" ]; then
    echo "$name: up to date"
  else
    "build_$name"
    echo "$key" > "$out/$name/.inputs"
  fi
  sums=$(cd "$out" && sha256sum $(outputs "$name"))
  echo "$sums"
  [ "$sums" = "$(grep " $name/" images/SHA256SUMS 2>/dev/null)" ] ||
    echo "WARNING: $name differs from images/SHA256SUMS (update it if the inputs changed on purpose)" >&2
done
