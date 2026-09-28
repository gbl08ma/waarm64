#!/usr/bin/env bash
# Builds the guest images in rootless Podman, never on the host (docs/images.md).
#   images/build.sh [name...]      names: linux, kvm-unit-tests, alpine, alpine-user, linux-crypto, debian, ltp (default: all)
#   images/build.sh --check name   exit 0 if target/images/<name> is current, else say how to rebuild
# linux: Buildroot's BusyBox root filesystem (rootfs.ext4) and a Linux Image built
#   from allnoconfig + linux.fragment with Buildroot's Bootlin toolchain; also
#   Image-defconfig, the same kernel from arm64 defconfig + linux.fragment (the
#   distro-like candidate, M4 step 4).
# alpine: Alpine's aarch64 minirootfs plus linux-virt and openrc (apk in a qemu-user
#   chroot), as an ext4 root (rootfs.ext4); the kernel (Image) and initramfs come
#   from linux-virt. images/alpine/ has the boot test's local.d script.
# alpine-user: the userspace benchmark's root (M6, images/alpine/user): alpine's
#   rootfs.ext4 plus xz, lua5.4, sqlite and openssl (M6.5) and the workloads, with its local.d
#   script instead of the boot test's, as rootfs-user.ext4 (it boots alpine's
#   Image and initramfs-virt). Built on the host side in Alpine's own container,
#   natively on arm64 and as that container's root: apk needs neither qemu-user
#   nor unshare, neither of which works in the x86_64 images container (kept for
#   Buildroot's x86_64 toolchains) under emulation.
# linux-crypto: the crypto extensions' test kernel (M6.5, images/crypto/):
#   allnoconfig + linux.fragment + images/crypto/linux.fragment, and an
#   initramfs whose static init reports the crypto self-tests (Image,
#   initramfs.cpio). Built natively in Alpine's arm64 container, as alpine-user.
# debian: the official debian-13-nocloud-arm64 qcow2 as published (disk.qcow2),
#   with the kernel (Image) and initrd (initrd.img) taken out of its /boot.
# kvm-unit-tests: the arm64 tests (*.flat) and their unittests.cfg, built with
#   Debian's gcc-aarch64-linux-gnu.
# ltp: the linux image's root filesystem plus a subset of LTP (Buildroot's
#   package, pruned to images/ltp/tests) and the arm64 kernel selftests (abi,
#   signal, tags) built from the kernel tree with Buildroot's toolchain, as
#   rootfs.ext4; it boots linux/Image-defconfig and runs /ltp.sh.
# Outputs go to target/images/<name>/, downloads to target/images/dl/. Output
# hashes are compared with images/SHA256SUMS (a mismatch warns: reproducibility
# is best-effort).
set -euo pipefail

BUILDROOT_TAG=2026.08
BUILDROOT_COMMIT=d5180309b1b66ef3b8eaccca70ad69be8e0729a1
LINUX=6.18.54
LINUX_SHA256=9df30b02dd8102bbd0be52556288ef6889ddbe7f1ddb96fbf847d0becf3eacac
KUT_COMMIT=5a221342a025948fa7d84f0c404748f6ba57f3ad # kvm-unit-tests master, 2026-09-08
ALPINE=3.24.2
ALPINE_SHA256=9bf70a7f18ea44094cbb5f70c58f9af129c8214745743db0e68e5502cc2ce773 # minirootfs
# Alpine keeps only the latest build of each package in its repository, so the
# pins fail loudly (rather than drift) once these are superseded.
ALPINE_PKGS="linux-virt=6.18.53-r0 openrc=0.63.2-r0"
USERLAND_PKGS="xz=5.8.4-r0 lua5.4=5.4.8-r0 sqlite=3.53.4-r0 openssl=3.5.8-r0"
USERLAND_TOOLS="e2fsprogs=1.47.4-r0 e2fsprogs-extra=1.47.4-r0"
CRYPTO_TOOLS="gcc=15.2.0-r5 musl-dev=1.2.6-r2 make=4.4.1-r4 bc=1.08.2-r1 flex=2.6.4-r8 bison=3.8.2-r3 perl=5.42.2-r1 linux-headers=7.0.0-r1 diffutils=3.12-r0 findutils=4.10.0-r1"
USERLAND_CONTAINER=docker.io/library/alpine@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 # 3.24, multi-arch
DEBIAN=20260914-2601
DEBIAN_SHA512=54c8a9b348129796bd28a1df0488f810385f6417cfa2e242ce4d6feb64c54444ed3c505700f3eda3b122763829a9074bf82e06fc8a6635e52c9ae924eb9a509a
export SOURCE_DATE_EPOCH=1788220800 # 2026-09-01T00:00:00Z

