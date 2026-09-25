#!/usr/bin/env bash
# Cross-builds the golden-corpus harness (static aarch64 Linux, no libc) to target/harness/harness.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p target/harness
clang --target=aarch64-linux-gnu -O2 -ffreestanding -nostdlib -static -fno-stack-protector \
  -fno-pie -mgeneral-regs-only -fuse-ld=lld -Wl,--image-base=0x400000 -Wl,--defsym=test_code=0x100000 -Wall -Werror \
  -o target/harness/harness tests/harness/harness.c
