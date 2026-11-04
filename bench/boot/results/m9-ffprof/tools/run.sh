#!/bin/bash
# A Firefox pages session from the snapshot with perf on the page's renderer: run.sh <outdir>
cd ~/Development/webpc
O=$1; rm -rf $O; mkdir -p $O/jd
FROM_SNAPSHOT=target/snapbench/pages.webpcsnap CHROMIUM_ARGS=--no-sandbox CHROMIUM_JS_FLAGS="--perf-prof --perf-prof-path=$PWD/$O/jd" \
  PHASES=pages TIMELINE_ALL=1 JITLOG=1 WEBPC_GUEST_USER=alarm \
  systemd-run --user --scope -q -p MemoryMax=10G -p MemorySwapMax=0 -- timeout 800 node bench/gpu/firefox-load.ts virgl target/archarm/desktop.qcow2 $O > $O/log.txt 2>&1 &
NODE=$!
for i in $(seq 120); do grep -q "\] running" $O/log.txt 2>/dev/null && break; sleep 1; done
PID=$(ps -eo pid=,cputimes=,args= --sort=-cputimes | grep -- --type=renderer | grep -v grep | head -1 | awk '{print $1}')
echo "renderer $PID"
timeout 700 perf record -q -k mono --user-regs=x16,x17,lr -e cpu-clock -F 999 -p $PID -o $O/perf.data &
PERF=$!
wait $NODE; echo "session exit $?"
kill -INT $PERF; wait $PERF
timeout 120 node bench/gpu/stalls.ts $O/*.timeline.json > $O/stalls.txt 2>&1
echo done