cd "$(dirname "$0")/.."
root=$PWD
out=target/images
NAMES=(linux kvm-unit-tests alpine alpine-user linux-crypto debian ltp)

# Buildroot (pinned by tag and checked against the commit) into $1 with the defconfig $2.
buildroot() {
  local br=$out/dl/buildroot-$BUILDROOT_TAG
  mkdir -p "$out/dl"
  [ -d "$br" ] || git clone -q --depth 1 --branch "$BUILDROOT_TAG" https://gitlab.com/buildroot.org/buildroot.git "$br"
  [ "$(git -C "$br" rev-parse HEAD)" = "$BUILDROOT_COMMIT" ] || { echo "buildroot: not $BUILDROOT_COMMIT" >&2; exit 1; }
  export WEBPC_IMAGES=$root/images
  make -s -C "$br" O="$root/$1" BR2_DL_DIR="$root/$out/dl" BR2_DEFCONFIG="$root/$2" defconfig
  make -s -C "$br" O="$root/$1" BR2_DL_DIR="$root/$out/dl" -j"$(nproc)"
}

# The kernel source tree, $out/build/linux-$LINUX.
linux_src() {
  local tar=$out/dl/linux-$LINUX.tar.xz
  [ -f "$tar" ] || wget -q -O "$tar" "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-$LINUX.tar.xz"
  echo "$LINUX_SHA256  $tar" | sha256sum -c --quiet
  [ -d "$out/build/linux-$LINUX" ] || tar -xf "$tar" -C "$out/build"
}

