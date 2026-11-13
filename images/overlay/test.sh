#!/bin/sh
# The boot test's workload: a few BusyBox commands whose output the runner checks.
set -e
echo "uname: $(uname -srm)"
grep -m1 -E '^(Features|CPU implementer)' /proc/cpuinfo
echo "answer: $((6 * 7))"
ls /dev/console
# virtio (M4 step 2): 16 bytes from virtio-rng, a line to virtio-console.
echo "hwrng: $(head -c 16 /dev/hwrng | od -An -tx1 | tr -d ' \n')"
echo "waarm64: hvc0 ok" > /dev/hvc0
# virtio-blk (M4 step 3): the root filesystem, and a raw read (the ext4 magic).
grep ' / ' /proc/mounts
echo "vda magic: $(dd if=/dev/vda bs=2 skip=540 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n')"
echo "waarm64: test ok"
