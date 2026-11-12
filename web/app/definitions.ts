// Machine definitions in and out (docs/machines.md §6): a machine's shape as a small JSON file (`webpc-machine`,
// version 1): its settings, and per attachment the disk's kind, name, size and identity (a URL as is; a file's name,
// size, date and hash where known; a blank disk's or ramdisk's size), read-only, written in place, a ramdisk as swap, its serial. No
// overlays, snapshots or file contents ("export a machine", the bundle, is later and named apart). An import makes a
// new machine (its name made unique): URL, blank and ramdisk disks come back as they were (a disk this browser has, by
// identity, is attached again); file disks, and stored disks this browser doesn't have, are files to pick at its first
// start, checked by name, size and date, then by hash where the definition has one. A machine with a USB controller says
// so (`machine.usb`; a relative mouse, a touchscreen and the clock device, `mouse`, `touch` and `clock`, likewise; shared folders, `shares` with `sharesMount` and `sharesPath`, never the folders themselves), and its remembered USB devices go as identities (`usbDevices`): no grant travels, so on another
// browser the first start offers one click each (docs/usb.md "The page"). All are left out when there's nothing to say.
// The network adapters go as their MACs (`machine.macs`, left out for one at the default), without their connections.
import { MsgError } from '../msg.ts';
import { sharesPathError } from './shares-mount.ts';
import { fromDefinition, toDefinition, validDefinitionUsb, type DefinitionUsb } from './usb-ports.ts';
import { validKeyboard } from './keyboard.ts';
import {
  adaptersOf,
  canonical,
  DEFAULT_MAC,
  isMac,
  MAX_ADAPTERS,
  MAX_DISKS,
  newId,
  uniqueName,
  type Attachment,
  type DiskIdentity,
  type DiskKind,
  type DiskRecord,
  type Display,
  type MachineRecord,
} from './shape.ts';
import type { Store } from './store.ts';
import { ramSplitError } from './machine.ts';

export const DEFINITION_TYPE = 'webpc-machine';
export const DEFINITION_VERSION = 1;

export type DefinitionDisk = {
  kind: DiskKind;
  name: string;
  size: number;
  identity: DiskIdentity;
  url?: string;
  sha256?: string;
  readOnly: boolean;
  inPlace?: boolean;
  swap?: boolean;
  serial: string;
};
export type Definition = {
  type: typeof DEFINITION_TYPE;
  version: number;
  /** `network`: whether it has an adapter; `macs`: the adapters' MACs, left out for none or one at the default (as before adapters). */
  machine: {
    name: string;
    ncpus: number;
    ramMiB: number;
    ramSplit?: number[];
    jitMiB?: number;
    keyboard?: string;
    netConfig?: false;
    display: Display;
    vulkan?: boolean;
    network: boolean;
    macs?: string[];
    usb?: boolean;
    mouse?: boolean;
    touch?: boolean;
    clock?: boolean;
    shares?: boolean;
    clipboard?: boolean;
    sharesMount?: false;
    sharesPath?: string;
  };
  disks: DefinitionDisk[];
  usbDevices?: DefinitionUsb[];
};

/** The switches a definition writes only when they are on (`usb`, `mouse` and the rest), in its order. */
const SWITCHES = ['usb', 'mouse', 'touch', 'clock', 'shares', 'clipboard'] as const;
type Switch = (typeof SWITCHES)[number];

/** The switches of `m` that are on, as `{ name: true }` in `keys`' order (those off are left out). */
const onOf = <K extends string>(m: Partial<Record<K, boolean>>, keys: readonly K[]) =>
  Object.fromEntries(keys.filter((k) => m[k]).map((k) => [k, true])) as Partial<Record<K, true>>;

/** The fields of `o` that are set (not empty, zero or false), in its order. */
const setOf = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v)) as Partial<T>;

/** An attachment's disk as a definition says it. */
function diskOf(d: DiskRecord, a: Attachment): DefinitionDisk {
  return {
    kind: d.kind,
    name: d.name,
    size: d.size,
    identity: d.identity,
    ...setOf({ url: d.url, sha256: d.sha256 }),
    readOnly: a.readOnly,
    ...onOf(a, ['inPlace', 'swap']),
    serial: a.id,
  };
}

/** A machine's settings as a definition says them. */
function settingsOf(m: MachineRecord): Definition['machine'] {
  const macs = adaptersOf(m).map((a) => a.mac);
  const someMacs = macs.length > 1 || (macs.length === 1 && macs[0] !== DEFAULT_MAC);
  return {
    name: m.name,
    ncpus: m.ncpus,
    ramMiB: m.ramMiB,
    ...setOf({ ramSplit: m.ramSplit, jitMiB: m.jitMiB, keyboard: m.keyboard }),
    ...(m.netConfig === false ? { netConfig: false } : {}),
    display: m.display,
    ...onOf(m, ['vulkan']),
    network: macs.length > 0,
    ...(someMacs ? { macs } : {}),
    ...onOf(m, SWITCHES),
    ...(m.sharesMount === false ? { sharesMount: false } : {}),
    ...setOf({ sharesPath: m.sharesPath }),
  };
}

