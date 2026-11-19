// A machine from a template (docs/machines.md "A machine from a template"; the demos' first start, docs/decisions.md "Demos"
// decision 11): a machine definition imported as a new stored machine (its disks by identity, a URL disk's at the same
// URL: web/app/definitions.ts), its template snapshot kept as the machine's first snapshot, and the record marked to
// restore it at its first start (`restoreFirst`), with no question: a fork onto the machine's fresh overlays, which is
// what a restore onto other overlays is (web/app/snapshots.ts `planRestore`). A demo's (`machineFromDemo`, a store's
// demo: web/app/demo-store.ts) is that from its definition's `demo`: its snapshot (checked against the content id the
// definition names), its first adapter on the demo network when it asks (`network: "demo"`), and the record marked
// with the demo it came from (`fromDemo`). A store's demo marked `template` makes a plain machine too
// (`machineFromStoreTemplate`: its machine and disks only, New machine's). DOM-free but for `fetch`.
import { checkManifest, contentId, fetchChunked, type Manifest } from '../chunked.ts';
import { msgOf, MsgError } from '../msg.ts';
import { importDefinition, parseDefinition, resolveUrls, type Definition } from './definitions.ts';
import { fetchText, type DemoRef, type StoreDemo } from './demo-store.ts';
import { withDemoNetwork } from './net-demo.ts';
import { newMac, type MachineRecord } from './shape.ts';
import { importSnapshot } from './snapshots.ts';
import type { SnapshotRecord, Store } from './store.ts';

export { resolveUrls };

/** The largest template snapshot a demo may download (bytes), whatever its card says. */
export const MAX_TEMPLATE = 1 << 30;

// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- no location in Node's tests
const absolute = (url: string) => new URL(url, globalThis.location?.href).href;

/** A definition's file fetched and parsed, its relative URLs resolved against the file's own. */
export async function fetchDefinition(url: string): Promise<Definition> {
  const abs = absolute(url);
  return resolveUrls(parseDefinition(await fetchText(abs, { demo: true })), abs);
}

/**
 * Makes machine `def` in this browser with `snapshot` (a snapshot file of a machine of the same shape: a template) as
 * its first kept snapshot, restored at its first start (`fromDemo`: the demo it is, on the record; `network`: its first
 * adapter on the demo network). The snapshot is kept before the machine's record is stored, and the record is stored
 * once with its marks: a failure (the storage full, most often) leaves no machine, and none of the disks or overlays
 * the import made. Returns both records.
 */
export async function machineFromTemplate(
  store: Store,
  def: Definition,
  snapshot: File,
  o: { fromDemo?: DemoRef; network?: boolean } = {},
): Promise<{ machine: MachineRecord; snapshot: SnapshotRecord }> {
  let kept!: SnapshotRecord;
  const { machine } = await importDefinition(store, def, async (m) => {
    try {
      kept = await importSnapshot(store, m.id, snapshot);
    } catch (e) {
      throw full(e) ?? e;
    }
    return marked({ ...m, restoreFirst: kept.id }, store, o);
  });
  return { machine, snapshot: kept };
}

/** Record `m` with a demo's marks: `fromDemo`, and its first adapter on the demo network (`network`). */
async function marked(m: MachineRecord, store: Store, o: { fromDemo?: DemoRef; network?: boolean }) {
  const withDemo = o.fromDemo ? { ...m, fromDemo: o.fromDemo } : m;
  return o.network ? withDemoNetwork(store, withDemo) : withDemo;
}

/** A snapshot's import refused for want of room, said as a demo's (its cause, the storage's numbers), else undefined. */
function full(e: unknown) {
  const cause = e instanceof Error ? e.cause : undefined;
  if (!msgOf(cause)?.key.startsWith('disks:overlay.storageFull')) return undefined;
  return new MsgError('machines:template.full', undefined, { cause });
}

/** The words for a demo whose files the server no longer has (a manifest's 404: docs/decisions.md "Demos"). */
export const gone = (url: string) => () =>
  new MsgError('machines:template.gone', undefined, { cause: new MsgError('machines:template.gone.cause', { url }) });

/** What a template snapshot's download may hold: at most `download` bytes (its card's), and never past `MAX_TEMPLATE`. */
type SnapshotFetch = {
  id?: string;
  download?: number;
  progress?: (done: number, total: number) => void;
  signal?: AbortSignal;
};

/** A download's failure as the visitor reads it (the headline, the cause under it). */
const failed = (cause: unknown) => new MsgError('machines:template.download', undefined, { cause });

/**
 * A chunked file fetched whole (a template snapshot), checked to be content `id` when given, of at most `download`
 * bytes (a store's card says it; another store's isn't trusted past that) and `MAX_TEMPLATE`: a 404 (the manifest's or
 * a piece's) says the demo's files are gone; another file under the URL (a site republished meanwhile) is refused;
 * the rest said as a failed download with why (a manifest that isn't one, a piece refused or wrong, the connection
 * lost). `signal` aborts it, the browser's `AbortError` thrown.
 */
