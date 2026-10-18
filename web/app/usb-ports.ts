// A machine's remembered USB devices (docs/usb.md "The page"), the part without a browser: an
// entry's identity and the Web Lock named after it, which connector a new entry takes, how the browser's granted
// devices are matched to entries (identical devices without a serial number by their order in `getDevices()`), the
// entries a definition carries, and the page's words for what the device worker reports (`UsbProblem`). DOM-free:
// Node's tests use it. The live side (the browser's devices, the locks, the running machine's ports) is
// web/app/usb-live.ts.
import type { UsbIdentity, UsbProblem, UsbVirtual } from '../usb-device.ts';
import { newId, USB_CONNECTORS, USER_CONNECTORS, type UsbEntry } from './shape.ts';

/** What WebUSB and WebHID tell of a device, as far as an entry needs it (a `USBDevice` and a `HIDDevice` both fit). */
export type SeenDevice = { vendorId: number; productId: number; serialNumber?: string | null; productName?: string | null };

const hex4 = (n: number) => n.toString(16).padStart(4, '0');

/** The identity the device worker opens an entry by (web/usb-device.ts). */
export function identityOf(e: Pick<UsbEntry, 'api' | 'vendorId' | 'productId' | 'serialNumber' | 'productName' | 'index'>): UsbIdentity {
  return { api: e.api, vendorId: e.vendorId, productId: e.productId, ...(e.serialNumber ? { serialNumber: e.serialNumber } : {}), ...(e.productName ? { productName: e.productName } : {}), ...(e.index ? { index: e.index } : {}) };
}

/** An identity as text, the same for the same device in every machine and tab: `usb:1d50:6018:s:<serial>`, or `…:n:<index>` without a serial. */
export function identityKey(i: Pick<UsbIdentity, 'api' | 'vendorId' | 'productId' | 'serialNumber' | 'index'>): string {
  return `${i.api}:${hex4(i.vendorId)}:${hex4(i.productId)}:${i.serialNumber ? `s:${i.serialNumber}` : `n:${i.index ?? 0}`}`;
}

/** The Web Lock a page holds while the device is attached to its machine (one machine at a time per device). */
export const usbLock = (i: Pick<UsbIdentity, 'api' | 'vendorId' | 'productId' | 'serialNumber' | 'index'>) => `webpc-usb:${identityKey(i)}`;

/** A device's name on the page: its product name, or its IDs. */
export function deviceName(d: { api?: string; kind?: string; vendorId?: number; productId?: number; productName?: string | null }): string {
  if (d.api === 'virtual') return d.kind === 'gadget-zero' ? 'Gadget Zero (test device)' : d.kind === 'keyboard' ? 'Built-in keyboard' : 'a test device';
  return d.productName?.trim() || `${d.api === 'hid' ? 'HID' : 'USB'} device ${hex4(d.vendorId ?? 0)}:${hex4(d.productId ?? 0)}`;
}
export const virtualName = (v: UsbVirtual) => deviceName(v);

/** The IDs as lsusb prints them. */
export const idsText = (d: { vendorId: number; productId: number }) => `${hex4(d.vendorId)}:${hex4(d.productId)}`;

/**
 * The connector a new entry goes on: the lowest one no entry of the machine uses, else the one fewest use (two entries
 * on one connector are fine: only one is attached at a time).
 */
export function freeConnector(entries: Pick<UsbEntry, 'connector'>[]): number {
  // The built-in keyboard's connector is left out (shape.ts `KEYBOARD_CONNECTOR`).
  const uses = Array.from({ length: USER_CONNECTORS }, (_, c) => entries.filter((e) => e.connector === c).length);
  return uses.indexOf(Math.min(...uses));
}

/** Whether a device the browser lists is this entry's device, without the order (`index`) of serial-less twins. */
const sameModel = (e: Pick<UsbEntry, 'vendorId' | 'productId' | 'serialNumber'>, d: SeenDevice) =>
  e.vendorId === d.vendorId && e.productId === d.productId && (e.serialNumber ?? '') === (d.serialNumber ?? '');

