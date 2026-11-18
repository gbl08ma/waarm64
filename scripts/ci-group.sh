# Jobs at once for scripts/ci.sh and scripts/ci-fast.sh (sourced): `group "name::command" ...` runs each command in a
# subshell beside the others, then prints each one's result and output in order, and fails when any did.
# CI_GROUP_TAIL (lines, default all) keeps only each output's end. Jobs that build with cargo queue on target/'s lock
# by themselves; their tests run beside each other.
ci_group_logs=$(mktemp -d)
trap 'rm -rf "$ci_group_logs"' EXIT
group() {
  local -a names=() pids=()
  local job name rc=0 i
  for job in "$@"; do
    name=${job%%::*}
    names+=("$name")
    (eval "${job#*::}") > "$ci_group_logs/$name.log" 2>&1 &
    pids+=($!)
  done
  for i in "${!pids[@]}"; do
    if wait "${pids[$i]}"; then printf '== %s: ok\n' "${names[$i]}"
    else rc=1; printf '== %s: FAILED\n' "${names[$i]}"; fi
    if [ -n "${CI_GROUP_TAIL:-}" ]; then
      sed 's/^/   /' "$ci_group_logs/${names[$i]}.log" | grep -v '^   $' | tail -n "$CI_GROUP_TAIL" || true
    else
      sed 's/^/   /' "$ci_group_logs/${names[$i]}.log" | grep -v '^   $' || true
    fi
  done
  return $rc
}
