#!/bin/bash
# PERF loop 81's A/B on the Mac: ab.sh <rounds> <arm>...: arms base (the renderer at 650d988d) and new (this loop's),
# their web/virgl-{renderer,screen,objects}.ts swapped in before each session (sway-mac.sh copies web/); each round
# starts with the next arm. gtk4-demo's gears (depth) and iconscroll (none), as PERF loop 79's.
cd /home/gabriel.guest/Development/waarm64
SP=<scratch>   # holds base/ (650d988d's three files) and new/ (this loop's)
restore() { cp $SP/new/virgl-renderer.ts $SP/new/virgl-screen.ts $SP/new/virgl-objects.ts web/; }
trap restore EXIT
rounds=$1; shift
arms=("$@") n=$#
for r in $(seq 1 "$rounds"); do
  for k in $(seq 0 $((n - 1))); do
    a=${arms[$(( (k + r - 1) % n ))]}
    cp $SP/$a/virgl-renderer.ts $SP/$a/virgl-screen.ts $SP/$a/virgl-objects.ts web/
    name=perf81-gtk-$a-$r
    VIRGL_GPU=virgl SCRIPT=gtk4-load.ts DEMOS=${DEMOS:-gears,iconscroll} WARM_S=10 PHASE_S=8 MAC_TIMEOUT=600 \
      timeout 800 bench/gpu/sway-mac.sh virgl target/arch/desktop.qcow2 "$name" > "bench/results/local/perf81/$name.out" 2>&1
    rc=$?
    echo "$name exit $rc $(timeout 60 bench/gpu/mac-leftovers.sh --kill 2>&1 | tr '\n' ' ')"
  done
done
echo ab-done
