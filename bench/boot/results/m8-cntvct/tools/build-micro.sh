#!/usr/bin/env bash
# Builds micro.c twice (the loop's MRS: CNTVCT_EL0, an exit; TPIDR_EL1, inline) with tests/baremetal's runtime
# -> target/cntvct/<reg>.bin.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
cd "$here/../../../../../tests/baremetal"
out=../../target/cntvct
mkdir -p "$out"
for r in cntvct_el0 tpidr_el1; do
  clang --target=aarch64-none-elf -march=armv8-a -O2 -mgeneral-regs-only -ffreestanding -nostdlib -static \
    -fno-stack-protector -fno-pie -fuse-ld=lld -Wl,-T,link.ld -Wall -I. "-DREG=\"$r\"" \
    -o "$out/$r.elf" start.S "$here/micro.c"
  llvm-objcopy -O binary "$out/$r.elf" "$out/$r.bin"
done
