#!/usr/bin/env bash
# Runs the bare-metal tests' oracle builds on qemu-system-aarch64 -M virt and
# prints each one's exit code (0 = pass), read from the "exit <code>" line it
# prints on the PL011. Run build.sh first.
# Always a GICv3; a test's "// smp: N" line gives the CPU count.
#   oracle.sh           local TCG, Cortex-A57 (ARMv8.0): the -DORACLE builds
#   oracle.sh --hvf     hvf on the M4 Mac (real Apple hardware at EL1, Apple's
#                       in-kernel vGIC), over ssh: the -DORACLE -DHVF builds
set -euo pipefail
cd "$(dirname "$0")"
out=../../target/baremetal
MAC=macmini.lan
qemu_args=(-m 128 -display none -monitor none -serial stdio -no-reboot)
hvf=$([ "${1:-}" = --hvf ] && echo 1 || true)
if [ -n "$hvf" ]; then
  ssh "$MAC" 'mkdir -p /tmp/webpc-baremetal'
  scp -q "$out"/*-hvf.elf "$MAC":/tmp/webpc-baremetal/
fi
for src in *.c; do
  t=${src%.c}
  smp=$(sed -n 's|^// smp: \([0-9]*\)$|\1|p' "$src"); smp=${smp:-1}
  if [ -n "$hvf" ]; then
    log=$(timeout 60 ssh "$MAC" /opt/homebrew/bin/qemu-system-aarch64 -M virt,gic-version=3 -accel hvf -cpu host -smp "$smp" \
      "${qemu_args[@]}" -kernel "/tmp/webpc-baremetal/$t-hvf.elf" </dev/null || true)
  else
    log=$(timeout 30 qemu-system-aarch64 -M virt,gic-version=3 -accel tcg -cpu cortex-a57 -smp "$smp" "${qemu_args[@]}" \
      -kernel "$out/$t-oracle.elf" </dev/null || true)
  fi
  code=$(printf '%s\n' "$log" | tr -d '\r' | sed -n 's/^exit \([0-9]*\)$/\1/p' | tail -1)
  echo "$t: ${code:-no exit line}"
done
