#!/usr/bin/env bash
# The Mac host's state after a run (docs/devenv.md "The Mac host"): its GPU's utilization, its load, and the Playwright
# Chrome for Testing processes no live node process owns (a run that hung its GPU leaves its browser behind: the
# harness's alarm ends node, not Chrome). Only reads, unless --kill: then those processes, and only those, are ended
# by PID (TERM, then KILL). A GPU process stuck exiting (state E, its GPU work never done) can't be ended by anything:
# it's reported, and only a restart of the Mac frees its GPU.
#   bench/gpu/mac-leftovers.sh [--kill]     (MAC_HOST, default macmini.lan)
set -euo pipefail
HOST=${MAC_HOST:-macmini.lan}
KILL=0
case "${1:-}" in
  --kill) KILL=1 ;;
  '') ;;
  *) echo "usage: $0 [--kill]" >&2; exit 2 ;;
esac
timeout 60 ssh "$HOST" "KILL=$KILL bash -s" <<'EOF'
set -u
gpu=$(ioreg -r -d 1 -c IOAccelerator | grep -o '"Device Utilization %"=[0-9]*' | head -1 | cut -d= -f2)
echo "GPU ${gpu:-?}% busy; load $(sysctl -n vm.loadavg)"
# pid, ppid, state, elapsed, command: a Playwright Chrome is ours unless a node process is among its ancestors.
ps -Ao pid=,ppid=,stat=,etime=,command= > /tmp/mac-leftovers.$$
leftovers=$(awk '
  { pid=$1; parent[pid]=$2; state[pid]=$3; age[pid]=$4; $1=$2=$3=$4=""; cmd[pid]=substr($0, 5) }
  END {
    for (p in cmd) {
      chrome = cmd[p] ~ /\/ms-playwright\// || (cmd[p] ~ /^\(Google Chrome fo/ && state[p] ~ /E/)
      if (!chrome) continue
      owned = 0
      for (a = parent[p]; a > 1 && (a in cmd); a = parent[a]) if (cmd[a] ~ /(^|\/)node( |$)/) { owned = 1; break }
      if (!owned) printf "%s %s %s %s\n", p, (state[p] ~ /E/ ? "exiting" : "alive"), age[p], substr(cmd[p], 1, 90)
    }
  }' /tmp/mac-leftovers.$$)
rm -f /tmp/mac-leftovers.$$
if [ -z "$leftovers" ]; then
  echo "no leftovers"
  exit 0
fi
echo "leftovers (pid, state, age, command):"
echo "$leftovers" | sed 's/^/  /'
alive=$(echo "$leftovers" | awk '$2 == "alive" { print $1 }')
exiting=$(echo "$leftovers" | awk '$2 == "exiting" { print $1 }' | tr '\n' ' ')
if [ "$KILL" = 1 ] && [ -n "$alive" ]; then
  kill $alive 2>/dev/null || true
  sleep 3
  for p in $alive; do kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null; done
  sleep 2
  echo "ended: $(echo $alive)"
  gpu=$(ioreg -r -d 1 -c IOAccelerator | grep -o '"Device Utilization %"=[0-9]*' | head -1 | cut -d= -f2)
  echo "GPU now ${gpu:-?}% busy"
elif [ -n "$alive" ]; then
  echo "(run with --kill to end the live ones)"
fi
if [ -n "$exiting" ]; then
  echo "stuck exiting: $exiting- their GPU work never finished; only a restart of the Mac frees the GPU"
fi
exit 1
EOF
