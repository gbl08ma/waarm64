// A store of demos (docs/decisions.md "Demos"; docs/machines.md §6.2): one JSON file (`waarm64-store`) holding its
// demos' definitions inline (each a whole `waarm64-machine` definition with a `demo`), whose relative URLs (the disks',
// the snapshot's, the thumbnail's) resolve against the store's own URL, so a site moves whole. A single definition's
// URL is taken where a store's is: a store of that one demo. Each demo is checked as a definition file is
// (web/app/definitions.ts `checkDefinition`); one this page can't read (a later version, damaged, an id seen before)
// is left out and said (`skipped`), so a store with a newer demo still shows the others. A demo is known by its store's
// URL and its id (`DemoRef`, a machine's `fromDemo`). A demo marked `template` is also offered under New machine
// (`templatesOf`; web/app/NewMachine.svelte). DOM-free but for `fetch`.
import { MsgError } from '../msg.ts';
import { checkDefinition, DEFINITION_TYPE, resolveUrls, type Definition, type Demo } from './definitions.ts';
import type { MachineRecord } from './shape.ts';
import type { Store } from './store.ts';

export const STORE_TYPE = 'waarm64-store';
export const STORE_VERSION = 1;
/** The project's store (disks.waarm64.com, tools/publish-demos.ts writes it). */
export const OUR_STORE = 'https://disks.waarm64.com/store.json';

/** A store's file as it's published. */
export type StoreFile = {
  type: typeof STORE_TYPE;
  version: number;
  /** What the store calls itself (plain text, the store's data); absent: the page says whose it is by its URL. */
  name?: string;
  demos: Definition[];
};

/** A demo by its store's URL (absolute: the store's, or the single definition's) and its id. */
export type DemoRef = { store: string; id: string };
/** A definition that is a demo's. */
export type DemoDefinition = Definition & { demo: Demo };
/** A store's demo: its definition, its URLs absolute. */
export type StoreDemo = { store: string; def: DemoDefinition };
/** A demo the store has that this page leaves out, and why (`id` where it has one). */
export type Skipped = { index: number; id?: string; error: MsgError };
export type DemoStore = { url: string; name?: string; demos: StoreDemo[]; skipped: Skipped[] };

type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Why a store couldn't be read (`key`, the cause), under its headline: the store's, or (`demo`) a demo's download's. */
function fail(key: string, params?: Record<string, string | number>, demo = false) {
  const cause = { cause: new MsgError(key, params) };
  return demo
    ? new MsgError('machines:demo-store.demoFailed', undefined, cause)
    : new MsgError('machines:demo-store.failed', undefined, cause);
}

/**
 * The text at `url` (absolute), or a message for the user: unreachable, or the server's status. For a demo's file
 * (`demo`), under the demo's headline, and a 404 as `gone` when given (the words for a demo whose files are gone).
 */
export async function fetchText(
  url: string,
  o: { demo?: boolean; gone?: () => MsgError; signal?: AbortSignal } = {},
): Promise<string> {
  let r: Response;
  try {
    r = await fetch(url, o.signal ? { signal: o.signal } : undefined);
  } catch (e) {
    if (o.signal?.aborted) throw e; // aborted: not the network's failure
    throw fail('machines:demo-store.unreachable', { url }, o.demo);
  }
  if (r.status === 404 && o.gone) throw o.gone();
  if (!r.ok) throw fail('machines:demo-store.status', { url, status: r.status }, o.demo);
  return r.text();
}

/** A demo's definition checked (it is a definition, and it has a `demo`); its URLs made absolute against `base`. */
function demoOf(x: unknown, base: string): DemoDefinition {
  const def = checkDefinition(x);
  if (!def.demo)
    throw new MsgError('machines:demo-store.notDemo', undefined, {
      cause: new MsgError('machines:demo-store.notDemo.cause', { name: def.machine.name }),
    });
  return resolveUrls(def, base) as DemoDefinition;
}

/**
 * Parses a store's file (or a single demo definition's) fetched from `url` (absolute); throws a message for the user
 * when it is neither. Demos it can't read are in `skipped`.
 */
export function parseStore(text: string, url: string): DemoStore {
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch {
    throw fail('machines:demo-store.notJson', { url });
  }
  if (isRecord(x) && x.type === DEFINITION_TYPE)
    return { url, demos: [{ store: url, def: demoOf(x, url) }], skipped: [] };
  const file = storeFile(x, url);
  return { url, ...(file.name === undefined ? {} : { name: file.name }), ...demosOf(file.demos, url) };
}

