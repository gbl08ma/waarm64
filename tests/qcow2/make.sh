#!/usr/bin/env bash
# Regenerates the qcow2 reader's fixtures with qemu-img/qemu-io (M4 step 4).
# data.raw is what every readable image must read as: 48 clusters of 4 KiB,
# random (stored uncompressed even with -c), zeros (left unallocated), text
# (compressible), and 4 clusters zeroed after allocation (v3: zero-flag
# entries that still carry an offset). The reject-* images each use one
# feature the reader refuses. Tests: core/tests/qcow2.rs, tests/qcow2.test.ts.
set -euo pipefail
cd "$(dirname "$0")"
rm -f ./*.raw ./*.qcow2 ./*.bin
python3 - <<'PY'
import random
random.seed(4)
b = bytearray(random.randbytes(16 * 4096))              # clusters 0-15
b += bytes(8 * 4096)                                     # 16-23
b += (b"waarm64 qcow2 fixture, compressible text. " * 1700)[:16 * 4096]  # 24-39
b += random.randbytes(8 * 4096)                          # 40-47 (40-43 zeroed below)
open("full.bin", "wb").write(b)
b[40 * 4096:44 * 4096] = bytes(4 * 4096)
open("data.raw", "wb").write(b)
PY
zero() { qemu-io -f qcow2 -c "write -z $((40 * 4096)) $((4 * 4096))" "$1" > /dev/null; }
qemu-img convert -f raw -O qcow2 -o compat=0.10,cluster_size=4096 full.bin v2.qcow2 && zero v2.qcow2
qemu-img convert -f raw -O qcow2 -o compat=1.1,cluster_size=512 full.bin v3.qcow2 && zero v3.qcow2
qemu-img convert -c -f raw -O qcow2 -o compat=1.1,cluster_size=4096 data.raw deflate.qcow2
rm full.bin
qemu-img create -q -f raw base.bin 64K
qemu-img create -q -f qcow2 -b base.bin -F raw reject-backing.qcow2
qemu-img convert -c -f raw -O qcow2 -o compression_type=zstd data.raw reject-zstd.qcow2
qemu-img create -q -f qcow2 -o extended_l2=on reject-extl2.qcow2 64K
qemu-img create -q -f qcow2 -o data_file=base.bin,data_file_raw=on reject-datafile.qcow2 64K
qemu-img create -q -f qcow2 --object secret,id=k,data=waarm64 -o encrypt.format=luks,encrypt.key-secret=k reject-luks.qcow2 64K
rm base.bin
for f in *.qcow2; do printf '%s: ' "$f"; qemu-img map -f qcow2 --output=json "$f" 2>/dev/null | grep -c '"compressed": true' || true; done
