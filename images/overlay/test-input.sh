#!/bin/sh
# virtio-input test (M4 step 6; `-- /test-input.sh`): a keyboard (event0) and a
# tablet (event1). Setting Caps Lock goes to the host on the keyboard's status
# queue; the runner answers by pressing and releasing A on the keyboard and
# clicking the tablet at (16384, 8192). Prints each event read as
# "type code value" up to the release.
set -e
mount -t ramfs ramfs /tmp # the root is read-only
grep -E '^(N|B: (EV|ABS|REL|LED))' /proc/bus/input/devices
exec 3< /dev/input/event0 4< /dev/input/event1
# struct input_event on arm64: 16 bytes of time, then type, code (u16), value (s32).
printf '\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\021\0\001\0\001\0\0\0' > /dev/input/event0
events() { # fd, the last event to read
  while :; do
    dd bs=24 count=1 <&$1 2>/dev/null > /tmp/ev
    e="$(od -An -j16 -N4 -tu2 /tmp/ev | tr -s ' ') $(od -An -j20 -N4 -td4 /tmp/ev | tr -d ' ')"
    echo "input$1:$e"
    [ "$e" = " $2" ] && break
  done
}
events 3 "1 30 0"
events 4 "1 272 0"
echo "webpc: test ok"