build_linux() {
  local dst=$out/linux bro=$out/build/buildroot
  rm -rf "$bro" "$out/build/linux" "$out/build/linux-defconfig" "$dst"
  mkdir -p "$dst"
  buildroot "$bro" images/buildroot.defconfig
  cp "$bro/images/rootfs.ext2" "$dst/rootfs.ext4"

  # Linux: allnoconfig + the fragment, every fragment line checked.
  linux_src
  local src=$out/build/linux-$LINUX obj=$out/build/linux
  local kmake=(make -s -C "$src" O="$root/$obj" ARCH=arm64 CROSS_COMPILE="$root/$bro/host/bin/aarch64-linux-"
    KBUILD_BUILD_TIMESTAMP=@$SOURCE_DATE_EPOCH KBUILD_BUILD_USER=webpc KBUILD_BUILD_HOST=webpc)
  # base: allnoconfig, or alldefconfig over arm64's defconfig (what `make defconfig` gives).
  local base sfx
  for base in allnoconfig defconfig; do
    sfx=${base#allnoconfig}; sfx=${sfx:+-$sfx}
    obj=$out/build/linux$sfx
    mkdir -p "$obj"
    if [ $base = allnoconfig ]; then
      cp images/linux.fragment "$obj/allconfig"
    else
      cat "$src/arch/arm64/configs/defconfig" images/linux.fragment > "$obj/allconfig"
    fi
    kmake[4]=O=$root/$obj
    "${kmake[@]}" KCONFIG_ALLCONFIG="$root/$obj/allconfig" ${base/defconfig/alldefconfig}
    local missing
    missing=$(grep '^CONFIG_' images/linux.fragment | grep -vxFf "$obj/.config" || true)
    [ -z "$missing" ] || { echo "linux.fragment ($base): not applied:" >&2; echo "$missing" >&2; exit 1; }
    "${kmake[@]}" -j"$(nproc)" Image
    cp "$obj/arch/arm64/boot/Image" "$dst/Image$sfx"
    cp "$obj/System.map" "$dst/System.map$sfx"
    cp "$obj/.config" "$dst/config$sfx"
  done
}

build_ltp() {
  local dst=$out/ltp bro=$out/build/buildroot-ltp src=$out/build/linux-$LINUX obj=$out/build/linux-headers
  rm -rf "$bro" "$obj" "$dst"
  mkdir -p "$bro" "$obj" "$dst"
  cat images/buildroot.defconfig images/ltp/buildroot.fragment > "$bro/webpc_defconfig"
  buildroot "$bro" "$bro/webpc_defconfig"
  # The arm64 selftests, with the kernel's UAPI headers, into the target tree;
  # then Buildroot again to remake the root filesystem with them.
  linux_src
  make -s -C "$src" O="$root/$obj" ARCH=arm64 headers
  local cc=$root/$bro/host/bin/aarch64-linux-
  make -s -C "$src/tools/testing/selftests" O="$root/$obj/kselftest" ARCH=arm64 CROSS_COMPILE="$cc" \
    TARGETS=arm64 ARM64_SUBTARGETS="abi signal tags" KHDR_INCLUDES="-isystem $root/$obj/usr/include" \
    INSTALL_PATH="$root/$bro/target/usr/lib/kselftests" install
  make -s -C "$out/dl/buildroot-$BUILDROOT_TAG" O="$root/$bro" BR2_DL_DIR="$root/$out/dl"
  cp "$bro/images/rootfs.ext2" "$dst/rootfs.ext4"
}

# binfmt_misc: aarch64 ELF executables run under qemu-user (F: opened now, so it works in the chroot).
QEMU_AARCH64_BINFMT=':aarch64:M::\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\xb7\x00:\xff\xff\xff\xff\xff\xff\xff\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff:/usr/bin/qemu-aarch64-static:F'

build_alpine() {
  local dst=$out/alpine r=$out/build/alpine tar=$out/dl/alpine-minirootfs-$ALPINE-aarch64.tar.gz
  rm -rf "$r" "$dst"
  mkdir -p "$r" "$dst"
  [ -f "$tar" ] || wget -q -O "$tar" "https://dl-cdn.alpinelinux.org/alpine/v${ALPINE%.*}/releases/aarch64/${tar##*/}"
  echo "$ALPINE_SHA256  $tar" | sha256sum -c --quiet
  # apk runs the packages' scripts (mkinitfs writes the initramfs), so the root
  # runs aarch64 code: a user namespace with its own binfmt_misc hands it to
  # qemu-user, and makes us root there for chroot and for mke2fs to record
  # files as root's. Its one uid maps to us, so /etc/shadow's group is put back.
  # mkinitfs and mke2fs honor SOURCE_DATE_EPOCH (and mke2fs E2FSPROGS_FAKE_TIME).
  unshare -rm bash -euo pipefail -c '
    r=$1 dst=$2 tar=$3 pkgs=$4
    tar --no-same-owner -xzf "$tar" -C "$r"
    mkdir -p /tmp/binfmt && mount -t binfmt_misc binfmt_misc /tmp/binfmt
    echo "$5" > /tmp/binfmt/register
    cp /etc/resolv.conf "$r/etc/"
    chroot "$r" apk --no-progress --no-cache -q add $pkgs
    # Again, with SOURCE_DATE_EPOCH: apk runs its trigger with a scrubbed environment.
    chroot "$r" mkinitfs -q "$(ls "$r/lib/modules")"
    # The boot test: a local.d script, the local service in the default runlevel,
    # and what an installed system runs at sysinit and boot.
    install -m 755 images/alpine/webpc.start "$r/etc/local.d/"
    chroot "$r" sh -euc "
      for s in devfs dmesg; do rc-update -q add \$s sysinit; done
      for s in modules hostname; do rc-update -q add \$s boot; done
      for s in killprocs mount-ro; do rc-update -q add \$s shutdown; done
      rc-update -q add local default"
    rm "$r/etc/resolv.conf" "$r/var/log/apk.log" # the log is timestamped
    find "$r" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
    mke2fs -q -t ext4 -d "$r" -L alpine -U 77656270-6300-4000-8000-000000000011 \
      -E hash_seed=77656270-6300-4000-8000-000000000012 "$dst/rootfs.ext4" 256M
    debugfs -w -R "sif /etc/shadow gid 42" "$dst/rootfs.ext4" 2>/dev/null
  ' - "$r" "$dst" "$tar" "$ALPINE_PKGS" "$QEMU_AARCH64_BINFMT"
  cp "$r"/boot/initramfs-virt "$dst/initramfs-virt"
  # vmlinuz-virt is EFI zboot: gzip'd Image at the offset and size in bytes 8-15.
  local z=$r/boot/vmlinuz-virt
  tail -c +$(($(od -An -tu4 -j8 -N4 "$z") + 1)) "$z" | head -c "$(od -An -tu4 -j12 -N4 "$z")" | gunzip > "$dst/Image"
}

build_alpine-user() {
  local dst=$out/alpine-user
  [ -f "$out/alpine/rootfs.ext4" ] || { echo "alpine-user needs the alpine image: images/build.sh alpine" >&2; exit 1; }
  rm -rf "$dst"
  mkdir -p "$dst"
  podman run --rm -v "$root:$root:z" -w "$root" -e SOURCE_DATE_EPOCH "$USERLAND_CONTAINER" sh -euc '
    apk add -q --no-cache $3
    r=/tmp/r
    mkdir $r
    debugfs -R "rdump / $r" "$1/alpine/rootfs.ext4" 2>/dev/null
    cp /etc/resolv.conf "$r/etc/"
    chroot "$r" apk --no-progress --no-cache -q add $2
    rm "$r/etc/resolv.conf" "$r/var/log/apk.log" "$r/etc/local.d/webpc.start"
    install -m 755 images/alpine/user/webpc-user.start "$r/etc/local.d/"
    mkdir -p "$r/usr/local/share/webpc"
    install -m 644 images/alpine/user/*.lua images/alpine/user/speed.sql "$r/usr/local/share/webpc/"
    find "$r" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
    # no_copy_xattrs: the host'"'"'s SELinux labels (random per container) would reach the image.
    E2FSPROGS_FAKE_TIME=$SOURCE_DATE_EPOCH mke2fs -q -t ext4 -d "$r" -L alpine-user \
      -U 77656270-6300-4000-8000-000000000013 -E hash_seed=77656270-6300-4000-8000-000000000014,no_copy_xattrs \
      "$1/alpine-user/rootfs-user.ext4" 256M
  ' - "$out" "$USERLAND_PKGS" "$USERLAND_TOOLS"
}

build_linux-crypto() {
  local dst=$out/linux-crypto
  rm -rf "$dst" "$out/build/linux-crypto"
  mkdir -p "$dst"
  linux_src
  podman run --rm -v "$root:$root:z" -w "$root" -e SOURCE_DATE_EPOCH -e root="$root" "$USERLAND_CONTAINER" sh -euc '
    apk add -q --no-cache $1
    src=$root/$2/build/linux-$3 obj=$root/$2/build/linux-crypto dst=$root/$4
    mkdir -p "$obj"
    cat images/linux.fragment images/crypto/linux.fragment > "$obj/allconfig"
    k="make -s -C $src O=$obj ARCH=arm64 KBUILD_BUILD_TIMESTAMP=@$SOURCE_DATE_EPOCH KBUILD_BUILD_USER=webpc KBUILD_BUILD_HOST=webpc"
    $k KCONFIG_ALLCONFIG="$obj/allconfig" allnoconfig
    missing=$(grep "^CONFIG_" "$obj/allconfig" | grep -vxFf "$obj/.config" || true)
    [ -z "$missing" ] || { echo "linux-crypto: not applied:" >&2; echo "$missing" >&2; exit 1; }
    $k -j"$(nproc)" Image
    gcc -static -Os -o "$obj/webpc-init" images/crypto/init.c
    gcc -O2 -o "$obj/gen_init_cpio" "$src/usr/gen_init_cpio.c"
    printf "dir /dev 0755 0 0\nnod /dev/console 0600 0 0 c 5 1\ndir /proc 0755 0 0\nfile /init %s 0755 0 0\n" "$obj/webpc-init" > "$obj/cpio.list"
    "$obj/gen_init_cpio" -t "$SOURCE_DATE_EPOCH" "$obj/cpio.list" > "$dst/initramfs.cpio"
    cp "$obj/arch/arm64/boot/Image" "$dst/Image"
    cp "$obj/.config" "$dst/config"
  ' - "$CRYPTO_TOOLS" "$out" "$LINUX" "$dst"
}

build_debian() {
  local dst=$out/debian b=$out/build/debian q=$out/dl/debian-13-nocloud-arm64-$DEBIAN.qcow2
  rm -rf "$b" "$dst"
  mkdir -p "$b" "$dst"
  [ -f "$q" ] || wget -q -O "$q" "https://cloud.debian.org/images/cloud/trixie/$DEBIAN/${q##*/}"
  echo "$DEBIAN_SHA512  $q" | sha512sum -c --quiet
  # The root filesystem is partition 1: its /boot has the kernel (an arm64 Image) and initrd.
  qemu-img convert -O raw "$q" "$b/disk.raw"
  local start size
  read -r start size < <(sfdisk -d "$b/disk.raw" | sed -n 's/^.*disk.raw1 : start= *\([0-9]*\), size= *\([0-9]*\),.*/\1 \2/p')
  dd if="$b/disk.raw" of="$b/root.img" bs=512 skip="$start" count="$size" conv=sparse status=none
  local v
  v=$(debugfs -R 'ls /boot' "$b/root.img" 2>/dev/null | tr -s ' ' '\n' | sed -n 's/^vmlinuz-//p')
  debugfs -R "dump /boot/vmlinuz-$v $dst/Image" "$b/root.img" 2>/dev/null
  debugfs -R "dump /boot/initrd.img-$v $dst/initrd.img" "$b/root.img" 2>/dev/null
  [ "$(od -An -c -j56 -N4 "$dst/Image" | tr -d ' ')" = ARMd ] || { echo "debian: /boot/vmlinuz-$v is not an arm64 Image" >&2; exit 1; }
  cp "$q" "$dst/disk.qcow2"
  rm -rf "$b"
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
  [ "$1" = alpine ] && files+=(images/alpine/webpc.start)
  [ "$1" = alpine-user ] && files+=($(find images/alpine/user -type f | sort) "$out/alpine/.inputs")
  local pins="^${1^^}"
  [ "$1" = alpine-user ] && pins='^USERLAND_' 
  [ "$1" = linux-crypto ] && files+=(images/linux.fragment $(find images/crypto -type f | sort)) && pins='^(CRYPTO_TOOLS|USERLAND_CONTAINER)'
  [ "$1" = ltp ] && files+=(images/buildroot.defconfig $(find images/overlay images/ltp -type f | sort))
  { cat "${files[@]}"; grep -E '^(BUILDROOT|LINUX|KUT|export SOURCE)' images/build.sh; grep -E "$pins" images/build.sh; declare -f "build_$1"; if [[ $1 == linux || $1 == ltp ]]; then declare -f buildroot linux_src; fi; } |
    sha256sum | cut -c1-16
}

