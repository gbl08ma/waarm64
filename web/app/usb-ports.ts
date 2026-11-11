// A machine's remembered USB devices (docs/usb.md "The page"), the part without a browser: an
// entry's identity and the Web Lock named after it, which connector a new entry takes, how the browser's granted
// devices are matched to entries (identical devices without a serial number by their order in `getDevices()`), the
// entries a definition carries, and the page's words for what the device worker reports (`UsbProblem`). DOM-free:
// Node's tests use it. The live side (the browser's devices, the locks, the running machine's ports) is
// web/app/usb-live.ts.
import { describe, errorText, msg, t, type Msg } from '../i18n.ts';
import type { UsbIdentity, UsbProblem, UsbVirtual } from '../usb-device.ts';
import { newId, USB_CONNECTORS, USER_CONNECTORS, type UsbEntry } from './shape.ts';

/** What WebUSB and WebHID tell of a device, as far as an entry needs it (a `USBDevice` and a `HIDDevice` both fit). */
export type SeenDevice = {
  vendorId: number;
  productId: number;
  serialNumber?: string | null;
  productName?: string | null;
};

const hex4 = (n: number) => n.toString(16).padStart(4, '0');

/** The identity the device worker opens an entry by (web/usb-device.ts). */
export function identityOf(
  e: Pick<UsbEntry, 'api' | 'vendorId' | 'productId' | 'serialNumber' | 'productName' | 'index'>,
): UsbIdentity {
  return {
    api: e.api,
    vendorId: e.vendorId,
    productId: e.productId,
    ...(e.serialNumber ? { serialNumber: e.serialNumber } : {}),
    ...(e.productName ? { productName: e.productName } : {}),
    ...(e.index ? { index: e.index } : {}),
  };
}

/** An identity as text, the same for the same device in every machine and tab: `usb:1d50:6018:s:<serial>`, or `…:n:<index>` without a serial. */
export function identityKey(i: Pick<UsbIdentity, 'api' | 'vendorId' | 'productId' | 'serialNumber' | 'index'>): string {
  return `${i.api}:${hex4(i.vendorId)}:${hex4(i.productId)}:${i.serialNumber ? `s:${i.serialNumber}` : `n:${i.index ?? 0}`}`;
}

/** The Web Lock a page holds while the device is attached to its machine (one machine at a time per device). */
export const usbLock = (i: Pick<UsbIdentity, 'api' | 'vendorId' | 'productId' | 'serialNumber' | 'index'>) =>
  `webpc-usb:${identityKey(i)}`;

/** A device's name on the page: its product name, or its IDs. */
export function deviceName(d: {
  api?: string;
  kind?: string;
  name?: string;
  vendorId?: number;
  productId?: number;
  productName?: string | null;
}): string {
  if (d.api === 'virtual' && d.kind === 'gamepad')
    return t('usb:usb-ports.gamepad', { name: d.name || t('usb:usb-ports.gamepad.unnamed') });
  if (d.api === 'virtual')
    return t(
      d.kind === 'gadget-zero'
        ? 'usb:usb-ports.gadgetZero'
        : d.kind === 'keyboard'
          ? 'usb:usb-ports.builtinKeyboard'
          : 'usb:usb-ports.testDevice',
    );
  const ids = `${hex4(d.vendorId ?? 0)}:${hex4(d.productId ?? 0)}`;
  return (
    d.productName?.trim() ||
    (d.api === 'hid' ? t('usb:usb-ports.hidDevice', { ids }) : t('usb:usb-ports.usbDevice', { ids }))
  );
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
  const index = d.serialNumber
    ? 0
    : devices.slice(0, at).filter((x) => sameModel({ vendorId: d.vendorId, productId: d.productId }, x)).length;
  return identityOf({
    api,
    vendorId: d.vendorId,
    productId: d.productId,
    serialNumber: d.serialNumber ?? undefined,
    productName: d.productName ?? undefined,
    index,
  });
}

/** A new entry for `identity` on `connector` (by default the free one among `entries`). */
export function newEntry(
  identity: UsbIdentity,
  entries: UsbEntry[],
  o: { connector?: number; atStart?: boolean } = {},
): UsbEntry {
  return {
    id: newId(),
    ...identityOf(identity),
    connector: o.connector ?? freeConnector(entries),
    atStart: o.atStart ?? true,
  };
}

/** The entry of `entries` that is `identity`, if any. */
export const entryOf = (entries: UsbEntry[], identity: UsbIdentity) =>
  entries.find((e) => identityKey(e) === identityKey(identity));

/** Whether there are identical devices without a serial number among `entries` (the USB tab says how they are told apart). */
export const hasTwins = (entries: UsbEntry[]) =>
  entries.some(
    (e) =>
      !e.serialNumber &&
      entries.some(
        (x) =>
          x !== e && x.api === e.api && x.vendorId === e.vendorId && x.productId === e.productId && !x.serialNumber,
      ),
  );