/** `x` checked as a store's file (its type, version, name and list; not its demos yet). */
function storeFile(x: unknown, url: string): { name?: string; demos: unknown[] } {
  if (!isRecord(x) || x.type !== STORE_TYPE) throw fail('machines:demo-store.notStore', { url });
  if (x.version !== STORE_VERSION)
    throw fail('machines:demo-store.version', { version: String(x.version), reads: STORE_VERSION });
  if (!Array.isArray(x.demos) || x.demos.length > 1000) throw fail('machines:demo-store.damaged', { field: 'demos' });
  if (x.name !== undefined && !(typeof x.name === 'string' && x.name.length <= 200))
    throw fail('machines:demo-store.damaged', { field: 'name' });
  return { name: x.name, demos: x.demos };
}

/** A store's demos, each checked: those this page can't read (or whose id came before) skipped, with why. */
function demosOf(list: unknown[], url: string): { demos: StoreDemo[]; skipped: Skipped[] } {
  const demos: StoreDemo[] = [];
  const skipped: Skipped[] = [];
  const seen = new Set<string>();
  for (const [index, d] of list.entries()) {
    const id = isRecord(d) && isRecord(d.demo) && typeof d.demo.id === 'string' ? d.demo.id : undefined;
    try {
      const def = demoOf(d, url);
      if (seen.has(def.demo.id))
        throw new MsgError('machines:demo-store.duplicate', undefined, {
          cause: new MsgError('machines:demo-store.duplicate.cause', { id: def.demo.id }),
        });
      seen.add(def.demo.id);
      demos.push({ store: url, def });
    } catch (e) {
      if (!(e instanceof MsgError)) throw e;
      skipped.push({ index, ...(id === undefined ? {} : { id }), error: e });
    }
  }
  return { demos, skipped };
}

/** The store (or single demo definition) at `url`, relative to the page's address. */
export async function fetchStore(url: string = OUR_STORE): Promise<DemoStore> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- no location in Node's tests
  const abs = new URL(url, globalThis.location?.href).href;
  return parseStore(await fetchText(abs), abs);
}

/** Store `s`'s demo `id`, if it has it. */
export const findDemo = (s: DemoStore, id: string) => s.demos.find((d) => d.def.demo.id === id);

/** Store `s`'s demos offered as templates under New machine (`demo.template`), in the store's order. */
export const templatesOf = (s: DemoStore) => s.demos.filter((d) => d.def.demo.template === true);

/**
 * Whether a run's clipboard sharing starts paused (docs/frontend.md "Clipboard"): a machine made from a demo (its
 * record's `fromDemo`), so that a demo neither reads the clipboard nor makes Chromium ask for its permission before the
 * user turns sharing on in the toolbar's menu. Every run of it starts so (the user's resume isn't remembered); a copy
 * of it has no `fromDemo`, so it shares from the start, as other machines do.
 */
export const startsPaused = (m: Pick<MachineRecord, 'fromDemo'> | undefined) => !!m?.fromDemo;

/** Whether machine `m` was made from demo `ref`. */
export const madeFrom = (m: MachineRecord, ref: DemoRef) => m.fromDemo?.store === ref.store && m.fromDemo.id === ref.id;

/**
 * This browser's machines made from demo `d` (`mine`: "started before"), and those made from a version it replaces
 * (`older`), the most recently used first.
 */
export async function demoMachines(
  store: Store,
  d: StoreDemo,
): Promise<{ mine: MachineRecord[]; older: MachineRecord[] }> {
  return machinesOf(await store.all('machines'), d);
}

/** `demoMachines` over machines `list` (the records as the page has them). */
export function machinesOf(
  list: readonly MachineRecord[],
  d: StoreDemo,
): { mine: MachineRecord[]; older: MachineRecord[] } {
  const all = [...list].sort((a, b) => b.modified - a.modified);
  const id = d.def.demo.id;
  const replaced = new Set(d.def.demo.replaces ?? []);
  return {
    mine: all.filter((m) => madeFrom(m, { store: d.store, id })),
    older: all.filter((m) => m.fromDemo?.store === d.store && replaced.has(m.fromDemo.id)),
  };
}
