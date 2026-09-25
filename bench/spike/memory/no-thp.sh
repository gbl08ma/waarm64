#!/bin/sh
# Chromium with transparent huge pages disabled for it and its children
# (prctl PR_SET_THP_DISABLE is inherited across fork/exec; no root needed), so
# large-working-set results don't depend on khugepaged timing. Linux only.
#   CHROMIUM=bench/spike/memory/no-thp.sh node bench/run.ts ...
exec python3 -c 'import ctypes, os, sys
if ctypes.CDLL(None).prctl(41, 1, 0, 0, 0): sys.exit("prctl(PR_SET_THP_DISABLE) failed")
os.execv(sys.argv[1], sys.argv[1:])' "${CHROMIUM_REAL:-/usr/bin/chromium}" "$@"
