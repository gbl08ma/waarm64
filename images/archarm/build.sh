#!/usr/bin/env bash
# Arch Linux ARM -> a UEFI-bootable qcow2 (GPT: ESP with systemd-boot + root ext4).
# On demand only: not part of images/build.sh, CI or any test. See docs/images.md "Arch Linux ARM".
#
#   images/archarm/build.sh [--out file.qcow2] [--root-mib 7500] [--esp-mib 256] [--packages "p1 p2"] [--modules dir]
#                           [--files dir] [--setup script.sh]
#
# --packages installs Arch packages first (pacman -Syu in the container, from Arch Linux ARM's mirrors; the
# system is upgraded with them): images/deqp/build.sh's guest takes mesa and libpng.
# --modules puts out-of-tree modules (dir/*.ko, e.g. target/archarm/virtio-snd/<uname -r> from
# images/archarm/virtio-snd.sh) into /usr/lib/modules/<uname -r>/updates and runs depmod; each module's vermagic must
# be the image's kernel (so --packages, which upgrades the kernel, is what makes them match on the day).
# --files copies dir's tree onto the root (as root; what's under home/<user> is then that user's), after the modules;
# --setup runs a bash script as root in the container after that, with the files in place (images/archarm/desktop.sh's).
# Downloads the latest ArchLinuxARM-aarch64-latest.tar.gz (md5 checked against the published
# .md5; a cached copy with the same md5 is reused), imports it as a rootless Podman image (the
# rootfs runs natively on arm64), and inside that container regenerates the initramfs (the
# shipped one is built with `autodetect` and lacks virtio_mmio/virtio_blk), copies the rootfs
# into an ext4 image with its ownership and xattrs (mke2fs -d) and takes the kernel and
# systemd-boot out. The host then lays out the GPT, ESP (mtools) and qcow2 (qemu-img).
# Host tools: podman, curl, sgdisk, mkfs.vfat + mtools, qemu-img. No root, no loop devices.
# Result: target/archarm/archlinuxarm-uefi.qcow2; login root/root or alarm/alarm, hostname alarm.
# Untested in webpc itself; checked on QEMU through our EDK2 with `node tools/uefi-oracle.ts
# $PWD/target/archarm/archlinuxarm-uefi.qcow2` (it "fails" at the password prompt: it logs in
# without a password; reaching `login:` is the success). Needs ~6 GiB of disk while building
# under target/archarm/work (not /tmp: the dev VM's is a small tmpfs).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=$ROOT/target/archarm
OUT=$W/archlinuxarm-uefi.qcow2
ROOT_MIB=7500
ESP_MIB=256
PACKAGES=
MODULES=
FILES=
SETUP=
while [ $# -gt 0 ]; do
  case $1 in
    --out) OUT=$(realpath -m "$2"); shift 2 ;;
    --root-mib) ROOT_MIB=$2; shift 2 ;;
    --esp-mib) ESP_MIB=$2; shift 2 ;;
    --packages) PACKAGES=$2; shift 2 ;;
    --modules) MODULES=$(realpath "$2"); shift 2 ;;
    --files) FILES=$(realpath "$2"); shift 2 ;;
    --setup) SETUP=$(realpath "$2"); shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
for t in podman curl sgdisk mkfs.vfat mcopy mmd qemu-img; do
  command -v "$t" >/dev/null || { echo "missing host tool: $t" >&2; exit 1; }
done

URL=http://os.archlinuxarm.org/os/ArchLinuxARM-aarch64-latest.tar.gz
TAR=$W/ArchLinuxARM-aarch64-latest.tar.gz
WORK=$W/work
IMG=localhost/archarm-scratch
# Fixed ids: the fstab and the loader entry refer to them.
ESP_PARTUUID=6d0a8f10-0000-4000-8000-0000000000e1
ROOT_PARTUUID=6d0a8f10-0000-4000-8000-0000000000e2

mkdir -p "$W"
rm -rf "$WORK"; mkdir -p "$WORK/pristine"
trap 'rm -rf "$WORK"; podman rmi -f "$IMG" >/dev/null 2>&1 || true' EXIT

