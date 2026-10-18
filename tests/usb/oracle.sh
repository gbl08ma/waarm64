#!/usr/bin/env bash
# The QEMU oracle for the xHCI (docs/plans/usb.md §5, docs/testing.md "USB"): the linux-usb guest
# (images/build.sh linux-usb: xhci-pci, usbtest, testusb) on qemu-system-aarch64 -M virt (TCG) with QEMU's
# qemu-xhci, and the dev VM's dummy_hcd Gadget Zero passed in through usb-host. The guest runs the same init and
# testusb as on our xHCI, so the two compare on behavior: testusb's results, the guest's kernel log, and (with
# --trace) QEMU's own usb_xhci_* trace events (doorbells, transfers, the events it queues and their completion codes).
#
#   tests/usb/oracle.sh [--trace] [--tests 1,2,...]  testusb's tests 0-29 (or those), each in a boot of its own, with
#                                                   the usb guest's arguments on ours (-c 10 -s 1024 -v 512 -g 16):
#                                                   a line per test, ok, its errno, or hung
#   tests/usb/oracle.sh [--trace] <usb_args>          one boot with these (init's form: commas for spaces)
#
# Brings Gadget Zero up (tests/usb/gadget.sh up zero) if it isn't. Writes each boot's serial console to
# target/usb/oracle/ (test-N.log, or guest.log) and, with --trace, QEMU's trace beside it (.trace); exits 0 when every
# boot printed "webpc: usb test ok". Needs qemu-hw-usb-host (QEMU's usb-host device) and the gadget rig
# (tests/usb/gadget.sh install).
set -euo pipefail
cd "$(dirname "$0")/../.."

trace=
[ "${1:-}" = --trace ] && { trace=1; shift; }
COMMON=-c,10,-s,1024,-v,512,-g,16 # the usb guest's on ours (tests/usb/options.ts), without -a
args=
tests=$(seq 0 29)
case ${1:-} in
  '') ;;
  --tests) tests=${2//,/ } ;;
  *) args=$1 ;;
esac
img=target/images/linux-usb
out=target/usb/oracle
[ -f "$img/Image" ] || { echo "oracle: no $img (images/build.sh linux-usb)" >&2; exit 1; }
qemu-system-aarch64 -device help 2>&1 | grep -q '"usb-host"' || { echo 'oracle: QEMU has no usb-host (sudo zypper in qemu-hw-usb-host)' >&2; exit 1; }
[ -d /sys/kernel/config/usb_gadget/webpc-zero ] || tests/usb/gadget.sh up zero > /dev/null

# Gadget Zero's host-side bus and address, by its serial (looked up before each boot: a reset can renumber it).
locate() {
  local d
  for d in /sys/bus/usb/devices/*; do
    [ "$(cat "$d/serial" 2> /dev/null)" = webpc-zero ] && { echo "$(cat "$d/busnum") $(cat "$d/devnum")"; return; }
  done
  echo 'oracle: Gadget Zero (serial webpc-zero) is not on the host bus' >&2
  exit 1
}

# boot <usb_args> <log> <seconds>: one guest run. usbtest.pattern=1, as the usb guest's runs on ours
# (tests/usb/gadget.sh's source/sink sends i % 63).
boot() {
  local at tr=()
  at=$(locate)
  [ -z "$trace" ] || tr=(-trace 'usb_xhci_*' -D "${2%.log}.trace")
  timeout "$3" qemu-system-aarch64 -M virt -cpu max -smp 1 -m 256 -nographic -no-reboot \
    -kernel "$img/Image" -initrd "$img/initramfs.cpio" \
    -append "console=ttyAMA0 panic=-1 usbtest.pattern=1 usb_devices=1 usb_args=$1" \
    -device qemu-xhci,id=xhci -device "usb-host,bus=xhci.0,hostbus=${at% *},hostaddr=${at#* }" \
    "${tr[@]}" < /dev/null > "$2" 2>&1 || true
}

mkdir -p "$out"
rm -f "$out"/*.log "$out"/*.trace
start=$SECONDS
if [ -n "$args" ]; then
  boot "$args" "$out/guest.log" "${WEBPC_ORACLE_TIMEOUT:-300}"
  grep -E '^(usb:|webpc:)|testusb|usbtest' "$out/guest.log" | sed 's/^\[[ 0-9.]*\] //' | tail -60
  echo "oracle: $((SECONDS - start)) s; the guest's console in $out/guest.log"
  grep -q 'webpc: usb test ok' "$out/guest.log"
  exit
fi
# Each of testusb's tests in a boot of its own (~2 s under TCG), so one that hangs times out alone.
bad=0
for t in $tests; do
  log=$out/test-$t.log
  boot "-a,-t,$t,$COMMON" "$log" "${WEBPC_ORACLE_TIMEOUT:-30}"
  if grep -q 'webpc: usb test ok' "$log" && grep -qE "test $t, +[0-9.]+ secs" "$log"; then
    r=ok
  elif grep -q 'webpc: usb test ok' "$log"; then
    r="not run (usbtest skips it for this device)"
  elif r=$(grep -m1 -oE "test $t --> [0-9]+ \([^)]*\)" "$log"); then
    r=${r#test $t --> }
    bad=1
  elif grep -q 'terminating on signal 15' "$log"; then
    r="hung (killed after ${WEBPC_ORACLE_TIMEOUT:-30} s)"
    bad=1
  else
    r='no result'
    bad=1
  fi
  printf 'test %2d: %s\n' "$t" "$r"
done
echo "oracle: $((SECONDS - start)) s; each test's console in $out/test-N.log"
exit $bad
