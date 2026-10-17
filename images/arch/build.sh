#!/usr/bin/env bash
# Arch Linux for aarch64 (arch.bens.haus's port; docs/images.md "Arch Linux") -> a UEFI-bootable qcow2 (GPT: ESP with
# systemd-boot, mounted at /boot, + root ext4). On demand only: not part of images/build.sh or CI; its --packages form
# makes dEQP's guest (images/deqp/build.sh), images/arch/desktop.sh the desktop guest.
#
#   images/arch/build.sh [--out file.qcow2] [--root-mib 8192] [--esp-mib 512] [--packages "p1 p2"] [--files dir]
#                        [--setup script.sh]
#
# In a container of localhost/arch-base (images/arch/base.sh, made if missing): `pacman -Syu` with base, linux,
# e2fsprogs, dosfstools, sudo and --packages from the port's mirror (the packages of the day); the system's settings
# (below); --files copies dir's tree onto the root (as root; what's under home/<user> is then that user's); --setup
# runs a bash script as root after that, with the files in place (images/arch/desktop-setup.sh). Then the initramfs
# (no `autodetect`: virtio_mmio, virtio_blk, ext4 and vfat in it; /etc/mkinitcpio.conf.d/webpc.conf, so the guest's own
# kernel updates make the same), the rootfs copied into an ext4 image with its ownership and xattrs (mke2fs -d), and
# the kernel and systemd-boot taken out. The host then lays out the GPT, ESP (mtools) and qcow2 (qemu-img, compressed;
# the root's free space costs nothing in it).
# The ESP holds what Arch's linux package puts in /boot (vmlinuz-linux, an EFI zboot kernel, and
# initramfs-linux.img), so `pacman -Syu` in the guest updates the kernel that boots.
# Settings: logins root/root and arch/arch (in wheel, which sudo allows), hostname archlinux, LANG=C.UTF-8, UTC,
# systemd-networkd (DHCP on en* and eth*, the lease's search domain and MTU taken), -resolved and -timesyncd; /etc/machine-id empty, as Arch Linux ARM's was
# (a transient id each boot, no first-boot presets).
# Host tools: podman, curl, sgdisk, mkfs.vfat + mtools, qemu-img. No root, no loop devices.
# Result: target/arch/arch-uefi.qcow2. Checked on QEMU through our EDK2 with `node tools/uefi-oracle.ts
# $PWD/target/arch/arch-uefi.qcow2` (it "fails" at the password prompt; reaching `login:` is the success). Works under
# target/arch/work (not /tmp: the dev VM's is a small tmpfs).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=$ROOT/target/arch
OUT=$W/arch-uefi.qcow2
ROOT_MIB=8192
ESP_MIB=512
PACKAGES=
FILES=
SETUP=
while [ $# -gt 0 ]; do
  case $1 in
    --out) OUT=$(realpath -m "$2"); shift 2 ;;
    --root-mib) ROOT_MIB=$2; shift 2 ;;
    --esp-mib) ESP_MIB=$2; shift 2 ;;
    --packages) PACKAGES=$2; shift 2 ;;
    --files) FILES=$(realpath "$2"); shift 2 ;;
    --setup) SETUP=$(realpath "$2"); shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
for t in podman curl sgdisk mkfs.vfat mcopy mmd qemu-img; do
  command -v "$t" >/dev/null || { echo "missing host tool: $t" >&2; exit 1; }
done

WORK=$W/work
# Fixed ids: the fstab and the loader entry refer to them.
ESP_PARTUUID=6d0a8f10-0000-4000-8000-0000000000e1
ROOT_PARTUUID=6d0a8f10-0000-4000-8000-0000000000e2

"$ROOT/images/arch/base.sh"
mkdir -p "$W"
rm -rf "$WORK"; mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/inner.sh" <<'INNER'
set -eu
pacman -Syu --noconfirm --noprogressbar --needed base linux e2fsprogs dosfstools sudo $PACKAGES >/tmp/pacman.log 2>&1 ||
  { tail -20 /tmp/pacman.log; echo "pacman failed" >&2; exit 1; }
pacman -Scc --noconfirm >/dev/null 2>&1
pacman -Q linux mesa 2>/dev/null | tr '\n' ' '; echo
K=$(ls /usr/lib/modules)
[ "$(echo "$K" | wc -l)" = 1 ] || { echo "more than one kernel: $K" >&2; exit 1; }

echo archlinux > /etc/hostname
echo LANG=C.UTF-8 > /etc/locale.conf
echo KEYMAP=us > /etc/vconsole.conf
ln -sf /usr/share/zoneinfo/UTC /etc/localtime
: > /etc/machine-id
for n in en eth; do
  # UseDomains: the lease's search domain (a tailnet's MagicDNS domain) goes to resolved; UseMTU: the lease's MTU (the
  # tunnel's 1280) on the link. networkd leaves both out by default
  printf '[Match]\nName=%s*\n\n[Network]\nDHCP=yes\n\n[DHCPv4]\nUseDomains=yes\nUseMTU=yes\n\n[DHCPv6]\nUseDomains=yes\n' $n > /etc/systemd/network/20-$n.network
