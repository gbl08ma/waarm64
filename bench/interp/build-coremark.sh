#!/usr/bin/env bash
# Builds CoreMark as a flat benchmark guest (M5 step 10), like guest.bin (loaded
# at 0x10000, entry at its first byte) but not committed: CoreMark (EEMBC,
# Apache-2.0; "CoreMark" names only results of unmodified sources) is fetched at
# a pinned commit into target/dl/coremark and built unmodified with our port
# layer (coremark/) into target/bench/coremark.bin, which bench/interp/suite.ts
# loads. ITERATIONS per run of CoreMark's main; the guest reruns it forever.
set -euo pipefail
cd "$(dirname "$0")"
COREMARK=1f483d5b8316753a742cbf5590caf5bd0a4e4777 # eembc/coremark main, 2025-05-01
ITERATIONS=10
cm=../../target/dl/coremark
out=../../target/bench
mkdir -p "$out" ../../target/dl
[ -d "$cm" ] || git clone -q https://github.com/eembc/coremark.git "$cm"
git -C "$cm" checkout -q "$COREMARK"
git -C "$cm" diff --quiet || { echo "coremark: $cm has local changes" >&2; exit 1; }
flags="-O2"
clang --target=aarch64-linux-gnu $flags -ffreestanding -nostdlib -static -fno-stack-protector -fno-pie \
  -fuse-ld=lld -Wl,-T,guest.ld -Wl,--defsym=BASE=0 -fno-builtin \
  -DITERATIONS=$ITERATIONS "-DFLAGS_STR=\"$flags\"" -Icoremark -I"$cm" \
  -o "$out/coremark.elf" coremark/core_portme.c "$cm"/core_{list_join,main,matrix,state,util}.c
llvm-objcopy -O binary "$out/coremark.elf" "$out/coremark.bin"
echo "$out/coremark.bin: $(stat -c %s "$out/coremark.bin") bytes, $ITERATIONS iterations per run"
# The reference: the same sources and flags as a static Linux program on raw
# syscalls (CoreMark picks its iterations and times itself), to run natively
# and under qemu-aarch64: target/bench/coremark-linux.
clang --target=aarch64-linux-gnu $flags -ffreestanding -nostdlib -static -fno-stack-protector -fno-pie \
  -fuse-ld=lld -fno-builtin -DWEBPC_LINUX -DITERATIONS=0 "-DFLAGS_STR=\"$flags\"" -Icoremark -I"$cm" \
  -o "$out/coremark-linux" coremark/core_portme.c "$cm"/core_{list_join,main,matrix,state,util}.c
