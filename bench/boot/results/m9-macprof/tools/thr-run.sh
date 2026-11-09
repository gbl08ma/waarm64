#!/usr/bin/env bash
# The compile threshold on the Mac: arms t1000 (floor 1000, max 2000: main), t500 (500/1000), t250 (250/500).
# Per round, arms rotated: Firefox's pages session from the snapshot, then alpine_user_jit and boot_alpine_jit.
cd ~/Development/webpc
D=bench/results/local/thr
arms=(t1000 t500 t250)
for r in 1 2 3; do
  for k in 0 1 2; do
    a=${arms[$(( (k + r - 1) % 3 ))]}
    echo "$(date +%T) round $r $a pages"
    WASM=$D/$a.wasm SCRIPT=firefox-load.ts FROM_SNAPSHOT=target/snapbench/pages.webpcsnap PHASES=pages TIMELINE_ALL=1 JITLOG=1 WEBPC_GUEST_USER=alarm MAC_TIMEOUT=600 \
      timeout 800 bench/gpu/sway-mac.sh virgl target/archarm/desktop.qcow2 thr-pages-$a-r$r > $D/pages-$a-r$r.txt 2>&1 || echo "  pages exit $?"
    for b in alpine_user_jit boot_alpine_jit; do
      echo "$(date +%T) round $r $a $b"
      WASM=$D/$a.wasm timeout 590 bench/run-mac.sh thr-r$r-$a-$b --page bench/boot/index.html --only $b 2>&1 | grep -E '^[a-z_]+ +[{(].*±|Error' | sed -E 's/ \{.*\}//' || true
    done
  done
done
echo "$(date +%T) done"
