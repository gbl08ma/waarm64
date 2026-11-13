#!/usr/bin/env bash
# The host-side USB test devices of docs/testing.md "USB: the dev VM's host rigs": configfs gadgets on dummy_hcd, in the dev VM's own kernel,
# seen by its Chromium as real USB devices (WebUSB) and by QEMU's usb-host. Needs passwordless sudo.
#
#   tests/usb/gadget.sh install        once per machine (and after a kernel update): builds dummy_hcd for the running
#                                      kernel, installs it with the udev rule, the modprobe blocklist and Chromium's
#                                      policy (docs/devenv.md "The USB rigs")
#   tests/usb/gadget.sh up [name...]   makes the gadgets (default: zero) and binds each to a dummy UDC
#   tests/usb/gadget.sh down [name...] unbinds and removes them (default: all of ours), and unloads dummy_hcd when none is left
#   tests/usb/gadget.sh status         what is up, with each gadget's bus path
#   tests/usb/gadget.sh check          exit 0 when the rig can come up here, else print why and exit 1
#
# Gadgets (vendor 0x0525, NetChip, as Linux's own gadgets):
#   zero      0525:a4a0 Gadget Zero as g_zero: configuration 1 source/sink (pattern 1: i % 63), configuration 2
#             loopback; serial "waarm64-zero"
#   zero-a, zero-b   two Gadget Zeros without a serial number, identical but for bcdDevice (the getDevices() order check)
#   acm       0525:a4a7 a CDC ACM serial port as g_serial's ACM mode; serial "waarm64-acm"
#
# dummy_hcd isn't built by openSUSE's kernel: `install` fetches drivers/usb/gadget/udc/dummy_hcd.c (GPL-2.0, not
# copied into this repo) for the running kernel's version from kernel.org's stable tree and builds it out of tree
# against kernel-default-devel.
set -euo pipefail
cd "$(dirname "$0")/../.."

G=/sys/kernel/config/usb_gadget
KVER=$(uname -r)
NUDC=4
POLICY=/etc/chromium/policies/managed/waarm64-usb.json
RULES=/etc/udev/rules.d/70-waarm64-usb.rules
MODPROBE=/etc/modprobe.d/50-waarm64-usb.conf
ALL=(zero zero-a zero-b acm)
# The origins the policy grants every 0525 gadget and every HID device to: the USB tests serve on these ports.
PORTS=(8190 8191 8192 8193 8194 8195 8196 8197)

die() { echo "gadget.sh: $*" >&2; exit 1; }

