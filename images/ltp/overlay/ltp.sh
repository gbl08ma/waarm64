#!/bin/sh
# LTP subset, arm64 and breakpoints kernel selftests and our debug test (M4
# step 7; `-- /ltp.sh` on the kernel command line). Prints one line per test,
# "ltp: <test> <exit code>", "kselftest: <test> <exit code>" and "webpc:
# debug <exit code>", with the reasons for skips and the output of failures.
# LTP: 0 pass, 32 TCONF (skipped), else failed (TFAIL 1, TBROK 2, TWARN 4).
# kselftest: 0 pass, 4 skip, else failed.
mount -t tmpfs tmpfs /tmp
mkdir -p /dev/shm && mount -t tmpfs tmpfs /dev/shm
export TMPDIR=/tmp LTPROOT=/usr/lib/ltp-testsuite
export PATH=$PATH:$LTPROOT/testcases/bin
cd /tmp
for t in $(cat /ltp-tests); do
  $t > /tmp/out 2>&1
  e=$?
  echo "ltp: $t $e"
  case $e in
    0) ;;
    32) grep -m2 TCONF /tmp/out ;;
    *) cat /tmp/out ;;
  esac
done
cd /usr/lib/kselftests/arm64 # abi, signal and tags, installed flat
for t in * ../breakpoints/breakpoint_test_arm64; do
  [ -x "$t" ] && [ -f "$t" ] || continue
  ./$t > /tmp/out 2>&1
  e=$?
  echo "kselftest: ${t##*/} $e"
  case $e in
    0) ;;
    4) grep -m2 -i skip /tmp/out ;;
    *) cat /tmp/out ;;
  esac
done
# Self-hosted debug: ptrace single step, perf breakpoints and watchpoints
# (images/ltp/debug.c). 0 pass, else failed.
webpc-debug > /tmp/out 2>&1
e=$?
echo "webpc: debug $e"
[ $e = 0 ] || cat /tmp/out
echo "webpc: test ok"
