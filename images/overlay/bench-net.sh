#!/bin/sh
# virtio-net benchmark (M4 step 7; `-- /bench-net.sh`, realtime mode, the test
# devices): ping-pong with the loopback adapter, each ping sent as soon as the
# last reply came back (ping -A): 1000 full-size frames (1472 bytes of data,
# 1514-byte frames each way), then 1000 small ones, timed by the host between
# the markers; ping's summary gives the round-trip times.
ip link set eth0 up
ip addr add 10.0.2.15/24 dev eth0
ping -c 1 10.0.2.2 > /dev/null # ARP
echo "webpc: net big start"; ping -A -q -c 1000 -s 1472 10.0.2.2 | tail -2; echo "webpc: net big end"
echo "webpc: net small start"; ping -A -q -c 1000 10.0.2.2 | tail -2; echo "webpc: net small end"
