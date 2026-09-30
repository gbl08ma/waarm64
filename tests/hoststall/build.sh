#!/usr/bin/env bash
# Builds the host-stall guests (tests/hoststall.test.ts) from stall.c with the bare-metal runtime:
# stall-run.bin, stall-install.bin, stall-idle.bin, stall-waiter.bin. Committed, like tests/baremetal's.
set -euo pipefail
cd "$(dirname "$0")"
out=../../target/baremetal
mkdir -p "$out"
b=../baremetal
cc() {
  clang --target=aarch64-none-elf -march=armv8-a -O2 -mgeneral-regs-only -ffreestanding -nostdlib \
    -static -fno-stack-protector -fno-pie -fuse-ld=lld -Wl,-T,$b/link.ld -Wall -Werror "$@"
}
for v in run install idle waiter; do
  case $v in run) d=;; install) d=-DFRESH;; idle) d=-DIDLE;; waiter) d=-DWAITER;; esac
  cc $d -o "$out/stall-$v.elf" $b/start.S stall.c
  llvm-objcopy -O binary "$out/stall-$v.elf" "stall-$v.bin"
  chmod 644 "stall-$v.bin"
done
