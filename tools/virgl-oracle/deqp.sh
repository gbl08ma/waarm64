#!/usr/bin/env bash
# dEQP's expected results on virgl (G4's gate, graphics.md §21): the dEQP build's container (images/deqp/build.sh:
# Arch's Mesa, the same deqp-gles2/3 the guest runs) on Mesa's virpipe, against this oracle's vtest server
# (build.sh) on a GLES 3.0 host (llvmpipe with MESA_GLES_VERSION_OVERRIDE=3.0, as capture.sh). The case list is a
# mustpass list's every <stride>th case (bench/gpu/deqp-run.ts's choice) or a file. Results: <out>/<api>.res
# (`<case> <status> <seconds>` a line, as deqp-run.ts writes them in the guest) and the server's log. dEQP's
# surfaceless target takes EGL's default display (EGL_PLATFORM picks it); the socket needs the container unlabelled
# (SELinux keeps a container from connecting to the host's socket).
#   tools/virgl-oracle/deqp.sh <gles2|gles3> <out> [stride|cases-file]   (OFFSET=<k>: the stride's k-th slice)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
B=$ROOT/target/virgl-oracle/build
api=$1 out=$(realpath -m "$2") pick=${3:-50}
[ -x "$B/vtest/virgl_test_server" ] || { echo "build the oracle first: tools/virgl-oracle/build.sh" >&2; exit 1; }
podman image exists localhost/webpc-deqp || { echo "build dEQP first: images/deqp/build.sh" >&2; exit 1; }
mkdir -p "$out/sock"
sock=$out/sock/vtest.sock
rm -f "$sock"
if [ -f "$pick" ]; then cp "$pick" "$out/cases.txt"; else
  podman run --rm localhost/webpc-deqp cat /cts/external/openglcts/data/gl_cts/data/mustpass/gles/aosp_mustpass/main/$api-main.txt |
    awk -v s="$pick" -v o="${OFFSET:-0}" 'NR % s == (o + 1) % s' > "$out/cases.txt"
fi
MESA_GLES_VERSION_OVERRIDE=3.0 LD_LIBRARY_PATH=$B/src \
  timeout 7200 "$B/vtest/virgl_test_server" --use-egl-surfaceless --use-gles --socket-path "$sock" > "$out/server.log" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null || true' EXIT
for _ in $(seq 50); do [ -S "$sock" ] && break; sleep 0.1; done
podman run --rm --security-opt label=disable -v "$out:/out" -e EGL_PLATFORM=surfaceless -e GALLIUM_DRIVER=virpipe -e LIBGL_ALWAYS_SOFTWARE=1 -e VTEST_SOCKET_NAME=/out/sock/vtest.sock \
  -w /build/modules/$api localhost/webpc-deqp sh -c "
  timeout 7000 ./deqp-$api --deqp-caselist-file=/out/cases.txt --deqp-surface-type=pbuffer --deqp-gl-config-name=rgba8888d24s8ms0 \
    --deqp-surface-width=256 --deqp-surface-height=256 --deqp-log-filename=/tmp/deqp.qpa --deqp-log-images=disable \
    --deqp-log-shader-sources=disable --deqp-watchdog=enable 2>&1 |
  awk '/^Test case /{name=\$3; sub(/^\\047/, \"\", name); sub(/\\047\\.\\.\$/, \"\", name); t=systime(); next} /^  (Pass|Fail|NotSupported|QualityWarning|CompatibilityWarning|InternalError|Crash|Timeout|ResourceError) \(/{print name, \$1, systime()-t; fflush()}' > /out/$api.res"
awk '{print $2}' "$out/$api.res" | sort | uniq -c
