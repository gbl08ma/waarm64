#!/usr/bin/env bash
# Builds the guest stress workloads (docs/images.md "stress") into target/images/stress/:
#   gostress   static arm64 Go (images/stress/gostress.go), CGO off
#   cstress    static arm64 C (images/stress/cstress.c), glibc
#   initrd.img Debian's initrd (target/images/debian/) + the two binaries, run as /run/stress/<name>
# Built natively in Go's official arm64 container under rootless Podman (no cross toolchain,
# no host build dependencies, never Docker). ~1 min; needs target/images/debian/ (npm start).
# usage: images/stress/build.sh [debian-images-dir]   (default target/images/debian)
set -euo pipefail
cd "$(dirname "$0")/../.."
root=$PWD
GO_CONTAINER=docker.io/library/golang@sha256:4364967143356b3498a4bcec1f1a2a2129495333f85f8f05b4e4dbb9ef70d287 # 1.26.8-trixie, arm64 manifest
debian=${1:-target/images/debian}
out=target/images/stress
mkdir -p "$out"
podman run --rm -v "$root:$root:z" -w "$root" -e HOME=/tmp "$GO_CONTAINER" sh -euc '
  CGO_ENABLED=0 GOFLAGS=-trimpath go build -ldflags="-s -w" -o target/images/stress/gostress images/stress/gostress.go
  gcc -O2 -static -pthread -o target/images/stress/cstress images/stress/cstress.c
  strip target/images/stress/cstress
'
node images/stress/mkinitrd.ts "$debian/initrd.img" "$out/initrd.img" "$out/gostress" "$out/cstress"
ls -l "$out"
