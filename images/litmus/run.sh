#!/bin/sh
# Runs the litmus image's tests (images/build.sh litmus) and checks every final
# state each one observes against herd7's allowed set (allowed.txt). Portable
# sh and awk: it runs in the guest (BusyBox) and on the oracle VM (Debian).
#   run.sh [test binary options, e.g. -s 1000 -r 2]
# One "litmus: <test> ok|FAIL model=<herd7> seen=<observation>" line per test
# (model: herd7's verdict on the test's condition, Never = forbidden; seen:
# litmus7's Never/Sometimes/Always with positive and negative counts), then
# "litmus: all ok, <n> skipped" or "litmus: FAILED <n>". Exits non-zero on any
# failure. A test with more threads than there are CPUs is skipped.
cd "$(dirname "$0")" || exit 1
out=${TMPDIR:-/tmp}/litmus.$$
fail=0 skip=0
for t in $(cat tests); do
  if ! ./"$t".exe -q "$@" > "$out" 2>&1; then
    echo "litmus: $t FAIL exit $?"; sed 's/^/  /' "$out"; fail=$((fail + 1)); continue
  fi
  awk -v t="$t" -f check.awk allowed.txt "$out"
  case $? in 0) ;; 2) skip=$((skip + 1)) ;; *) fail=$((fail + 1)) ;; esac
done
rm -f "$out"
if [ $fail = 0 ]; then echo "litmus: all ok, $skip skipped"; else echo "litmus: FAILED $fail"; exit 1; fi
