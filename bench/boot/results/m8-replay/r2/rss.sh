#!/bin/bash
# rss.sh <out.txt> [seconds]: every 5 s, the biggest Chromium renderer's RSS and its executable anonymous mappings'
# RSS (V8's wasm code), in MiB: "<unix s> <pid> <rss> <exec-anon>".
out=$1; end=$((SECONDS+${2:-1500}))
while [ $SECONDS -lt $end ]; do
  best=; bestrss=0
  for p in $(ps -eo pid=,args= | awk '/--type=renderer/ && !/awk/ {print $1}'); do
    r=$(awk '/^VmRSS/ {print $2}' /proc/$p/status 2>/dev/null); r=${r:-0}
    if [ "$r" -gt "$bestrss" ]; then best=$p; bestrss=$r; fi
  done
  if [ -n "$best" ]; then
    x=$(awk '/^[0-9a-f]+-[0-9a-f]+ / { ex = ($2 ~ /x/ && (NF < 6 || $6 ~ /^\[anon/)) } /^Rss:/ { if (ex) s += $2 } END { print s+0 }' /proc/$best/smaps 2>/dev/null)
    echo "$(date +%s) $best $((bestrss/1024)) $((x/1024))" >> "$out"
  fi
  sleep 5
done
