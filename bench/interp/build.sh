#!/usr/bin/env bash
# Builds the flat guest binary (loaded at 0x10000, entry at its first byte) for the MIPS benchmark.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p ../../target/bench
clang --target=aarch64-linux-gnu -O2 -ffreestanding -nostdlib -static -fno-stack-protector -fno-pie \
  -mgeneral-regs-only -fuse-ld=lld -Wl,-T,guest.ld -Wall -Werror -o ../../target/bench/guest.elf guest.c
llvm-objcopy -O binary ../../target/bench/guest.elf guest.bin
