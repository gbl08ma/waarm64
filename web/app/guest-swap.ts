// A ramdisk as swap (docs/machines.md §4.3 "As swap"): the device worker writes a swap area's first page over the
// empty ramdisk at every start (web/ramdisk.ts `swapHeader`, labelled `swapLabel`), and the guest gets an `fstab.extra`
// systemd credential (SMBIOS type 11: web/app/guest-unit.ts `oemStrings`) whose lines `systemd-fstab-generator` reads
// as /etc/fstab's (systemd 254+: Debian 13 and Arch, not Debian 12), so the swap is on with nothing done inside.
// `discard`: what the guest frees in it is trimmed, and the ramdisk gives that memory back to the host.
import type { Credential } from './machine.ts';

/** The label of the `n`th swap ramdisk of a machine (mkswap's at most 15 bytes). */
export const swapLabel = (n: number) => `webpc-swap${n}`;

/** The fstab options: `nofail`, so a guest whose kernel refuses the area (pages past 4 KiB) boots on. */
export const SWAP_OPTIONS = 'sw,nofail,discard';

/** The credential that turns on the swap areas labelled `labels` (none: no credential). */
export const swapCredentials = (labels: string[]): Credential[] =>
  labels.length
    ? [{ name: 'fstab.extra', data: labels.map((l) => `LABEL=${l} none swap ${SWAP_OPTIONS} 0 0\n`).join('') }]
    : [];
