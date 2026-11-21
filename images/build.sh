#!/usr/bin/env bash
# Builds the guest images in rootless Podman, never on the host (docs/images.md).
#   images/build.sh [name...]      names: buildroot, linux, kvm-unit-tests, alpine, alpine-user, alpine-gl, alpine-virgl, linux-crypto, linux-gpu, linux-snd, linux-usb, linux-usbhost, debian, ltp, litmus, fptest, intro, edk2, alpine-uefi, alpine-demo, agent, venus (default: all)
#   images/build.sh --check name   exit 0 if target/images/<name> is current, else say how to rebuild
#   images/build.sh --inputs name  print the key of name's inputs (what --check compares with <name>/.inputs)
# buildroot: Buildroot's BusyBox root filesystem (rootfs.ext4), with Buildroot's
#   own toolchain, built natively in images/buildroot/Containerfile (multi-arch:
#   the host's architecture, arm64 or x86_64), as ltp. kvm-unit-tests runs in
#   images/Containerfile (x86_64: qemu-user on the arm64 VM).
# linux: a Linux Image from allnoconfig + linux.fragment, and Image-defconfig,
#   the same kernel from arm64 defconfig + linux.fragment (the distro-like
#   candidate, M4 step 4); built natively in Alpine's arm64 container (M7: an
#   hour under qemu-user in the images container before), as linux-crypto.
# alpine: Alpine's aarch64 minirootfs plus openrc and linux-virt's modules, as an
#   ext4 root (rootfs.ext4), with the kernel (Image) and initramfs, all from the
#   $ALPINE release (its virt ISO), built natively in Alpine's arm64 container as
#   alpine-user. images/alpine/ has the boot test's local.d script.
# alpine-user: the userspace benchmark's root (M6, images/alpine/user): alpine's
#   rootfs.ext4 plus xz, lua5.4, sqlite and openssl (M6.5) and the workloads, with its local.d
#   script instead of the boot test's, as rootfs-user.ext4 (it boots alpine's
#   Image and initramfs-virt). Built on the host side in Alpine's own container,
#   natively on arm64 and as that container's root: apk needs neither qemu-user
#   nor unshare, neither of which works in the x86_64 images container (kept for
#   Buildroot's x86_64 toolchains) under emulation.
# alpine-gl: the llvmpipe benchmark's root (images/alpine/gl): alpine's rootfs.ext4 plus
#   Mesa (EGL, GLES, the Gallium drivers: llvmpipe), glcomp, a compositor's GLES load, and glquery (occlusion queries waited on)
#   compiled in the same container, with its local.d script instead of the boot test's, as
#   rootfs-gl.ext4 (it boots alpine's Image and initramfs-virt). Built as alpine-user.
# alpine-virgl: G2's virgl guest (docs/graphics.md "The guest's 3D: Mesa's virgl"): alpine-gl's root plus Mesa
#   $MESA built from source with llvmpipe and virgl in /opt/mesa (Alpine's Mesa has no
#   virgl on any architecture), so both renderers run the same build; rootfs-virgl.ext4.
# linux-crypto: the crypto extensions' test kernel (M6.5, images/crypto/):
#   allnoconfig + linux.fragment + images/crypto/linux.fragment, and an
#   initramfs whose static init reports the crypto self-tests (Image,
#   initramfs.cpio). Built natively in Alpine's arm64 container, as alpine-user.
# linux-gpu, linux-snd: the virtio-gpu and virtio-snd test kernels (images/gpu/,
#   images/snd/), the same way: allnoconfig + linux.fragment + their fragment, and an
#   initramfs with their static init.
# linux-usb: the USB test kernel (images/usb/): the same, with the kernel's testusb
#   (tools/usb/testusb.c) beside the init, for the xHCI and Gadget Zero (docs/usb.md).
# linux-usbhost: linux-usb's kernel with cdc_acm, usbhid and hidraw (images/usbhost/), and an init
#   whose usb_mode= runs testusb, an ACM echo or the hidraw checks: the guest-level tests through
#   WebUSB and WebHID (scripts/ci-usb.sh).
# litmus: herdtools7's litmus7 tests for the memory model (M7, images/litmus/):
#   diyone7 makes each test in images/litmus/tests.txt, herd7's aarch64.cat
#   lists its allowed final states (allowed.txt), litmus7 turns it into a
#   static C program; stress.c is the atomics stress, built with LSE and with
#   LL/SC atomics. Output: an initramfs (BusyBox + the tests, booted with
#   linux/Image) and litmus.tar (the same tests for real hardware: the oracle
#   VM). herdtools7 is CeCILL-B: built and run here, never copied into waarm64.
#   Built natively in Alpine's arm64 container, as alpine-user.
# debian: the official debian-13-nocloud-arm64 qcow2 as published (disk.qcow2),
#   with the kernel (Image) and initrd (initrd.img) taken out of its /boot by
#   tools/debian.ts (Node, on the host: the tests' Debian; the pin
#   is images/debian.json).
# kvm-unit-tests: the arm64 tests (*.flat) and their unittests.cfg, built with
#   Debian's gcc-aarch64-linux-gnu.
# ltp: the linux image's root filesystem plus a subset of LTP (Buildroot's
#   package, pruned to images/ltp/tests) and the arm64 kernel selftests (abi,
#   signal, tags) built from the kernel tree with Buildroot's toolchain, as
#   rootfs.ext4; it boots linux/Image-defconfig and runs /ltp.sh.
# edk2: EDK2's ArmVirtQemuKernel firmware (QEMU_EFI.fd, RELEASE), the UEFI that
#   boots unmodified disk images (M8 phase B, docs/firmware.md): an arm64 Image
#   entered like a kernel with the DT in x0, without the network stack (no PXE or
#   HTTP boot). Built natively in Debian's arm64
#   container (apt from snapshot.debian.org, as images/Containerfile). Also
#   shell.img, the firmware tests' disk: a FAT filesystem (no partition table)
#   whose \EFI\BOOT\BOOTAA64.EFI is the build's UEFI Shell, running
#   images/edk2/startup.nsh. images/edk2/*.patch are applied to the source.
# alpine-uefi: Alpine's published UEFI cloud images (images/alpine-uefi.json,
#   pinned by SHA512), which the firmware tests boot unmodified: alpine.qcow2
#   (Limine) and alpine-grub.qcow2 (GRUB). Downloaded on the host, as debian.
# alpine-demo: the Alpine demo's disk (images/alpine-demo/; docs/images.md): Alpine's Limine cloud image (its own pin,
#   images/alpine-demo/base.json) cut
#   to Alpine's base (no tiny-cloud, sshd, chronyd, dhcpcd), root logged in on the serial console, udhcpc on eth0,
#   apk with main (community on demand), a command-not-found hook that installs what's missing, the guest agent's
#   OpenRC service, Limine without its wait and init_on_free=1; a 1 GiB alpine-demo.qcow2. Built natively in Alpine's
#   arm64 container, as alpine-user.
# agent: clipboard sharing's guest agent (agent/, docs/plans/clipboard.md §3.3),
#   waarm64-agent, a static aarch64-unknown-linux-musl binary the page ships: built
#   natively in the Rust project's Alpine image (the toolchain agent/rust-toolchain.toml
#   names), linked by rust-lld. The one image with a fallback: without Podman (a
#   cloud session), the host's cargo builds it the same way (rustup's musl target,
#   rust-lld: no cross gcc) and writes agent/HOST-BUILD beside it, a build for tests
#   that `npm run dist` refuses (docs/images.md "agent"). Where Podman exists, never.
# venus: Vulkan's renderer (vk/, vk/README.md), venus.wasm and its licences (LICENSES.txt), which the page ships:
#   vk/build.sh in Node's Debian image (Node for vk/gen.ts; meson, ninja and Mesa's build tools from
#   snapshot.debian.org, as edk2), its work tree under target/images/build/venus (Mesa, virglrenderer, wasi-sdk),
#   the repository at a fixed path (/src) as the agent's. Not a guest image either: also installed where the page and
#   the tests take it, target/vk/ (with vk/build.sh's stamp, venus.wasm.inputs), over what vk/build.sh made there.
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
ALPINE_ISO_SHA256=a57ba668b5f6b17a670fcf8e799d5d7fe43766ed086d6ce2927b0625bf43dbf6 # alpine-virt ISO
# Alpine's repositories keep only the latest build of each package, so pins on
# them fail loudly (rather than drift) once superseded. A release's media stay on
# the mirror for good: alpine comes only from them (the minirootfs, and the virt
# ISO's kernel, initramfs, modloop and package repository), and the other images
# take what they can from the ISO's repository (alpine_release) first.
ALPINE_KERNEL=6.18.52-0-virt # the ISO's
ALPINE_PKGS="openrc=0.63.2-r0" # from the ISO's repository
USERLAND_PKGS="xz=5.8.4-r0 lua5.4=5.4.8-r0 sqlite=3.53.4-r0 openssl=3.5.8-r0" # openssl from the ISO's
USERLAND_TOOLS="e2fsprogs=1.47.4-r0 e2fsprogs-extra=1.47.4-r0" # the ISO's
GL_PKGS="mesa-egl=26.1.6-r0 mesa-gles=26.1.6-r0 mesa-dri-gallium=26.1.6-r0"
GL_TOOLS="gcc=15.2.0-r5 musl-dev=1.2.6-r3 mesa-dev=26.1.6-r0"
MESA=26.1.6
MESA_SHA256=5296b88a0f1e012e2cb9ada150a2bbadf728ca81e5a4fb2ab43c83a4d2158606
VIRGL_TOOLS="build-base=0.5-r4 meson=1.11.1-r0 samurai=1.2-r8 python3=3.14.10-r1 py3-mako=1.3.12-r0 py3-yaml=6.0.3-r2 py3-packaging=26.2-r0 llvm22-dev=22.1.3-r1 libdrm-dev=2.4.134-r0 expat-dev=2.10.0-r0 zlib-dev=1.4-r0 zstd-dev=1.5.7-r2 bison=3.8.2-r3 flex=2.6.4-r8 linux-headers=7.0.0-r1 elfutils-dev=0.195-r0"
KERNEL_TOOLS="gcc=15.2.0-r5 musl-dev=1.2.6-r3 make=4.4.1-r4 bc=1.08.2-r1 flex=2.6.4-r8 bison=3.8.2-r3 perl=5.42.3-r0 linux-headers=7.0.0-r1 diffutils=3.12-r0 findutils=4.10.0-r1 openssl-dev=3.5.9-r0"
LITMUS_TOOLS="ocaml=4.14.4-r0 dune=3.22.2-r1 ocaml-menhir=20220210-r6 ocaml-menhir-dev=20220210-r6 ocaml-zarith=1.14-r1 ocaml-findlib=1.9.6-r8 gmp-dev=6.3.0-r4 busybox-static=1.37.0-r31 gcc=15.2.0-r5 musl-dev=1.2.6-r3 make=4.4.1-r4 tar=1.35-r5"
HERDTOOLS_TAG=7.58
HERDTOOLS_COMMIT=1ca343e16a2038e406d1ac674e7e3a1b722b36c7
# fptest: Berkeley SoftFloat and TestFloat 3e (the commits scripts/testfloat.sh pins).
FPTEST_SOFTFLOAT=a0c6494cdc11865811dec815d5c0049fba9d82a8
FPTEST_SOFTFLOAT_SHA256=1f719bcc8878be9627f6cfc44a0d6dbddf32bacc70ac81193bcbf2c62f97cbe9
FPTEST_TESTFLOAT=a9c849f1b0eb0264b626d9686ffae167d996e3be
FPTEST_TESTFLOAT_SHA256=54852fd1d11f0109011e54d69952cda097d3c49709ce46e4800353a6e8c764c3
FPTEST_TOOLS="gcc=15.2.0-r5 musl-dev=1.2.6-r3 make=4.4.1-r4 python3=3.14.10-r1 busybox-static=1.37.0-r31 tar=1.35-r5"
EDK2_TAG=edk2-stable202608
EDK2_COMMIT=2970e5699ba6267f3384ffab20f96647578aebc8
EDK2_CONTAINER=docker.io/library/debian@sha256:1808211ab6f37c6fc6a75368651697536f7bf47993f2797befa8908b1254979d # trixie, arm64
EDK2_SNAPSHOT=20260924T000000Z
EDK2_TOOLS="build-essential uuid-dev acpica-tools python3 python-is-python3 dosfstools mtools"
AGENT_CONTAINER=docker.io/library/rust@sha256:0cce0a5e0e8ba67b455257a3a02a1d99005f382748789d6464460028810f1627 # 1.99.0-alpine3.24, multi-arch
AGENT_TOOLCHAIN=1.99.0 # the image's, and agent/rust-toolchain.toml's
AGENT_TOOLS="zopfli=1.0.3_git20260213-r0" # the gzip the page ships (waarm64-agent.gz): 7% smaller than level 6's
VENUS_CONTAINER=docker.io/library/node@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 # 26.13.0-trixie-slim, multi-arch
VENUS_SNAPSHOT=20261106T000000Z # after the image's Debian (2026-11-05)
VENUS_TOOLS="git curl ca-certificates build-essential pkg-config meson ninja-build python3 python3-mako python3-yaml python3-packaging bison flex libdrm-dev libvulkan-dev libzstd-dev zlib1g-dev libexpat1-dev glslang-tools"
# alpine-demo: the tools that take the published image apart (the live repositories'; e2fsprogs is the ISO's), and
# the cloud image's packages it removes, down to alpine-base, e2fsprogs, linux-virt and Limine.
DEMO_TOOLS="qemu-img=11.0.3-r0 sfdisk=2.42.3-r1 mtools=4.0.49-r0"
DEMO_DEL="tiny-cloud chrony dhcpcd doas dosfstools mount nvme-cli openssh sgdisk tzdata"
INTRO_TOOLS="gcc=15.2.0-r5 musl-dev=1.2.6-r3 make=4.4.1-r4 bc=1.08.2-r1 flex=2.6.4-r8 bison=3.8.2-r3 perl=5.42.3-r0 linux-headers=7.0.0-r1 diffutils=3.12-r0 findutils=4.10.0-r1 busybox-static=1.37.0-r31 zopfli=1.0.3_git20260213-r0" # KERNEL_TOOLS less openssl-dev (nothing in this kernel signs or hashes at build time), BusyBox, and the gzip the page ships
# The aports commits Alpine built busybox-static and musl-dev from (the packages' own record: the build checks it), for
# the licences file the page serves: the sources of the binaries inside the image, pinned.
INTRO_BUSYBOX_COMMIT=c3ef5d10e6ef6528852c51f0564963e2f8c1be19
INTRO_MUSL_COMMIT=8f79d39391b46d6dbf1800fb68b8212a21d5ee2e
USERLAND_CONTAINER=docker.io/library/alpine@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 # 3.24, multi-arch
export SOURCE_DATE_EPOCH=1788220800 # 2026-09-01T00:00:00Z

