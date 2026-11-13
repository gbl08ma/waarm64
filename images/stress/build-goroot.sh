#!/usr/bin/env bash
# Builds target/images/stress/goroot.ext4: a trimmed Go 1.26 toolchain (go, compile, link, asm,
# the std sources without tests) plus /work/{hello,web}/main.go, for running the real `go build`
# in the Debian guest (docs/images.md "stress"). Podman only, native arm64. ~1 min, ~110 MiB.
# The guest needs it as a second virtio-blk (nothing in the page's machines has one yet).
set -euo pipefail
cd "$(dirname "$0")/../.."
root=$PWD
GO_CONTAINER=docker.io/library/golang@sha256:4364967143356b3498a4bcec1f1a2a2129495333f85f8f05b4e4dbb9ef70d287 # keep in step with build.sh
ALPINE=docker.io/library/alpine@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 # images/build.sh's USERLAND_CONTAINER
mkdir -p target/images/stress
podman run --rm -v "$root:$root:z" -w "$root" -e HOME=/tmp -e SOURCE_DATE_EPOCH=1788220800 "$GO_CONTAINER" bash -euc '
  G=/usr/local/go; D=$PWD/target/images/stress/goroot.d
  rm -rf "$D"; mkdir -p "$D/go/bin" "$D/go/pkg/tool/linux_arm64" "$D/work/hello" "$D/work/web"
  cp "$G"/VERSION "$G"/go.env "$D/go/"
  echo CGO_ENABLED=0 >> "$D/go/go.env" # no gcc in the guest
  cp "$G/bin/go" "$D/go/bin/"
  for t in asm compile link; do cp "$G/pkg/tool/linux_arm64/$t" "$D/go/pkg/tool/linux_arm64/"; done
  cp -r "$G/pkg/include" "$D/go/pkg/"
  (cd "$G" && find src -path src/cmd -prune -o -type f ! -name "*_test.go" ! -path "*/testdata/*" -print | tar -cf - -T - | tar -xf - -C "$D/go")
  printf "package main\nimport \"fmt\"\nfunc main() { fmt.Println(\"hello\") }\n" > "$D/work/hello/main.go"
  printf "package main\nimport (\"net/http\"; \"encoding/json\"; \"crypto/tls\"; \"os\")\nfunc main() { _ = http.Get; _ = json.Marshal; _ = tls.Dial; os.Exit(0) }\n" > "$D/work/web/main.go"
  for d in hello web; do printf "module %s\ngo 1.26\n" $d > "$D/work/$d/go.mod"; done
  # prove the trimmed tree builds before it is packed (its own GOROOT, a cold cache)
  (cd "$D/work/web" && GOROOT="$D/go" GOCACHE=/tmp/gc GOFLAGS=-mod=mod "$D/go/bin/go" build -o /tmp/web . && /tmp/web && echo trimmed-goroot-ok)
  du -sh "$D"
'
# pack it as ext4 in Alpine's arm64 container (Go'"'"'s has no e2fsprogs)
podman run --rm -v "$root:$root:z" -w "$root" -e SOURCE_DATE_EPOCH=1788220800 "$ALPINE" sh -euc '
  apk add --no-cache -q e2fsprogs
  mke2fs -q -t ext4 -d target/images/stress/goroot.d -L waarm64-go -E root_owner=0:0 -U 5fb2a0c1-9c2a-4a41-8d3e-0d1c5a3b7e11 target/images/stress/goroot.ext4 160M
  rm -rf target/images/stress/goroot.d
'
ls -l target/images/stress/goroot.ext4
