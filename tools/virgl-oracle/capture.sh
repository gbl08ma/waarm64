#!/usr/bin/env bash
# Runs one GL client against the virgl oracle (build.sh) on a GLES 3.0 host (llvmpipe with
# MESA_GLES_VERSION_OVERRIDE=3.0, about what WebGL2 is) and keeps what it sent:
#   <out>/<name>.dump        the stream (dump.ts reads it: submits, resources, transfers, the capsets)
#   <out>/<name>.server.log  the TGSI virglrenderer received and the GLSL it made, per shader
#   <out>/<name>.client.log  the client's output (VIRGL_DEBUG=tgsi: the TGSI Mesa sent)
# The client runs on GALLIUM_DRIVER=virpipe (Mesa's virgl over vtest). Clients that need a window run under
# xvfb-run (glmark2-es2 --off-screen works; es2gears doesn't, EGLUT wants DRI3).
#   tools/virgl-oracle/capture.sh <out> <name> <client command...>
#   e.g. tools/virgl-oracle/capture.sh bench/results/local/g2 glcomp ./glcomp 3
#        tools/virgl-oracle/capture.sh bench/results/local/g2 glmark2 xvfb-run -a glmark2-es2 --off-screen -b texture:duration=1
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
B=$ROOT/target/virgl-oracle/build
[ -x "$B/vtest/virgl_test_server" ] || { echo "build the oracle first: tools/virgl-oracle/build.sh" >&2; exit 1; }
out=$(realpath "$1") name=$2
shift 2
mkdir -p "$out"
sock=$out/.$name.sock
rm -f "$out/$name.dump" "$sock"
VTEST_DUMP=$out/$name.dump VREND_DEBUG=shader MESA_GLES_VERSION_OVERRIDE=3.0 LD_LIBRARY_PATH=$B/src \
  timeout 300 "$B/vtest/virgl_test_server" --use-egl-surfaceless --use-gles --no-loop-or-fork --socket-path "$sock" \
  > "$out/$name.server.log" 2>&1 &
server=$!
for _ in $(seq 50); do [ -S "$sock" ] && break; sleep 0.1; done
GALLIUM_DRIVER=virpipe VTEST_SOCKET_NAME=$sock VIRGL_DEBUG=tgsi timeout 240 "$@" > "$out/$name.client.log" 2>&1 || echo "client exited $?" >&2
wait "$server" || true
rm -f "$sock"
echo "$out/$name.dump: $(grep -c 'TGSI received' "$out/$name.server.log") shaders"