/** Machine `id`'s definition. */
export async function exportDefinition(store: Store, id: string): Promise<Definition> {
  const m = await store.get('machines', id);
  if (!m)
    throw new MsgError('machines:definitions.machineGone', undefined, {
      cause: new MsgError('machines:definitions.machineGone.cause'),
    });
  const disks: DefinitionDisk[] = [];
  for (const a of m.attachments) {
    const d = await store.get('disks', a.disk);
    if (!d)
      throw new MsgError('machines:definitions.diskMissing', undefined, {
        cause: new MsgError('machines:definitions.diskMissing.cause', { name: m.name }),
      });
    disks.push(diskOf(d, a));
  }
  const usb = m.usbDevices?.length ? { usbDevices: toDefinition(m.usbDevices) } : {};
  return { type: DEFINITION_TYPE, version: DEFINITION_VERSION, machine: settingsOf(m), disks, ...usb };
}

type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw => typeof v === 'object' && v !== null;
/** `v` is absent, or `ok`. */
const optional = (v: unknown, ok: (v: unknown) => boolean) => v === undefined || ok(v);
const isBool = (v: unknown) => typeof v === 'boolean';
const isFalse = (v: unknown) => v === false;
/** An integer in [min, max]. */
const isInt = (v: unknown, min: number, max = Infinity) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isNumbers = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => typeof n === 'number');

/** A split of the RAM over memory 0 and the spill memories that adds up to it and can be laid out. */
const validSplit = (m: Raw) =>
  optional(
    m.ramSplit,
    (v) => isNumbers(v) && !ramSplitError(v, m.vulkan === true) && v.reduce((a, b) => a + b, 0) === m.ramMiB,
  );
/** The adapters' MACs: one to `MAX_ADAPTERS` of them, on a machine with a network. */
const validMacs = (m: Raw) =>
  optional(
    m.macs,
    (v) =>
      Array.isArray(v) &&
      v.length >= 1 &&
      v.length <= MAX_ADAPTERS &&
      v.every((x) => typeof x === 'string' && isMac(x)) &&
      m.network === true,
  );

/** A definition's machine settings, each checked. */
const MACHINE_CHECKS: ((m: Raw) => boolean)[] = [
  (m) => typeof m.name === 'string',
  (m) => isInt(m.ncpus, 1, 64),
  (m) => isInt(m.ramMiB, 64),
  validSplit,
  (m) => optional(m.jitMiB, (v) => isInt(v, 1, 4096)),
  (m) => optional(m.keyboard, (v) => typeof v === 'string' && validKeyboard(v)),
  (m) => optional(m.netConfig, isFalse),
  (m) => m.display === '2d' || m.display === '3d',
  (m) => optional(m.vulkan, isBool),
  (m) => isBool(m.network),
  validMacs,
  (m) => SWITCHES.every((k: Switch) => optional(m[k], isBool)),
  (m) => optional(m.sharesMount, isFalse),
  (m) => optional(m.sharesPath, (v) => typeof v === 'string' && !sharesPathError(v)),
];

const DISK_KINDS: unknown[] = ['url', 'file', 'stored', 'blank', 'ramdisk'];
/** A definition's disk: its kind, size, name, identity, serial and switches checked. */
function validDisk(x: unknown) {
  if (!isRecord(x)) return false;
  const size = x.size;
  return (
    DISK_KINDS.includes(x.kind) &&
    Number.isSafeInteger(size) &&
    (size as number) > 0 &&
    typeof x.name === 'string' &&
    isRecord(x.identity) &&
    !!x.identity.kind &&
    typeof x.serial === 'string' &&
    /^[0-9a-f]{12}$/.test(x.serial) &&
    optional(x.inPlace, isBool) &&
    optional(x.swap, isBool)
  );
}

/** Whether a parsed definition (its type and version checked) has what an import needs, each field as it should be. */
function valid(d: Raw) {
  const m = d.machine;
  return (
    isRecord(m) &&
    MACHINE_CHECKS.every((check) => check(m)) &&
    optional(d.usbDevices, validDefinitionUsb) &&
    Array.isArray(d.disks) &&
    d.disks.length <= MAX_DISKS &&
    d.disks.every(validDisk)
  );
}

/** Parses a definition file's text; throws a message for the user when it isn't one this page reads. */
export function parseDefinition(text: string): Definition {
  let d: unknown;
  try {
    d = JSON.parse(text);
  } catch {
    throw new MsgError('machines:definitions.notJson', undefined, {
      cause: new MsgError('machines:definitions.notJson.cause'),
    });
  }
  if (!isRecord(d) || d.type !== DEFINITION_TYPE)
    throw new MsgError('machines:definitions.notDefinition', undefined, {
      cause: new MsgError('machines:definitions.notDefinition.cause'),
    });
  if (d.version !== DEFINITION_VERSION)
    throw new MsgError('machines:definitions.version', undefined, {
      cause: new MsgError('machines:definitions.version.cause', {
        version: String(d.version),
        reads: DEFINITION_VERSION,
      }),
    });
  if (!valid(d))
    throw new MsgError('machines:definitions.damaged', undefined, {
      cause: new MsgError('machines:definitions.damaged.cause'),
    });
  return d as Definition;
}

