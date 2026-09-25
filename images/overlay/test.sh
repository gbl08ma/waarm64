#!/bin/sh
# The boot test's workload: a few BusyBox commands whose output the runner checks.
set -e
echo "uname: $(uname -srm)"
grep -m1 -E '^(Features|CPU implementer)' /proc/cpuinfo
echo "answer: $((6 * 7))"
ls /dev/console
# virtio (M4 step 2): 16 bytes from virtio-rng, a line to virtio-console.
echo "hwrng: $(head -c 16 /dev/hwrng | od -An -tx1 | tr -d ' \n')"
echo "webpc: hvc0 ok" > /dev/hvc0
echo "webpc: test ok"