done
systemctl enable -q systemd-networkd systemd-resolved systemd-timesyncd
echo root:root | chpasswd
useradd -m -G wheel arch
echo arch:arch | chpasswd
echo '%wheel ALL=(ALL:ALL) ALL' > /etc/sudoers.d/10-wheel
chmod 440 /etc/sudoers.d/10-wheel
echo "PARTUUID=$ESP_PARTUUID  /boot  vfat  rw,relatime,fmask=0077,dmask=0077,umask=0077,errors=remount-ro  0 2" >> /etc/fstab
mkdir -p /etc/mkinitcpio.conf.d
cat > /etc/mkinitcpio.conf.d/webpc.conf <<C
# webpc's disks are virtio-mmio: no autodetect (images/arch/build.sh)
MODULES=(virtio_mmio virtio_blk ext4 vfat)
HOOKS=(base systemd modconf keyboard sd-vconsole block filesystems fsck)
C

if [ -d /files ]; then
  cp -a --no-preserve=ownership /files/. /
  for h in /files/home/*/; do [ -d "$h" ] && u=$(basename "$h") && chown -R "$u:$u" "/home/$u" && echo "files for $u"; done
fi
if [ -f /setup.sh ]; then
  echo "== setup"
  bash -eu /setup.sh
fi

mkinitcpio -k "$K" -g /out/initramfs-linux.img >/tmp/mkinitcpio.log 2>&1 || { tail -20 /tmp/mkinitcpio.log; exit 1; }
cp /usr/lib/modules/$K/vmlinuz /out/vmlinuz-linux
cp /usr/lib/systemd/boot/efi/systemd-bootaa64.efi /out/
# pacman's download sandbox back on (images/arch/base.sh turned it off for the container).
sed -i -e 's/^DisableSandbox/#DisableSandbox/' -e 's/^#DownloadUser/DownloadUser/' /etc/pacman.conf

mkdir /tmp/root
tar -C / --one-file-system --xattrs --numeric-owner --exclude='./boot/*' --exclude=./out --exclude=./inner.sh --exclude=./files --exclude=./setup.sh \
  -cpf - . 2>/dev/null | tar -C /tmp/root --xattrs --numeric-owner -xpf -
cd /tmp/root
rm -rf tmp/* out inner.sh run/.containerenv
mkdir -p boot proc sys dev run tmp
chmod 1777 tmp
# Podman's own hostname, hosts and resolv.conf replaced.
echo archlinux > etc/hostname
printf '127.0.0.1  localhost\n::1        localhost\n' > etc/hosts
rm -f etc/resolv.conf
ln -s /run/systemd/resolve/stub-resolv.conf etc/resolv.conf
truncate -s "${ROOT_MIB}M" /out/root.ext4
mke2fs -q -t ext4 -L archroot -U "$ROOT_PARTUUID" -d /tmp/root /out/root.ext4
e2fsck -fn /out/root.ext4 | tail -1
INNER

echo "== container: packages, settings, initramfs, rootfs -> ext4"
MOUNTS=()
[ -z "$FILES" ] || MOUNTS+=(-v "$FILES:/files:ro,Z")
[ -z "$SETUP" ] || MOUNTS+=(-v "$SETUP:/setup.sh:ro,Z")
podman run --rm "${MOUNTS[@]}" -e PACKAGES="$PACKAGES" -e ESP_PARTUUID=$ESP_PARTUUID -e ROOT_PARTUUID=$ROOT_PARTUUID -e ROOT_MIB=$ROOT_MIB \
  -v "$WORK:/out:Z" -v "$WORK/inner.sh:/inner.sh:ro,Z" localhost/arch-base bash /inner.sh

echo "== ESP"
ESP=$WORK/esp.img
truncate -s "${ESP_MIB}M" "$ESP"
mkfs.vfat -F 32 -n ARCHBOOT -i 6D0A8F11 "$ESP" >/dev/null
mmd -i "$ESP" ::/EFI ::/EFI/BOOT ::/EFI/systemd ::/loader ::/loader/entries
mcopy -i "$ESP" "$WORK/systemd-bootaa64.efi" ::/EFI/BOOT/BOOTAA64.EFI
mcopy -i "$ESP" "$WORK/systemd-bootaa64.efi" ::/EFI/systemd/systemd-bootaa64.efi
mcopy -i "$ESP" "$WORK/vmlinuz-linux" ::/vmlinuz-linux
mcopy -i "$ESP" "$WORK/initramfs-linux.img" ::/initramfs-linux.img
printf 'default arch.conf\ntimeout 3\nconsole-mode keep\neditor yes\n' > "$WORK/loader.conf"
cat > "$WORK/arch.conf" <<E
title   Arch Linux
linux   /vmlinuz-linux
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
