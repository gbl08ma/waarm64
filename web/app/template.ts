// A machine from a template (docs/machines.md "A machine from a template"; the demos' first start, DEMO-KICKOFF.md
// decision 11): a machine definition imported as a new stored machine (its disks by identity: a chunked image's by its
// content, wherever it's hosted), its template snapshot kept as the machine's first snapshot, and the record marked to
// restore it at its first start (`restoreFirst`), with no question: a fork onto the machine's fresh overlays, which is
// what a restore onto other overlays is (web/app/snapshots.ts `planRestore`). A demo's (`machineFromDemo`, a store's
// demo: web/app/demo-store.ts) is that from its definition's `demo`: its snapshot (checked against the content id the
// definition names), its first adapter on the demo network when it asks (`network: "demo"`), and the record marked
// with the demo it came from (`fromDemo`). DOM-free but for `fetch`.
import { fetchChunked } from '../chunked.ts';
import { msgOf, MsgError } from '../msg.ts';
import { importDefinition, parseDefinition, resolveUrls, type Definition } from './definitions.ts';
import { fetchText, type DemoRef, type StoreDemo } from './demo-store.ts';
import { attachDemoNetwork } from './net-demo.ts';
import type { MachineRecord } from './shape.ts';
import { importSnapshot } from './snapshots.ts';
import type { SnapshotRecord, Store } from './store.ts';

export { resolveUrls };

// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- no location in Node's tests
const absolute = (url: string) => new URL(url, globalThis.location?.href).href;

/** A definition's file fetched and parsed, its relative URLs resolved against the file's own. */
export async function fetchDefinition(url: string): Promise<Definition> {
  const abs = absolute(url);
  return resolveUrls(parseDefinition(await fetchText(abs, { demo: true })), abs);
}

/**
 * Makes machine `def` in this browser with `snapshot` (a snapshot file of a machine of the same shape: a template) as
 * its first kept snapshot, restored at its first start (`fromDemo`: the demo it is, on the record). Returns both records.
 */
export async function machineFromTemplate(
  store: Store,
  def: Definition,
  snapshot: File,
  o: { fromDemo?: DemoRef } = {},
): Promise<{ machine: MachineRecord; snapshot: SnapshotRecord }> {
  const { machine } = await importDefinition(store, def);
  let kept: SnapshotRecord;
  try {
    kept = await importSnapshot(store, machine.id, snapshot);
  } catch (e) {
    // No machine without its template (the storage full, most often): the record goes, its disks stay (another
    // machine may have them).
    await store.deleteMachine(machine.id).catch(() => undefined); // tidying up: the failure thrown is the one to report
    throw full(e) ?? e;
  }
  const m = { ...machine, restoreFirst: kept.id, ...(o.fromDemo ? { fromDemo: o.fromDemo } : {}) };
  await store.put('machines', m);
  return { machine: m, snapshot: kept };
}

/** A snapshot's import refused for want of room, said as a demo's (its cause, the storage's numbers), else undefined. */
function full(e: unknown) {
  const cause = e instanceof Error ? e.cause : undefined;
  if (!msgOf(cause)?.key.startsWith('disks:overlay.storageFull')) return undefined;
  return new MsgError('machines:template.full', undefined, { cause });
}

/** The words for a demo whose files the server no longer has (a manifest's 404: decision 12). */
export const gone = (url: string) => () =>
  new MsgError('machines:template.gone', undefined, { cause: new MsgError('machines:template.gone.cause', { url }) });

/**
 * A chunked file fetched whole (a template snapshot), checked to be content `id` when given: a 404 says the demo's
 * files are gone; another file under the URL (a site republished meanwhile) is refused.
 */
async function fetchSnapshot(url: string, id?: string, progress?: (done: number, total: number) => void) {
  // The manifest first, for its 404 in words (fetchChunked fetches it again: a small file, from the cache).
  const manifest = JSON.parse(await fetchText(url, { demo: true, gone: gone(url) })) as { id?: unknown };
  if (id !== undefined && manifest.id !== id)
    throw new MsgError('machines:template.otherSnapshot', undefined, {
      cause: new MsgError('machines:template.otherSnapshot.cause'),
    });
  try {
    return await fetchChunked(url, { progress });
  } catch (e) {
    // A piece refused or the connection lost partway: nothing is kept, and trying again starts over.
    if (e instanceof MsgError) throw e;
    throw new MsgError('machines:template.cutOff', undefined, {
      cause: new MsgError('machines:template.cutOff.cause', { host: new URL(url).host }, { cause: e }),
    });
  }
}

/**
 * Makes store demo `d`'s machine in this browser: its definition imported, marked `fromDemo`, its template snapshot
 * (if it has one) fetched first, so a failed download leaves no machine, and kept to restore at its first start; its
 * first adapter on the demo network if it asks. Named as the definition says, with a suffix past the visitor's own
 * machines' names (importDefinition's: a fresh copy is `Alpine (2)`). Returns the record as stored.
 */
export async function machineFromDemo(
  store: Store,
  d: StoreDemo,
  progress?: (done: number, total: number) => void,
): Promise<{ machine: MachineRecord; snapshot?: SnapshotRecord }> {
  const { def } = d;
  const fromDemo = { store: d.store, id: def.demo.id };
  const snap = def.demo.snapshot;
  let made: { machine: MachineRecord; snapshot?: SnapshotRecord };
  if (snap) {
    const { blob } = await fetchSnapshot(snap.manifest, snap.id, progress);
    made = await machineFromTemplate(store, def, new File([blob], `${def.machine.name}.waarm64snap`), { fromDemo });
  } else {
    const { machine } = await importDefinition(store, def);
    const m = { ...machine, fromDemo };
    await store.put('machines', m);
    made = { machine: m };
  }
  if (def.demo.network === 'demo') await attachDemoNetwork(store, made.machine.id);
  return { ...made, machine: (await store.get('machines', made.machine.id)) ?? made.machine };
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
  const { blob } = await fetchSnapshot(new URL(snapshot, url).href, undefined, progress);
  return machineFromTemplate(store, def, new File([blob], `${def.machine.name}.waarm64snap`));
}