check() {
  local why=()
  sudo -n true 2> /dev/null || why+=('no passwordless sudo')
  [ -d /lib/modules/"$KVER"/build ] || why+=("no kernel build tree for $KVER (kernel-default-devel)")
  modinfo -n libcomposite > /dev/null 2>&1 || why+=('no libcomposite module')
  modinfo -n usb_f_ss_lb > /dev/null 2>&1 || why+=('no usb_f_ss_lb module')
  modinfo -n dummy_hcd > /dev/null 2>&1 || why+=('no dummy_hcd module (tests/usb/gadget.sh install)')
  [ -f "$RULES" ] || why+=("no $RULES (tests/usb/gadget.sh install)")
  [ -f "$POLICY" ] || why+=("no $POLICY (tests/usb/gadget.sh install)")
  if [ ${#why[@]} -gt 0 ]; then printf '%s\n' "${why[@]}"; return 1; fi
}

build_dummy() {
  # v7.2.9 from 7.2.9-1-default; a .0 release is tagged without it (v7.2).
  local v=${KVER%%-*}
  v=${v%.0}
  local dir=target/usb/dummy_hcd/$KVER
  mkdir -p "$dir/src" "$dir/build"
  if [ ! -s "$dir/src/dummy_hcd.c" ]; then
    curl -sSfL --max-time 60 -o "$dir/src/dummy_hcd.c" \
      "https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/plain/drivers/usb/gadget/udc/dummy_hcd.c?h=v$v" \
      || die "couldn't fetch dummy_hcd.c for v$v"
  fi
  cp "$dir/src/dummy_hcd.c" "$dir/build/dummy_hcd.c"
  echo 'obj-m := dummy_hcd.o' > "$dir/build/Kbuild"
  make -s -C /lib/modules/"$KVER"/build M="$PWD/$dir/build" modules 2>&1 | grep -v -e 'compiler differs' -e 'was built by' -e 'You are using' -e 'Skipping BTF' || true
  [ -f "$dir/build/dummy_hcd.ko" ] || die 'dummy_hcd.ko did not build'
  sudo install -D -m 644 "$dir/build/dummy_hcd.ko" /lib/modules/"$KVER"/updates/dummy_hcd.ko
  sudo depmod -a "$KVER"
}

install() {
  modinfo -n dummy_hcd > /dev/null 2>&1 || build_dummy
  local tmp
  tmp=$(mktemp -d)
  # Device nodes for the user (an ssh session has no seat, so uaccess doesn't apply): our gadgets' usbfs nodes, the
  # ACM gadget's device-side tty (/dev/ttyGS*: the far end of the guest's serial port),
  # /dev/uhid, and the hidraw nodes of uhid's devices (tests/usb/uhid.ts).
  cat > "$tmp/rules" << 'EOF'
# waarm64's USB test rig (tests/usb/gadget.sh, tests/usb/uhid.ts)
SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="0525", MODE="0666"
KERNEL=="uhid", MODE="0666"
SUBSYSTEM=="hidraw", DEVPATH=="/devices/virtual/misc/uhid/*", MODE="0666"
SUBSYSTEM=="tty", KERNEL=="ttyGS*", MODE="0666"
EOF
  # The host's class drivers would hold the gadgets' interfaces (WebUSB doesn't detach them, docs/usb.md "What the browser allows").
  printf '%s\n' '# waarm64 USB test rig: keep the gadgets free for WebUSB and QEMU (tests/usb/gadget.sh)' \
    'blacklist usbtest' 'blacklist cdc_acm' > "$tmp/modprobe"
  local urls
  urls=$(printf '"http://127.0.0.1:%s",' "${PORTS[@]}")
  urls="[${urls%,}]"
  cat > "$tmp/policy" << EOF
{
  "WebUsbAllowDevicesForUrls": [{ "devices": [{ "vendor_id": 1317 }], "urls": $urls }],
  "WebHidAllowAllDevicesForUrls": $urls
}
EOF
  sudo install -m 644 "$tmp/rules" "$RULES"
  sudo install -m 644 "$tmp/modprobe" "$MODPROBE"
  sudo install -D -m 644 "$tmp/policy" "$POLICY"
  rm -r "$tmp"
  sudo udevadm control --reload
  # Nodes that exist already take the rule now (a "change" doesn't reapply MODE to them; an "add" does).
  # One trigger each: udevadm ANDs a sysname match with a subsystem match, so uhid (subsystem misc) beside
  # `--subsystem-match=hidraw` was never triggered and kept root's 0600 until a reboot.
  sudo udevadm trigger --action=add --sysname-match='ttyGS*'
  sudo udevadm trigger --action=add --sysname-match=uhid
  sudo udevadm trigger --action=add --subsystem-match=hidraw
  sudo udevadm settle
  echo "installed: dummy_hcd for $KVER, $RULES, $MODPROBE, $POLICY"
}

load() {
  [ -d /sys/class/udc/dummy_udc.0 ] && return
  sudo modprobe libcomposite
  sudo modprobe usb_f_ss_lb
  sudo modprobe usb_f_acm
  sudo modprobe dummy_hcd num=$NUDC is_high_speed=1
  for _ in $(seq 50); do [ -d /sys/class/udc/dummy_udc.$((NUDC - 1)) ] && return; sleep 0.1; done
  die 'dummy UDCs did not appear'
}

free_udc() {
  local used=" " u
  for f in "$G"/*/UDC; do [ -f "$f" ] && used+="$(cat "$f") "; done
  for u in $(seq 0 $((NUDC - 1))); do
    [[ $used == *" dummy_udc.$u "* ]] || { echo "dummy_udc.$u"; return; }
  done
  die 'no free dummy UDC'
}

# w <file> <value>: configfs writes as root.
w() { echo "$2" | sudo tee "$1" > /dev/null; }

make_gadget() {
  local name=$1 g=$G/waarm64-$1
  [ -d "$g" ] && return
  sudo mkdir "$g"
  w "$g/idVendor" 0x0525
  w "$g/bcdUSB" 0x0200
  sudo mkdir "$g/strings/0x409"
  w "$g/strings/0x409/manufacturer" waarm64
  case $name in
    zero | zero-a | zero-b)
      w "$g/idProduct" 0xa4a0
      w "$g/strings/0x409/product" 'Gadget Zero'
      # zero-a and zero-b differ only in bcdDevice (1.01, 1.02), which isn't part of the identity: it tells them apart in tests.
      case $name in
        zero) w "$g/strings/0x409/serialnumber" waarm64-zero ;;
        zero-a) w "$g/bcdDevice" 0x0101 ;;
        zero-b) w "$g/bcdDevice" 0x0102 ;;
      esac
      sudo mkdir "$g/functions/SourceSink.0" "$g/functions/Loopback.0"
      # Bulk IN sources (i % 63) per packet, as usbtest.pattern=1 checks (the linux-usb guest's runs).
      w "$g/functions/SourceSink.0/pattern" 1
      sudo mkdir -p "$g/configs/c.1/strings/0x409" "$g/configs/c.2/strings/0x409"
      w "$g/configs/c.1/strings/0x409/configuration" 'source/sink'
      w "$g/configs/c.2/strings/0x409/configuration" loopback
      sudo ln -s "$g/functions/SourceSink.0" "$g/configs/c.1/"
      sudo ln -s "$g/functions/Loopback.0" "$g/configs/c.2/"
      ;;
    acm)
      w "$g/idProduct" 0xa4a7
      w "$g/strings/0x409/product" 'Gadget Serial'
      w "$g/strings/0x409/serialnumber" waarm64-acm
      sudo mkdir "$g/functions/acm.0"
      sudo mkdir -p "$g/configs/c.1/strings/0x409"
      w "$g/configs/c.1/strings/0x409/configuration" 'CDC ACM'
      sudo ln -s "$g/functions/acm.0" "$g/configs/c.1/"
      ;;
    *) sudo rmdir "$g/strings/0x409" "$g"; die "unknown gadget '$name' (${ALL[*]})" ;;
  esac
  w "$g/UDC" "$(free_udc)"
}

remove_gadget() {
  local g=$G/waarm64-$1 c f
  [ -d "$g" ] || return 0
  [ -n "$(cat "$g/UDC")" ] && w "$g/UDC" ''
  for c in "$g"/configs/*; do
    [ -d "$c" ] || continue
    for f in "$c"/*; do [ -L "$f" ] && sudo rm "$f"; done
    [ -d "$c/strings/0x409" ] && sudo rmdir "$c/strings/0x409"
    sudo rmdir "$c"
  done
  for f in "$g"/functions/*; do [ -d "$f" ] && sudo rmdir "$f"; done
  sudo rmdir "$g/strings/0x409" "$g"
}

# The bus path of a gadget's host-side device (e.g. 3-1), once enumerated.
host_path() {
  local udc
  udc=$(cat "$G/waarm64-$1/UDC")
  local d
  for d in /sys/bus/usb/devices/usb*; do
    [ "$(cat "$d/product" 2> /dev/null)" = 'Dummy host controller' ] || continue
    # dummy_hcd.N pairs with dummy_udc.N; its root hub's parent is the platform device dummy_hcd.N.
    [ "$(basename "$(readlink -f "$d/..")")" = "dummy_hcd.${udc#dummy_udc.}" ] || continue
    [ -d "$d/$(basename "$d" | tr -d usb)-1" ] && echo "$(basename "$d" | tr -d usb)-1"
  done
}

wait_enumerated() {
  local name=$1 p
  for _ in $(seq 50); do
    p=$(host_path "$name")
    if [ -n "$p" ] && [ -e /sys/bus/usb/devices/"$p"/devnum ]; then
      local bus dev
      bus=$(cat /sys/bus/usb/devices/"$p"/busnum)
      dev=$(cat /sys/bus/usb/devices/"$p"/devnum)
      local node
      node=$(printf '/dev/bus/usb/%03d/%03d' "$bus" "$dev")
      for _ in $(seq 30); do [ -r "$node" ] && [ -w "$node" ] && break; sleep 0.1; done
      [ -w "$node" ] || die "$node isn't writable by $(id -un) (the udev rule: tests/usb/gadget.sh install)"
      # A class driver loaded anyway (by hand, before the blocklist): let the interfaces go.
      local i drv
      for i in /sys/bus/usb/devices/"$p":*; do
        [ -L "$i/driver" ] || continue
        drv=$(basename "$(readlink -f "$i/driver")")
        [ "$drv" = usbfs ] || w "$i/driver/unbind" "$(basename "$i")"
      done
      echo "$name $(cat /sys/bus/usb/devices/"$p"/idVendor):$(cat /sys/bus/usb/devices/"$p"/idProduct) $p $node $(cat /sys/bus/usb/devices/"$p"/speed)M"
      return
    fi
    sleep 0.1
  done
  die "gadget $name did not enumerate"
}

status() {
  local d n
  for d in "$G"/waarm64-*; do
    [ -d "$d" ] || continue
    n=${d##*/waarm64-}
    echo "$n $(cat "$d/UDC") host $(host_path "$n")"
  done
}

cmd=${1:-}
shift || true
case $cmd in
  install) install ;;
  check) check ;;
  up)
    why=$(check) || die "can't come up: ${why//$'\n'/; }"
    load
    [ $# -gt 0 ] || set -- zero
    for n in "$@"; do make_gadget "$n"; done
    for n in "$@"; do wait_enumerated "$n"; done
    ;;
  down)
    [ $# -gt 0 ] || set -- "${ALL[@]}"
    for n in "$@"; do remove_gadget "$n"; done
    if ! compgen -G "$G/waarm64-*" > /dev/null && lsmod | grep -q '^dummy_hcd '; then sudo rmmod dummy_hcd; fi
    ;;
  status) status ;;
  *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
