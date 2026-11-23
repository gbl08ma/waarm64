#!/usr/bin/env bash
# Chrome's memory on the Mac host over a run (dev-only; bench/gpu/sway-mac.sh with RSSLOG=1 starts it there, macOS
# having no /proc for bench/mem/probe.ts): every 5 s the epoch second, the largest renderer's RSS and the GPU
# process's (ps, KiB), the renderers' sum and the browser's, one line each, for at most <seconds>.
#   bench/gpu/mac-rss.sh <out> <seconds>
out=$1 end=$(( $(date +%s) + $2 ))
while [ "$(date +%s)" -lt "$end" ]; do
  echo "$(date +%s) $(ps -Axo rss=,command= | awk '/--type=renderer/ { s += $1; if ($1 > r) r = $1 } /--type=gpu-process/ { if ($1 > g) g = $1 } /Chrome for Testing\.app\/Contents\/MacOS\// && !/--type=/ { b += $1 } END { print r + 0, g + 0, s + 0, b + 0 }')" >> "$out"
  sleep 5
done
