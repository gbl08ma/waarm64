#!/usr/bin/env bash
# Prepares a Claude Code cloud session (Ubuntu x86_64 container, root, no Lima VM) to build and
# test the project. Idempotent; run by the SessionStart hook in .claude/settings.json, and a no-op
# outside cloud sessions (CLAUDE_CODE_REMOTE unset), so the local Lima VM workflow is untouched.
# What differs from the dev VM, and what is not available: docs/cloud.md.
set -euo pipefail
[ -n "${CLAUDE_CODE_REMOTE-}" ] || [ "${1-}" = --force ] || exit 0
cd "$(dirname "$0")/.."
NODE_DIR=/opt/node26
DTC_DIR=/opt/dtc
# The version of Node that package.json's engines asks for (the container ships an older one).
if [ ! -x "$NODE_DIR/bin/node" ]; then
  v=$(curl -fsS https://nodejs.org/dist/index.json | grep -o '"version":"v26\.[0-9.]*"' | head -1 | cut -d'"' -f4)
  mkdir -p "$NODE_DIR"
  curl -fsSL "https://nodejs.org/dist/$v/node-$v-linux-x64.tar.xz" | tar -xJ -C "$NODE_DIR" --strip-components=1
fi
# Test tools: dtc is built from source below (Ubuntu's 1.7.0 prints strings differently from the
# 1.7.2 that produced tests/dtb/waarm64.dts).
need=()
for p in qemu-aarch64:qemu-user qemu-img:qemu-utils flex:flex bison:bison make:make gcc:gcc; do
  command -v "${p%%:*}" >/dev/null || need+=("${p##*:}")
done
fc-list 2>/dev/null | grep -qi dejavu || need+=(fonts-dejavu-core)
# vk/build.sh (Venus's module and its native translator) and the Venus tests' shaders (docs/cloud.md).
for p in glslc:glslc glslangValidator:glslang-tools spirv-as:spirv-tools ninja:ninja-build; do
  command -v "${p%%:*}" >/dev/null || need+=("${p##*:}")
done
for p in libvulkan-dev libzstd-dev libdrm-dev python3-mako; do
  dpkg -s "$p" >/dev/null 2>&1 || need+=("$p")
done
if [ ${#need[@]} -gt 0 ]; then
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${need[@]}" >/dev/null
fi
command -v meson >/dev/null || pip install -q --break-system-packages meson >/dev/null 2>&1 || true
if [ ! -x "$DTC_DIR/dtc" ]; then
  t=$(mktemp -d)
  git clone -q --depth 1 --branch v1.7.2 https://git.kernel.org/pub/scm/utils/dtc/dtc.git "$t/dtc"
  make -s -C "$t/dtc" -j"$(nproc)" dtc NO_PYTHON=1 NO_YAML=1 >/dev/null 2>&1
  mkdir -p "$DTC_DIR" && cp "$t/dtc/dtc" "$DTC_DIR/" && rm -rf "$t"
fi
# The Playwright Chromium the container ships stands in for /usr/bin/chromium.
chrome=$(ls -d /opt/pw-browsers/chromium-*/chrome-linux*/chrome 2>/dev/null | sort | tail -1 || true)
if [ -n "${CLAUDE_ENV_FILE-}" ]; then
  {
    echo "export PATH=$NODE_DIR/bin:$DTC_DIR:\$PATH"
    echo "export NODE_USE_ENV_PROXY=1" # Node ignores HTTPS_PROXY otherwise (tools/debian.ts downloads with fetch)
    [ -z "$chrome" ] || echo "export CHROMIUM=$chrome"
  } >> "$CLAUDE_ENV_FILE"
fi
# JS dependencies (ci.sh does the same when they're stale).
PATH=$NODE_DIR/bin:$PATH
[ node_modules/.package-lock.json -nt package-lock.json ] || npm ci --no-fund --no-audit >/dev/null
[ tools/lint/node_modules/.package-lock.json -nt tools/lint/package-lock.json ] || npm ci --prefix tools/lint --no-fund --no-audit >/dev/null
# Pre-fetch the pinned nightly and its std sources (the first cargo call would otherwise do it).
rustc --version >/dev/null
# cargo-nextest, which scripts/ci.sh and scripts/ci-fast.sh run the Rust tests with (docs/devenv.md): built with stable.
cargo nextest --version >/dev/null 2>&1 || { rustup toolchain install stable --profile minimal >/dev/null && cargo +stable install --locked -q cargo-nextest@0.9.152; }
# Clipboard sharing's guest agent: without Podman, images/build.sh agent builds it with the host's cargo (rustup installs
# agent/rust-toolchain.toml's stable with its aarch64-unknown-linux-musl target; rust-lld links it), marked HOST-BUILD
# (docs/cloud.md). Not fatal: the tests that need it skip.
images/build.sh agent >/dev/null || echo "the guest agent didn't build (images/build.sh agent): its tests skip" >&2
# The UEFI firmware (EDK2) is built in Podman on arm64, which the cloud can't do; the build is
# pinned and reproducible, so the deployed page's copy is fetched instead and kept only if both
# files match images/SHA256SUMS (the guest's firmware is never one whose hash doesn't match).
# The deployed copy (`npm run dist`, tools/dist.ts) has the firmware under a hashed name in assets/,
# named in the page's bundled code, and its licenses as EDK2-LICENSES.txt; a deploy from before
# that had both under target/images/edk2/, tried first.
# shell.img (the Node firmware test's disk) isn't deployed: that test skips here.
fw=target/images/edk2
site=https://waarm64.com
if ! images/build.sh --check edk2 >/dev/null 2>&1; then
  mkdir -p "$fw"
  # The firmware's URL in the deployed page: the hashed name its index.html's scripts mention.
  firmware_url() {
    local js name
    for js in $(curl -fsSL "$site/" | grep -oE 'assets/[A-Za-z0-9_.-]+\.js' | sort -u); do
      name=$(curl -fsSL "$site/$js" | grep -oE 'QEMU_EFI-[A-Za-z0-9_-]+\.fd' | head -1)
      [ -n "$name" ] && { echo "$site/assets/$name"; return; }
    done
  }
  fetch() { # its name in images/SHA256SUMS, then the URLs to try in order
    local f=$1 want url
    shift
    want=$(grep " edk2/$f\$" images/SHA256SUMS | cut -d' ' -f1)
    for url in "$@"; do
      [ -n "$url" ] && curl -fsSL -o "$fw/$f.part" "$url" 2>/dev/null || continue
      if [ "$(sha256sum "$fw/$f.part" | cut -d' ' -f1)" = "$want" ]; then mv "$fw/$f.part" "$fw/$f"; return 0; fi
      echo "edk2/$f from $url doesn't match images/SHA256SUMS: not used" >&2
    done
    rm -f "$fw/$f.part"
    echo "edk2/$f: not found on $site (Debian on the page won't start; docs/cloud.md)" >&2
    return 1
  }
  if fetch QEMU_EFI.fd "$site/target/images/edk2/QEMU_EFI.fd" "$(firmware_url)" \
    && fetch LICENSES.txt "$site/target/images/edk2/LICENSES.txt" "$site/EDK2-LICENSES.txt"; then
    images/build.sh --inputs edk2 > "$fw/.inputs"
  fi
fi
