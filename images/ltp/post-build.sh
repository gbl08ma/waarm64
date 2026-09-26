#!/bin/sh
# Buildroot post-build script for the LTP guest: keeps only the tests in
# images/ltp/tests (and their helpers: files named after them) in LTP's
# testcases/bin, and drops the rest of LTP's install but its library data.
set -e
t=$1/usr/lib/ltp-testsuite
list=$WEBPC_IMAGES/ltp/tests
cd "$t/testcases/bin"
for f in *; do
  base=${f%%_*}
  grep -qxF "$f" "$list" || grep -qxF "$base" "$list" || rm -rf "$f"
done
rm -rf "$t/testcases/open_posix_testsuite" "$t/testcases/kernel" "$t/runtest" "$t/scenario_groups" "$t/testscripts"
cp "$list" "$1/ltp-tests"