echo "== download"
WANT=$(curl -fsSL "$URL.md5" | cut -d' ' -f1)
if [ ! -f "$TAR" ] || [ "$(md5sum "$TAR" | cut -d' ' -f1)" != "$WANT" ]; then
  curl -fL --retry 3 -o "$TAR" "$URL"
  [ "$(md5sum "$TAR" | cut -d' ' -f1)" = "$WANT" ] || { echo "md5 mismatch" >&2; exit 1; }
fi
echo "md5 $WANT"

echo "== import"
podman import --os linux --arch arm64 "$TAR" "$IMG" >/dev/null
# podman injects its own hostname, hosts and resolv.conf into the container: put the tarball's
# originals back in the copy.
tar xzf "$TAR" --no-same-owner -C "$WORK/pristine" ./etc/hostname ./etc/hosts 2>/dev/null

cat > "$WORK/inner.sh" <<'INNER'
set -eu
if [ -n "$PACKAGES" ]; then
  # pacman's download sandbox doesn't work in a rootless container (restored in the image's copy below).
  cp /etc/pacman.conf /tmp/pacman.conf
  sed -i -e 's/^#DisableSandbox/DisableSandbox/' -e 's/^DownloadUser/#DownloadUser/' /etc/pacman.conf
  pacman-key --init >/dev/null 2>&1 && pacman-key --populate archlinuxarm >/dev/null 2>&1
  pacman -Syu --noconfirm --noprogressbar --needed $PACKAGES >/dev/null 2>&1 || { echo "pacman failed" >&2; exit 1; }
  pacman -Scc --noconfirm >/dev/null 2>&1
  cp /tmp/pacman.conf /etc/pacman.conf
  pacman -Q $PACKAGES linux-aarch64
fi
K=$(ls /lib/modules | head -1)
if [ -d /mods ]; then
  mkdir -p /lib/modules/$K/updates
  for m in /mods/*.ko; do
    v=$(modinfo -F vermagic "$m" | cut -d' ' -f1)
    [ "$v" = "$K" ] || { echo "$(basename "$m") is for $v, the image's kernel is $K" >&2; exit 1; }
    install -m 644 "$m" /lib/modules/$K/updates/
    echo "module $(basename "$m") ($v)"
  done
  depmod "$K"
fi
if [ -d /files ]; then
  cp -a --no-preserve=ownership /files/. /
  for h in /files/home/*/; do [ -d "$h" ] && u=$(basename "$h") && chown -R "$u:$u" "/home/$u" && echo "files for $u"; done
fi
if [ -f /setup.sh ]; then
  echo "== setup"
  bash -eu /setup.sh
fi
cat > /tmp/mkinitcpio.conf <<C
MODULES=(virtio_mmio virtio_blk ext4 vfat)
BINARIES=()
FILES=()
HOOKS=(base systemd modconf keyboard sd-vconsole block filesystems fsck)
COMPRESSION=zstd
C
mkinitcpio -c /tmp/mkinitcpio.conf -k "$K" -g /out/initramfs-linux.img >/dev/null 2>&1
cp /boot/Image /usr/lib/systemd/boot/efi/systemd-bootaa64.efi /out/

mkdir /tmp/root
tar -C / --one-file-system --xattrs --numeric-owner --exclude='./boot/*' --exclude=./out --exclude=./inner.sh --exclude=./files --exclude=./setup.sh --exclude=./mods \
  -cpf - . 2>/dev/null | tar -C /tmp/root --xattrs --numeric-owner -xpf -