/**
 * Which device of `devices` (one API's `getDevices()`, in its order) each entry is: by IDs and serial number; among
 * identical devices without one, the entry's `index`-th. Entries of the other API are left out. Returns entry id → the
 * device's position in `devices`.
 */
export function matchDevices(entries: UsbEntry[], api: 'usb' | 'hid', devices: SeenDevice[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) {
    if (e.api !== api) continue;
    const twins = devices.map((d, i) => [d, i] as const).filter(([d]) => sameModel(e, d));
    const at = e.serialNumber ? twins[0] : twins[e.index ?? 0];
    if (at) out.set(e.id, at[1]);
  }
  return out;
}

/** The identity of the device at position `at` of `devices` (one API's `getDevices()`): its `index` among identical serial-less ones. */
export function identityAt(api: 'usb' | 'hid', devices: SeenDevice[], at: number): UsbIdentity {
  const d = devices[at];
  const index = d.serialNumber ? 0 : devices.slice(0, at).filter((x) => sameModel({ vendorId: d.vendorId, productId: d.productId }, x)).length;
  return identityOf({ api, vendorId: d.vendorId, productId: d.productId, serialNumber: d.serialNumber ?? undefined, productName: d.productName ?? undefined, index });
}

/** A new entry for `identity` on `connector` (by default the free one among `entries`). */
export function newEntry(identity: UsbIdentity, entries: UsbEntry[], o: { connector?: number; atStart?: boolean } = {}): UsbEntry {
  return { id: newId(), ...identityOf(identity), connector: o.connector ?? freeConnector(entries), atStart: o.atStart ?? true };
}

/** The entry of `entries` that is `identity`, if any. */
export const entryOf = (entries: UsbEntry[], identity: UsbIdentity) => entries.find((e) => identityKey(e) === identityKey(identity));

/** Whether there are identical devices without a serial number among `entries` (the USB tab says how they are told apart). */
export const hasTwins = (entries: UsbEntry[]) => entries.some((e) => !e.serialNumber && entries.some((x) => x !== e && x.api === e.api && x.vendorId === e.vendorId && x.productId === e.productId && !x.serialNumber));

