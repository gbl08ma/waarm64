#!/bin/sh
# I/O benchmark (M4 step 4; `-- /bench-dd.sh` on the kernel command line): a
# sequential read of all of /dev/vda, timed by the host between the markers.
echo "waarm64: dd start"
dd if=/dev/vda of=/dev/null bs=1M
echo "waarm64: dd end"
