#!/bin/sh
# The boot test's workload: a few BusyBox commands whose output the runner checks.
set -e
echo "uname: $(uname -srm)"
grep -m1 -E '^(Features|CPU implementer)' /proc/cpuinfo
echo "answer: $((6 * 7))"
ls /dev/console
echo "webpc: test ok"