cd /tmp/root
rm -rf tmp/* out inner.sh run/.containerenv
mkdir -p boot proc sys dev run tmp
chmod 1777 tmp
rm -f etc/hostname etc/hosts etc/resolv.conf
cp /out/pristine/etc/hostname /out/pristine/etc/hosts etc/
ln -s /run/systemd/resolve/resolv.conf etc/resolv.conf
echo "PARTUUID=$ESP_PARTUUID  /boot  vfat  rw,relatime,fmask=0077,dmask=0077,umask=0077,errors=remount-ro  0 2" >> etc/fstab
truncate -s "${ROOT_MIB}M" /out/root.ext4
mke2fs -q -t ext4 -L archroot -U "$ROOT_PARTUUID" -d /tmp/root /out/root.ext4
e2fsck -fn /out/root.ext4 | tail -1
INNER

echo "== container: initramfs, rootfs -> ext4"
MOUNT_MODULES=()
if [ -n "$MODULES" ]; then
  ls "$MODULES"/*.ko >/dev/null || { echo "no modules in $MODULES" >&2; exit 1; }
  MOUNT_MODULES=(-v "$MODULES:/mods:ro,Z")
fi
[ -z "$FILES" ] || MOUNT_MODULES+=(-v "$FILES:/files:ro,Z")
[ -z "$SETUP" ] || MOUNT_MODULES+=(-v "$SETUP:/setup.sh:ro,Z")
podman run --rm "${MOUNT_MODULES[@]}" -e PACKAGES="$PACKAGES" -e ESP_PARTUUID=$ESP_PARTUUID -e ROOT_PARTUUID=$ROOT_PARTUUID -e ROOT_MIB=$ROOT_MIB \
  -v "$WORK:/out:Z" -v "$WORK/inner.sh:/inner.sh:ro,Z" "$IMG" bash /inner.sh

echo "== ESP"
ESP=$WORK/esp.img
truncate -s "${ESP_MIB}M" "$ESP"
mkfs.vfat -F 32 -n ARCHBOOT -i 6D0A8F11 "$ESP" >/dev/null
mmd -i "$ESP" ::/EFI ::/EFI/BOOT ::/EFI/systemd ::/loader ::/loader/entries
mcopy -i "$ESP" "$WORK/systemd-bootaa64.efi" ::/EFI/BOOT/BOOTAA64.EFI
mcopy -i "$ESP" "$WORK/systemd-bootaa64.efi" ::/EFI/systemd/systemd-bootaa64.efi
mcopy -i "$ESP" "$WORK/Image" ::/Image
mcopy -i "$ESP" "$WORK/initramfs-linux.img" ::/initramfs-linux.img
printf 'default arch.conf\ntimeout 3\nconsole-mode keep\neditor yes\n' > "$WORK/loader.conf"
cat > "$WORK/arch.conf" <<E
title   Arch Linux ARM
linux   /Image
initrd  /initramfs-linux.img
options root=PARTUUID=$ROOT_PARTUUID rw console=tty0 console=ttyAMA0 loglevel=4
E
mcopy -i "$ESP" "$WORK/loader.conf" ::/loader/loader.conf
mcopy -i "$ESP" "$WORK/arch.conf" ::/loader/entries/arch.conf

echo "== disk"
ESP_START=2048
ESP_END=$((ESP_START + ESP_MIB * 2048 - 1))
ROOT_START=$((ESP_END + 1))
ROOT_END=$((ROOT_START + ROOT_MIB * 2048 - 1))
RAW=$WORK/disk.raw
truncate -s $(((ROOT_END + 1 + 2048) * 512)) "$RAW"
sgdisk -o -n 1:$ESP_START:$ESP_END -t 1:EF00 -c 1:ESP -u 1:$ESP_PARTUUID \
  -n 2:$ROOT_START:$ROOT_END -t 2:B921B045-1DF0-41C3-AF44-4C6F280D3FAE -c 2:root -u 2:$ROOT_PARTUUID "$RAW" >/dev/null
dd if="$ESP" of="$RAW" bs=512 seek=$ESP_START conv=notrunc,sparse status=none
dd if="$WORK/root.ext4" of="$RAW" bs=512 seek=$ROOT_START conv=notrunc,sparse status=none
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
qemu-img convert -f raw -O qcow2 -c "$RAW" "$OUT"
qemu-img check "$OUT" | tail -1
ls -lh "$OUT"
