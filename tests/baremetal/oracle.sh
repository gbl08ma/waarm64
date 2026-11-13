#!/usr/bin/env bash
# Runs the bare-metal tests' oracle builds on qemu-system-aarch64 -M virt and
# prints each one's exit code (0 = pass), read from the "exit <code>" line it
# prints on the PL011. Run build.sh first.
# Always a GICv3; a test's "// smp: N" line gives the CPU count, its
# "// input: <text>" line what to type on the serial console (after a second),
# and a "// flash" line attaches an erased flash bank 1 (the firmware
# configuration's variable store, M8 phase B).
#   oracle.sh           local TCG, Cortex-A57 (ARMv8.0; a test's "// qemu-cpu: <model>"
#                       line overrides it): the -DORACLE builds
#   oracle.sh --hvf     hvf on the M4 Mac (real Apple hardware at EL1, Apple's
#                       in-kernel vGIC), over ssh: the -DORACLE -DHVF builds
set -euo pipefail
cd "$(dirname "$0")"
out=../../target/baremetal
MAC=macmini.lan
qemu_args=(-m 128 -display none -monitor none -serial stdio -no-reboot)
hvf=$([ "${1:-}" = --hvf ] && echo 1 || true)
if [ -n "$hvf" ]; then
  ssh "$MAC" 'mkdir -p /tmp/waarm64-baremetal'
  scp -q "$out"/*-hvf.elf "$MAC":/tmp/waarm64-baremetal/
fi
for src in *.c; do
  t=${src%.c}
  smp=$(sed -n 's|^// smp: \([0-9]*\)$|\1|p' "$src"); smp=${smp:-1}
  cpu=$(sed -n 's|^// qemu-cpu: \(.*\)$|\1|p' "$src"); cpu=${cpu:-cortex-a57}
  input=$(sed -n 's|^// input: \(.*\)$|\1|p' "$src")
  stdin() { if [ -n "$input" ]; then sleep 1; printf '%s\n' "$input"; sleep 5; fi; }
  flash=()
  if grep -qx '// flash' "$src"; then
    if [ -n "$hvf" ]; then
      ssh "$MAC" "head -c 67108864 /dev/zero | LC_ALL=C tr '\\000' '\\377' > /tmp/waarm64-baremetal/flash1.img"
      flash=(-drive if=pflash,unit=1,format=raw,file=/tmp/waarm64-baremetal/flash1.img)
    else
      head -c 67108864 /dev/zero | LC_ALL=C tr '\000' '\377' > "$out/flash1.img"
      flash=(-drive "if=pflash,unit=1,format=raw,file=$out/flash1.img")
    fi
  fi
  if [ -n "$hvf" ]; then
    # Bounded on the Mac too: timeout ends ssh, not the QEMU it started there (one spun for days, 2026-11-03).
    log=$(timeout 60 ssh "$MAC" perl -e "'alarm shift; exec @ARGV'" 50 /opt/homebrew/bin/qemu-system-aarch64 -M virt,gic-version=3 -accel hvf -cpu host -smp "$smp" \
      "${qemu_args[@]}" "${flash[@]}" -kernel "/tmp/waarm64-baremetal/$t-hvf.elf" < <(stdin) || true)
  else
    log=$(timeout 30 qemu-system-aarch64 -M virt,gic-version=3 -accel tcg -cpu "$cpu" -smp "$smp" "${qemu_args[@]}" \
      "${flash[@]}" -kernel "$out/$t-oracle.elf" < <(stdin) || true)
  fi
  code=$(printf '%s\n' "$log" | tr -d '\r' | sed -n 's/^exit \([0-9]*\)$/\1/p' | tail -1)
  echo "$t: ${code:-no exit line}"
done
