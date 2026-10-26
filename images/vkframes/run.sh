#!/bin/sh
# In the guest (images/vkframes/build.sh's disk, mounted at /vkf): replays a program's capture on the Venus device
# offscreen (its memory types mapped onto the device's: lavapipe's first is host-visible, ours isn't), screenshots the frames build.sh chose, and compares each with lavapipe's reference byte by byte:
#   /vkf/run.sh <name>  ->  "frame <n> bytes <total> differ <bytes that differ> over <bytes off by more than 24> max <largest difference>"
# (a frame missing or of another size: "frame <n> missing"). The replay's own output is in /tmp/vkf/<name>.log.
set -u
name=$1
frames=$(awk -v n="$name" '$1 == n { print $2 }' /vkf/programs)
out=/tmp/vkf/$name
rm -rf "$out"; mkdir -p "$out"
LD_LIBRARY_PATH=/vkf/lib VK_DRIVER_FILES=/usr/share/vulkan/icd.d/virtio_icd.json \
  /vkf/bin/gfxrecon-replay -m remap --swapchain offscreen --screenshots "$frames" --screenshot-dir "$out" \
  --screenshot-prefix "$name" "/vkf/$name.gfxr" > "/tmp/vkf/$name.log" 2>&1
status=$?
echo "replay $status"
# What went wrong, briefly (the screen holds a few lines).
[ "$status" = 0 ] || grep -m 4 -E 'FATAL|ERROR|error' "/tmp/vkf/$name.log" | cut -c 1-300
for ref in /vkf/ref/"$name"_frame_*.bmp; do
  f=${ref##*_frame_}; f=${f%.bmp}
  got=$out/${name}_frame_$f.bmp
  if [ ! -f "$got" ] || [ "$(wc -c < "$got")" != "$(wc -c < "$ref")" ]; then echo "frame $f missing"; continue; fi
  # cmp -l: each differing byte's offset and both values in octal.
  cmp -l "$ref" "$got" | awk -v f="$f" -v total="$(wc -c < "$ref")" '
    function oct(s,  v, i) { v = 0; for (i = 1; i <= length(s); i++) v = v * 8 + substr(s, i, 1); return v }
    { d = oct($2) - oct($3); if (d < 0) d = -d; n++; if (d > 24) over++; if (d > max) max = d }
    END { printf "frame %s bytes %d differ %d over %d max %d\n", f, total, n, over, max }'
done
