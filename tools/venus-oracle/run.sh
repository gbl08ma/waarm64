#!/usr/bin/env bash
# Runs one Vulkan client through the Venus oracle (build.sh): starts `virgl_test_server --venus` (its render server
# on the host's lavapipe), runs the client on Mesa's Venus ICD over vtest, then stops the server.
#   tools/venus-oracle/run.sh <client command...>
#   e.g. tools/venus-oracle/run.sh vulkaninfo --summary
#        tools/venus-oracle/run.sh target/vulkan/scene/vk --pack target/vulkan/aquarium.pack \
#          --shaders target/vulkan/scene/shaders --fish 100 --dump 30:/tmp/venus.ppm
# Env: VENUS_SERVER_LOG (default: the server's output to stderr), VENUS_HOST_ICD (the host driver's manifest,
# default lavapipe's), VENUS_TIMEOUT (seconds for the client, default 300). The client's own env passes through
# (VN_DEBUG gets vtest added; VN_PERF etc. work as usual).
# VENUS_DUMP=<file>: run build.sh --capture's server instead, which appends capture.patch's records to <file>
# (read it with tools/venus-oracle/dump.ts). VENUS_WSI=1: build.sh --wsi's Venus driver (Wayland), for clients that
# present; the client then needs WAYLAND_DISPLAY (a headless sway, e.g.).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
P=$ROOT/target/venus-oracle/install
[ -x "$P/bin/virgl_test_server" ] || { echo "build the oracle first: tools/venus-oracle/build.sh" >&2; exit 1; }
SP=$P   # the server's install
if [ -n "${VENUS_DUMP:-}" ]; then
  SP=$ROOT/target/venus-oracle/install-capture
  [ -x "$SP/bin/virgl_test_server" ] || { echo "build the capture first: tools/venus-oracle/build.sh --capture" >&2; exit 1; }
fi
CP=$P   # the client driver's install
if [ "${VENUS_WSI:-0}" = 1 ]; then
  CP=$ROOT/target/venus-oracle/install-wsi
  [ -d "$CP/share/vulkan/icd.d" ] || { echo "build the WSI driver first: tools/venus-oracle/build.sh --wsi" >&2; exit 1; }
fi
# lavapipe exports host-visible memory as a dma-buf only through /dev/udmabuf (root:kvm 0660 in the dev VM). Without
# it, it exports an opaque fd, a memfd whose data starts past a header: vtest refuses it, and a client mapping it at
# offset 0 overwrites the header (lavapipe crashes in vkFreeMemory).
if [ ! -r /dev/udmabuf ] || [ ! -w /dev/udmabuf ]; then
  echo "/dev/udmabuf isn't open to $(id -un): sudo setfacl -m u:$(id -un):rw /dev/udmabuf (until reboot)" >&2
  exit 1
fi
[ $# -gt 0 ] || { echo "usage: $0 <client command...>" >&2; exit 2; }
HOST_ICD=${VENUS_HOST_ICD:-/usr/share/vulkan/icd.d/lvp_icd.aarch64.json}
# A short directory: a unix socket's path must fit sun_path (108 bytes).
dir=$(mktemp -d /tmp/venus.XXXXXX)
sock=$dir/vtest.sock
server=
cleanup() {
  if [ -n "$server" ]; then kill "$server" 2>/dev/null || true; wait "$server" 2>/dev/null || true; fi
  rm -rf "$dir"
}
trap cleanup EXIT
# The server keeps virgl (GL) on too, on llvmpipe's surfaceless EGL (the winsys it needs in the VM), so it offers
# both capsets as our device will.
env LD_LIBRARY_PATH="$SP/lib64" RENDER_SERVER_EXEC_PATH="$SP/libexec/virgl_render_server" VK_DRIVER_FILES="$HOST_ICD" \
  timeout $((${VENUS_TIMEOUT:-300} + 30)) "$SP/bin/virgl_test_server" --venus --use-egl-surfaceless --use-gles \
  --socket-path "$sock" > "${VENUS_SERVER_LOG:-/dev/stderr}" 2>&1 &
server=$!
for _ in $(seq 100); do [ -S "$sock" ] && break; sleep 0.1; done
[ -S "$sock" ] || { echo "the vtest server didn't start" >&2; exit 1; }
status=0
env -u VENUS_DUMP VK_DRIVER_FILES="$CP/share/vulkan/icd.d/virtio_icd.aarch64.json" VN_DEBUG="vtest${VN_DEBUG:+,$VN_DEBUG}" \
  VTEST_SOCKET_NAME="$sock" timeout "${VENUS_TIMEOUT:-300}" "$@" || status=$?
exit $status