/** A definition's remembered devices (machines.md §6): their identities and settings, no ids and no grants. */
export type DefinitionUsb = Omit<UsbEntry, 'id'>;
export const toDefinition = (entries: UsbEntry[] = []): DefinitionUsb[] => entries.map(({ id: _, ...e }) => e);
/** Whether `x` is a definition's list of devices (validated before an import). */
export function validDefinitionUsb(x: unknown): x is DefinitionUsb[] {
  const u16 = (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 0xffff;
  return Array.isArray(x) && x.length <= 64 && x.every((e) => e && (e.api === 'usb' || e.api === 'hid') && u16(e.vendorId) && u16(e.productId)
    && (e.serialNumber === undefined || typeof e.serialNumber === 'string') && (e.productName === undefined || typeof e.productName === 'string')
    && (e.index === undefined || (Number.isInteger(e.index) && e.index >= 0 && e.index < 64)) && Number.isInteger(e.connector) && e.connector >= 0 && e.connector < USB_CONNECTORS && typeof e.atStart === 'boolean');
}
export const fromDefinition = (x: DefinitionUsb[] = []): UsbEntry[] => x.map((e) => ({ id: newId(), ...identityOf(e), connector: e.connector, atStart: e.atStart }));

/** The host's OS, for the remedies (they differ). */
export type HostOs = 'linux' | 'mac' | 'windows' | 'chromeos' | 'other';
export function hostOs(nav: { userAgent?: string; userAgentData?: { platform?: string } } = globalThis.navigator ?? {}): HostOs {
  const p = `${nav.userAgentData?.platform ?? ''} ${nav.userAgent ?? ''}`.toLowerCase();
  if (p.includes('cros')) return 'chromeos';
  if (p.includes('win')) return 'windows';
  if (p.includes('mac')) return 'mac';
  if (p.includes('linux') || p.includes('x11')) return 'linux';
  return 'other';
}

/** USB interface classes by number, as the messages name them. */
const CLASSES: Record<number, string> = { 0x01: 'audio', 0x02: 'communications (CDC)', 0x03: 'HID', 0x06: 'still image', 0x07: 'printer', 0x08: 'mass storage', 0x09: 'hub', 0x0a: 'CDC data', 0x0b: 'smart card', 0x0e: 'video', 0x10: 'audio/video', 0xe0: 'wireless controller (Bluetooth)', 0xfe: 'DFU', 0xff: 'vendor-specific' };
const className = (c: number) => CLASSES[c] ?? `class 0x${c.toString(16).padStart(2, '0')}`;

/** The HID top-level collections the browser protects, as the messages name them (usage page:usage). */
const HID_USAGES: Record<string, string> = { '1:1': 'pointer', '1:2': 'mouse', '1:6': 'keyboard', '1:7': 'keypad', '1:128': 'system control' };

/** Where to go instead for what WebUSB keeps from pages, by class (docs/usb.md "What WebUSB can't attach, and where it goes instead"). */
function protectedRoute(c: number): string {
  switch (c) {
    case 0x03: return ' Its HID part can come in as a HID device instead (Add a device…, then a HID device), unless it is a keyboard or a mouse: the machine has the page\'s.';
    case 0x08: return ' A disk image comes in through the machine\'s Disks instead.';
    case 0x01: case 0x0e: case 0x10: return ' Sound goes through the machine\'s sound card (and the microphone), which the page has.';
    case 0xe0: return ' A browser has no way to a Bluetooth adapter.';
    default: return '';
  }
}

/** The udev rule that opens a device to the user (Linux), for the messages. */
const udevRule = (d: { api: 'usb' | 'hid'; vendorId: number; productId: number }) => d.api === 'hid'
  ? `KERNEL=="hidraw*", ATTRS{idVendor}=="${hex4(d.vendorId)}", ATTRS{idProduct}=="${hex4(d.productId)}", TAG+="uaccess"`
  : `SUBSYSTEM=="usb", ATTRS{idVendor}=="${hex4(d.vendorId)}", ATTRS{idProduct}=="${hex4(d.productId)}", TAG+="uaccess"`;

/** A step of a remedy: what to do, then a command or a line to copy (`code`), or a page to open (`link`). */
export type FixStep = { text: string; code?: string; link?: string };
/**
 * A problem in words: `text` first, short and plain; `fix`, the host OS's remedy, which the page shows folded (a
 * title, numbered steps, a note: UsbProblems.svelte); `said`, the browser's own message, folded with it.
 */
export type ProblemWords = { text: string; fix?: { title: string; steps: FixStep[]; note?: FixStep }; said?: string };

/** The words as plain text: `text` alone, or (`all`) everything in them. */
export function wordsText(w: ProblemWords, all = false): string {
  if (!all) return w.text;
  const f = w.fix;
  const step = (s: FixStep) => [s.text, s.code, s.link].filter(Boolean).join(' ');
  const fix = f ? [`${f.title}:`, ...f.steps.map((s, i) => `${i + 1}. ${step(s)}`), ...(f.note ? [step(f.note)] : [])] : [];
  return [w.text, ...fix, ...(w.said ? [`The browser said: ${w.said}`] : [])].join('\n');
}

/** Zadig's steps for the WinUSB driver on an interface (Windows: a browser uses a device only through WinUSB). */
const zadig = (iface?: number): FixStep[] => [
  { text: `Install the WinUSB driver for it with Zadig: Options, List All Devices, pick the device${iface === undefined ? '' : `'s interface ${iface}`}, WinUSB, Replace Driver.`, link: 'https://zadig.akeo.ie' },
  { text: 'Unplug the device, plug it in again, then attach it.' },
];

/**
 * A problem the device worker reported, in words for the user, with the host OS's remedy where there is one
 * (docs/usb.md "What the browser allows": the host's drivers come first, and the page can't change that).
 */
export function problemText(p: UsbProblem, d: { api: 'usb' | 'hid'; vendorId: number; productId: number }, os: HostOs = hostOs()): ProblemWords {
  switch (p.kind) {
    case 'protected-interface':
      return { text: `Interface ${p.interface} is a ${className(p.class)} interface, which the browser keeps from pages: the guest doesn't see it.${protectedRoute(p.class)}` };
    case 'claim-failed': {
      const text = `Something on this computer is already using it (interface ${p.interface}), so the browser can't pass it to the machine.`;
      const said = p.message;
      const name = `1-2:1.${p.interface}`;
      switch (os) {
        case 'linux': return {
          text, said, fix: {
            title: 'How to free it on Linux',
            steps: [
              { text: 'Find the kernel driver that holds it (such as cdc_acm, ftdi_sio, cp210x, ch341 or usblp):', code: 'lsusb -t' },
              { text: `Find the interface's name under that driver (such as ${name}):`, code: 'ls /sys/bus/usb/drivers/<driver>/' },
              { text: 'Unbind it; it stays free until the device is plugged in again:', code: `echo -n ${name} | sudo tee /sys/bus/usb/drivers/<driver>/unbind` },
              { text: 'Attach the device again.' },
            ],
            note: { text: 'To keep the driver off for good (for every device it serves), add this line to a file in /etc/modprobe.d/:', code: 'blacklist <driver>' },
          },
        };
        case 'mac': return {
          text, said, fix: {
            title: 'What to do on macOS',
            steps: [{ text: 'Quit any app that uses the device, then attach it again.' }],
            note: { text: "macOS's own drivers keep serial devices (CDC serial, serial adapters), and a page can't take them: if one of those holds it, the device can't reach the machine from this computer." },
          },
        };
        case 'windows': return { text, said, fix: { title: 'How to free it on Windows', steps: zadig(p.interface), note: { text: "Windows' own programs then no longer see that interface." } } };
        default: return { text: `${text} Close what uses it on this computer, then attach it again.`, said };
      }
    }
    case 'protected-collection': {
      const what = HID_USAGES[`${p.usagePage}:${p.usage}`] ?? `collection ${hex4(p.usagePage)}:${hex4(p.usage)}`;
      return {
        text: p.kept
          ? `The device's ${what} part is kept from pages by the browser, all but its feature reports (its settings, which tools such as VIA use): the guest gets only those. The machine has the page's keyboard and mouse already.`
          : `The device's ${what} part is kept from pages by the browser: the guest doesn't get it. The machine has the page's keyboard and mouse already.`,
      };
    }
    case 'no-collections':
      return { text: 'Everything this HID device offers is kept from pages by the browser (a keyboard\'s keys, a mouse\'s pointer, a security key): nothing is left for the guest. The machine has the page\'s keyboard and mouse already.' };
    case 'open-failed': {
      const said = p.message;
      if (os === 'linux') return {
        text: "The browser couldn't open it: your user probably has no permission to use it.", said, fix: {
          title: 'How to give your user access on Linux',
          steps: [
            { text: 'Add this udev rule to /etc/udev/rules.d/70-webpc.rules:', code: udevRule(d) },
            { text: 'Reload the rules:', code: 'sudo udevadm control --reload' },
            { text: 'Unplug the device, plug it in again, then attach it.' },
          ],
        },
      };
      if (os === 'windows' && d.api === 'usb') return { text: "The browser couldn't open it: on Windows it needs the WinUSB driver.", said, fix: { title: 'How to install it', steps: zadig() } };
      return { text: "The browser couldn't open it: another program may have it open. Close that program, then attach the device again.", said };
    }
  }
}

/** An error as the page shows it: a line, and the problems' words when it is an attach's that has them (a `UsbError`). */
export type ErrorView = { text: string; words?: ProblemWords[] };
export function errorView(e: unknown): ErrorView {
  const u = e as { lead?: string; words?: ProblemWords[]; message?: string } | undefined;
  return u?.words?.length ? { text: u.lead ?? '', words: u.words } : { text: String(u?.message ?? e) };
}
