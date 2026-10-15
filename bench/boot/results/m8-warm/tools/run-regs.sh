#!/bin/bash
# A Firefox pages session with perf on the page's renderer: run.sh <outdir> [extra js flags]
cd ~/Development/webpc
O=$1; mkdir -p $O/jd
CHROMIUM_ARGS=--no-sandbox CHROMIUM_JS_FLAGS="--perf-prof --perf-prof-path=$PWD/$O/jd $2" PHASES=pages TIMELINE_ALL=1 \
  systemd-run --user --scope -q -p MemoryMax=10G -p MemorySwapMax=0 -- timeout 900 node bench/gpu/firefox-load.ts virgl target/archarm/desktop.qcow2 $O > $O/log.txt 2>&1 &
NODE=$!
for i in $(seq 600); do grep -q "^.*mesa" $O/log.txt 2>/dev/null && break; sleep 1; done
PID=$(ps -eo pid=,cputimes=,args= --sort=-cputimes | grep -- --type=renderer | grep -v grep | head -1 | awk '{print $1}')
echo "renderer $PID"
timeout 600 perf record -q -k mono --user-regs=x16,x17,lr -e cpu-clock -F 999 -p $PID -o $O/perf.data &
PERF=$!
wait $NODE; echo "session exit $?"
kill -INT $PERF; wait $PERF
node bench/gpu/stalls.ts $O/pages-all.timeline.json
