// A machine definition's checks (docs/machines.md §6, §6.2; web/app/definitions.ts reads and writes them): its type and
// version (1 and 2: version 2 only added `demo`), and each field as an import needs it, a damaged one named by its
// path (`machine.ramMiB`, `disks[0].url`, `demo.view`) in the error the user reads. Fields it doesn't know are ignored.
import { MsgError } from '../msg.ts';
import { validGrownSize } from './resize.ts';
import { sharesPathError } from './shares-mount.ts';
import { validDefinitionUsb } from './usb-ports.ts';
import { validKeyboard } from './keyboard.ts';
import { isMac, MAX_ADAPTERS, MAX_DISKS } from './shape.ts';
import { ramSplitError } from './machine.ts';
import type { Definition } from './definitions.ts';

export const DEFINITION_TYPE = 'waarm64-machine';
/** The version this page writes: 2 added `demo` (docs/machines.md §6.2). */
export const DEFINITION_VERSION = 2;
/** The versions this page reads: version 1 is version 2 without `demo`. */
const READS = [1, 2];

/** The switches a definition writes only when they are on (`usb`, `mouse` and the rest), in its order. */
export const SWITCHES = ['usb', 'mouse', 'touch', 'clock', 'shares', 'clipboard'] as const;
type Switch = (typeof SWITCHES)[number];

type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
/** `v` is absent, or `ok`. */
const optional = (v: unknown, ok: (v: unknown) => boolean) => v === undefined || ok(v);
const isBool = (v: unknown) => typeof v === 'boolean';
const isFalse = (v: unknown) => v === false;
/** An integer in [min, max]. */
const isInt = (v: unknown, min: number, max = Infinity) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isNumbers = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => typeof n === 'number');
/** A string of at most `max` characters (`min` at least). */
const isText = (v: unknown, max: number, min = 0) => typeof v === 'string' && v.length >= min && v.length <= max;
/** A URL a definition names a file by: absolute (http or https) or relative (to the file it's in, or its store's). */
export function isFileUrl(v: unknown) {
  if (typeof v !== 'string' || !v || v.length > 2048) return false;
  try {
    return ['http:', 'https:'].includes(new URL(v, 'https://x.invalid/a/').protocol);
  } catch {
    return false;
  }
}
/** A demo's id: what links name it by (`?id=`), and what "started before" matches. */
export const isDemoId = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(v);
const isHash = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

/**
 * A disk's identity (shape.ts `DiskIdentity`) as its kind `kind` has it: a URL's by content (a chunked image's id) or
 * by path, a file's by name and date, a stored, blank or ramdisk disk's by an id (hashed in the shape, never a record's).
 */
function validIdentity(v: unknown, kind: unknown) {
  if (!isRecord(v) || v.kind !== kind || !isInt(v.bytes, 0, Number.MAX_SAFE_INTEGER)) return false;
  switch (kind) {
    case 'url':
      return v.chunked !== undefined
        ? isHash(v.chunked)
        : isText(v.path, 2048) &&
            optional(v.etag, (e) => isText(e, 1024)) &&
            optional(v.lastModified, (e) => isText(e, 1024));
    case 'file':
      return isText(v.name, 1024) && typeof v.modified === 'number';
    default:
      return isText(v.id, 64, 1);
  }
}

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

/** Checks by the field they check (what a damaged definition's error names): the first that fails is the problem. */
type Checks = Record<string, (o: Raw) => boolean>;

/** A definition's machine settings, each checked. */
const MACHINE_CHECKS: Checks = {
  name: (m) => typeof m.name === 'string',
  ncpus: (m) => isInt(m.ncpus, 1, 64),
  ramMiB: (m) => isInt(m.ramMiB, 64),
  ramSplit: validSplit,
  jitMiB: (m) => optional(m.jitMiB, (v) => isInt(v, 1, 4096)),
  keyboard: (m) => optional(m.keyboard, (v) => typeof v === 'string' && validKeyboard(v)),
  netConfig: (m) => optional(m.netConfig, isFalse),
  agent: (m) => optional(m.agent, isFalse),
  display: (m) => m.display === '2d' || m.display === '3d',
  vulkan: (m) => optional(m.vulkan, isBool),
  network: (m) => isBool(m.network),
  macs: validMacs,
  ...Object.fromEntries(SWITCHES.map((k: Switch) => [k, (m: Raw) => optional(m[k], isBool)])),
  sharesMount: (m) => optional(m.sharesMount, isFalse),
  sharesPath: (m) => optional(m.sharesPath, (v) => typeof v === 'string' && !sharesPathError(v)),
};