outputs() {
  case $1 in
    linux) echo linux/Image linux/Image-defconfig linux/rootfs.ext4 ;;
    alpine) echo alpine/Image alpine/initramfs-virt alpine/rootfs.ext4 ;;
    alpine-user) echo alpine-user/rootfs-user.ext4 ;;
    linux-crypto) echo linux-crypto/Image linux-crypto/initramfs.cpio ;;
    debian) echo debian/Image debian/initrd.img debian/disk.qcow2 ;;
    kvm-unit-tests) echo kvm-unit-tests/*.flat ;; # run from $out
    ltp) echo ltp/rootfs.ext4 ;;
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

# One image built and checked (its outputs' hashes against images/SHA256SUMS).
build() {
  local name=$1 key sums
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
}

if [ -z "${WEBPC_IN_CONTAINER:-}" ]; then
  rest=() user= crypto=
  for name in "${@:-${NAMES[@]}}"; do
    [[ " ${NAMES[*]} " == *" $name "* ]] || { echo "unknown image $name" >&2; exit 1; }
    if [ "$name" = alpine-user ]; then user=1; elif [ "$name" = linux-crypto ]; then crypto=1; else rest+=("$name"); fi
  done
  if [ ${#rest[@]} -gt 0 ]; then
    tag=webpc-images:$(sha256sum images/Containerfile | cut -c1-12)
    podman image exists "$tag" || podman build -t "$tag" -f images/Containerfile images
    mkdir -p "$out"
    podman run --rm --userns=keep-id -v "$root:$root:z" -w "$root" \
      -e WEBPC_IN_CONTAINER=1 -e HOME=/tmp "$tag" images/build.sh "${rest[@]}"
  fi
  # After the images container: alpine-user builds on alpine, in its own container.
  if [ -n "$user" ]; then build alpine-user; fi
  if [ -n "$crypto" ]; then build linux-crypto; fi
  exit 0
fi

for name in "$@"; do build "$name"; done
