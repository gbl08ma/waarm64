// Machine definitions in and out (docs/plans/machines.md §6): a machine's shape as a small JSON file (`webpc-machine`,
// version 1): its settings, and per attachment the disk's kind, name, size and identity (a URL as is; a file's name,
// size, date and hash where known; a blank disk's or ramdisk's size), read-only, written in place, its serial. No
// overlays, snapshots or file contents ("export a machine", the bundle, is later and named apart). An import makes a
// new machine (its name made unique): URL, blank and ramdisk disks come back as they were (a disk this browser has, by
// identity, is attached again); file disks, and stored disks this browser doesn't have, are files to pick at its first
// start, checked by name, size and date, then by hash where the definition has one. A machine with a USB controller says
// so (`machine.usb`), and its remembered USB devices go as identities (`usbDevices`): no grant travels, so on another
// browser the first start offers one click each (docs/usb.md "The page"). Both are left out when there's nothing to say.
// The network adapters go as their MACs (`machine.macs`, left out for one at the default), without their connections.
import { fromDefinition, toDefinition, validDefinitionUsb, type DefinitionUsb } from './usb-ports.ts';
import { validKeyboard } from './keyboard.ts';
import { adaptersOf, canonical, DEFAULT_MAC, isMac, MAX_ADAPTERS, MAX_DISKS, newId, uniqueName, type Attachment, type DiskIdentity, type DiskKind, type DiskRecord, type Display, type MachineRecord } from './shape.ts';
import type { Store } from './store.ts';
import { ramSplitError } from './machine.ts';

export const DEFINITION_TYPE = 'webpc-machine';
export const DEFINITION_VERSION = 1;

export type DefinitionDisk = { kind: DiskKind; name: string; size: number; identity: DiskIdentity; url?: string; sha256?: string; readOnly: boolean; inPlace?: boolean; serial: string };
export type Definition = {
  type: typeof DEFINITION_TYPE;
  version: number;
  /** `network`: whether it has an adapter; `macs`: the adapters' MACs, left out for none or one at the default (as before adapters). */
  machine: { name: string; ncpus: number; ramMiB: number; ramSplit?: number[]; jitMiB?: number; keyboard?: string; display: Display; network: boolean; macs?: string[]; usb?: boolean };
  disks: DefinitionDisk[];
  usbDevices?: DefinitionUsb[];
};

/** Machine `id`'s definition. */
export async function exportDefinition(store: Store, id: string): Promise<Definition> {
  const m = await store.get('machines', id);
  if (!m) throw new Error('that machine is gone');
  const disks: DefinitionDisk[] = [];
  for (const a of m.attachments) {
    const d = await store.get('disks', a.disk);
    if (!d) throw new Error(`${m.name} has a disk that isn't in this browser`);
    disks.push({ kind: d.kind, name: d.name, size: d.size, identity: d.identity, ...(d.url ? { url: d.url } : {}), ...(d.sha256 ? { sha256: d.sha256 } : {}), readOnly: a.readOnly, ...(a.inPlace ? { inPlace: true } : {}), serial: a.id });
  }
  const usb = m.usbDevices?.length ? { usbDevices: toDefinition(m.usbDevices) } : {};
  const macs = adaptersOf(m).map((a) => a.mac);
  return { type: DEFINITION_TYPE, version: DEFINITION_VERSION, machine: { name: m.name, ncpus: m.ncpus, ramMiB: m.ramMiB, ...(m.ramSplit ? { ramSplit: m.ramSplit } : {}), ...(m.jitMiB ? { jitMiB: m.jitMiB } : {}), ...(m.keyboard ? { keyboard: m.keyboard } : {}), display: m.display, network: macs.length > 0, ...(macs.length > 1 || (macs.length === 1 && macs[0] !== DEFAULT_MAC) ? { macs } : {}), ...(m.usb ? { usb: true } : {}) }, disks, ...usb };
}

