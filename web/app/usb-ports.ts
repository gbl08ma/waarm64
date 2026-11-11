// A machine's remembered USB devices (docs/usb.md "The page"), the part without a browser: an
// entry's identity and the Web Lock named after it, which connector a new entry takes, how the browser's granted
// devices are matched to entries (identical devices without a serial number by their order in `getDevices()`), the
// entries a definition carries. DOM-free: Node's tests use it. The page's words for what the device worker reports
// (`UsbProblem`) are web/app/usb-problems.ts; the live side (the browser's devices, the locks, the running machine's
// ports) is web/app/usb-live.ts.
import { t } from '../i18n.ts';
import type { UsbIdentity, UsbVirtual } from '../usb-device.ts';
import { newId, USB_CONNECTORS, USER_CONNECTORS, type UsbEntry } from './shape.ts';

/** What WebUSB and WebHID tell of a device, as far as an entry needs it (a `USBDevice` and a `HIDDevice` both fit). */
export type SeenDevice = {
  vendorId: number;
  productId: number;
  serialNumber?: string | null;
  productName?: string | null;
};

/** A 16-bit ID as lsusb prints it. */
export const hex4 = (n: number) => n.toString(16).padStart(4, '0');

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
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty name is none
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
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- a blank name is none
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
    const at = e.serialNumber ? twins.at(0) : twins.at(e.index ?? 0);
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
/** An integer in [lo, hi). */
const int = (n: unknown, lo: number, hi: number) => typeof n === 'number' && Number.isInteger(n) && n >= lo && n < hi;
const optional = (v: unknown, ok: (v: unknown) => boolean) => v === undefined || ok(v);
const isString = (v: unknown) => typeof v === 'string';

/** Whether a definition's device says who it is: its API and IDs, and a serial number, a name and an index or not. */
const validIdentity = (e: object) =>
  'api' in e &&
  (e.api === 'usb' || e.api === 'hid') &&
  'vendorId' in e &&
  int(e.vendorId, 0, 0x10000) &&
  'productId' in e &&
  int(e.productId, 0, 0x10000) &&
  optional('serialNumber' in e ? e.serialNumber : undefined, isString) &&
  optional('productName' in e ? e.productName : undefined, isString) &&
  optional('index' in e ? e.index : undefined, (i) => int(i, 0, 64));

/** Whether a definition's device has its settings: its connector, and whether it is attached at the start. */
const validSettings = (e: object) =>
  'connector' in e && int(e.connector, 0, USB_CONNECTORS) && 'atStart' in e && typeof e.atStart === 'boolean';

/** Whether `x` is a definition's list of devices (validated before an import). */
export function validDefinitionUsb(x: unknown): x is DefinitionUsb[] {
  return (
    Array.isArray(x) &&
    x.length <= 64 &&
    x.every((e: unknown) => typeof e === 'object' && e !== null && validIdentity(e) && validSettings(e))
  );
}
export const fromDefinition = (x: DefinitionUsb[] = []): UsbEntry[] =>
  x.map((e) => ({ id: newId(), ...identityOf(e), connector: e.connector, atStart: e.atStart }));
