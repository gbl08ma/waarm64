#!/bin/sh
# 9p benchmark (M4 step 7; `-- /bench-9p.sh`, realtime mode, the test devices):
# on the host's tree, a 16 MiB sequential write and read (dd, 1 MiB blocks),
# then creating, listing with stat (ls -l) and removing 200 files, each phase
# timed by the host between its markers.
mount -t 9p -o trans=virtio,version=9p2000.L host /mnt
cd /mnt
mark() { echo "webpc: $1"; }
mark "9p write start"; dd if=/dev/zero of=big bs=1M count=16 2>/dev/null; mark "9p write end"
mark "9p read start"; dd if=big of=/dev/null bs=1M 2>/dev/null; mark "9p read end"
mark "9p create start"; for i in $(seq 200); do : > f$i; done; mark "9p create end"
mark "9p stat start"; ls -l > /dev/null; mark "9p stat end"
mark "9p unlink start"; rm f*; mark "9p unlink end"
rm big
cd /
umount /mnt
