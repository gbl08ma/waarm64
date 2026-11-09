#!/usr/bin/env bash
# Builds the flat guest binaries (loaded at 0x10000, entry at their first byte) for the
# MIPS benchmarks: guest.bin (integer, M1) and guest-fp.bin (FP/NEON, M2, ARMv8.0 only) and guest-fz.bin (its FZ mode);
# and for vm_run MIPS (M4) guest-vm.bin (guest.c linked at 0x40210000) with its EL1
# entry vm-start.bin (raw, at 0x40200000).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p ../../target/bench
cc() {
  clang --target=aarch64-linux-gnu -O2 -ffreestanding -nostdlib -static -fno-stack-protector -fno-pie \
    -fuse-ld=lld -Wl,-T,guest.ld -Wall -Werror "$@"
}
cc -Wl,--defsym=BASE=0 -mgeneral-regs-only -o ../../target/bench/guest.elf guest.c
llvm-objcopy -O binary ../../target/bench/guest.elf guest.bin
cc -Wl,--defsym=BASE=0 -march=armv8-a -fno-math-errno -o ../../target/bench/guest-fp.elf guest-fp.c
llvm-objcopy -O binary ../../target/bench/guest-fp.elf guest-fp.bin
cc -Wl,--defsym=BASE=0 -march=armv8-a -fno-math-errno -DFZ -o ../../target/bench/guest-fz.elf guest-fp.c
llvm-objcopy -O binary ../../target/bench/guest-fz.elf guest-fz.bin
cc -Wl,--defsym=BASE=0x40200000 -DBASE=0x40200000 -mgeneral-regs-only -o ../../target/bench/guest-vm.elf guest.c
llvm-objcopy -O binary ../../target/bench/guest-vm.elf guest-vm.bin
clang --target=aarch64-linux-gnu -nostdlib -static -fuse-ld=lld -Wl,-Ttext=0x40200000,--build-id=none -o ../../target/bench/vm-start.elf vm-start.S
llvm-objcopy -O binary -j .text ../../target/bench/vm-start.elf vm-start.bin
chmod 644 guest.bin guest-fp.bin guest-fz.bin guest-vm.bin vm-start.bin
