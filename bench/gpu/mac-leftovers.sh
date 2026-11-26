#!/usr/bin/env bash
# The Mac host's state after a run (docs/devenv.md "The Mac host"). Its disk first: the per-run output a run left in
# the mirrors (bench/mac-out.sh's MAC_OUTPUTS under its MAC_MIRRORS: the *-mac.sh scripts move theirs back, so any is
# from a run that was ended or couldn't move it), each mirror's size and ours besides, any ~/waarm64* directory no
# script owns (reported, never deleted), and the data volume's free space (a warning under 40 GiB). Then its GPU's
# utilization, its load, and the Playwright Chrome for Testing processes (bench/mac-chrome.sh's, or Playwright's own)
# no live node process owns (a run that hung its GPU leaves its browser behind: the harness's alarm ends node, not
# Chrome), and the QEMU processes no ssh session or Lima owns (an oracle run's, orphaned: tests/baremetal/oracle.sh
# --hvf). Only reads, unless --kill: then those processes, and only those, are ended by PID (TERM, then KILL), and the
# per-run output is deleted (nothing else on the disk). A GPU process stuck exiting (state E, its GPU work never done)
# can't be ended by anything: it's reported, and only a restart of the Mac frees its GPU. The last line sums it all
# up; the exit code is 1 when something is left, a directory is no script's or the disk is low.
#   bench/gpu/mac-leftovers.sh [--kill]     (MAC_HOST, default macmini.lan)
set -euo pipefail
cd "$(dirname "$0")/../.."
HOST=${MAC_HOST:-macmini.lan}
KILL=0
case "${1:-}" in
  --kill) KILL=1 ;;
  '') ;;
  *) echo "usage: $0 [--kill]" >&2; exit 2 ;;
esac
. bench/mac-out.sh
# Bounded there too: timeout ends ssh, not what it started there.
timeout 90 ssh -o ConnectTimeout=10 "$HOST" "KILL=$KILL MIRRORS='$MAC_MIRRORS' OTHERS='$MAC_OTHERS' OUTPUTS='$MAC_OUTPUTS' perl -e 'alarm shift; exec @ARGV' 80 bash -s" <<'MAC'
set -u
cd
bad=0
# The per-run output left: each MAC_OUTPUTS directory of each mirror that has anything in it.
left=0 runs=
for m in $MIRRORS; do
  [ -d "$m" ] || continue
  for o in $OUTPUTS; do
    d=$m/$o
    [ -d "$d" ] || continue
    n=$(find "$d" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')
    [ "$n" -gt 0 ] || continue
    left=$((left + n))
    runs+="  ~/$d: $n entries, $(du -sh "$d" | awk '{ print $1 }')"$'\n'
    if [ "$KILL" = 1 ]; then find "$d" -mindepth 1 -maxdepth 1 -exec rm -rf {} +; fi
  done
done
if [ "$left" -gt 0 ]; then
  echo "per-run output left on the Mac:"
  printf '%s' "$runs"
  if [ "$KILL" = 1 ]; then
    echo "  (deleted)"
    outputs="$left deleted"
  else
    echo "  (run with --kill to delete it)"
    outputs="$left left"
    bad=1
  fi
else
  echo "no per-run output left"
  outputs=none
fi
# The mirrors and ours besides, with their sizes; any other ~/waarm64* is no script's.
sizes= unknown=
for d in waarm64*; do
  [ -d "$d" ] || continue
  own=0
  set -f
  for k in $MIRRORS $OTHERS; do case $d in $k) own=1 ;; esac; done
  set +f
  if [ "$own" = 1 ]; then sizes+=" ~/$d $(du -sh "$d" | awk '{ print $1 }'),"; else unknown+=" ~/$d ($(du -sh "$d" | awk '{ print $1 }'))"; fi
done
echo "ours:${sizes%,}"
strays=
if [ -n "$unknown" ]; then
  echo "no script's (not deleted):$unknown"
  strays="; directories no script's: $(echo "$unknown" | grep -o '~/' | wc -l | tr -d ' ')"
  bad=1
fi
free=$(df -k "$HOME" | awk 'NR == 2 { printf "%d", $4 / 1048576 }')
if [ "$free" -lt 40 ]; then
  echo "the data volume has $free GiB free, under 40: see what's above, and ask before deleting anything else"
  disk="$free GiB free, LOW"
  bad=1
else
  echo "the data volume: $free GiB free"
  disk="$free GiB free"
fi

gpu=$(ioreg -r -d 1 -c IOAccelerator | grep -o '"Device Utilization %"=[0-9]*' | head -1 | cut -d= -f2)
echo "GPU ${gpu:-?}% busy; load $(sysctl -n vm.loadavg)"
# pid, ppid, state, elapsed, command: a Playwright Chrome is ours unless a node process is among its ancestors, a QEMU
# unless an sshd or limactl is.
ps -Ao pid=,ppid=,stat=,etime=,command= > /tmp/mac-leftovers.$$
leftovers=$(awk '
  { pid=$1; parent[pid]=$2; state[pid]=$3; age[pid]=$4; $1=$2=$3=$4=""; cmd[pid]=substr($0, 5) }
  END {
    for (p in cmd) {
      chrome = cmd[p] ~ /\/(ms-playwright|waarm64-chrome)\// || (cmd[p] ~ /^\(Google Chrome fo/ && state[p] ~ /E/)
      qemu = cmd[p] ~ /(^|\/)qemu-system-/
      if (!chrome && !qemu) continue
      owned = 0
      for (a = parent[p]; a > 1 && (a in cmd); a = parent[a])
        if (chrome ? cmd[a] ~ /(^|\/)node( |$)/ : cmd[a] ~ /sshd|limactl/) { owned = 1; break }
      if (!owned) printf "%s %s %s %s\n", p, (state[p] ~ /E/ ? "exiting" : "alive"), age[p], substr(cmd[p], 1, 90)
    }
  }' /tmp/mac-leftovers.$$)
rm -f /tmp/mac-leftovers.$$
processes=none
if [ -z "$leftovers" ]; then
  echo "no leftover processes"
else
  echo "leftover processes (pid, state, age, command):"
  echo "$leftovers" | sed 's/^/  /'
  alive=$(echo "$leftovers" | awk '$2 == "alive" { print $1 }')
  exiting=$(echo "$leftovers" | awk '$2 == "exiting" { print $1 }' | tr '\n' ' ')
  processes=
  if [ "$KILL" = 1 ] && [ -n "$alive" ]; then
    kill $alive 2>/dev/null || true
    sleep 3
    for p in $alive; do kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null; done
    sleep 2
    echo "ended: $(echo $alive)"
    gpu=$(ioreg -r -d 1 -c IOAccelerator | grep -o '"Device Utilization %"=[0-9]*' | head -1 | cut -d= -f2)
    echo "GPU now ${gpu:-?}% busy"
    processes="$(echo $alive | wc -w | tr -d ' ') ended"
  elif [ -n "$alive" ]; then
    echo "(run with --kill to end the live ones)"
    processes="$(echo $alive | wc -w | tr -d ' ') alive"
    bad=1
  fi
  if [ -n "$exiting" ]; then
    echo "stuck exiting: $exiting- their GPU work never finished; only a restart of the Mac frees the GPU"
    processes="${processes:+$processes, }$(echo $exiting | wc -w | tr -d ' ') stuck exiting"
    bad=1
  fi
fi
echo "leftovers: processes $processes; per-run output $outputs$strays; $disk"
exit $bad
MAC
