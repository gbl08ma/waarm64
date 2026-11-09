#!/usr/bin/env bash
# Builds the bare-metal EL1 tests into flat binaries (loaded at 0x4000_0000,
# entry at the first byte): <test>.bin from start.S + <test>.c, and virtio/<test>.bin from virtio/<test>.c. The binaries are
# committed so `cargo test` needs no cross compiler; rerun this after editing.
# The ELFs (and the -DORACLE and -DHVF variants oracle.sh runs) go to target/baremetal/.
set -euo pipefail
cd "$(dirname "$0")"
out=../../target/baremetal
mkdir -p "$out"
cc() {
  clang --target=aarch64-none-elf -march=armv8-a -O2 -mgeneral-regs-only -ffreestanding -nostdlib \
    -static -fno-stack-protector -fno-pie -fuse-ld=lld -Wl,-T,link.ld -Wall -Werror \
    "$@"
}
for src in *.c; do
  t=${src%.c}
  cc -o "$out/$t.elf" start.S "$src"
  cc -DORACLE -o "$out/$t-oracle.elf" start.S "$src" # for oracle.sh
  cc -DORACLE -DHVF -o "$out/$t-hvf.elf" start.S "$src" # for oracle.sh --hvf
  llvm-objcopy -O binary "$out/$t.elf" "$t.bin"
  chmod 644 "$t.bin"
done
# The device tests (virtio/, run by tests/virtio-guest.test.ts with their disks), without oracle variants.
mkdir -p "$out/virtio"
for src in virtio/*.c; do
  t=${src%.c}
  cc -o "$out/$t.elf" start.S "$src"
  llvm-objcopy -O binary "$out/$t.elf" "$t.bin"
  chmod 644 "$t.bin"
done
