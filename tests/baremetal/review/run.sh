#!/usr/bin/env bash
# Builds review.c and prints what each candidate does on QEMU TCG, the M4 under
# hvf, and webpc (the reference interpreter and the block interpreter), into
# tests/baremetal/review/out.
set -euo pipefail
cd "$(dirname "$0")"
out=$PWD/out
mkdir -p "$out"
clang --target=aarch64-none-elf -march=armv8-a -O2 -mgeneral-regs-only -ffreestanding -nostdlib -static \
  -fno-stack-protector -fno-pie -fuse-ld=lld -Wl,-T,../link.ld -Wall -Werror -o "$out/review.elf" ../start.S review.c
llvm-objcopy -O binary "$out/review.elf" review.bin
args=(-m 128 -display none -monitor none -serial stdio -no-reboot)
timeout 30 qemu-system-aarch64 -M virt,gic-version=3 -accel tcg -cpu max "${args[@]}" -kernel "$out/review.elf" </dev/null \
  | tr -d '\r' >"$out/qemu.txt" || true
scp -q "$out/review.elf" macmini.lan:/tmp/webpc-review.elf
timeout 60 ssh macmini.lan /opt/homebrew/bin/qemu-system-aarch64 -M virt,gic-version=3 -accel hvf -cpu host \
  "${args[@]}" -kernel /tmp/webpc-review.elf </dev/null | tr -d '\r' >"$out/hvf.txt" || true
cd ../../..
for jit in 0 1; do
  WEBPC_NATIVE_JIT=$jit REVIEW_OUT="$out/webpc-jit$jit.txt" timeout 500 \
    systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 -- \
    cargo test -p webpc-core --release --test baremetal review_observations -- --ignored --nocapture 2>&1 | tail -3
done
