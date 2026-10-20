#!/bin/bash
# psum.sh <dir>: per session under <dir>: busy MIPS, wasm MB, modules, flushes, stalls, RSS median/max, wasm code (exec anon) median/max (MiB).
for d in "$1"/*/; do
  d=${d%/}
  n=$(basename "$d")
  [ -f "$d/stalls.txt" ] || continue
  s=$(grep -o '([0-9]* a busy vCPU' "$d/stalls.txt" | tr -dc 0-9)
  st=$(grep -o 'stalls >=20/50/100/250/500/1000 ms: [0-9/]*' "$d/stalls.txt" | head -1 | awk '{print $NF}')
  j=$(python3 -c "import json;j=json.load(open('$d/results.json'))['jit'];print(f\"{j['bytes']/1e6:.0f} MB {j['modules']} mods {j['flushes']} fl\")")
  r=$(awk '{print $3}' "$d/rss.txt" | sort -n | awk '{a[NR]=$1} END {print a[int((NR+1)/2)], a[NR]}')
  x=$(awk '{print $4}' "$d/rss.txt" | sort -n | awk '{a[NR]=$1} END {print a[int((NR+1)/2)], a[NR]}')
  echo "$n busy $s MIPS, $j, stalls $st, RSS med/max $r, wasm code med/max $x"
done
