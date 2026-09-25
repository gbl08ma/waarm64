#!/usr/bin/env bash
# Builds the flat guest binaries (loaded at 0x10000, entry at their first byte) for the
# MIPS benchmarks: guest.bin (integer, M1) and guest-fp.bin (FP/NEON, M2, ARMv8.0 only).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p ../../target/bench
cc() {
  clang --target=aarch64-linux-gnu -O2 -ffreestanding -nostdlib -static -fno-stack-protector -fno-pie \
    -fuse-ld=lld -Wl,-T,guest.ld -Wall -Werror "$@"
}
cc -mgeneral-regs-only -o ../../target/bench/guest.elf guest.c
llvm-objcopy -O binary ../../target/bench/guest.elf guest.bin
cc -march=armv8-a -fno-math-errno -o ../../target/bench/guest-fp.elf guest-fp.c
llvm-objcopy -O binary ../../target/bench/guest-fp.elf guest-fp.bin
chmod 644 guest.bin guest-fp.bin
