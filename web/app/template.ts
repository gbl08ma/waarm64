// A machine from a template (docs/machines.md "A machine from a template"; the demos' first start, DEMO-KICKOFF.md
// decision 11): a machine definition imported as a new stored machine (its disks by identity: a chunked image's by its
// content, wherever it's hosted), its template snapshot kept as the machine's first snapshot, and the record marked to
// restore it at its first start (`restoreFirst`), with no question: a fork onto the machine's fresh overlays, which is
// what a restore onto other overlays is (web/app/snapshots.ts `planRestore`). DOM-free but for `fetch`.
import { fetchChunked } from '../chunked.ts';
import { importDefinition, parseDefinition, type Definition } from './definitions.ts';
import type { MachineRecord } from './shape.ts';
import { importSnapshot } from './snapshots.ts';
import type { SnapshotRecord, Store } from './store.ts';

/** A definition's file fetched and parsed, its disks' relative URLs resolved against the file's own. */
export async function fetchDefinition(url: string): Promise<Definition> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- no location in Node's tests
  const abs = new URL(url, globalThis.location?.href).href;
  const r = await fetch(abs);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return resolveUrls(parseDefinition(await r.text()), abs);
}

/** `def` with its URL disks' relative URLs made absolute against `base` (where the definition was fetched from). */
export const resolveUrls = (def: Definition, base: string): Definition => ({
  ...def,
  disks: def.disks.map((d) => (d.url ? { ...d, url: new URL(d.url, base).href } : d)),
});

/**
 * Makes machine `def` in this browser with `snapshot` (a snapshot file of a machine of the same shape: a template) as
 * its first kept snapshot, restored at its first start. Returns both records.
 */
export async function machineFromTemplate(
  store: Store,
  def: Definition,
  snapshot: File,
): Promise<{ machine: MachineRecord; snapshot: SnapshotRecord }> {
  const { machine } = await importDefinition(store, def);
  const kept = await importSnapshot(store, machine.id, snapshot);
  const m = { ...machine, restoreFirst: kept.id };
  await store.put('machines', m);
  return { machine: m, snapshot: kept };
}

/** `machineFromTemplate` from a definition's URL and its snapshot's (a chunked file's manifest, fetched whole). */
export async function machineFromUrls(
  store: Store,
  definition: string,
  snapshot: string,
  progress?: (done: number, total: number) => void,
) {
  const def = await fetchDefinition(definition);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- no location in Node's tests
  const from = new URL(definition, globalThis.location?.href);
  const { blob } = await fetchChunked(new URL(snapshot, from).href, { progress });
  return machineFromTemplate(store, def, new File([blob], `${def.machine.name}.waarm64snap`));
}