cd "$(dirname "$0")/.."
root=$PWD
out=target/images
NAMES=(buildroot linux kvm-unit-tests alpine alpine-user alpine-gl alpine-virgl linux-crypto linux-gpu linux-snd linux-usb linux-usbhost debian ltp litmus fptest intro edk2 alpine-uefi alpine-demo agent venus)

# Buildroot (pinned by tag and checked against the commit) into $1 with the defconfig $2.
buildroot() {
  local br=$out/dl/buildroot-$BUILDROOT_TAG
  mkdir -p "$out/dl"
  [ -d "$br" ] || git clone -q --depth 1 --branch "$BUILDROOT_TAG" https://gitlab.com/buildroot.org/buildroot.git "$br"
  [ "$(git -C "$br" rev-parse HEAD)" = "$BUILDROOT_COMMIT" ] || { echo "buildroot: not $BUILDROOT_COMMIT" >&2; exit 1; }
  export WAARM64_IMAGES=$root/images
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

build_buildroot() {
  local dst=$out/buildroot bro=$out/build/buildroot
  rm -rf "$bro" "$dst"
  mkdir -p "$dst"
  buildroot "$bro" images/buildroot.defconfig
  cp "$bro/images/rootfs.ext2" "$dst/rootfs.ext4"
}

# The kernels, natively in Alpine's arm64 container: allnoconfig + the fragment
# (Image), and alldefconfig over arm64's defconfig + the fragment
# (Image-defconfig), every fragment line checked.
build_linux() {
  local dst=$out/linux
  rm -rf "$dst" "$out/build/linux" "$out/build/linux-defconfig"
  mkdir -p "$dst"
  linux_src
  podman run --rm -v "$root:$root:z" -w "$root" -e SOURCE_DATE_EPOCH -e root="$root" "$USERLAND_CONTAINER" sh -euc '
    apk add -q --no-cache $1
    src=$root/$2/build/linux-$3 dst=$root/$4
    for base in allnoconfig defconfig; do
      sfx= target=allnoconfig
      [ $base = defconfig ] && sfx=-defconfig target=alldefconfig
      obj=$root/$2/build/linux$sfx
      mkdir -p "$obj"
      if [ $base = allnoconfig ]; then
        cp images/linux.fragment "$obj/allconfig"
      else
        cat "$src/arch/arm64/configs/defconfig" images/linux.fragment > "$obj/allconfig"
      fi
      k="make -s -C $src O=$obj ARCH=arm64 KBUILD_BUILD_TIMESTAMP=@$SOURCE_DATE_EPOCH KBUILD_BUILD_USER=waarm64 KBUILD_BUILD_HOST=waarm64"
      $k KCONFIG_ALLCONFIG="$obj/allconfig" $target
      missing=$(grep "^CONFIG_" images/linux.fragment | grep -vxFf "$obj/.config" || true)
      [ -z "$missing" ] || { echo "linux.fragment ($base): not applied:" >&2; echo "$missing" >&2; exit 1; }
      $k -j"$(nproc)" Image
      cp "$obj/arch/arm64/boot/Image" "$dst/Image$sfx"
      cp "$obj/System.map" "$dst/System.map$sfx"
      cp "$obj/.config" "$dst/config$sfx"
    done
  ' - "$KERNEL_TOOLS" "$out" "$LINUX" "$dst"
}

build_ltp() {
  local dst=$out/ltp bro=$out/build/buildroot-ltp src=$out/build/linux-$LINUX obj=$out/build/linux-headers
  rm -rf "$bro" "$obj" "$dst"
  mkdir -p "$bro" "$obj" "$dst"
  cat images/buildroot.defconfig images/ltp/buildroot.fragment > "$bro/waarm64_defconfig"
  buildroot "$bro" "$bro/waarm64_defconfig"
  # The arm64 and breakpoints selftests, with the kernel's UAPI headers, and
  # images/ltp/debug.c into the target tree; then Buildroot again to remake
  # the root filesystem with them.
  linux_src
  make -s -C "$src" O="$root/$obj" ARCH=arm64 headers
  local cc=$root/$bro/host/bin/aarch64-linux-
  make -s -C "$src/tools/testing/selftests" O="$root/$obj/kselftest" ARCH=arm64 CROSS_COMPILE="$cc" \
    TARGETS="arm64 breakpoints" ARM64_SUBTARGETS="abi signal tags" KHDR_INCLUDES="-isystem $root/$obj/usr/include" \
    INSTALL_PATH="$root/$bro/target/usr/lib/kselftests" install
  "${cc}gcc" -O2 -Wall -Werror -isystem "$root/$obj/usr/include" -o "$bro/target/usr/bin/waarm64-debug" images/ltp/debug.c
  make -s -C "$out/dl/buildroot-$BUILDROOT_TAG" O="$root/$bro" BR2_DL_DIR="$root/$out/dl"
  cp "$bro/images/rootfs.ext2" "$dst/rootfs.ext4"
}

# The $ALPINE release's virt ISO, unpacked into $out/dl/alpine-$ALPINE-iso: boot/
# (the kernel, initramfs and modloop) and apks/ (a package repository: what an
# installer needs, frozen with the release).
alpine_release() {
  local iso=$out/dl/alpine-virt-$ALPINE-aarch64.iso d=$out/dl/alpine-$ALPINE-iso
  mkdir -p "$out/dl"
  [ -f "$iso" ] || wget -q -O "$iso" "https://dl-cdn.alpinelinux.org/alpine/v${ALPINE%.*}/releases/aarch64/${iso##*/}"
  echo "$ALPINE_ISO_SHA256  $iso" | sha256sum -c --quiet
  [ -d "$d" ] && return
  rm -rf "$d.tmp" && mkdir "$d.tmp"
  # bsdtar only reads the pinned ISO: unpinned.
  podman run --rm -v "$root:$root:z" -w "$root" "$USERLAND_CONTAINER" sh -euc '
    apk add -q --no-cache libarchive-tools
    bsdtar -xf "$1" -C "$2" apks boot/vmlinuz-virt boot/initramfs-virt boot/modloop-virt
    chmod -R u+w "$2" # read-only on the ISO
  ' - "$iso" "$d.tmp"
  mv "$d.tmp" "$d"
}

build_alpine() {
  local dst=$out/alpine tar=$out/dl/alpine-minirootfs-$ALPINE-aarch64.tar.gz iso=$out/dl/alpine-$ALPINE-iso
  rm -rf "$dst"
  mkdir -p "$dst"
  [ -f "$tar" ] || wget -q -O "$tar" "https://dl-cdn.alpinelinux.org/alpine/v${ALPINE%.*}/releases/aarch64/${tar##*/}"
  echo "$ALPINE_SHA256  $tar" | sha256sum -c --quiet
  alpine_release
  # As the container's root (owners kept); no network: everything comes from the
  # release. linux-virt's files are its modules (the modloop) and the ISO's kernel
  # and initramfs, which loads virtio_mmio, virtio_blk and ext4 itself.
  # unsquashfs only reads the pinned modloop: unpinned.
  podman run --rm -v "$root:$root:z" -w "$root" -e SOURCE_DATE_EPOCH "$USERLAND_CONTAINER" sh -euc '
    tar=$1 iso=$2 dst=$3 pkgs=$4 tools=$5 kver=$6
    apk add -q --no-cache squashfs-tools
    apk add -q --no-cache --repositories-file /dev/null -X "$iso/apks" $tools
    r=/tmp/r
    mkdir $r
    tar -xpzf "$tar" -C $r
    cp -r "$iso/apks" $r/tmp/apks
    touch $r/tmp/none
    chroot $r apk --no-network --no-progress --no-cache -q --repositories-file /tmp/none -X /tmp/apks add $pkgs
    rm -rf $r/tmp/apks $r/tmp/none $r/var/log/apk.log # the log is timestamped
    unsquashfs -q -n -d /tmp/modloop "$iso/boot/modloop-virt"
    mkdir -p $r/lib/modules
    mv /tmp/modloop/modules/$kver $r/lib/modules/
    # The boot test: a local.d script, the local service in the default runlevel,
    # and what an installed system runs at sysinit and boot.
    install -m 755 images/alpine/waarm64.start $r/etc/local.d/
    chroot $r sh -euc "
      for s in devfs dmesg; do rc-update -q add \$s sysinit; done
      for s in modules hostname; do rc-update -q add \$s boot; done
      for s in killprocs mount-ro; do rc-update -q add \$s shutdown; done
      rc-update -q add local default"
    find $r -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
    E2FSPROGS_FAKE_TIME=$SOURCE_DATE_EPOCH mke2fs -q -t ext4 -d $r -L alpine -U 57413634-0000-4000-8000-000000000011 \
      -E hash_seed=57413634-0000-4000-8000-000000000012,no_copy_xattrs "$dst/rootfs.ext4" 256M
  ' - "$tar" "$iso" "$dst" "$ALPINE_PKGS" "$USERLAND_TOOLS" "$ALPINE_KERNEL"
  cp "$iso/boot/initramfs-virt" "$dst/initramfs-virt"
  # vmlinuz-virt is EFI zboot: gzip'd Image at the offset and size in bytes 8-15.
  local z=$iso/boot/vmlinuz-virt
  tail -c +$(($(od -An -tu4 -j8 -N4 "$z") + 1)) "$z" | head -c "$(od -An -tu4 -j12 -N4 "$z")" | gunzip > "$dst/Image"
}

build_alpine-user() {
  local dst=$out/alpine-user
  [ -f "$out/alpine/rootfs.ext4" ] || { echo "alpine-user needs the alpine image: images/build.sh alpine" >&2; exit 1; }
  rm -rf "$dst"
  mkdir -p "$dst"
  alpine_release
  podman run --rm -v "$root:$root:z" -w "$root" -e SOURCE_DATE_EPOCH "$USERLAND_CONTAINER" sh -euc '
    apk add -q --no-cache -X "$4/apks" $3
    r=/tmp/r
    mkdir $r
    debugfs -R "rdump / $r" "$1/alpine/rootfs.ext4" 2>/dev/null
    cp /etc/resolv.conf "$r/etc/"
    cp -r "$4/apks" "$r/tmp/apks"
    chroot "$r" apk --no-progress --no-cache -q -X /tmp/apks add $2
    rm -r "$r/etc/resolv.conf" "$r/tmp/apks" "$r/var/log/apk.log" "$r/etc/local.d/waarm64.start"
    install -m 755 images/alpine/user/waarm64-user.start "$r/etc/local.d/"
    mkdir -p "$r/usr/local/share/waarm64"
    install -m 644 images/alpine/user/*.lua images/alpine/user/speed.sql "$r/usr/local/share/waarm64/"
    find "$r" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
    # no_copy_xattrs: the host'"'"'s SELinux labels (random per container) would reach the image.
    E2FSPROGS_FAKE_TIME=$SOURCE_DATE_EPOCH mke2fs -q -t ext4 -d "$r" -L alpine-user \
      -U 57413634-0000-4000-8000-000000000013 -E hash_seed=57413634-0000-4000-8000-000000000014,no_copy_xattrs \
      "$1/alpine-user/rootfs-user.ext4" 256M
  ' - "$out" "$USERLAND_PKGS" "$USERLAND_TOOLS" "$out/dl/alpine-$ALPINE-iso"
}

build_alpine-gl() {
  local dst=$out/alpine-gl
  [ -f "$out/alpine/rootfs.ext4" ] || { echo "alpine-gl needs the alpine image: images/build.sh alpine" >&2; exit 1; }
  rm -rf "$dst"
  mkdir -p "$dst"
  alpine_release
  podman run --rm -v "$root:$root:z" -w "$root" -e SOURCE_DATE_EPOCH "$USERLAND_CONTAINER" sh -euc '
    apk add -q --no-cache -X "$5/apks" $3 $4
    r=/tmp/r
    mkdir $r
    debugfs -R "rdump / $r" "$1/alpine/rootfs.ext4" 2>/dev/null
    cp /etc/resolv.conf "$r/etc/"
    chroot "$r" apk --no-progress --no-cache -q add $2
    rm "$r/etc/resolv.conf" "$r/var/log/apk.log" "$r/etc/local.d/waarm64.start"
    install -m 755 images/alpine/gl/waarm64-gl.start "$r/etc/local.d/"
    gcc -O2 -o "$r/usr/local/bin/glcomp" images/alpine/gl/glcomp.c -lEGL -lGLESv2
    gcc -O2 -o "$r/usr/local/bin/glquery" images/alpine/gl/glquery.c -lEGL -lGLESv2
    strip "$r/usr/local/bin/glcomp" "$r/usr/local/bin/glquery"
    find "$r" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
    E2FSPROGS_FAKE_TIME=$SOURCE_DATE_EPOCH mke2fs -q -t ext4 -d "$r" -L alpine-gl \
      -U 57413634-0000-4000-8000-000000000015 -E hash_seed=57413634-0000-4000-8000-000000000016,no_copy_xattrs \
      "$1/alpine-gl/rootfs-gl.ext4" 512M
  ' - "$out" "$GL_PKGS" "$GL_TOOLS" "$USERLAND_TOOLS" "$out/dl/alpine-$ALPINE-iso"
}

build_alpine-virgl() {
  local dst=$out/alpine-virgl tar=$out/dl/mesa-$MESA.tar.xz
  [ -f "$out/alpine-gl/rootfs-gl.ext4" ] || { echo "alpine-virgl needs the alpine-gl image: images/build.sh alpine-gl" >&2; exit 1; }
  mkdir -p "$out/dl"
  [ -f "$tar" ] || wget -q -O "$tar" "https://archive.mesa3d.org/mesa-$MESA.tar.xz"
  echo "$MESA_SHA256  $tar" | sha256sum -c --quiet
  rm -rf "$dst"
  mkdir -p "$dst"
  alpine_release
  podman run --rm -v "$root:$root:z" -w "$root" -e SOURCE_DATE_EPOCH "$USERLAND_CONTAINER" sh -euc '
    apk add -q --no-cache -X "$5/apks" $3 $4
    r=/tmp/r
    mkdir $r
    debugfs -R "rdump / $r" "$1/alpine-gl/rootfs-gl.ext4" 2>/dev/null
    tar -xf "$2" -C /tmp
    cd /tmp/mesa-*
    meson setup b --prefix=/opt/mesa --libdir=lib -Dbuildtype=release -Db_ndebug=true \
      -Dgallium-drivers=llvmpipe,virgl -Dvulkan-drivers= -Dplatforms= -Dglx=disabled -Degl=enabled \
      -Dgles1=disabled -Dgles2=enabled -Dgbm=enabled -Dllvm=enabled -Dshared-llvm=enabled -Dvideo-codecs= \
      -Dgallium-va=disabled -Dgallium-rusticl=false -Dlmsensors=disabled -Dvalgrind=disabled -Dlibunwind=disabled \
      -Dxmlconfig=disabled -Dzstd=enabled >/dev/null
    ninja -C b >/dev/null
    DESTDIR=$r ninja -C b install >/dev/null
    rm -rf "$r/opt/mesa/include" "$r/opt/mesa/lib/pkgconfig"
    cd - >/dev/null
    install -m 755 images/alpine/gl/waarm64-gl.start "$r/etc/local.d/"
    find "$r" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
    E2FSPROGS_FAKE_TIME=$SOURCE_DATE_EPOCH mke2fs -q -t ext4 -d "$r" -L alpine-virgl \
      -U 57413634-0000-4000-8000-000000000017 -E hash_seed=57413634-0000-4000-8000-000000000018,no_copy_xattrs \
      "$1/alpine-virgl/rootfs-virgl.ext4" 512M
  ' - "$out" "$tar" "$VIRGL_TOOLS" "$USERLAND_TOOLS" "$out/dl/alpine-$ALPINE-iso"
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
    k="make -s -C $src O=$obj ARCH=arm64 KBUILD_BUILD_TIMESTAMP=@$SOURCE_DATE_EPOCH KBUILD_BUILD_USER=waarm64 KBUILD_BUILD_HOST=waarm64"
    $k KCONFIG_ALLCONFIG="$obj/allconfig" allnoconfig
    missing=$(grep "^CONFIG_" "$obj/allconfig" | grep -vxFf "$obj/.config" || true)
    [ -z "$missing" ] || { echo "linux-crypto: not applied:" >&2; echo "$missing" >&2; exit 1; }
    $k -j"$(nproc)" Image
    gcc -static -Os -o "$obj/waarm64-init" images/crypto/init.c
    gcc -O2 -o "$obj/gen_init_cpio" "$src/usr/gen_init_cpio.c"
    printf "dir /dev 0755 0 0\nnod /dev/console 0600 0 0 c 5 1\ndir /proc 0755 0 0\nfile /init %s 0755 0 0\n" "$obj/waarm64-init" > "$obj/cpio.list"
    "$obj/gen_init_cpio" -t "$SOURCE_DATE_EPOCH" "$obj/cpio.list" > "$dst/initramfs.cpio"
    cp "$obj/arch/arm64/boot/Image" "$dst/Image"
    cp "$obj/.config" "$dst/config"
  ' - "$KERNEL_TOOLS" "$out" "$LINUX" "$dst"
}

build_linux-gpu() {
  local dst=$out/linux-gpu
  rm -rf "$dst" # the kernel tree in build/linux-gpu stays: make rebuilds what the config changed
  mkdir -p "$dst"
  linux_src
  podman run --rm -v "$root:$root:z" -w "$root" -e SOURCE_DATE_EPOCH -e root="$root" "$USERLAND_CONTAINER" sh -euc '
    apk add -q --no-cache $1
    src=$root/$2/build/linux-$3 obj=$root/$2/build/linux-gpu dst=$root/$4
    mkdir -p "$obj"
    cat images/linux.fragment images/gpu/linux.fragment > "$obj/allconfig"
    k="make -s -C $src O=$obj ARCH=arm64 KBUILD_BUILD_TIMESTAMP=@$SOURCE_DATE_EPOCH KBUILD_BUILD_USER=waarm64 KBUILD_BUILD_HOST=waarm64"
    $k KCONFIG_ALLCONFIG="$obj/allconfig" allnoconfig
    missing=$(grep "^CONFIG_" "$obj/allconfig" | grep -vxFf "$obj/.config" || true)
    [ -z "$missing" ] || { echo "linux-gpu: not applied:" >&2; echo "$missing" >&2; exit 1; }
    $k -j"$(nproc)" Image
    gcc -static -Os -o "$obj/waarm64-init" images/gpu/init.c
    gcc -O2 -o "$obj/gen_init_cpio" "$src/usr/gen_init_cpio.c"
    printf "dir /dev 0755 0 0\nnod /dev/console 0600 0 0 c 5 1\ndir /proc 0755 0 0\nfile /init %s 0755 0 0\n" "$obj/waarm64-init" > "$obj/cpio.list"
    "$obj/gen_init_cpio" -t "$SOURCE_DATE_EPOCH" "$obj/cpio.list" > "$dst/initramfs.cpio"
    cp "$obj/arch/arm64/boot/Image" "$dst/Image"
    cp "$obj/.config" "$dst/config"
  ' - "$KERNEL_TOOLS" "$out" "$LINUX" "$dst"
}

build_linux-snd() {
  local dst=$out/linux-snd
  rm -rf "$dst" # the kernel tree in build/linux-snd stays: make rebuilds what the config changed
  mkdir -p "$dst"
  linux_src
  podman run --rm -v "$root:$root:z" -w "$root" -e SOURCE_DATE_EPOCH -e root="$root" "$USERLAND_CONTAINER" sh -euc '
    apk add -q --no-cache $1
    src=$root/$2/build/linux-$3 obj=$root/$2/build/linux-snd dst=$root/$4
    mkdir -p "$obj"
    cat images/linux.fragment images/snd/linux.fragment > "$obj/allconfig"
    k="make -s -C $src O=$obj ARCH=arm64 KBUILD_BUILD_TIMESTAMP=@$SOURCE_DATE_EPOCH KBUILD_BUILD_USER=waarm64 KBUILD_BUILD_HOST=waarm64 KBUILD_BUILD_VERSION=1" # the version (#1) pinned: a rebuild in the same tree is the same kernel
    $k KCONFIG_ALLCONFIG="$obj/allconfig" allnoconfig
    missing=$(grep "^CONFIG_" "$obj/allconfig" | grep -vxFf "$obj/.config" || true)
    [ -z "$missing" ] || { echo "linux-snd: not applied:" >&2; echo "$missing" >&2; exit 1; }
    $k -j"$(nproc)" Image
    gcc -static -Os -o "$obj/waarm64-init" images/snd/init.c -lm
    gcc -static -Os -s -o "$dst/snd-play" images/snd/play.c # a WAV player for guests without alsa-utils (the page'"'"'s Debian test)
    gcc -static -Os -s -o "$dst/snd-rec" images/snd/rec.c # and a recorder
    gcc -O2 -o "$obj/gen_init_cpio" "$src/usr/gen_init_cpio.c"
    printf "dir /dev 0755 0 0\nnod /dev/console 0600 0 0 c 5 1\ndir /proc 0755 0 0\nfile /init %s 0755 0 0\n" "$obj/waarm64-init" > "$obj/cpio.list"
    "$obj/gen_init_cpio" -t "$SOURCE_DATE_EPOCH" "$obj/cpio.list" > "$dst/initramfs.cpio"
    cp "$obj/arch/arm64/boot/Image" "$dst/Image"
    cp "$obj/.config" "$dst/config"
  ' - "$KERNEL_TOOLS" "$out" "$LINUX" "$dst"
}

build_linux-usb() {
  local dst=$out/linux-usb
  rm -rf "$dst" # the kernel tree in build/linux-usb stays: make rebuilds what the config changed
  mkdir -p "$dst"
  linux_src
  podman run --rm -v "$root:$root:z" -w "$root" -e SOURCE_DATE_EPOCH -e root="$root" "$USERLAND_CONTAINER" sh -euc '
    apk add -q --no-cache $1
    src=$root/$2/build/linux-$3 obj=$root/$2/build/linux-usb dst=$root/$4
    mkdir -p "$obj"
    cat images/linux.fragment images/usb/linux.fragment > "$obj/allconfig"
    k="make -s -C $src O=$obj ARCH=arm64 KBUILD_BUILD_TIMESTAMP=@$SOURCE_DATE_EPOCH KBUILD_BUILD_USER=waarm64 KBUILD_BUILD_HOST=waarm64 KBUILD_BUILD_VERSION=1"
    $k KCONFIG_ALLCONFIG="$obj/allconfig" allnoconfig
    missing=$(grep "^CONFIG_" "$obj/allconfig" | grep -vxFf "$obj/.config" || true)
    [ -z "$missing" ] || { echo "linux-usb: not applied:" >&2; echo "$missing" >&2; exit 1; }
    $k -j"$(nproc)" Image
    gcc -static -Os -o "$obj/waarm64-init" images/usb/init.c
    gcc -static -Os -o "$obj/testusb" "$src/tools/usb/testusb.c" -lpthread # the kernel'"'"'s own (GPL): built and run, not copied
    gcc -O2 -o "$obj/gen_init_cpio" "$src/usr/gen_init_cpio.c"
    printf "dir /dev 0755 0 0\nnod /dev/console 0600 0 0 c 5 1\ndir /proc 0755 0 0\ndir /sys 0755 0 0\nfile /init %s 0755 0 0\nfile /testusb %s 0755 0 0\n" "$obj/waarm64-init" "$obj/testusb" > "$obj/cpio.list"
    "$obj/gen_init_cpio" -t "$SOURCE_DATE_EPOCH" "$obj/cpio.list" > "$dst/initramfs.cpio"
    cp "$obj/arch/arm64/boot/Image" "$dst/Image"
    cp "$obj/.config" "$dst/config"
  ' - "$KERNEL_TOOLS" "$out" "$LINUX" "$dst"
}

build_linux-usbhost() {
  local dst=$out/linux-usbhost
  rm -rf "$dst" # the kernel tree in build/linux-usbhost stays: make rebuilds what the config changed
  mkdir -p "$dst"
  linux_src
  podman run --rm -v "$root:$root:z" -w "$root" -e SOURCE_DATE_EPOCH -e root="$root" "$USERLAND_CONTAINER" sh -euc '
    apk add -q --no-cache $1
    src=$root/$2/build/linux-$3 obj=$root/$2/build/linux-usbhost dst=$root/$4
    mkdir -p "$obj"
    cat images/linux.fragment images/usb/linux.fragment images/usbhost/linux.fragment > "$obj/allconfig"
    k="make -s -C $src O=$obj ARCH=arm64 KBUILD_BUILD_TIMESTAMP=@$SOURCE_DATE_EPOCH KBUILD_BUILD_USER=waarm64 KBUILD_BUILD_HOST=waarm64 KBUILD_BUILD_VERSION=1"
    $k KCONFIG_ALLCONFIG="$obj/allconfig" allnoconfig
    missing=$(grep "^CONFIG_" "$obj/allconfig" | grep -vxFf "$obj/.config" || true)
    [ -z "$missing" ] || { echo "linux-usbhost: not applied:" >&2; echo "$missing" >&2; exit 1; }
    $k -j"$(nproc)" Image
    gcc -static -Os -o "$obj/waarm64-init" images/usbhost/init.c
    gcc -static -Os -o "$obj/testusb" "$src/tools/usb/testusb.c" -lpthread # the kernel'"'"'s own (GPL): built and run, not copied
    gcc -O2 -o "$obj/gen_init_cpio" "$src/usr/gen_init_cpio.c"
    printf "dir /dev 0755 0 0\nnod /dev/console 0600 0 0 c 5 1\ndir /proc 0755 0 0\ndir /sys 0755 0 0\nfile /init %s 0755 0 0\nfile /testusb %s 0755 0 0\n" "$obj/waarm64-init" "$obj/testusb" > "$obj/cpio.list"
    "$obj/gen_init_cpio" -t "$SOURCE_DATE_EPOCH" "$obj/cpio.list" > "$dst/initramfs.cpio"
    cp "$obj/arch/arm64/boot/Image" "$dst/Image"
    cp "$obj/.config" "$dst/config"
  ' - "$KERNEL_TOOLS" "$out" "$LINUX" "$dst"
}

build_litmus() {
  local dst=$out/litmus ht=$out/dl/herdtools7-$HERDTOOLS_TAG
  rm -rf "$dst" "$out/build/litmus"
  mkdir -p "$dst" "$out/build/litmus"
  [ -d "$ht" ] || git clone -q --depth 1 --branch "$HERDTOOLS_TAG" https://github.com/herd/herdtools7.git "$ht"
  [ "$(git -C "$ht" rev-parse HEAD)" = "$HERDTOOLS_COMMIT" ] || { echo "herdtools7: not $HERDTOOLS_COMMIT" >&2; exit 1; }
  linux_src
  podman run --rm -v "$root:$root:z" -w "$root" -e SOURCE_DATE_EPOCH -e root="$root" "$USERLAND_CONTAINER" sh -euc '
    apk add -q --no-cache $1
    ht=$root/$2 b=$root/$3/build/litmus dst=$root/$4 src=$root/$3/build/linux-$5
    (cd "$ht" && sh ./version-gen.sh /usr > /dev/null && dune build -j"$(nproc)" --profile release herd/herd.exe litmus/litmus.exe gen/diyone.exe)
    bin=$ht/_build/default
    # The tests, their allowed states and verdicts, and their C programs.
    mkdir -p "$b/t" "$b/r/litmus"
    grep -v "^#" images/litmus/tests.txt | while read -r name cycle; do
      (cd "$b/t" && "$bin/gen/diyone.exe" -arch AArch64 -oneloc -name "$name" $cycle)
      echo "$name" >> "$b/r/litmus/tests"
    done
    (cd "$b/t" && "$bin/herd/herd.exe" -set-libdir "$ht/herd/libdir" -model aarch64.cat $(sed "s/$/.litmus/" "$b/r/litmus/tests")) |
      awk -f images/litmus/allowed.awk > "$b/r/litmus/allowed.txt"
    # Settings from the Arm machine configs of herdtools7 (aarch64.cfg): they make the
    # M4 show relaxed outcomes (SB, MP ~50 per million); the defaults showed none.
    mkdir "$b/c"
    "$bin/litmus/litmus.exe" -set-libdir "$ht/litmus/libdir" -mode std -driver shell -a 4 -mem direct -st 1 -barrier userfence -affinity incr0 -s 5k -r 200 -linkopt "-static -s" -o "$b/c" $(sed "s|^|$b/t/|; s/$/.litmus/" "$b/r/litmus/tests")
    make -s -C "$b/c" -j"$(nproc)"
    # The atomics stress (stress.c), with LSE and with LL/SC atomics inlined:
    # stress <variant> <-march> <instructions it must contain>.
    stress() {
      gcc -static -s -O2 -march=$2 -mno-outline-atomics -pthread -o "$b/r/litmus/stress-$1" images/litmus/stress.c
      insns=$(objdump -d "$b/r/litmus/stress-$1" | awk "{ print \$3 }" | sort -u) v=$1
      shift 2
      for i; do echo "$insns" | grep -qx "$i" || { echo "stress-$v: no $i" >&2; exit 1; }; done
    }
    stress lse armv8.1-a casal caspal ldadd
    stress llsc armv8-a ldxr stxr ldxp stlxp
    cp "$b"/c/*.exe "$b"/t/*.litmus images/litmus/run.sh images/litmus/check.awk "$b/r/litmus/"
    find "$b/r" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
    tar -C "$b/r" --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$SOURCE_DATE_EPOCH" -cf "$dst/litmus.tar" litmus
    # The initramfs: BusyBox, the init script, the tests.
    gcc -O2 -o "$b/gen_init_cpio" "$src/usr/gen_init_cpio.c"
    { printf "dir /dev 0755 0 0\nnod /dev/console 0600 0 0 c 5 1\n"
      for d in proc tmp bin sbin usr usr/bin usr/sbin litmus; do printf "dir /%s 0755 0 0\n" $d; done
      printf "file /bin/busybox /bin/busybox.static 0755 0 0\nfile /init %s 0755 0 0\n" "$root/images/litmus/init"
      for f in $(cd "$b/r/litmus" && ls); do
        m=0644; case $f in *.exe|run.sh|stress-*) m=0755;; esac
        printf "file /litmus/%s %s %s 0 0\n" "$f" "$b/r/litmus/$f" $m
      done; } > "$b/cpio.list"
    "$b/gen_init_cpio" -t "$SOURCE_DATE_EPOCH" "$b/cpio.list" > "$dst/initramfs.cpio"
  ' - "$LITMUS_TOOLS" "$ht" "$out" "$dst" "$LINUX"
}

# The FP suite (images/fptest/): SoftFloat (ARM's NaN rules) and testfloat_gen
# from the pinned sources, fptest.c and its form tables (forms.py), all static,
# natively in Alpine's arm64 container; an initramfs (BusyBox, the init, the
# suite; booted with linux/Image, waarm64.fptest=<options>) and fptest.tar (the
# same programs and run.sh, for the oracle VM).
build_fptest() {
  local dst=$out/fptest b=$out/build/fptest
  rm -rf "$dst" "$b"
  mkdir -p "$dst" "$b" "$out/dl"
  for p in "softfloat $FPTEST_SOFTFLOAT $FPTEST_SOFTFLOAT_SHA256" "testfloat $FPTEST_TESTFLOAT $FPTEST_TESTFLOAT_SHA256"; do
    set -- $p
    local tar=$out/dl/berkeley-$1-3-$2.tar.gz
    [ -f "$tar" ] || curl -fsSL -o "$tar" "https://github.com/ucb-bar/berkeley-$1-3/archive/$2.tar.gz"
    echo "$3  $tar" | sha256sum -c --quiet
    mkdir "$b/$1" && tar xzf "$tar" -C "$b/$1" --strip-components=1
  done
  linux_src
  podman run --rm -v "$root:$root:z" -w "$root" -e SOURCE_DATE_EPOCH "$USERLAND_CONTAINER" sh -euc '
    apk add -q --no-cache $1
    b=$2 dst=$3 src=$4/build/linux-$5 cfg=Linux-ARM-VFPv2-GCC
    make -s -C "$b/softfloat/build/$cfg" -j"$(nproc)"
    make -s -C "$b/testfloat/build/$cfg" -j"$(nproc)" SOFTFLOAT_DIR=../../../softfloat LINK="gcc -static -s -o \$@" testfloat_gen
    python3 images/fptest/forms.py "$b"
    gcc -static -s -O2 -std=gnu11 -Wall -Werror -I"$b" -I"$b/softfloat/source/include" -o "$b/fptest" images/fptest/fptest.c "$b/softfloat/build/$cfg/softfloat.a"
    mkdir -p "$b/r/fptest"
    cp "$b/fptest" "$b/testfloat/build/$cfg/testfloat_gen" images/fptest/run.sh "$b/r/fptest/"
    find "$b/r" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
    tar -C "$b/r" --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$SOURCE_DATE_EPOCH" -cf "$dst/fptest.tar" fptest
    gcc -O2 -o "$b/gen_init_cpio" "$src/usr/gen_init_cpio.c"
    { printf "dir /dev 0755 0 0\nnod /dev/console 0600 0 0 c 5 1\n"
      printf "nod /dev/null 0666 0 0 c 1 3\n"
      for d in proc tmp bin sbin usr usr/bin usr/sbin fptest; do printf "dir /%s 0755 0 0\n" $d; done
      printf "file /bin/busybox /bin/busybox.static 0755 0 0\nfile /init %s 0755 0 0\n" images/fptest/init
      for f in fptest testfloat_gen; do printf "file /fptest/%s %s 0755 0 0\n" $f "$b/r/fptest/$f"; done; } > "$b/cpio.list"
    "$b/gen_init_cpio" -t "$SOURCE_DATE_EPOCH" "$b/cpio.list" > "$dst/initramfs.cpio"
  ' - "$FPTEST_TOOLS" "$root/$b" "$root/$dst" "$root/$out" "$LINUX"
}

# The introduction's guest (images/intro/; docs/images.md "intro"): a kernel of its own
# (allnoconfig + images/intro/linux.fragment) with its initramfs built in: BusyBox (Alpine's
# static one, its applets linked at build time), the init, the tour and the three toys with their
# sources, all static, natively in Alpine's arm64 container. One file, intro.img, and what the page
# fetches, its gzip (zopfli's: intro.img.gz), with LICENSES.txt (what is inside: the page ships GPL
# binaries here). Its kernel tree
# stays in target/images/build/intro between builds (KBUILD_BUILD_VERSION: the banner's build count
# would otherwise differ from one build to the next).
build_intro() {
  local dst=$out/intro
  rm -rf "$dst"
  mkdir -p "$dst" "$out/dl" "$out/build"
  linux_src
  podman run --rm -v "$root:$root:z" -w "$root" -e SOURCE_DATE_EPOCH -e root="$root" "$USERLAND_CONTAINER" sh -euc '
    apk add -q --no-cache $1
    src=$root/$2/build/linux-$3 obj=$root/$2/build/intro dst=$root/$4 i=images/intro
    # The packages are the ones the licences file names the sources of.
    built() { awk -v p="P:$1" "BEGIN { RS=\"\" } index(\$0, p \"\n\") { print }" /lib/apk/db/installed | sed -n "s/^c://p"; }
    [ "$(built busybox-static)" = "$6" ] && [ "$(built musl-dev)" = "$7" ] || { echo "intro: busybox-static or musl-dev was built from another aports commit: update INTRO_BUSYBOX_COMMIT, INTRO_MUSL_COMMIT" >&2; exit 1; }
    mkdir -p "$obj/toys"
    for t in scope ridges life; do gcc -static -s -O2 -std=gnu11 -Wall -Werror -o "$obj/toys/$t" $i/$t.c -lm; done
    for t in typed session; do gcc -static -s -Os -std=gnu11 -Wall -Werror -o "$obj/toys/$t" $i/$t.c; done
    { printf "dir /dev 0755 0 0\nnod /dev/console 0600 0 0 c 5 1\n"
      for d in proc sys tmp root etc bin sbin usr usr/bin usr/sbin toys; do printf "dir /%s 0755 0 0\n" $d; done
      printf "file /bin/busybox /bin/busybox.static 0755 0 0\n"
      /bin/busybox.static --list-full | sed "s|.*|slink /& /bin/busybox 0777 0 0|"
      printf "file /init %s 0755 0 0\nfile /etc/profile %s 0644 0 0\n" "$root/$i/init" "$root/$i/profile"
      for f in tour cycle; do printf "file /usr/bin/%s %s 0755 0 0\n" $f "$root/$i/$f"; done
      for t in typed session; do printf "file /usr/bin/%s %s 0755 0 0\n" $t "$obj/toys/$t"; done
      for t in scope ridges life; do printf "file /toys/%s %s 0755 0 0\nfile /toys/%s.c %s 0644 0 0\n" $t "$obj/toys/$t" $t "$root/$i/$t.c"; done
      printf "file /toys/screen.h %s 0644 0 0\n" "$root/$i/screen.h"; } > "$obj/cpio.list"
    { cat $i/linux.fragment; printf "CONFIG_INITRAMFS_SOURCE=\"%s\"\n" "$obj/cpio.list"; } > "$obj/allconfig"
    k="make -s -C $src O=$obj ARCH=arm64 KBUILD_BUILD_TIMESTAMP=@$SOURCE_DATE_EPOCH KBUILD_BUILD_USER=waarm64 KBUILD_BUILD_HOST=waarm64 KBUILD_BUILD_VERSION=1"
    $k KCONFIG_ALLCONFIG="$obj/allconfig" allnoconfig
    missing=$(grep "^CONFIG_" "$obj/allconfig" | grep -vxFf "$obj/.config" || true)
    [ -z "$missing" ] || { echo "intro: not applied:" >&2; echo "$missing" >&2; exit 1; }
    $k -j"$(nproc)" Image
    cp "$obj/arch/arm64/boot/Image" "$dst/intro.img"
    zopfli -c "$dst/intro.img" > "$dst/intro.img.gz"
    # What is inside and under which licences, for the page to serve beside it: ours, then the GPL
    # and the note on system calls, both from the kernel tree.
    pkg() { echo " $1 " | sed -n "s/.* $2=\([^ ]*\) .*/\1/p"; }
    { sed "s/@LINUX@/$3/g; s/@LINUX_SHA256@/$5/; s/@BUSYBOX_COMMIT@/$6/g; s/@MUSL_COMMIT@/$7/g; s/@BUSYBOX_PKG@/$(pkg "$1" busybox-static)/; s/@MUSL_PKG@/$(pkg "$1" musl-dev)/" $i/LICENSES.head; sed -n "/GNU GENERAL PUBLIC LICENSE/,\$p" "$src/LICENSES/preferred/GPL-2.0"
      printf "\n\nLinux: the note on system calls\n-------------------------------\n\n"
      sed -n "/NOTE!/,\$p" "$src/LICENSES/exceptions/Linux-syscall-note"; } > "$dst/LICENSES.txt"
    cp "$obj/.config" "$dst/config"
  ' - "$INTRO_TOOLS" "$out" "$LINUX" "$dst" "$LINUX_SHA256" "$INTRO_BUSYBOX_COMMIT" "$INTRO_MUSL_COMMIT"
}

build_debian() {
  rm -rf "$out/debian"
  WAARM64_DL=$root/$out/dl node --disable-warning=ExperimentalWarning tools/debian.ts
}

build_alpine-uefi() {
  rm -rf "$out/alpine-uefi"
  mkdir -p "$out/alpine-uefi"
  WAARM64_DL=$root/$out/dl node --disable-warning=ExperimentalWarning --input-type=module -e '
    import { linkSync, readFileSync } from "node:fs";
    const { download } = await import(process.argv[1] + "/tools/debian.ts");
    const { images } = JSON.parse(readFileSync(process.argv[1] + "/images/alpine-uefi.json", "utf8"));
    for (const [name, pin] of Object.entries(images)) {
      const path = await download({ ...pin, label: `Alpine (${pin.loader})`, pinFile: "images/alpine-uefi.json" });
      linkSync(path, `${process.argv[2]}/${name}.qcow2`);
    }' "$root" "$root/$out/alpine-uefi"
}

# The OpenRC service of the guest agent, as the page gives it (web/app/guest-agent.ts `agentOpenrc`).
agent_openrc() {
  node --input-type=module -e 'import { agentOpenrc } from "./web/app/guest-agent.ts"; process.stdout.write(agentOpenrc())'
}

# The demo's Alpine (docs/images.md `alpine-demo`): Alpine's Limine cloud image (images/alpine-demo/base.json) taken apart in Alpine's arm64 container as its
# root, its packages cut to Alpine's base (apk del: nothing new installed, so nothing from the live repositories goes
# in), images/alpine-demo's files and the agent's service added, and put together again on a 1 GiB disk: the EFI
# partition as published but limine.conf, the root a new ext4 of the rest (fixed UUIDs, every time SOURCE_DATE_EPOCH).
build_alpine-demo() {
  local dst=$out/alpine-demo w=$out/build/alpine-demo
  alpine_release
  rm -rf "$dst" "$w"
  mkdir -p "$dst" "$w"
  # Its base: Alpine's Limine cloud image of images/alpine-demo/base.json (its own pin: alpine-uefi's stays CI's).
  WAARM64_DL=$root/$out/dl node --disable-warning=ExperimentalWarning --input-type=module -e '
    import { linkSync, readFileSync } from "node:fs";
    const { download } = await import(process.argv[1] + "/tools/debian.ts");
    const pin = JSON.parse(readFileSync(process.argv[1] + "/images/alpine-demo/base.json", "utf8"));
    linkSync(await download({ ...pin, label: `Alpine (${pin.loader})`, pinFile: "images/alpine-demo/base.json" }), process.argv[2]);
  ' "$root" "$root/$w/base.qcow2"
  agent_openrc > "$w/waarm64-agent"
  podman run --rm -v "$root:$root:z" -w "$root" -e SOURCE_DATE_EPOCH "$USERLAND_CONTAINER" sh -euc '
    out=$1 w=$2 iso=$3 dst=$4 del=$5
    apk add -q --no-cache -X "$iso/apks" $6
    apk add -q --no-cache $7
    qemu-img convert -O raw $w/base.qcow2 $w/in.raw
    # The published layout, checked: EFI at 1 MiB (185 MiB in 3.24.4; 96 MiB in 3.24.2), "/" after it.
    sfdisk -d $w/in.raw | grep -q "in.raw1 : start=        2048, size=      378880, .*name=\"EFI\"" || { echo "alpine-demo: not the EFI partition expected" >&2; exit 1; }
    set -- $(sfdisk -d $w/in.raw | sed -n "s/.*in.raw2 : start= *\([0-9]*\), size= *\([0-9]*\),.*/\1 \2/p")
    [ "$1" = 380928 ] || { echo "alpine-demo: not the root partition expected" >&2; exit 1; }
    dd if=$w/in.raw of=$w/efi.vfat bs=512 skip=2048 count=378880 status=none
    dd if=$w/in.raw of=$w/in.ext4 bs=512 skip=$1 count=$2 status=none
    rm $w/in.raw
    # Limine: no menu wait, the demo'"'"'s command line (init_on_free=1: what the kernel frees is zero, out of a snapshot).
    cp images/alpine-demo/limine.conf $w/limine.conf
    touch -d "@$SOURCE_DATE_EPOCH" $w/limine.conf
    mcopy -o -m -i $w/efi.vfat $w/limine.conf ::/limine/limine.conf
    r=/tmp/r
    mkdir $r
    debugfs -R "rdump / $r" $w/in.ext4 2>/dev/null
    rm $w/in.ext4
    # Alpine'"'"'s base: what the cloud image adds over it removed (tiny-cloud, sshd, chronyd, dhcpcd: udhcpc instead).
    chroot $r apk del --no-network --no-progress -q $del
    for l in $r/etc/runlevels/*/*; do [ -e "$r$(readlink "$l")" ] || rm "$l"; done
    rm -rf $r/var/log/apk.log $r/var/lib/cloud $r/etc/tiny-cloud.conf* $r/etc/ssh $r/etc/chrony $r/etc/doas.d $r/etc/dhcpcd.conf*
    install -m 644 images/alpine-demo/inittab $r/etc/inittab
    install -m 644 images/alpine-demo/interfaces $r/etc/network/interfaces
    install -m 644 images/alpine-demo/repositories $r/etc/apk/repositories
    install -m 644 images/alpine-demo/motd $r/etc/motd
    install -m 644 images/alpine-demo/command-not-found.sh $r/etc/profile.d/command-not-found.sh
    install -m 755 $w/waarm64-agent $r/etc/init.d/waarm64-agent
    ln -s /etc/init.d/waarm64-agent $r/etc/runlevels/default/waarm64-agent
    echo alpine > $r/etc/hostname
    rm -rf $r/etc/apk/cache $r/var/cache/apk/*
    find $r -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
    # A 1 GiB disk: the EFI partition as it was, "/" the rest.
    truncate -s 1G $w/disk.raw
    printf "%s\n" "label: gpt" "label-id: 57413634-0000-4000-8000-000000000021" "unit: sectors" \
      "start=2048, size=378880, type=C12A7328-F81F-11D2-BA4B-00A0C93EC93B, uuid=57413634-0000-4000-8000-000000000022, name=\"EFI\"" \
      "start=380928, type=0FC63DAF-8483-4772-8E79-3D69D8477DE4, uuid=57413634-0000-4000-8000-000000000023, name=\"/\"" |
      sfdisk -q $w/disk.raw
    set -- $(sfdisk -d $w/disk.raw | sed -n "s/.*disk.raw2 : start= *\([0-9]*\), size= *\([0-9]*\),.*/\1 \2/p")
    # Its inode tables and journal written out here (zeros: free in the qcow2 and the pieces), not by the guest
    # first mount: a lazy init wrote 15 MB of zeros into the overlay of a template made from it.
    E2FSPROGS_FAKE_TIME=$SOURCE_DATE_EPOCH mke2fs -q -t ext4 -d $r -L / -U 57413634-0000-4000-8000-000000000024 \
      -E hash_seed=57413634-0000-4000-8000-000000000025,no_copy_xattrs,lazy_itable_init=0,lazy_journal_init=0 $w/root.ext4 $(($2 / 2))k
    e2fsck -fn $w/root.ext4 >/dev/null
    dd if=$w/efi.vfat of=$w/disk.raw bs=512 seek=2048 conv=notrunc status=none
    dd if=$w/root.ext4 of=$w/disk.raw bs=512 seek=$1 conv=notrunc status=none
    # One coroutine: the clusters in order, so the file is the same each time.
    qemu-img convert -m 1 -c -O qcow2 $w/disk.raw $dst/alpine-demo.qcow2
    rm $w/disk.raw $w/root.ext4 $w/efi.vfat
  ' - "$out" "$w" "$out/dl/alpine-$ALPINE-iso" "$dst" "$DEMO_DEL" "$USERLAND_TOOLS" "$DEMO_TOOLS"
}

# EDK2 (pinned by tag, checked against the commit; its submodules pinned by it)
# into a fresh copy of the tree, built natively in Debian's arm64 container.
build_edk2() {
  local dst=$out/edk2 src=$out/dl/edk2-$EDK2_TAG b=$out/build/edk2
  if [ ! -d "$src" ]; then
    git clone -q --depth 1 --branch "$EDK2_TAG" https://github.com/tianocore/edk2.git "$src"
    git -C "$src" submodule update -q --init --depth 1 --jobs 8
  fi
  [ "$(git -C "$src" rev-parse HEAD)" = "$EDK2_COMMIT" ] || { echo "edk2: not $EDK2_COMMIT" >&2; exit 1; }
  rm -rf "$b" "$dst"
  mkdir -p "$b" "$dst"
  tar -C "$src" --exclude=.git -cf - . | tar -C "$b" -xf -
  cp images/edk2/startup.nsh "$b/"
  # waarm64's own driver (images/edk2/Waarm64XhciDxe, MIT): the DT's generic-xhci as a non-discoverable xHCI, so the
  # firmware's USB stack drives the machine's controller and the page's built-in keyboard (docs/usb.md "The keyboard").
  # usb-xhci.patch adds it and NonDiscoverablePciDeviceDxe to ArmVirtQemuKernel's build.
  cp -r images/edk2/Waarm64XhciDxe "$b/ArmVirtPkg/"
  # The firmware on the screen (docs/firmware.md "Our patches"): the boot manager connects a
  # virtio-gpu on virtio-mmio before the console, as it does PCI displays, so its GOP joins ConOut and shows
  # the logo and the firmware's text (virtio-gpu-console); the boot progress bar draws in one Blt a second,
  # not one per block (boot-logo-progress); and the GOP flushes what its Blts wrote once a frame, not after each
  # (virtio-gpu-deferred-flush: the page answers a flush a frame, and the menus draw a character per Blt).
  for p in images/edk2/*.patch; do git apply --directory="$b" "$p"; done
  # The serial console offers text modes up to 240x56 and GRUB takes the largest, asking the terminal
  # to resize itself (xterm's CSI 8;r;c t). The page's terminal is 80 columns, where the menu is lost:
  # offer the 80x25 mode alone (docs/firmware.md "Our patches"). When it can go: docs/backlog.md
  # "EDK2's terminal modes" (a virtio-gpu machine's GRUB draws on the screen already).
  sed -i -E '/^  \{ (80, +50|100, 31|128, 40|160, 42|240, 56) \}/d' "$b/MdeModulePkg/Universal/Console/TerminalDxe/Terminal.c"
  [ "$(grep -c -E '^  \{ [0-9]+, +[0-9]+ \}' "$b/MdeModulePkg/Universal/Console/TerminalDxe/Terminal.c")" = 1 ] || { echo "edk2: the terminal's mode table changed" >&2; exit 1; }
  podman run --rm -v "$root:$root:z" -w "$root/$b" -e SOURCE_DATE_EPOCH "$EDK2_CONTAINER" bash -ec '
    export DEBIAN_FRONTEND=noninteractive
    rm -f /etc/apt/sources.list.d/* /etc/apt/sources.list
    printf "Types: deb\nURIs: http://snapshot.debian.org/archive/debian/%s\nSuites: trixie trixie-updates\nComponents: main\nCheck-Valid-Until: no\n" "$1" > /etc/apt/sources.list.d/snapshot.sources
    apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends $2 >/dev/null
    make -s -C BaseTools -j"$(nproc)" >/dev/null 2>&1 || make -C BaseTools
    export PYTHON_COMMAND=python3 # edksetup.sh reads it unset (and fails under set -u)
    set -- # and takes the positional parameters for its own options
    . ./edksetup.sh >/dev/null
    # Reproducible: BaseTools draws the stack cookies at random into these lists and
    # picks from them by hash(GUID) (so a fixed hash seed too). They are public in the
    # binary either way.
    d=Build/ArmVirtQemuKernel-AArch64/RELEASE_GCC && mkdir -p $d
    python3 -c "import hashlib, json, sys; [json.dump([int.from_bytes(hashlib.sha256(b\"waarm64-edk2-%d-%d\" % (b, i)).digest()[:b // 8], \"little\") % ((1 << b) - 1) for i in range(100)], open(sys.argv[1] + \"/StackCookieValues%d.json\" % b, \"w\")) for b in (32, 64)]" $d
    export PYTHONHASHSEED=0
    build -s -a AARCH64 -t GCC -b RELEASE -p ArmVirtPkg/ArmVirtQemuKernel.dsc -D NETWORK_ENABLE=FALSE -n "$(nproc)" > build.log 2>&1 || { tail -30 build.log; exit 1; }
    # The test disk: 8 MiB of FAT, a fixed volume ID, every timestamp SOURCE_DATE_EPOCH.
    img=Build/shell.img && rm -f $img
    cp $d/AARCH64/Shell.efi Build/BOOTAA64.EFI && touch -d @$SOURCE_DATE_EPOCH startup.nsh Build/BOOTAA64.EFI
    mkfs.fat -C -i 57413634 -n WAARM64 $img 8192 >/dev/null
    mmd -i $img ::/EFI ::/EFI/BOOT
    mcopy -m -i $img Build/BOOTAA64.EFI ::/EFI/BOOT/ && mcopy -m -i $img startup.nsh ::/
  ' - "$EDK2_SNAPSHOT" "$EDK2_TOOLS"
  cp "$b/Build/ArmVirtQemuKernel-AArch64/RELEASE_GCC/FV/QEMU_EFI.fd" "$b/Build/shell.img" "$dst/"
  # The binary goes to users, so its licenses go with it: EDK2's, and those of the
  # submodules linked in (OpenSSL in Hash2DxeCrypto, libfdt).
  { echo "QEMU_EFI.fd: EDK2 $EDK2_TAG ($EDK2_COMMIT), ArmVirtPkg/ArmVirtQemuKernel.dsc, built by waarm64's images/build.sh edk2."
    echo "It also holds Waarm64XhciDxe, waarm64's own driver (MIT, as the rest of waarm64: images/edk2/Waarm64XhciDxe in its sources)."
    for f in License.txt CryptoPkg/Library/OpensslLib/openssl/LICENSE.txt MdePkg/Library/BaseFdtLib/libfdt/BSD-2-Clause; do
      printf '\n==== %s ====\n\n' "$f"; cat "$src/$f"
    done; } > "$dst/LICENSES.txt"
}

# The agent (agent/): in its image, the repository at a fixed path (/src) and the crates' cache under
# target/images/build/agent, so the binary doesn't depend on the checkout's path. Without Podman, the host's cargo.
build_agent() {
  local dst=$out/agent b=$out/build/agent
  [ "$(sed -n 's/^channel = "\(.*\)"$/\1/p' agent/rust-toolchain.toml)" = "$AGENT_TOOLCHAIN" ] || { echo "agent: agent/rust-toolchain.toml isn't $AGENT_TOOLCHAIN" >&2; exit 1; }
  rm -rf "$dst" "$b/target"
  mkdir -p "$dst" "$b"
  local cargo=(cargo build --locked --release --target aarch64-unknown-linux-musl)
  if command -v podman >/dev/null; then
    podman run --rm --userns=keep-id -v "$root:/src:z" -w /src/agent -e RUSTUP_TOOLCHAIN="$AGENT_TOOLCHAIN" \
      -e CARGO_HOME="/src/$b/cargo" -e CARGO_TARGET_DIR="/src/$b/target" "$AGENT_CONTAINER" "${cargo[@]}"
  else
    echo "agent: no Podman, so the host's cargo builds it (marked HOST-BUILD: for tests, not for distribution)" >&2
    (cd agent && rustup toolchain install && CARGO_TARGET_DIR="$root/$b/target" "${cargo[@]}")
    printf '%s\n' "Built by the host's cargo (images/build.sh agent without Podman): for tests only, not the shipped build." \
      "npm run dist refuses it; images/build.sh agent where Podman is builds that one (docs/images.md \"agent\")." > "$dst/HOST-BUILD"
  fi
  cp "$b/target/aarch64-unknown-linux-musl/release/waarm64-agent" "$dst/"
  # What the page fetches and hands to fw_cfg as it is (web/app/guest-agent.ts): zopfli's gzip, in the image as root
  # (apk; rootless, so the file is still the user's). Without Podman, gzip -9 (a HOST-BUILD anyway).
  if command -v podman >/dev/null; then
    podman run --rm -v "$root/$dst:/a:z" "$AGENT_CONTAINER" \
      sh -c "apk add -q --no-cache $AGENT_TOOLS && zopfli -c /a/waarm64-agent > /a/waarm64-agent.gz"
  else
    gzip -9nc "$dst/waarm64-agent" > "$dst/waarm64-agent.gz"
  fi
}

# Vulkan's renderer (vk/build.sh) in Node's Debian image, its work tree kept for the next build.
build_venus() {
  local dst=$out/venus b=$out/build/venus
  rm -rf "$dst"
  mkdir -p "$dst" "$b"
  podman run --rm -v "$root:/src:z" -w /src -e SOURCE_DATE_EPOCH -e VK_WORK="/src/$b" "$VENUS_CONTAINER" bash -ec '
    export DEBIAN_FRONTEND=noninteractive
    rm -f /etc/apt/sources.list.d/* /etc/apt/sources.list
    printf "Types: deb\nURIs: http://snapshot.debian.org/archive/debian/%s\nSuites: trixie trixie-updates\nComponents: main\nCheck-Valid-Until: no\n" "$1" > /etc/apt/sources.list.d/snapshot.sources
    apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends $2 >/dev/null
    vk/build.sh
  ' - "$VENUS_SNAPSHOT" "$VENUS_TOOLS"
  cp "$b/venus.wasm" "$b/LICENSES.txt" "$dst/"
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
  local files=(images/Containerfile) pins="^${1^^}"
  [[ $1 == buildroot || $1 == ltp ]] && files=(images/buildroot/Containerfile)
  [ "$1" = buildroot ] && files+=(images/buildroot.defconfig $(find images/overlay -type f | sort))
  [ "$1" = linux ] && files+=(images/linux.fragment) && pins='^(KERNEL_TOOLS|USERLAND_CONTAINER)'
  [ "$1" = debian ] && files+=(images/debian.json) && pins='^export SOURCE'
  [ "$1" = alpine ] && files+=(images/alpine/waarm64.start) && pins='^(ALPINE|USERLAND_TOOLS|USERLAND_CONTAINER)'
  [ "$1" = alpine-user ] && files+=($(find images/alpine/user -type f | sort) "$out/alpine/.inputs")
  [ "$1" = alpine-user ] && pins='^USERLAND_' 
  [ "$1" = alpine-gl ] && files+=($(find images/alpine/gl -type f | sort) "$out/alpine/.inputs") && pins='^(GL_|USERLAND_TOOLS|USERLAND_CONTAINER)'
  [ "$1" = alpine-virgl ] && files+=($(find images/alpine/gl -type f | sort) "$out/alpine-gl/.inputs") && pins='^(MESA|VIRGL_TOOLS|USERLAND_TOOLS|USERLAND_CONTAINER)'
  [ "$1" = linux-crypto ] && files+=(images/linux.fragment $(find images/crypto -type f | sort)) && pins='^(KERNEL_TOOLS|USERLAND_CONTAINER)'
  [ "$1" = linux-gpu ] && files+=(images/linux.fragment $(find images/gpu -type f | sort)) && pins='^(KERNEL_TOOLS|USERLAND_CONTAINER)'
  [ "$1" = linux-snd ] && files+=(images/linux.fragment $(find images/snd -type f | sort)) && pins='^(KERNEL_TOOLS|USERLAND_CONTAINER)'
  [ "$1" = linux-usb ] && files+=(images/linux.fragment $(find images/usb -type f | sort)) && pins='^(KERNEL_TOOLS|USERLAND_CONTAINER)'
  [ "$1" = linux-usbhost ] && files+=(images/linux.fragment $(find images/usb images/usbhost -type f | sort)) && pins='^(KERNEL_TOOLS|USERLAND_CONTAINER)'
  [ "$1" = litmus ] && files+=($(find images/litmus -type f | sort)) && pins='^(LITMUS_TOOLS|HERDTOOLS|USERLAND_CONTAINER|LINUX)'
  [ "$1" = fptest ] && files+=($(find images/fptest -type f | sort)) && pins='^(FPTEST_|USERLAND_CONTAINER|LINUX)'
  [ "$1" = intro ] && files+=($(find images/intro -type f | sort)) && pins='^(INTRO_|USERLAND_CONTAINER)'
  [ "$1" = edk2 ] && files+=(images/edk2/startup.nsh images/edk2/*.patch $(find images/edk2/Waarm64XhciDxe -type f | sort)) && pins='^EDK2_'
  [ "$1" = alpine-uefi ] && files+=(images/alpine-uefi.json) && pins='^ALPINE_UEFI_' # none: '^$' matched every blank line
  [ "$1" = alpine-demo ] && files+=($(find images/alpine-demo -type f | sort)) && pins='^(ALPINE|USERLAND_TOOLS|USERLAND_CONTAINER|DEMO_)'
  [ "$1" = agent ] && files=(agent/Cargo.toml agent/Cargo.lock agent/rust-toolchain.toml agent/.cargo/config.toml agent/no-unwind.ld $(find agent/src -type f | sort)) && pins='^AGENT_'
  [ "$1" = venus ] && files=(vk/build.sh) && pins='^VENUS_'
  [ "$1" = ltp ] && files+=(images/buildroot.defconfig $(find images/overlay images/ltp -type f | sort))
  { cat "${files[@]}"; grep -E '^(BUILDROOT|LINUX|KUT|export SOURCE)' images/build.sh; grep -E "$pins" images/build.sh; declare -f "build_$1"; if [[ $1 == buildroot || $1 == ltp ]]; then declare -f buildroot; fi; if [[ $1 == linux || $1 == ltp || $1 == linux-crypto || $1 == linux-gpu || $1 == linux-snd || $1 == linux-usb || $1 == linux-usbhost || $1 == fptest || $1 == intro ]]; then declare -f linux_src; fi; if [[ $1 == alpine* ]]; then declare -f alpine_release; fi; if [ "$1" = agent ]; then command -v podman >/dev/null && echo podman || echo host; fi; if [ "$1" = venus ]; then vk/build.sh --inputs; fi; if [ "$1" = alpine-demo ]; then agent_openrc; fi; } |
    sha256sum | cut -c1-16
}

outputs() {
  case $1 in
    buildroot) echo buildroot/rootfs.ext4 ;;
    linux) echo linux/Image linux/Image-defconfig ;;
    alpine) echo alpine/Image alpine/initramfs-virt alpine/rootfs.ext4 ;;
    alpine-user) echo alpine-user/rootfs-user.ext4 ;;
    alpine-gl) echo alpine-gl/rootfs-gl.ext4 ;;
    alpine-virgl) echo alpine-virgl/rootfs-virgl.ext4 ;;
    linux-crypto) echo linux-crypto/Image linux-crypto/initramfs.cpio ;;
    linux-gpu) echo linux-gpu/Image linux-gpu/initramfs.cpio ;;
    linux-snd) echo linux-snd/Image linux-snd/initramfs.cpio linux-snd/snd-play linux-snd/snd-rec ;;
    linux-usb) echo linux-usb/Image linux-usb/initramfs.cpio ;;
    linux-usbhost) echo linux-usbhost/Image linux-usbhost/initramfs.cpio ;;
    debian) echo debian/disk.qcow2 ;;
    kvm-unit-tests) echo kvm-unit-tests/*.flat ;; # run from $out
    ltp) echo ltp/rootfs.ext4 ;;
    litmus) echo litmus/initramfs.cpio litmus/litmus.tar ;;
    fptest) echo fptest/initramfs.cpio fptest/fptest.tar ;;
    intro) echo intro/intro.img intro/intro.img.gz intro/LICENSES.txt ;;
    edk2) echo edk2/QEMU_EFI.fd edk2/LICENSES.txt edk2/shell.img ;;
    alpine-uefi) echo alpine-uefi/alpine.qcow2 alpine-uefi/alpine-grub.qcow2 ;;
    alpine-demo) echo alpine-demo/alpine-demo.qcow2 ;;
    agent) echo agent/waarm64-agent agent/waarm64-agent.gz ;;
    venus) echo venus/venus.wasm venus/LICENSES.txt ;;
  esac
}

if [ "${1:-}" = --inputs ]; then
  inputs "${2:?--inputs needs an image name}"
  exit 0
fi

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
    # A failed build (a pin gone from Alpine's repositories, say) leaves the
    # previous image where it was. Out of `if`, so that errexit holds inside.
    rm -rf "$out/$name.prev"
    [ ! -e "$out/$name" ] || mv "$out/$name" "$out/$name.prev"
    set +e
    (set -e; "build_$name")
    local status=$?
    set -e
    if [ $status -ne 0 ]; then
      rm -rf "$out/$name"
      [ ! -e "$out/$name.prev" ] || mv "$out/$name.prev" "$out/$name"
      echo "$name: build failed; the previous image is unchanged" >&2
      exit $status
    fi
    rm -rf "$out/$name.prev"
    echo "$key" > "$out/$name/.inputs"
  fi
  sums=$(cd "$out" && sha256sum $(outputs "$name"))
  echo "$sums"
  [ "$sums" = "$(grep " $name/" images/SHA256SUMS 2>/dev/null)" ] ||
    echo "WARNING: $name differs from images/SHA256SUMS (update it if the inputs changed on purpose)" >&2
}

if [ -z "${WAARM64_IN_CONTAINER:-}" ]; then
  rest=() br=() alpine= user= gl= virgl= crypto= gpu= snd= usb= usbhost= litmus= fptest= intro= kernel= debian= edk2= alpine_uefi= alpine_demo= agent= venus=
  for name in "${@:-${NAMES[@]}}"; do
    [[ " ${NAMES[*]} " == *" $name "* ]] || { echo "unknown image $name" >&2; exit 1; }
    if [ "$name" = alpine ]; then alpine=1; elif [ "$name" = alpine-user ]; then user=1; elif [ "$name" = alpine-gl ]; then gl=1; elif [ "$name" = alpine-virgl ]; then virgl=1; elif [ "$name" = linux-crypto ]; then crypto=1; elif [ "$name" = linux-gpu ]; then gpu=1; elif [ "$name" = linux-snd ]; then snd=1; elif [ "$name" = linux-usb ]; then usb=1; elif [ "$name" = linux-usbhost ]; then usbhost=1; elif [ "$name" = litmus ]; then litmus=1; elif [ "$name" = fptest ]; then fptest=1; elif [ "$name" = intro ]; then intro=1; elif [ "$name" = linux ]; then kernel=1; elif [ "$name" = debian ]; then debian=1; elif [ "$name" = edk2 ]; then edk2=1; elif [ "$name" = alpine-uefi ]; then alpine_uefi=1; elif [ "$name" = alpine-demo ]; then alpine_demo=1; elif [ "$name" = agent ]; then agent=1; elif [ "$name" = venus ]; then venus=1; elif [ "$name" = buildroot ] || [ "$name" = ltp ]; then br+=("$name"); else rest+=("$name"); fi
  done
  # The Buildroot images, natively in the host's architecture.
  if [ ${#br[@]} -gt 0 ]; then
    tag=waarm64-buildroot:$(sha256sum images/buildroot/Containerfile | cut -c1-12)
    podman image exists "$tag" || podman build -t "$tag" -f images/buildroot/Containerfile images/buildroot
    mkdir -p "$out"
    podman run --rm --userns=keep-id -v "$root:$root:z" -w "$root" \
      -e WAARM64_IN_CONTAINER=1 -e HOME=/tmp "$tag" images/build.sh "${br[@]}"
  fi
  if [ ${#rest[@]} -gt 0 ]; then
    tag=waarm64-images:$(sha256sum images/Containerfile | cut -c1-12)
    podman image exists "$tag" || podman build -t "$tag" -f images/Containerfile images
    mkdir -p "$out"
    podman run --rm --userns=keep-id -v "$root:$root:z" -w "$root" \
      -e WAARM64_IN_CONTAINER=1 -e HOME=/tmp "$tag" images/build.sh "${rest[@]}"
  fi
  # After the images container, the ones built natively in Alpine's arm64
  # container (alpine-user builds on alpine).
  if [ -n "$kernel" ]; then build linux; fi
  if [ -n "$debian" ]; then build debian; fi # Node on the host (tools/debian.ts)
  if [ -n "$alpine_uefi" ]; then build alpine-uefi; fi # the same
  if [ -n "$alpine_demo" ]; then build alpine-demo; fi # after alpine-uefi
  if [ -n "$alpine" ]; then build alpine; fi
  if [ -n "$user" ]; then build alpine-user; fi
  if [ -n "$gl" ]; then build alpine-gl; fi
  if [ -n "$virgl" ]; then build alpine-virgl; fi
  if [ -n "$crypto" ]; then build linux-crypto; fi
  if [ -n "$gpu" ]; then build linux-gpu; fi
  if [ -n "$snd" ]; then build linux-snd; fi
  if [ -n "$usb" ]; then build linux-usb; fi
  if [ -n "$usbhost" ]; then build linux-usbhost; fi
  if [ -n "$litmus" ]; then build litmus; fi
  if [ -n "$fptest" ]; then build fptest; fi
  if [ -n "$intro" ]; then build intro; fi
  if [ -n "$edk2" ]; then build edk2; fi
  if [ -n "$agent" ]; then build agent; fi # Podman, or the host's cargo without it
  if [ -n "$venus" ]; then # and where the page and the tests take it (vk/build.sh's place), with its stamp
    build venus
    mkdir -p target/vk && cp "$out/venus/venus.wasm" "$out/venus/LICENSES.txt" target/vk/ && vk/build.sh --inputs > target/vk/venus.wasm.inputs
  fi
  exit 0
fi

for name in "$@"; do build "$name"; done
