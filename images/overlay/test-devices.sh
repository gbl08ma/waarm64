#!/bin/sh
# Device test (M4 step 6; `-- /test-devices.sh` on the kernel command line):
# virtio-net pings the loopback adapter's peer, 9p file operations on the
# host's tree (tag `host`, with /hello.txt in it), and a pattern on the
# simple-framebuffer, which the runner reads back.
set -e
# virtio-net: the loopback adapter answers ARP and ICMP echo for 10.0.2.2.
ip link set eth0 up
ip addr add 10.0.2.15/24 dev eth0
echo "net: mac $(cat /sys/class/net/eth0/address)"
ping -c 3 10.0.2.2 | grep transmitted
# 9p: create, write, read, rename, readdir, symlink, stat, unlink.
mount -t 9p -o trans=virtio,version=9p2000.L host /mnt
cd /mnt
echo "9p: $(cat hello.txt)"
mkdir d
echo "some text" > d/a
mv d/a d/b
ln -s b d/l
echo "9p: $(readlink d/l) $(cat d/l) $(wc -c < d/b) $(ls -l d/b | cut -c1-10)"
w=$(head -c 200000 /dev/hwrng | tee d/big | md5sum)
[ "$(md5sum < d/big)" = "$w" ] && echo "9p: big $(wc -c < d/big) ok"
echo "9p: ls $(ls d | tr '\n' ' ')"
rm d/l d/big
echo "9p: after rm $(ls d | tr '\n' ' ')"
mv d/b from-guest
rmdir d
echo "9p: top $(ls | tr '\n' ' ')"
cd /
umount /mnt
# Framebuffer: row 0 red, row 1 grey (x8r8g8b8), the rest as the host left it.
echo "fb: $(cat /proc/fb) $(cat /sys/class/graphics/fb0/virtual_size)"
w=$(cut -d, -f1 /sys/class/graphics/fb0/virtual_size)
{
  for i in $(seq $w); do printf '\000\000\377\000'; done
  for i in $(seq $w); do printf '\100\100\100\000'; done
} > /dev/fb0
echo "waarm64: test ok"