async function fetchSnapshot(url: string, o: SnapshotFetch = {}) {
  // The manifest once (its 404 in words), checked, and its pieces by it: each against its hash (fetchChunked).
  const manifest = snapshotManifest(await fetchText(url, { demo: true, gone: gone(url), signal: o.signal }), o);
  try {
    return await fetchChunked(url, { progress: o.progress, manifest, signal: o.signal });
  } catch (e) {
    if (o.signal?.aborted) throw e;
    // Nothing is kept, and trying again starts over.
    const m = msgOf(e);
    if (m?.key === 'disks:chunked.pieceStatus' && m.params?.status === 404) throw gone(url)();
    if (m) throw failed(e);
    // The connection lost partway.
    throw new MsgError('machines:template.cutOff', undefined, {
      cause: new MsgError('machines:template.cutOff.cause', { host: new URL(url).host }, { cause: e }),
    });
  }
}

/** A template snapshot's manifest `text` checked: a manifest, of content `o.id`, within `o.download` and `MAX_TEMPLATE`. */
function snapshotManifest(text: string, o: SnapshotFetch): Manifest {
  let raw: Partial<Manifest> | null;
  try {
    raw = JSON.parse(text) as Partial<Manifest> | null;
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== 'object') throw failed(new MsgError('disks:chunked.malformed'));
  // The id the definition names must be the manifest's and its content's: the hashes' (the pieces are checked by them).
  if (o.id !== undefined && (raw.id !== o.id || !Array.isArray(raw.hashes) || contentId(raw.hashes) !== o.id))
    throw new MsgError('machines:template.otherSnapshot', undefined, {
      cause: new MsgError('machines:template.otherSnapshot.cause'),
    });
  let manifest: Manifest;
  try {
    manifest = checkManifest(raw);
  } catch (e) {
    throw failed(e);
  }
  // Bounded before a piece is fetched: its pieces may all be one hosted piece named again and again.
  const most = Math.min(o.download ?? MAX_TEMPLATE, MAX_TEMPLATE);
  if (manifest.size > most)
    throw new MsgError('machines:template.tooBig', undefined, {
      cause: new MsgError('machines:template.tooBig.cause', { size: manifest.size, most }),
    });
  return manifest;
}

/**
 * Makes store demo `d`'s machine in this browser: its definition imported, marked `fromDemo`, its template snapshot
 * (if it has one) fetched first and kept to restore at its first start; its first adapter on the demo network if it
 * asks. The record is stored once, with all of that: a failure anywhere leaves no machine (so trying again makes one);
 * `signal` aborts the download (its `AbortError` thrown), and nothing is made. Named as the definition says, with a suffix past the visitor's own
 * machines' names (importDefinition's: a fresh copy is `Alpine (2)`). Returns the record as stored.
 */
export async function machineFromDemo(
  store: Store,
  d: StoreDemo,
  progress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ machine: MachineRecord; snapshot?: SnapshotRecord }> {
  const { def } = d;
  const fromDemo = { store: d.store, id: def.demo.id };
  const snap = def.demo.snapshot;
  const o = { fromDemo, network: def.demo.network === 'demo' };
  if (snap) {
    const { blob } = await fetchSnapshot(snap.manifest, { id: snap.id, download: def.demo.download, progress, signal });
    signal?.throwIfAborted(); // nothing made yet: the page that asked is gone
    return machineFromTemplate(store, def, new File([blob], `${def.machine.name}.waarm64snap`), o);
  }
  const { machine } = await importDefinition(store, def, (m) => marked(m, store, o));
  return { machine };
}

/**
 * A store's demo as a template (`demo.template`: New machine's, web/app/NewMachine.svelte): its definition without its
 * `demo`, so no template snapshot (a cold boot from its disks), no demo network and no `fromDemo`. The machine is the
 * user's own, as a copy of a demo's is.
 */
export function templateDefinition(d: StoreDemo): Definition {
  const { demo: _, ...def } = d.def;
  return def;
}

/**
 * Makes store demo `d`'s machine as a template (`templateDefinition`); `toPick`: its disks that are files to pick. Its
 * adapters get MACs of their own, as an empty machine's: the demo's recipe fixes one (its shape's), which two machines
 * from the template on one network would share.
 */
export async function machineFromStoreTemplate(store: Store, d: StoreDemo) {
  const taken = (await store.all('machines')).flatMap((m) => (m.adapters ?? []).map((a) => a.mac));
  const fresh = (m: MachineRecord) => ({
    ...m,
    adapters: m.adapters?.map((a) => {
      const mac = newMac(taken);
      taken.push(mac);
      return { ...a, mac };
    }),
  });
  return importDefinition(store, templateDefinition(d), (m) => Promise.resolve(fresh(m)));
}

/**
 * A machine from a definition's URL: a demo's (`machineFromDemo`, the definition its own store), or, with `snapshot`
 * (a chunked file's manifest, relative to the definition), `machineFromTemplate` with that snapshot.
 */
export async function machineFromUrls(
  store: Store,
  definition: string,
  snapshot?: string,
  progress?: (done: number, total: number) => void,
): Promise<{ machine: MachineRecord; snapshot?: SnapshotRecord }> {
  const url = absolute(definition);
  const def = await fetchDefinition(url);
  if (!snapshot && def.demo) return machineFromDemo(store, { store: url, def: { ...def, demo: def.demo } }, progress);
  if (!snapshot) {
    const { machine } = await importDefinition(store, def);
    return { machine };
  }
  const { blob } = await fetchSnapshot(new URL(snapshot, url).href, { progress });
  return machineFromTemplate(store, def, new File([blob], `${def.machine.name}.waarm64snap`));
}
