#!/bin/sh
# I/O benchmark (M4 step 7; `-- /bench-fio.sh`, realtime mode): fio on /dev/vda,
# one synchronous job with O_DIRECT (no page cache): 4 KiB random reads, then
# 1 MiB sequential reads, 3 s each, timed by fio in the guest. Prints
# "BENCH <name> <value> <unit>" lines (terse v3 fields: read bandwidth in KiB/s,
# IOPS, mean completion latency in µs).
for job in randread:4k read:1M; do
  fio --name=${job%:*} --filename=/dev/vda --rw=${job%:*} --bs=${job#*:} --direct=1 --ioengine=psync \
    --runtime=3 --time_based --output-format=terse --terse-version=3 |
    awk -F';' -v n=${job%:*} '{ print "BENCH fio_" n "_bw " $7 " KiB/s"; print "BENCH fio_" n "_iops " $8 " IOPS"; print "BENCH fio_" n "_lat " $16 " us" }'
done
