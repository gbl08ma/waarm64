// Machine definitions in and out (docs/machines.md §6): a machine's shape as a small JSON file (`waarm64-machine`,
// version 2, which reads version 1 too: version 2 only added `demo`, a demo's card, docs/machines.md §6.2): its settings, and per attachment the disk's kind, name, size and identity (a URL as is; a file's name,
// size, date and hash where known; a blank disk's or ramdisk's size), read-only, written in place, a ramdisk as swap, its serial. No
// overlays, snapshots or file contents ("export a machine", the bundle, is later and named apart). An import makes a
// new machine (its name made unique): URL, blank and ramdisk disks come back as they were (a disk this browser has, by
// identity, is attached again); file disks, and stored disks this browser doesn't have, are files to pick at its first
// start, checked by name, size and date, then by hash where the definition has one. A machine with a USB controller says
// so (`machine.usb`; a relative mouse, a touchscreen and the clock device, `mouse`, `touch` and `clock`, likewise; shared folders, `shares` with `sharesMount` and `sharesPath`, never the folders themselves), and its remembered USB devices go as identities (`usbDevices`): no grant travels, so on another
// browser the first start offers one click each (docs/usb.md "The page"). All are left out when there's nothing to say.
// The network adapters go as their MACs (`machine.macs`, left out for one at the default), without their connections.
// A grown overlay goes as its size (`overlaySize`, docs/machines.md §4.5): the import gives the attachment an empty
// overlay of that size, marked to grow (its base's partition doesn't fill it), so the machine sees the same disk; a
// stored disk grown since it was made, as the size it was made with (the image to pick) and the size seen as `overlaySize`.
// A damaged definition's error names the field at fault (`machine.ramMiB`, `disks[0].url`, `demo.view`).
import { MsgError } from '../msg.ts';
import { grownSize, withGrownOverlay } from './resize.ts';
import { sizeSeen } from './disk-size.ts';
import { fromDefinition, toDefinition, type DefinitionUsb } from './usb-ports.ts';
import { checkDefinition, DEFINITION_TYPE, DEFINITION_VERSION, SWITCHES } from './definition-check.ts';
import {
  adaptersOf,
  canonical,
  DEFAULT_MAC,
  newId,
  uniqueName,
  type Attachment,
  type DiskIdentity,
  type DiskKind,
  type DiskRecord,
  type Display,
  type MachineRecord,
} from './shape.ts';
import type { OverlayRecord, Store } from './store.ts';

export { checkDefinition, DEFINITION_TYPE, DEFINITION_VERSION, isDemoId, isFileUrl } from './definition-check.ts';

/**
 * A demo (DEMO-KICKOFF.md decisions 11–15; docs/machines.md §6.2): what its card in a store shows and what its first
 * start does. Its URLs, as its disks', are relative to the file it's in (a store's or a definition's).
 */
export type Demo = {
  /** Unique in its store; a new version of a demo gets a new id (`replaces` names the ones before). */
  id: string;
  /** The card's text (plain text: the store's data, not the catalog's). */
  summary: string;
  thumbnail?: string;
  /** The bytes a visitor downloads to reach its first prompt (tools/publish-demos.ts checks it against the files). */
  download: number;
  /** What the page shows when it opens: the serial console or the screen. */
  view: 'serial' | 'screen';
  /** The template snapshot its first start restores (a chunked file's manifest and its content id); none: a cold boot. */
  snapshot?: { manifest: string; id: string };
  /** `demo`: its first adapter attached to the demo network (web/app/net-demo.ts). */
  network?: 'demo';
  /** The ids of the versions it replaces (a machine made from one is "an older version of this demo"). */
  replaces?: string[];
  /**
   * `true`: offered under New machine as a template too, a starting point for the user's own machine (its machine and
   * disks only: no snapshot, no demo network, no `fromDemo`; web/app/template.ts `machineFromStoreTemplate`).
   */
  template?: boolean;
};

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
  /** Its overlay's own size where it was grown past the disk's (§4.5): what the guest sees. */
  overlaySize?: number;
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
    agent?: false;
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
  /** Version 2: a demo's card, which a store lists (web/app/demo-store.ts). */
  demo?: Demo;
};

/** The switches of `m` that are on, as `{ name: true }` in `keys`' order (those off are left out). */
const onOf = <K extends string>(m: Partial<Record<K, boolean>>, keys: readonly K[]) =>
  Object.fromEntries(keys.filter((k) => m[k]).map((k) => [k, true])) as Partial<Record<K, true>>;

/** The fields of `o` that are set (not empty, zero or false), in its order. */
const setOf = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v)) as Partial<T>;

/**
 * An attachment's disk as a definition says it (`o`: its overlay's record, if it has one). A stored disk grown since it
 * was made (`made`) says the size it was made with, which another browser asks for in the image to pick (§6), and, for a
 * writable attachment, the size its guest sees as `overlaySize`: the imported machine's overlay over that image.
 */
function diskOf(d: DiskRecord, a: Attachment, o?: OverlayRecord): DefinitionDisk {
  const made = d.kind === 'stored' && !a.readOnly && d.made !== undefined && d.made < d.size ? d.made : undefined;
  return {
    kind: d.kind,
    name: d.name,
    size: made ?? d.size,
    identity: d.identity,
    ...setOf({ url: d.url, sha256: d.sha256 }),
    readOnly: a.readOnly,
    ...onOf(a, ['inPlace', 'swap']),
    serial: a.id,
    ...setOf({ overlaySize: made === undefined ? grownSize(d, a, o) : sizeSeen(d, a, o) }),
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
    ...(m.agent === false ? { agent: false } : {}),
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
    disks.push(diskOf(d, a, a.overlay ? await store.get('overlays', a.overlay) : undefined));
  }
  const usb = m.usbDevices?.length ? { usbDevices: toDefinition(m.usbDevices) } : {};
  return { type: DEFINITION_TYPE, version: DEFINITION_VERSION, machine: settingsOf(m), disks, ...usb };
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
  return checkDefinition(d);
}

