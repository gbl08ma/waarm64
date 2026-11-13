#!/bin/sh
# Writable root (M4 step 5; `-- /test-rw.sh` on the kernel command line, the
# disk behind a copy-on-write overlay): remount / read-write, count this boot,
# check what an earlier boot wrote or write it, and remount read-only so it is
# all on the disk before power-off.
set -e
mount -o remount,rw /
n=$(($(cat /rw-count 2>/dev/null || echo 0) + 1))
echo $n > /rw-count
echo "rw: boot $n"
if [ -f /rw-data ]; then
  echo "rw: kept $(md5sum < /rw-data)"
else
  head -c 300000 /dev/hwrng > /rw-data
  echo "rw: wrote $(md5sum < /rw-data)"
fi
mount -o remount,ro /
echo "waarm64: test ok"
