#!/bin/sh
# DEMO loop 1's Alpine (bench/demo/REPORT.md "DEMO loop 1"): Alpine's published UEFI cloud image (images/build.sh
# alpine-uefi: 3.24.2 tiny, Limine) with root logged in on the serial console and tiny-cloud, sshd and chronyd off,
# so it boots to a `#` prompt with no seed disk and no network: a stand-in for loop 3's `alpine-demo` image until it
# exists. Edited in rootless Podman (an Alpine container: qemu-img, debugfs on the root partition; nothing mounted),
# recompressed as the published image is.
# Limine's menu doesn't wait (`timeout: 0`); `SPIKE_CMDLINE` adds to the kernel's command line (e.g. `init_on_free=1`).
#   [SPIKE_CMDLINE=...] bench/demo/spike-image.sh [out, default target/images/remote/alpine-spike.qcow2]
set -eu
cd "$(dirname "$0")/../.."
in=target/images/alpine-uefi/alpine.qcow2
out=${1:-target/images/remote/alpine-spike.qcow2}
[ -f "$in" ] || { echo "no $in: images/build.sh alpine-uefi"; exit 1; }
mkdir -p "$(dirname "$out")"
work=$(mktemp -d "${TMPDIR:-/tmp}/alpine-spike.XXXXXX")
trap 'rm -rf "$work"' EXIT
cp "$in" "$work/in.qcow2"
timeout 600 podman run --rm -e "CMDLINE=${SPIKE_CMDLINE:-}" -v "$work:/w:z" docker.io/library/alpine:3.24 sh -euc '
apk add -q qemu-img e2fsprogs-extra sfdisk mtools >/dev/null
qemu-img convert -O raw /w/in.qcow2 /w/disk.raw
# Limine (the EFI partition, the first, at 1 MiB): no wait at its menu, the command line added to.
efi=/w/disk.raw@@1048576
mtype -i $efi ::/limine/limine.conf | sed -e "s/^timeout: .*/timeout: 0/" -e "s|^\(    cmdline: .*\)\$|\1${CMDLINE:+ $CMDLINE}|" > /w/limine.conf
grep -q "^timeout: 0" /w/limine.conf
mcopy -o -i $efi /w/limine.conf ::/limine/limine.conf
# The root partition (the second: "/"), by its start and size in sectors.
set -- $(sfdisk -d /w/disk.raw | sed -n "s/.*raw2 : start= *\([0-9]*\), size= *\([0-9]*\),.*/\1 \2/p")
start=$1 size=$2
dd if=/w/disk.raw of=/w/root.ext4 bs=512 skip=$start count=$size status=none
printf "%s\n" \
  "# DEMO loop 1 (bench/demo/spike-image.sh): root logged in on the serial console." \
  "::sysinit:/sbin/openrc sysinit" "::sysinit:/sbin/openrc boot" "::wait:/sbin/openrc default" \
  "ttyAMA0::respawn:/bin/login -f root" \
  "::ctrlaltdel:/sbin/reboot" "::shutdown:/sbin/openrc shutdown" > /w/inittab
printf "auto lo\niface lo inet loopback\n\nauto eth0\niface eth0 inet dhcp\n" > /w/interfaces
debugfs -w /w/root.ext4 -f - <<EOF >/dev/null
rm /etc/inittab
write /w/inittab /etc/inittab
sif /etc/inittab uid 0
sif /etc/inittab gid 0
write /w/interfaces /etc/network/interfaces
sif /etc/network/interfaces uid 0
sif /etc/network/interfaces gid 0
rm /etc/runlevels/boot/tiny-cloud-boot
rm /etc/runlevels/default/tiny-cloud-early
rm /etc/runlevels/default/tiny-cloud-main
rm /etc/runlevels/default/tiny-cloud-final
rm /etc/runlevels/default/sshd
rm /etc/runlevels/default/chronyd
EOF
e2fsck -fn /w/root.ext4 >/dev/null
debugfs -R "cat /etc/inittab" /w/root.ext4 2>/dev/null | grep -q "login -f root"
dd if=/w/root.ext4 of=/w/disk.raw bs=512 seek=$start conv=notrunc status=none
qemu-img convert -c -O qcow2 /w/disk.raw /w/out.qcow2
'
mv "$work/out.qcow2" "$out"
echo "$out: $(stat -c %s "$out") bytes"
