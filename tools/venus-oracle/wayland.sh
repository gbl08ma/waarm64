#!/usr/bin/env bash
# Runs a command beside a headless sway (pixman, no outputs on screen), with WAYLAND_DISPLAY set to its socket's
# full path (so XDG_RUNTIME_DIR stays the user's), then stops sway. For presenting Venus clients:
#   tools/venus-oracle/wayland.sh env VENUS_WSI=1 MESA_VK_WSI_DEBUG=sw tools/venus-oracle/capture.sh vkcube \
#     vkcube --wsi wayland --c 200
# Venus's own Wayland WSI over vtest crashes vkcube in wsi_GetSwapchainImagesKHR on this sway (the dma-buf path);
# MESA_VK_WSI_DEBUG=sw (wl_shm, the image in host-visible memory) works. Env: SWAY_SIZE (default 1280x720).
set -euo pipefail
[ $# -gt 0 ] || { echo "usage: $0 <command...>" >&2; exit 2; }
dir=$(mktemp -d /tmp/venus-wl.XXXXXX)
chmod 700 "$dir"
printf 'output HEADLESS-1 resolution %s\n' "${SWAY_SIZE:-1280x720}" > "$dir/sway.conf"
env XDG_RUNTIME_DIR="$dir" WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1 \
  sway -c "$dir/sway.conf" > "$dir/sway.log" 2>&1 &
sway=$!
cleanup() { kill "$sway" 2>/dev/null || true; wait "$sway" 2>/dev/null || true; rm -rf "$dir"; }
trap cleanup EXIT
for _ in $(seq 100); do [ -S "$dir/wayland-1" ] && break; sleep 0.1; done
[ -S "$dir/wayland-1" ] || { echo "sway didn't start:" >&2; cat "$dir/sway.log" >&2; exit 1; }
status=0
WAYLAND_DISPLAY=$dir/wayland-1 "$@" || status=$?
exit $status
