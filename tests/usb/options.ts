// What the USB test kernel (images/usb/init.c; docs/usb.md) gets in every runner: its command lines
// and the machine's USB (two Gadget Zeros, the high-speed one unplugged and plugged in again at fixed
// steps). The native twin has the same (core/tests/usb_guest.rs). No Node imports: the Chromium boot
// worker takes it too (tests/browser/boot-worker.ts).
import type { BootOptions } from '../../web/vm.ts';

export const USB_KERNEL = 'linux-usb/Image';
export const USB_INITRD = 'linux-usb/initramfs.cpio';
export const USB_HUBS_CMDLINE = 'console=ttyAMA0 panic=-1';
export const USB_CMDLINE = 'console=ttyAMA0 panic=-1 usbtest.pattern=1 usb_devices=2 usb_unplug=1 usb_args=-a,-c,10,-s,1024,-v,512,-g,16';
/** The steps at which connector 0's Gadget Zero is unplugged and plugged in again (mid-pass 2; native: `USB_UNPLUG`, `USB_REPLUG`). */
export const USB_UNPLUG = 95_000_000;
export const USB_REPLUG = 150_000_000;

const HIGH = { api: 'virtual', kind: 'gadget-zero', pattern: 1 } as const;

/** `BootOptions.usb` for the testusb run: the hot-plug events only where they land at exact steps (`events` false: parallel SMP). */
export function usbGuest(events = true): BootOptions['usb'] {
  return {
    attach: [{ connector: 0, device: HIGH }, { connector: 1, device: { ...HIGH, speed: 'super' } }],
    events: events ? [{ step: USB_UNPLUG, connector: 0 }, { step: USB_REPLUG, connector: 0, device: HIGH }] : [],
  };
}
