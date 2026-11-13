#!/usr/bin/env bash
# Builds Berkeley TestFloat 3e (with SoftFloat 3e) under target/testfloat, once,
# and checks waarm64_core::fp against its vectors (core/tests/testfloat.rs).
# Commits and licenses: THIRD_PARTY.json. Needs network access on the first run.
set -euo pipefail
cd "$(dirname "$0")/.."
dir=target/testfloat
tfgen=$dir/testfloat/build/Linux-x86_64-GCC/testfloat_gen
if [ ! -x "$tfgen" ]; then
  rm -rf "$dir" && mkdir -p "$dir"
  fetch() { # name commit sha256
    mkdir "$dir/$1"
    if curl -fsSL -o "$dir/$1.tar.gz" "https://github.com/ucb-bar/berkeley-$1-3/archive/$2.tar.gz"; then
      echo "$3  $dir/$1.tar.gz" | sha256sum -c --quiet
      tar xzf "$dir/$1.tar.gz" -C "$dir/$1" --strip-components=1
    else # e.g. Claude Code cloud sessions, whose proxy refuses codeload.github.com: the commit id pins it instead
      git -C "$dir/$1" init -q
      git -C "$dir/$1" fetch -q --depth 1 "https://github.com/ucb-bar/berkeley-$1-3.git" "$2"
      git -C "$dir/$1" checkout -q FETCH_HEAD
    fi
  }
  fetch softfloat a0c6494cdc11865811dec815d5c0049fba9d82a8 1f719bcc8878be9627f6cfc44a0d6dbddf32bacc70ac81193bcbf2c62f97cbe9
  fetch testfloat a9c849f1b0eb0264b626d9686ffae167d996e3be 54852fd1d11f0109011e54d69952cda097d3c49709ce46e4800353a6e8c764c3
  command make -s -C "$dir/softfloat/build/Linux-x86_64-GCC" -j"$(nproc)" >/dev/null
  command make -s -C "$dir/testfloat/build/Linux-x86_64-GCC" -j"$(nproc)" SOFTFLOAT_DIR=../../../softfloat testfloat_gen >/dev/null
fi
TESTFLOAT_GEN="$PWD/$tfgen" cargo test -q --release --test testfloat -- --nocapture 2>&1 | grep -v '^$'