/** Parses a definition file's text; throws a message for the user when it isn't one this page reads. */
export function parseDefinition(text: string): Definition {
  let d: Definition;
  try {
    d = JSON.parse(text) as Definition;
  } catch {
    throw new Error("this file isn't a machine definition (it isn't JSON)");
  }
  if (d?.type !== DEFINITION_TYPE) throw new Error("this file isn't a machine definition");
  if (d.version !== DEFINITION_VERSION) throw new Error(`this definition is version ${d.version}; this page reads version ${DEFINITION_VERSION}`);
  const m = d.machine;
  const ok = m && typeof m.name === 'string' && Number.isInteger(m.ncpus) && m.ncpus >= 1 && m.ncpus <= 64 && Number.isInteger(m.ramMiB) && m.ramMiB >= 64 && (m.ramSplit === undefined || (Array.isArray(m.ramSplit) && !ramSplitError(m.ramSplit) && m.ramSplit.reduce((a, b) => a + b, 0) === m.ramMiB)) && (m.jitMiB === undefined || (Number.isInteger(m.jitMiB) && m.jitMiB >= 1 && m.jitMiB <= 4096)) && (m.keyboard === undefined || validKeyboard(m.keyboard)) && (m.display === '2d' || m.display === '3d') && typeof m.network === 'boolean' && (m.macs === undefined || (Array.isArray(m.macs) && m.macs.length >= 1 && m.macs.length <= MAX_ADAPTERS && m.macs.every((x) => typeof x === 'string' && isMac(x)) && m.network)) && (m.usb === undefined || typeof m.usb === 'boolean') && (d.usbDevices === undefined || validDefinitionUsb(d.usbDevices))
    && Array.isArray(d.disks) && d.disks.length <= MAX_DISKS && d.disks.every((x) => ['url', 'file', 'stored', 'blank', 'ramdisk'].includes(x?.kind) && Number.isSafeInteger(x.size) && x.size > 0 && typeof x.name === 'string' && x.identity?.kind && typeof x.serial === 'string' && /^[0-9a-f]{12}$/.test(x.serial));
  if (!ok) throw new Error('this machine definition is damaged (a field is missing or out of range)');
  return d;
}

/**
 * Makes a machine from definition `def` in this browser; returns it, and the names of the disks to pick at its first
 * start (files, and stored disks this browser doesn't have, which come back as files: their bytes aren't in it).
 */
export async function importDefinition(store: Store, def: Definition): Promise<{ machine: MachineRecord; toPick: string[] }> {
  const have = await store.all('disks');
  const now = Date.now();
  const attachments: Attachment[] = [];
  const toPick: string[] = [];
  for (const x of def.disks) {
    const same = have.find((d) => canonical(d.identity) === canonical(x.identity));
    let d: DiskRecord;
    if (same) {
      d = same;
    } else if (x.kind === 'url') {
      d = { id: newId(), kind: 'url', name: x.name, size: x.size, url: x.url, identity: x.identity, created: now };
    } else if (x.kind === 'blank' || x.kind === 'ramdisk') {
      // Under the identity's id, so the shape is the definition's.
      d = { id: x.identity.kind === x.kind ? x.identity.id : newId(), kind: x.kind, name: x.name, size: x.size, identity: x.identity, created: now };
    } else {
      // A file to pick (a stored disk becomes one: its bytes aren't in this browser).
      d = { id: newId(), kind: 'file', name: x.name, size: x.size, identity: x.kind === 'file' ? x.identity : { kind: 'file', name: x.name, bytes: x.identity.bytes || x.size, modified: 0 }, ...(x.sha256 ? { sha256: x.sha256 } : {}), created: now };
      toPick.push(x.name);
    }
    if (!same) {
      await store.put('disks', d);
      have.push(d);
    }
    attachments.push({ id: attachments.some((a) => a.id === x.serial) ? newId() : x.serial, disk: d.id, readOnly: x.readOnly, ...(x.inPlace && d.kind === 'stored' ? { inPlace: true } : {}) });
  }
  const machine: MachineRecord = {
    id: newId(),
    name: uniqueName(def.machine.name, (await store.all('machines')).map((m) => m.name)),
    ncpus: def.machine.ncpus,
    ramMiB: def.machine.ramMiB,
    ...(def.machine.ramSplit ? { ramSplit: def.machine.ramSplit } : {}),
    ...(def.machine.jitMiB ? { jitMiB: def.machine.jitMiB } : {}),
    ...(def.machine.keyboard ? { keyboard: def.machine.keyboard } : {}),
    display: def.machine.display,
    // The adapters come without connections: those hold secrets, and are this browser's (network-adapters.md §5).
    adapters: (def.machine.macs ?? (def.machine.network ? [DEFAULT_MAC] : [])).map((mac) => ({ id: newId(), mac })),
    usb: def.machine.usb ?? false,
    ...(def.usbDevices?.length ? { usbDevices: fromDefinition(def.usbDevices) } : {}),
    attachments,
    created: now,
    modified: now,
  };
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
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', leaves))].map((x) => x.toString(16).padStart(2, '0')).join('');
}