/** A definition's remembered devices (machines.md §6): their identities and settings, no ids and no grants. */
export type DefinitionUsb = Omit<UsbEntry, 'id'>;
export const toDefinition = (entries: UsbEntry[] = []): DefinitionUsb[] => entries.map(({ id: _, ...e }) => e);
/** Whether `x` is a definition's list of devices (validated before an import). */
export function validDefinitionUsb(x: unknown): x is DefinitionUsb[] {
  /** An integer in [lo, hi). */
  const int = (n: unknown, lo: number, hi: number) => typeof n === 'number' && Number.isInteger(n) && n >= lo && n < hi;
  const optional = (v: unknown, ok: (v: unknown) => boolean) => v === undefined || ok(v);
  const isString = (v: unknown) => typeof v === 'string';
  return (
    Array.isArray(x) &&
    x.length <= 64 &&
    x.every(
      (e: unknown) =>
        typeof e === 'object' &&
        e !== null &&
        'api' in e &&
        (e.api === 'usb' || e.api === 'hid') &&
        'vendorId' in e &&
        int(e.vendorId, 0, 0x10000) &&
        'productId' in e &&
        int(e.productId, 0, 0x10000) &&
        optional('serialNumber' in e ? e.serialNumber : undefined, isString) &&
        optional('productName' in e ? e.productName : undefined, isString) &&
        optional('index' in e ? e.index : undefined, (i) => int(i, 0, 64)) &&
        'connector' in e &&
        int(e.connector, 0, USB_CONNECTORS) &&
        'atStart' in e &&
        typeof e.atStart === 'boolean',
    )
  );
}
export const fromDefinition = (x: DefinitionUsb[] = []): UsbEntry[] =>
  x.map((e) => ({ id: newId(), ...identityOf(e), connector: e.connector, atStart: e.atStart }));

/** The host's OS, for the remedies (they differ). */
export type HostOs = 'linux' | 'mac' | 'windows' | 'chromeos' | 'other';
export function hostOs(
  nav: { userAgent?: string; userAgentData?: { platform?: string } } = globalThis.navigator ?? {},
): HostOs {
  const p = `${nav.userAgentData?.platform ?? ''} ${nav.userAgent ?? ''}`.toLowerCase();
  if (p.includes('cros')) return 'chromeos';
  if (p.includes('win')) return 'windows';
  if (p.includes('mac')) return 'mac';
  if (p.includes('linux') || p.includes('x11')) return 'linux';
  return 'other';
}

/** USB interface classes by number, as the messages name them (their keys). */
const CLASSES: Record<number, string> = {
  0x01: 'usb:usb-ports.class.audio',
  0x02: 'usb:usb-ports.class.cdc',
  0x03: 'usb:usb-ports.class.hid',
  0x06: 'usb:usb-ports.class.stillImage',
  0x07: 'usb:usb-ports.class.printer',
  0x08: 'usb:usb-ports.class.massStorage',
  0x09: 'usb:usb-ports.class.hub',
  0x0a: 'usb:usb-ports.class.cdcData',
  0x0b: 'usb:usb-ports.class.smartCard',
  0x0e: 'usb:usb-ports.class.video',
  0x10: 'usb:usb-ports.class.audioVideo',
  0xe0: 'usb:usb-ports.class.bluetooth',
  0xfe: 'usb:usb-ports.class.dfu',
  0xff: 'usb:usb-ports.class.vendor',
};
const className = (c: number): Msg =>
  CLASSES[c] ? msg(CLASSES[c]) : msg('usb:usb-ports.class.other', { code: `0x${c.toString(16).padStart(2, '0')}` });

/** The HID top-level collections the browser protects, as the messages name them (usage page:usage → key). */
const HID_USAGES: Record<string, string> = {
  '1:1': 'usb:usb-ports.usage.pointer',
  '1:2': 'usb:usb-ports.usage.mouse',
  '1:6': 'usb:usb-ports.usage.keyboard',
  '1:7': 'usb:usb-ports.usage.keypad',
  '1:128': 'usb:usb-ports.usage.systemControl',
};

/**
 * What WebUSB keeps from pages, with where to go instead by class (docs/usb.md "What WebUSB can't attach, and where it
 * goes instead"): a message per route.
 */
function protectedInterface(iface: number, c: number): string {
  const p = { interface: iface, class: className(c) };
  switch (c) {
    case 0x03:
      return t('usb:usb-ports.protectedInterface.hid', p);
    case 0x08:
      return t('usb:usb-ports.protectedInterface.disk', p);
    case 0x01:
    case 0x0e:
    case 0x10:
      return t('usb:usb-ports.protectedInterface.sound', p);
    case 0xe0:
      return t('usb:usb-ports.protectedInterface.bluetooth', p);
    default:
      return t('usb:usb-ports.protectedInterface', p);
  }
}

/** The udev rule that opens a device to the user (Linux), for the messages. */
const udevRule = (d: { api: 'usb' | 'hid'; vendorId: number; productId: number }) =>
  d.api === 'hid'
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
  const fix = f
    ? [`${f.title}:`, ...f.steps.map((s, i) => `${i + 1}. ${step(s)}`), ...(f.note ? [step(f.note)] : [])]
    : [];
  return [w.text, ...fix, ...(w.said ? [browserSaid(w.said)] : [])].join('\n');
}

