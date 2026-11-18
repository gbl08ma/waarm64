# The machine's CI lock (docs/testing.md "Tiers"), sourced by the scripts/ci*.sh scripts: `ci_lock exclusive` for
# scripts/ci.sh and the topic scripts, `ci_lock shared` for scripts/ci-fast.sh. One file in /tmp for every worktree and
# session on the machine; flock(1) holds it on fd 9 until the script exits (its children inherit the fd: one left
# running keeps the lock, and lslocks names it). Fast lanes run beside each other; an exclusive run waits for them to
# end and they wait for it. An exclusive run goes first: it holds a second file (the intent) while it waits, and a
# fast lane passes through the intent before it takes the lock, so a stream of fast lanes can't hold it off.
# A script run by one that holds the lock (WAARM64_CI_LOCK set) doesn't take it again. WAARM64_CI_LOCK_WAIT bounds
# the wait (s, default 3600).
ci_lock() {
  [ -n "${WAARM64_CI_LOCK:-}" ] && return 0
  local mode=$1 file=/tmp/waarm64-ci.lock wait=${WAARM64_CI_LOCK_WAIT:-3600} flag=-x said= fd
  [ "$mode" = shared ] && flag=-s
  exec 8>> "$file.intent" 9>> "$file"
  for fd in 8 9; do
    flock -n "$flag" "$fd" && continue
    if [ -z "$said" ]; then
      said=1
      printf 'waiting for the CI lock (%s, %s) held by:\n' "$file" "$mode"
      local pid
      for pid in $(lslocks --noheadings -o PID,PATH 2> /dev/null | awk -v f="$file" '$2 == f || $2 == f ".intent" { print $1 }' | sort -u); do
        printf '  %s\n' "$(ps -o pid=,etime=,args= -p "$pid" 2> /dev/null | cut -c1-160)"
      done
    fi
    flock -w "$wait" "$flag" "$fd" || { printf 'gave up on the CI lock after %d s\n' "$wait"; exit 1; }
  done
  exec 8>&-
  export WAARM64_CI_LOCK=$mode
}
