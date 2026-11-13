# The disk I/O benchmark's guest side (bench/io/suite.ts): run by `init=/bin/sh -- -c ". /mnt/guest.sh"` after the
# host's 9p share (this file) is mounted. /dev/vda is the read-only root; /dev/vdb is the disk under test (256 MiB,
# a chosen file with a fresh overlay). Each job's JSON sits between "waarm64: <name> start" and "waarm64: <name> end".
mark() { echo "waarm64: $1"; }
want() { [ -z "$ONLY" ] || case " $ONLY " in *" $1 "*) return 0;; *) return 1;; esac; }
job() { # name, then fio options
  n=$1; shift
  want $n || return 0
  mark "$n start"
  fio --name=$n --filename=/dev/vdb --ioengine=psync --direct=1 --output-format=json "$@"
  mark "$n end"
}
T="--runtime=${RUNTIME:-3} --time_based"
# Base reads (the file's bytes, nothing written yet).
job randread4k --rw=randread --bs=4k $T
job seqread128k --rw=read --bs=128k $T
job seqread1M --rw=read --bs=1M $T
want dd && { mark "dd start"; dd if=/dev/vdb of=/dev/null bs=1M count=128 2>/dev/null; mark "dd end"; }
# Writes: first writes to fresh blocks (sequential, then with an fsync after each write), random 4 KiB without and with fsync.
job seqwrite1M --rw=write --bs=1M --size=64M
job seqwrite1M_fsync --rw=write --bs=1M --size=16M --offset=64M --fsync=1
job randwrite4k --rw=randwrite --bs=4k --size=16M --io_size=8M --offset=80M --runtime=10
job randwrite4k_fsync --rw=randwrite --bs=4k --size=16M --io_size=1M --offset=96M --runtime=10 --fsync=1
want ddsync && { mark "ddsync start"; dd if=/dev/zero of=/dev/vdb bs=1M count=16 seek=112 conv=fsync 2>/dev/null; mark "ddsync end"; }
# Reads of what the guest wrote (the overlay's blocks).
job heldseqread1M --rw=read --bs=1M --size=64M $T
job heldrandread4k --rw=randread --bs=4k --size=64M $T
mark "test ok"