/**
 * `def` with its relative URLs (its URL disks', its demo's snapshot and thumbnail) made absolute against `base`: where
 * the definition was fetched from, or its store.
 */
export function resolveUrls<D extends Definition>(def: D, base: string): D {
  const abs = (u: string) => new URL(u, base).href;
  const demo = def.demo && {
    ...def.demo,
    ...(def.demo.thumbnail ? { thumbnail: abs(def.demo.thumbnail) } : {}),
    ...(def.demo.snapshot ? { snapshot: { ...def.demo.snapshot, manifest: abs(def.demo.snapshot.manifest) } } : {}),
  };
  return {
    ...def,
    disks: def.disks.map((d) => (d.url ? { ...d, url: abs(d.url) } : d)),
    ...(demo ? { demo } : {}),
  };
}

/**
 * The disk a definition's disk `x` comes back as: the one this browser has by identity (`same`; a URL disk's at the
 * same URL), a URL, blank or ramdisk disk as it was, or a file to pick (`pick`; a stored disk becomes one: its bytes
 * aren't in this browser).
 */
function diskFor(
  x: DefinitionDisk,
  have: DiskRecord[],
  now: number,
): { d: DiskRecord; same?: boolean; pick?: boolean } {
  // A URL disk is the same disk only at the same URL: a chunked image is its content wherever it's hosted (its
  // identity, which the shape hashes, matches on any host), but the record says where it's read from, and that stays
  // the definition's. Another store's definition naming an image's id doesn't decide where ours reads it (the bytes
  // are checked against the id either way: web/chunked.ts), nor does a mirror that later goes away.
  const same = have.find(
    (d) => canonical(d.identity) === canonical(x.identity) && (x.kind !== 'url' || sameUrl(d.url, x.url)),
  );
  if (same) return { d: same, same: true };
  const base = { name: x.name, size: x.size, created: now };
  if (x.kind === 'url') return { d: { id: newId(), kind: 'url', url: x.url, identity: x.identity, ...base } };
  // A record of its own, whatever id the identity names (that id is the definition's, hashed in the shape as part of
  // the identity, never a record's to take: it could be one this browser has).
  if (x.kind === 'blank' || x.kind === 'ramdisk')
    return { d: { id: newId(), kind: x.kind, identity: x.identity, ...base } };
  const identity: DiskIdentity =
    x.kind === 'file' ? x.identity : { kind: 'file', name: x.name, bytes: x.identity.bytes || x.size, modified: 0 };
  return { d: { id: newId(), kind: 'file', identity, ...setOf({ sha256: x.sha256 }), ...base }, pick: true };
}

/** Whether two URLs (a record's, a definition's: absolute, or the page's) name the same file. */
function sameUrl(a: string | undefined, b: string | undefined) {
  if (a === undefined || b === undefined) return false;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- no location in Node's tests
  const at = globalThis.location?.href;
  try {
    return new URL(a, at).href === new URL(b, at).href;
  } catch {
    return false;
  }
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
    ...(m.agent === false ? { agent: false as const } : {}),
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
 * `finish`: what the record needs before it's stored (a template's snapshot kept under its id, its marks), given the
 * record; the machine is stored once, as it returns it (its attachments are this import's). `finish` runs before any
 * record is written (its files are the machine's: without its record, the store's sweep takes them), and the disks,
 * overlays and machine are written after it, at once: a tab closed during a template's long import leaves no disk record
 * behind. When it throws (or a disk can't be made) nothing is left: the disks and overlays this import made go, and the
 * machine's files (`finish`'s: a kept snapshot) with them.
 */
export async function importDefinition(
  store: Store,
  def: Definition,
  finish?: (m: MachineRecord) => Promise<MachineRecord>,
): Promise<{ machine: MachineRecord; toPick: string[] }> {
  const have = await store.all('disks');
  const now = Date.now();
  const planned: { x: DefinitionDisk; d: DiskRecord; same: boolean; a: Attachment }[] = [];
  const toPick: string[] = [];
  for (const x of def.disks) {
    const { d, same, pick } = diskFor(x, have, now);
    if (pick) toPick.push(x.name);
    if (!same) have.push(d);
    planned.push({
      x,
      d,
      same: !!same,
      a: attachmentOf(
        x,
        d,
        planned.map((p) => p.a),
      ),
    });
  }
  const names = (await store.all('machines')).map((m) => m.name);
  let machine: MachineRecord = machineFrom(
    def,
    uniqueName(def.machine.name, names),
    planned.map((p) => p.a),
    now,
  );
  const attachments: Attachment[] = [];
  const made: string[] = [];
  try {
    if (finish) machine = await finish(machine);
    for (const { x, d, same, a } of planned) {
      if (!same) {
        await store.put('disks', d);
        made.push(d.id);
      }
      attachments.push(await withGrownOverlay(store, d, a, x.overlaySize));
    }
    machine = { ...machine, attachments };
    await store.put('machines', machine);
    return { machine, toPick };
  } catch (e) {
    // Tidying up: the failure thrown is the one to report. The machine's files (and a snapshot's record) first, then the
    // grown overlays it made on disks it found, then the disks it made (their overlays with them).
    const tidy = (f: Promise<unknown>) => f.catch(() => undefined);
    await tidy(store.deleteMachine(machine.id));
    for (const { overlay, disk } of attachments)
      if (overlay && !made.includes(disk)) await tidy(store.deleteOverlay(overlay));
    for (const id of made) await tidy(store.deleteDisk(id));
    throw e;
  }
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
