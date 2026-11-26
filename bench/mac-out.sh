# What a *-mac.sh script's run writes on the Mac host (sourced; docs/devenv.md "The Mac host"), and the Mac's layout:
# each mirror there keeps its inputs at fixed paths that each run overwrites, and its runs' output only under
# MAC_OUTPUTS, which the scripts move back here at their end (also when the run failed) and
# bench/gpu/mac-leftovers.sh reports (`--kill` empties) when a run left something behind. The Mac's disk is small.
#   mac_move <host> <dest> <local dir> <path>...   the paths (under ~/<dest> there; globs expanded there) moved into
#                                                   <local dir>: what arrived is deleted there, then what's left empty;
#                                                   what didn't arrive stays there (rsync's exit code is returned)
#   mac_move_at_exit <host> <dest> <local dir> <path>...   mac_move at this script's exit (an EXIT trap: also when the
#                                                   run failed or the script was ended); a failed move fails a run that passed
#   mac_rm <host> <dest> <path>...                  the paths (globs expanded there) deleted there
# The mirrors (under ~ there): waarm64-bench.noindex (bench/run-mac.sh, bench/ab-mac.sh, bench/compare/run-mac.sh),
# waarm64-bench-<tree>.noindex (bench/ab-mac.sh's arms from another checkout), waarm64-gpu-bench.noindex (bench/gpu/*-mac.sh,
# bench/vulkan/mac*.sh, bench/video/*-mac.sh), waarm64-snapz-bench.noindex (bench/snapz/*-mac.sh). Ours besides: waarm64-chrome
# (bench/mac-chrome.sh), waarm64-net-test (bench/net/local-ipv6.ts), waarm64-tailcat (kept by hand: docs/testing.md).
MAC_MIRRORS='waarm64-bench.noindex waarm64-bench-*.noindex waarm64-gpu-bench.noindex waarm64-snapz-bench.noindex'
MAC_OTHERS='waarm64-chrome waarm64-net-test waarm64-tailcat'
# Under a mirror: a run's results and logs; bench/vulkan/mac.sh's; bench/snapz/probe.ts's profile, downloads and copies;
# a bench/run.ts --profile directory's profiles (removed by run.ts unless it was killed).
MAC_OUTPUTS='bench/results/local vulkan/results vulkan-web/results target/snapz target/bench-profiles'
_mac_ssh=(ssh -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
#   mac_bash <host> <command>   the command (no ' in it) run by bash there, bounded there too (timeout ends ssh, not
#                               what it started there): the login shell there is zsh, which fails a whole command when
#                               one of its globs matches nothing
mac_bash() {
  timeout 120 "${_mac_ssh[@]}" "$1" "perl -e \"alarm shift; exec @ARGV\" 110 bash -c '$2'"
}
mac_move() {
  local host=$1 dest=$2 to=$3 rc=0 p d n list
  shift 3
  list=$(mac_bash "$host" "cd $dest && shopt -s nullglob && for p in $*; do [ ! -e \"\$p\" ] || echo \"\$p\"; done") || return
  [ -n "$list" ] || { echo "mac_move: nothing at $host:$dest/ $*" >&2; return 23; }
  # One rsync a directory, its names from a list (one argument each overflows rsync's arguments at ~500): <dir>/ is
  # the directory's contents.
  local -A names=()
  for p in $list; do
    case $p in */) d=${p%/} n=. ;; */*) d=${p%/*} n=${p##*/} ;; *) d=. n=$p ;; esac
    names[$d]+="$n"$'\n'
  done
  mkdir -p "$to"
  for d in "${!names[@]}"; do
    printf '%s' "${names[$d]}" | timeout 1800 rsync -a -r -e "${_mac_ssh[*]}" --files-from=- --remove-source-files "$host:$dest/$d/" "$to/" || rc=$?
  done
  # Then the directories left empty, the paths' own and their parents' up to an output directory (MAC_OUTPUTS, or a
  # mirror's results/), which stays.
  local stop
  stop=$(echo "$MAC_OUTPUTS results ." | tr ' ' '|')
  mac_bash "$host" "cd $dest && for p in $(echo $list); do [ ! -d \"\$p\" ] || find \"\$p\" -depth -type d -empty -delete; d=\$(dirname \"\${p%/}\"); while true; do case \$d in $stop) break ;; esac; rmdir \"\$d\" 2>/dev/null || break; d=\$(dirname \"\$d\"); done; done" || true
  return $rc
}
mac_move_at_exit() {
  _mac_exit=("$@")
  trap '_mac_rc=$?; mac_move "${_mac_exit[@]}" || { _mac_m=$?; [ $_mac_rc -ne 0 ] || _mac_rc=$_mac_m; }; exit $_mac_rc' EXIT
}
mac_rm() {
  local host=$1 dest=$2
  shift 2
  [ -n "$dest" ] && [ $# -gt 0 ] || return 0
  mac_bash "$host" "cd $dest && shopt -s nullglob && for p in $*; do rm -rf -- \"\$p\"; done"
}