/** The browser's own message, as the page quotes it under a problem. */
export const browserSaid = (said: string) => t('usb:usb-ports.browserSaid', { said });

/** Zadig's steps for the WinUSB driver on an interface (Windows: a browser uses a device only through WinUSB). */
const zadig = (iface?: number): FixStep[] => [
  {
    text: iface === undefined ? t('usb:usb-ports.zadig') : t('usb:usb-ports.zadig.interface', { interface: iface }),
    link: 'https://zadig.akeo.ie',
  },
  { text: t('usb:usb-ports.replug') },
];

/**
 * A problem the device worker reported, in words for the user, with the host OS's remedy where there is one
 * (docs/usb.md "What the browser allows": the host's drivers come first, and the page can't change that).
 */
export function problemText(
  p: UsbProblem,
  d: { api: 'usb' | 'hid'; vendorId: number; productId: number },
  os: HostOs = hostOs(),
): ProblemWords {
  switch (p.kind) {
    case 'protected-interface':
      return { text: protectedInterface(p.interface, p.class) };
    case 'claim-failed': {
      const text = t('usb:usb-ports.claimFailed', { interface: p.interface });
      const said = p.message;
      const name = `1-2:1.${p.interface}`;
      switch (os) {
        case 'linux':
          return {
            text,
            said,
            fix: {
              title: t('usb:usb-ports.claimFailed.linux'),
              steps: [
                { text: t('usb:usb-ports.claimFailed.linux.driver'), code: 'lsusb -t' }, // i18n-ignore: a command
                {
                  text: t('usb:usb-ports.claimFailed.linux.name', { name }),
                  code: 'ls /sys/bus/usb/drivers/<driver>/', // i18n-ignore: a command
                },
                {
                  text: t('usb:usb-ports.claimFailed.linux.unbind'),
                  code: `echo -n ${name} | sudo tee /sys/bus/usb/drivers/<driver>/unbind`, // i18n-ignore: a command
                },
                { text: t('usb:usb-ports.claimFailed.linux.again') },
              ],
              note: { text: t('usb:usb-ports.claimFailed.linux.blacklist'), code: 'blacklist <driver>' }, // i18n-ignore: a line of a file
            },
          };
        case 'mac':
          return {
            text,
            said,
            fix: {
              title: t('usb:usb-ports.claimFailed.mac'),
              steps: [{ text: t('usb:usb-ports.claimFailed.mac.quit') }],
              note: { text: t('usb:usb-ports.claimFailed.mac.note') },
            },
          };
        case 'windows':
          return {
            text,
            said,
            fix: {
              title: t('usb:usb-ports.claimFailed.windows'),
              steps: zadig(p.interface),
              note: { text: t('usb:usb-ports.claimFailed.windows.note') },
            },
          };
        default:
          return { text: t('usb:usb-ports.claimFailed.other', { interface: p.interface }), said };
      }
    }
    case 'protected-collection': {
      const usage = HID_USAGES[`${p.usagePage}:${p.usage}`];
      const what = usage
        ? msg(usage)
        : msg('usb:usb-ports.usage.other', { usage: `${hex4(p.usagePage)}:${hex4(p.usage)}` });
      return {
        text: p.kept
          ? t('usb:usb-ports.protectedCollection.kept', { what })
          : t('usb:usb-ports.protectedCollection', { what }),
      };
    }
    case 'no-collections':
      return { text: t('usb:usb-ports.noCollections') };
    case 'open-failed': {
      const said = p.message;
      if (os === 'linux')
        return {
          text: t('usb:usb-ports.openFailed.linux'),
          said,
          fix: {
            title: t('usb:usb-ports.openFailed.linux.title'),
            steps: [
              { text: t('usb:usb-ports.openFailed.linux.udev'), code: udevRule(d) },
              { text: t('usb:usb-ports.openFailed.linux.reload'), code: 'sudo udevadm control --reload' }, // i18n-ignore: a command
              { text: t('usb:usb-ports.replug') },
            ],
          },
        };
      if (os === 'windows' && d.api === 'usb')
        return {
          text: t('usb:usb-ports.openFailed.windows'),
          said,
          fix: { title: t('usb:usb-ports.openFailed.windows.title'), steps: zadig() },
        };
      return { text: t('usb:usb-ports.openFailed.other'), said };
    }
  }
}

/**
 * An error as the page shows it: its words (a headline and its causes, a line each), or, for an attach's that has the
 * problems' words (a `UsbError`), its headline and those.
 */
export type ErrorView = { text: string; words?: ProblemWords[] };
export function errorView(e: unknown): ErrorView {
  const words = (e as { words?: ProblemWords[] } | undefined)?.words;
  return words?.length ? { text: describe(e).headline, words } : { text: errorText(e) };
}

/** An error's view as plain text, a line each: its text, then each problem's (for the message bar). */
export function errorLines(e: unknown): string {
  const v = errorView(e);
  return [v.text, ...(v.words ?? []).map((w) => w.text)].join('\n');
}