/**
 * The disk a definition's disk `x` comes back as: the one this browser has by identity (`same`), a URL, blank or
 * ramdisk disk as it was, or a file to pick (`pick`; a stored disk becomes one: its bytes aren't in this browser).
 */
function diskFor(
  x: DefinitionDisk,
  have: DiskRecord[],
  now: number,
): { d: DiskRecord; same?: boolean; pick?: boolean } {
  const same = have.find((d) => canonical(d.identity) === canonical(x.identity));
  if (same) return { d: same, same: true };
  const base = { name: x.name, size: x.size, created: now };
  if (x.kind === 'url') return { d: { id: newId(), kind: 'url', url: x.url, identity: x.identity, ...base } };
  // Under the identity's id, so the shape is the definition's.
  if (x.kind === 'blank' || x.kind === 'ramdisk')
    return {
      d: { id: x.identity.kind === x.kind ? x.identity.id : newId(), kind: x.kind, identity: x.identity, ...base },
    };
  const identity: DiskIdentity =
    x.kind === 'file' ? x.identity : { kind: 'file', name: x.name, bytes: x.identity.bytes || x.size, modified: 0 };
  return { d: { id: newId(), kind: 'file', identity, ...setOf({ sha256: x.sha256 }), ...base }, pick: true };
}

/** The attachment of disk `d` from the definition's `x` (its serial, unless another attachment has it already). */
const attachmentOf = (x: DefinitionDisk, d: DiskRecord, attachments: Attachment[]): Attachment => ({
  id: attachments.some((a) => a.id === x.serial) ? newId() : x.serial,
  disk: d.id,
  readOnly: x.readOnly,
  ...(x.inPlace && d.kind === 'stored' ? { inPlace: true } : {}),
  ...(x.swap && d.kind === 'ramdisk' ? { swap: true as const } : {}),
});

/** The machine record a definition's settings make, named `name`. */
function machineFrom(def: Definition, name: string, attachments: Attachment[], now: number): MachineRecord {
  const m = def.machine;
  return {
    id: newId(),
    name,
    ncpus: m.ncpus,
    ramMiB: m.ramMiB,
    ...setOf({ ramSplit: m.ramSplit, jitMiB: m.jitMiB, keyboard: m.keyboard }),
    ...(m.netConfig === false ? { netConfig: false as const } : {}),
    display: m.display,
    ...onOf(m, ['vulkan']),
    // The adapters come without connections: those hold secrets, and are this browser's (docs/networking/adapters.md §5).
    adapters: (m.macs ?? (m.network ? [DEFAULT_MAC] : [])).map((mac) => ({ id: newId(), mac })),
    usb: m.usb ?? false,
    mouse: m.mouse ?? false,
    ...onOf(m, ['touch', 'clock', 'shares', 'clipboard']),
    ...(m.sharesMount === false ? { sharesMount: false as const } : {}),
    ...setOf({ sharesPath: m.sharesPath }),
    ...(def.usbDevices?.length ? { usbDevices: fromDefinition(def.usbDevices) } : {}),
    attachments,
    created: now,
    modified: now,
  };
}

/**
 * Makes a machine from definition `def` in this browser; returns it, and the names of the disks to pick at its first
 * start (files, and stored disks this browser doesn't have, which come back as files: their bytes aren't in it).
 */
export async function importDefinition(
  store: Store,
  def: Definition,
): Promise<{ machine: MachineRecord; toPick: string[] }> {
  const have = await store.all('disks');
  const now = Date.now();
  const attachments: Attachment[] = [];
  const toPick: string[] = [];
  for (const x of def.disks) {
    const { d, same, pick } = diskFor(x, have, now);
    if (pick) toPick.push(x.name);
    if (!same) {
      await store.put('disks', d);
      have.push(d);
    }
    attachments.push(attachmentOf(x, d, attachments));
  }
  const names = (await store.all('machines')).map((m) => m.name);
  const machine = machineFrom(def, uniqueName(def.machine.name, names), attachments, now);
  await store.put('machines', machine);
  return { machine, toPick };
}

/**
 * The hash a definition or a changes file names an image by (web/changes.ts `hashSource`: the SHA-256 of the 4 MiB
 * slices' SHA-256 digests), of a `File` on a page (async slices).
 */
export async function hashFile(file: Blob, progress?: (done: number) => void) {
  const SLICE = 4 << 20;
  const leaves = new Uint8Array(Math.ceil(file.size / SLICE) * 32);
  for (let off = 0, i = 0; off < file.size; off += SLICE, i++) {
    const bytes = await file.slice(off, Math.min(file.size, off + SLICE)).arrayBuffer();
    leaves.set(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), i * 32);
    progress?.(Math.min(file.size, off + SLICE));
  }
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', leaves))]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
