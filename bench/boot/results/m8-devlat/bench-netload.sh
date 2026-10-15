#!/bin/sh
# Ad hoc (bench/boot/REPORT.md "M8: the device round trip"): bench-net.sh's small pings, warm, idle ("small") and
# with every vCPU busy (a shell loop per CPU: "big"). Not in the image: put it on a copy of the Buildroot disk,
#   cp target/images/buildroot/rootfs.ext4 bench/results/local/rootfs.ext4
#   debugfs -w -R "write <this file> bench-netload.sh" bench/results/local/rootfs.ext4
#   debugfs -w -R "set_inode_field bench-netload.sh mode 0100755" bench/results/local/rootfs.ext4
# and run `--only net --query='jit=1&ncpus=1&stats=1&disk=/bench/results/local/rootfs.ext4&script=/bench-netload.sh'`.
ip link set eth0 up
ip addr add 10.0.2.15/24 dev eth0
ping -c 1 10.0.2.2 > /dev/null; ping -A -q -c 3000 10.0.2.2 > /dev/null # ARP, warm-up
echo "webpc: net small start"; ping -A -q -c 5000 10.0.2.2 | tail -2; echo "webpc: net small end"
n=$(grep -c ^processor /proc/cpuinfo); pids=""
for i in $(seq $n); do (while :; do :; done) & pids="$pids $!"; done
echo "webpc: net big start"; ping -A -q -c 5000 10.0.2.2 | tail -2; echo "webpc: net big end"
kill $pids