const DISK_KINDS: unknown[] = ['url', 'file', 'stored', 'blank', 'ramdisk'];
/** A definition's disk: its kind, size, name, identity, serial and switches checked (a URL disk has its URL). */
const DISK_CHECKS: Checks = {
  kind: (x) => DISK_KINDS.includes(x.kind),
  size: (x) => Number.isSafeInteger(x.size) && (x.size as number) > 0,
  name: (x) => typeof x.name === 'string',
  identity: (x) => validIdentity(x.identity, x.kind),
  url: (x) => (x.kind === 'url' ? isFileUrl(x.url) : optional(x.url, (v) => typeof v === 'string')),
  serial: (x) => typeof x.serial === 'string' && /^[0-9a-f]{12}$/.test(x.serial),
  inPlace: (x) => optional(x.inPlace, isBool),
  swap: (x) => optional(x.swap, isBool),
  overlaySize: (x) => optional(x.overlaySize, (v) => validGrownSize(v, x.size as number)),
};

/** A demo's card and what its first start does (version 2's `demo`). */
const DEMO_CHECKS: Checks = {
  id: (x) => isDemoId(x.id),
  summary: (x) => isText(x.summary, 1000),
  thumbnail: (x) => optional(x.thumbnail, isFileUrl),
  download: (x) => Number.isSafeInteger(x.download) && (x.download as number) > 0,
  view: (x) => x.view === 'serial' || x.view === 'screen',
  snapshot: (x) => optional(x.snapshot, (s) => isRecord(s) && isFileUrl(s.manifest) && isHash(s.id)),
  network: (x) => optional(x.network, (v) => v === 'demo'),
  replaces: (x) =>
    optional(x.replaces, (v) => Array.isArray(v) && v.length <= 64 && v.every((r) => isDemoId(r) && r !== x.id)),
  template: (x) => optional(x.template, isBool),
};

/** The first of `checks` that `o` fails, as `<at>.<field>` (`at` empty: the field alone). */
function failed(o: Raw, checks: Checks, at = ''): string | undefined {
  const field = Object.keys(checks).find((k) => !checks[k](o));
  return field === undefined ? undefined : at ? `${at}.${field}` : field;
}

/**
 * What's wrong with a definition (its type and version checked), as the field at fault (`machine.ramMiB`,
 * `disks[0].serial`, `demo.view`); undefined when it has what an import needs, each field as it should be.
 */
function problem(d: Raw): string | undefined {
  const m = d.machine;
  if (!isRecord(m)) return 'machine';
  const bad = failed(m, MACHINE_CHECKS, 'machine');
  if (bad) return bad;
  if (!optional(d.usbDevices, validDefinitionUsb)) return 'usbDevices';
  if (!Array.isArray(d.disks) || d.disks.length > MAX_DISKS) return 'disks';
  for (const [i, x] of (d.disks as unknown[]).entries()) {
    if (!isRecord(x)) return `disks[${i}]`;
    const disk = failed(x, DISK_CHECKS, `disks[${i}]`);
    if (disk) return disk;
  }
  if (d.version === 1 || d.demo === undefined) return undefined;
  if (!isRecord(d.demo)) return 'demo';
  return failed(d.demo, DEMO_CHECKS, 'demo') ?? (d.demo.network && m.network !== true ? 'demo.network' : undefined);
}

/**
 * Checks a parsed definition (a file's, or one inline in a store: web/app/demo-store.ts); throws a message for the
 * user when it isn't one this page reads. A version 1 definition reads as it always did (it has no `demo`: one there
 * is left out). Fields this page doesn't know are ignored, so a later page's additions within a version still read
 * here; tools/publish-demos.ts refuses them (a typo in a store's source).
 */
export function checkDefinition(d: unknown): Definition {
  if (!isRecord(d) || d.type !== DEFINITION_TYPE)
    throw new MsgError('machines:definition-check.notDefinition', undefined, {
      cause: new MsgError('machines:definition-check.notDefinition.cause'),
    });
  if (!READS.includes(d.version as number))
    throw new MsgError('machines:definition-check.version', undefined, {
      cause: new MsgError('machines:definition-check.version.cause', {
        version: String(d.version),
        reads: DEFINITION_VERSION,
      }),
    });
  const field = problem(d);
  if (field)
    throw new MsgError('machines:definition-check.damaged', undefined, {
      cause: new MsgError('machines:definition-check.damaged.cause', { field }),
    });
  if (d.version === 1 && 'demo' in d) {
    const v1 = { ...d };
    delete v1.demo;
    return v1 as Definition;
  }
  return d as Definition;
}
