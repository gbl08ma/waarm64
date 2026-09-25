#!/usr/bin/env bash
# Runs the bare-metal tests' ORACLE builds on qemu-system-aarch64 -M virt
# (TCG, Cortex-A57: ARMv8.0) and prints each one's SYSTEM_OFF code (0 = pass),
# read from x1 in QEMU's CPU log at the PSCI HVC (one instruction per TB, so
# the log has the state right before it). Run build.sh first.
set -euo pipefail
cd "$(dirname "$0")"
out=../../target/baremetal
for elf in "$out"/*-oracle.elf; do
  t=$(basename "$elf" -oracle.elf)
  log="$out/$t-oracle.log"
  timeout 30 qemu-system-aarch64 -M virt -accel tcg,one-insn-per-tb=on -cpu cortex-a57 -m 128 -display none -serial none \
    -kernel "$elf" -d int,cpu -D "$log"
  code=$(awk '/X01=/ { x1 = $NF } /Hypervisor Call/ { print strtonum("0x" substr(x1, 5)) }' "$log" | tail -1)
  echo "$t: ${code:-no SYSTEM_OFF}"
done
