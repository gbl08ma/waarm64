// The names agent (docs/plans/room-names.md "The names agent"): the page's side of owning names in a room. It keeps the
// owners' secret and the titles (the only place a name is kept in words), makes their entries (a `ref` block from two
// explorers, proof of work, a signature, stamps at the three calendars), collects finished anchors with the headers
// they need, renews when due, makes again an entry whose anchor came too late, and publishes each title to two of the
// room's servers through a publisher (a names client alone: no machine, no key of the node's). A server that shows a
// better chain of another key's makes the title lost; another branch of the title's own chain is taken as its own.
// The module does the work (web/names-ops.ts: `ts_names_*` in the names worker, web/names-worker.ts); this decides.
//
// **The services are compiled in**: the calendars and explorers below, and no stored value, link or option names
// another (a pending anchor names its calendar by index, never by URL; a receipt's own URI is never fetched). The
// page tests route these URLs to the pretend ones (tests/net/ots-calendar.ts), as Node's tests do through `fetch`.
//
// N5's API: `NamesAgent.register`, `setZone`, `release`, `titles` (each title's state and dates), `pass`; the
// connection's export (`exportNames`, `importNames`, carried by web/app/connections.ts with the node key).
import { NamesError, type IdsAnswer, type NamesBackend, type PutAnswer } from './names-ops.ts';
import type { FromNames, ToNames } from './names-worker.ts';
import { openIdb, roomOf } from './room.ts';

export { roomOf };
import type { NamesTitle, NamesOp } from './ts-client.ts';

/** The calendars, in the module's order (net/ts/src/room/names/anchor.rs `Calendar`: a pending anchor's index). */
export const CALENDARS = [
  'https://alice.btc.calendar.opentimestamps.org',
  'https://bob.btc.calendar.opentimestamps.org',
  'https://finney.calendar.eternitywall.com',
] as const;
/** The explorers (Esplora's API): a `ref` block taken 6 deep where both agree, and an anchor's block's header and the six after it. */
export const EXPLORERS = ['https://blockstream.info/api', 'https://mempool.space/api'] as const;
/** Every service the agent talks to: nothing else is ever fetched (`get`). */
export const SERVICES: readonly string[] = [...CALENDARS, ...EXPLORERS];

/** How often titles are looked after while the page is open (and at every load). */
export const PASS_MS = 60 * 60 * 1000;
/** The first wait before asking again (a pending proof, an entry to make again), doubling to PASS_MS. */
export const RETRY_MS = 5 * 60 * 1000;
/** A zone's slots, narrow and wide (net/ts room/names/zone.rs): a name with more points than the first is sealed in the
 * second, and has at most that many (web/app/names-view.ts `MAX_POINTS`). */
const ZONE_NARROW = 4;
/** An entry unanchored past its window is kept and asked for this long more (seconds). */
const STALE_KEEP_S = 7 * 24 * 60 * 60;
/** A fetch's longest wait. */
const FETCH_MS = 15_000;
/** Proof of work tries a call (production: ~0.5 ms each in a tab), so the worker answers between slices. */
const MINE_SLICE = 256;
/** A server takes a new zone for a name at most this often (net/ts room/names/store.rs `ZONE_EVERY`), and a minute. */
const ZONE_AGAIN_MS = 11 * 60 * 1000;
/** What the dialog says of a claim's wait for its anchor (room-names.md "How long an anchor takes"). */
export const PUBLIC_IN_MS = 2 * 60 * 60 * 1000;

/** Where a name points: the name itself (`label` null) or a label under it, at a node key (64 hex digits). */
export type ZonePoint = { label: string | null; key: string };

/** A room connection, as the agent knows it: its key's entry and the room's link. */
export type NamesConn = { identityKey: string; link: string };

/** A title as kept (IndexedDB `waarm64-room`, store `titles`, under [identityKey, room hash, name]). */
export type TitleRecord = {
  identityKey: string;
  /** The room's ID (a private room's is a secret, as its link in the connection is) and link (the publisher's). */
  room: string;
  link: string;
  name: string;
  /** Every entry of the title with its anchor or pending one, and the zone (net/ts room/names/wire.rs `Item`, hex);
   * empty before the first entry is made. */
  item: string;
  /** Each unanchored entry's pending anchors (hex, signed), one per calendar that gave a receipt. */
  stamps: Record<string, string[]>;
  /** When an entry's proof is asked for again. */
  collect: Record<string, { next: number; tries: number }>;
  /** When an entry may be made again (one that couldn't be stamped, or came too late). */
  remake?: { next: number; tries: number };
  points: ZonePoint[];
  /** A zone's `seq` (64 bits) is `n << 32 | branch`: `n` counts up past every `seq` the title has seen, `branch` is
   * this copy's, 32 random bits drawn when the title was registered or taken in from an export (each paste draws its
   * own), so two copies of a title, however made, share one with a chance of 2^-32 a pair. */
  zone: { n: number; branch: number };
  /** The owners' secret of this title, when it isn't its connection's: one taken in from an export pasted into a
   * connection that had a secret of its own already (review 2: renewals signed with the connection's would break the
   * chain). */
  secret?: string;
  /** A better chain of another key's owns the name (its owner key): renewal stops. */
  lost?: { at: number; by: string };
  /** Let go: a release was made. */
  released?: boolean;
  /** A server didn't take the zone put (within its 10 minutes of the last, or behind the room's): put again then (ms). */
  putAgain?: number;
  /** The item last published and taken (or shown as the title's own), and when. */
  published?: string;
  publishedAt?: number;
  /** When the first entry was stamped (ms). */
  stampedAt?: number;
  made: number;
};

/** The dialog's check of a name as typed (`NamesAgent.check`): `until` in Unix seconds. */
export type NameCheck = { state: 'invalid' | 'yours' | 'free' | 'unknown' } | { state: 'taken'; until: number };

/** What a title is now, for the page (N5's dialog and the adapter's states). */
export type TitleState = 'preparing' | 'reserved' | 'active' | 'grace' | 'lapsed' | 'released' | 'lost';

export type TitleView = {
  identityKey: string;
  room: string;
  /** The room's link (the connection's when the title was registered): which connection's adapter shows it. */
  link: string;
  name: string;
  state: TitleState;
  /** Unix seconds: the chain's first entry's time; until when it resolves; when its cover ends; when renewal is due. */
  claimedAt?: number;
  keptUntil?: number;
  lapsesAt?: number;
  renewAt?: number;
  /** A reserved claim: about when it becomes public (ms). */
  publicAbout?: number;
  /** The key of the chain that owns the name instead (lost). */
  lostTo?: string;
  points: ZonePoint[];
  publishedAt?: number;
};

type Chain = { ids: string[]; owner: string; seniority: number; resolveEnd: number; coverEnd: number; released: boolean };
type EntryStatus = { id: string; kind: 'claim' | 'renew' | 'release'; prev: string; owner: string; time: number | null; refTime: number; windowEnd: number; stale: boolean; pending: boolean };
/** `zone.seq` in decimal: 64 bits, past what a number holds. */
export type TitleStatus = { id: string; entries: EntryStatus[]; owner: Chain | null; best: Chain | null; zone: { seq: string; owner: string } | null; term: number; grace: number };
type Judged = { verdict: 'ours' | 'branch' | 'lost' | 'none'; item: string; by?: string; pending: boolean };

// ---- Storage ----

/** Where the agent keeps the owners' secret and the titles. */
export type NamesStore = {
  /** The owners' secret of connection `identityKey` (64 hex digits), if made. */
  secret(identityKey: string): Promise<string | undefined>;
  /** Keeps `secret` unless one is there; the one kept. */
  addSecret(identityKey: string, secret: string): Promise<string>;
  titles(identityKey?: string): Promise<TitleRecord[]>;
  get(identityKey: string, room: string, name: string): Promise<TitleRecord | undefined>;
  put(t: TitleRecord): Promise<void>;
  delete(identityKey: string, room: string, name: string): Promise<void>;
  /** Connection `identityKey`'s secret and every title of it gone (its connection deleted, after saying so). */
  forget(identityKey: string): Promise<void>;
};

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => Uint8Array.from({ length: s.length >> 1 }, (_, i) => parseInt(s.slice(2 * i, 2 * i + 2), 16));

/** A room's ID as a key: a hash (the ID itself is a private room's secret, and Web Locks' names are listed). */
async function roomHash(room: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`waarm64 room titles\n${room}`));
  return hex(new Uint8Array(h).subarray(0, 16));
}

/** In memory: the tests'. */
export function memoryNamesStore(): NamesStore {
  const secrets = new Map<string, string>();
  const titles = new Map<string, TitleRecord>();
  const k = (i: string, r: string, n: string) => JSON.stringify([i, r, n]);
  return {
    secret: (i) => Promise.resolve(secrets.get(i)),
    addSecret: (i, s) => {
      if (!secrets.has(i)) secrets.set(i, s);
      return Promise.resolve(secrets.get(i)!);
    },
    titles: (i) => Promise.resolve([...titles.values()].filter((t) => i === undefined || t.identityKey === i).map((t) => structuredClone(t))),
    get: (i, r, n) => Promise.resolve(structuredClone(titles.get(k(i, r, n)))),
    put: (t) => { titles.set(k(t.identityKey, t.room, t.name), structuredClone(t)); return Promise.resolve(); },
    delete: (i, r, n) => { titles.delete(k(i, r, n)); return Promise.resolve(); },
    forget: (i) => {
      secrets.delete(i);
      for (const [key, t] of titles) if (t.identityKey === i) titles.delete(key);
      return Promise.resolve();
    },
  };
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = (e) => { e.preventDefault(); reject(r.error); };
  });
}

async function tx<T>(stores: string[], mode: IDBTransactionMode, f: (t: IDBTransaction) => Promise<T>): Promise<T> {
  const db = await openIdb();
  try {
    const t = db.transaction(stores, mode);
    const done = new Promise<void>((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = t.onabort = () => reject(t.error); });
    const out = await f(t);
    await done;
    return out;
  } finally {
    db.close();
  }
}

/** The page's: IndexedDB `waarm64-room`, stores `owner` (the secret under the connection's `identityKey`, as `identity`
 * keeps its node key) and `titles` (under [identityKey, room hash, name]). */
export function idbNamesStore(): NamesStore {
  const key = async (t: { identityKey: string; room: string; name: string }) => [t.identityKey, await roomHash(t.room), t.name];
  return {
    secret: (i) => tx(['owner'], 'readonly', (t) => req(t.objectStore('owner').get(i) as IDBRequest<{ secret: string } | undefined>)).then((v) => v?.secret),
    addSecret: (i, s) => tx(['owner'], 'readwrite', async (t) => {
      const o = t.objectStore('owner');
      const have = await req(o.get(i) as IDBRequest<{ secret: string } | undefined>);
      if (have) return have.secret;
      await req(o.add({ secret: s }, i));
      return s;
    }),
    titles: (i) => tx(['titles'], 'readonly', (t) => req(t.objectStore('titles').getAll(i === undefined ? undefined : IDBKeyRange.bound([i], [i, []])) as IDBRequest<TitleRecord[]>)),
    get: async (i, r, n) => {
      const k = await key({ identityKey: i, room: r, name: n });
      return tx(['titles'], 'readonly', (t) => req(t.objectStore('titles').get(k) as IDBRequest<TitleRecord | undefined>));
    },
    put: async (v) => {
      const k = await key(v);
      await tx(['titles'], 'readwrite', (t) => req(t.objectStore('titles').put(v, k)));
    },
    delete: async (i, r, n) => {
      const k = await key({ identityKey: i, room: r, name: n });
      await tx(['titles'], 'readwrite', (t) => req(t.objectStore('titles').delete(k)));
    },
    forget: (i) => tx(['owner', 'titles'], 'readwrite', async (t) => {
      await req(t.objectStore('owner').delete(i));
      await req(t.objectStore('titles').delete(IDBKeyRange.bound([i], [i, []])));
    }),
  };
}

// ---- The worker ----

/** The agent's backend in a worker of its own (the page's): proof of work and publishers off the page's thread. */
export function workerBackend(wasm = new URL('../target/net/ts.wasm', import.meta.url).href): NamesBackend {
  const worker = new Worker(new URL('./names-worker.ts', import.meta.url), { type: 'module' });
  const waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  let n = 0;
  worker.onmessage = (e: MessageEvent<FromNames>) => {
    const m = e.data;
    const w = waiting.get(m.n);
    waiting.delete(m.n);
    if (m.type === 'answer') w?.resolve(m.value);
    else w?.reject(m.code ? new NamesError(m.code) : new Error(m.message));
  };
  const post = (m: ToNames) => worker.postMessage(m);
  post({ type: 'start', wasm });
  type Ask = { type: 'op'; op: NamesOp; input: object } | { type: 'publish'; link: string; items: { id: string; item: string }[] } | { type: 'ids'; link: string; first: number };
  const ask = <T>(m: Ask) => new Promise<T>((resolve, reject) => {
    const k = ++n;
    waiting.set(k, { resolve: (v) => resolve(v as T), reject });
    post({ ...m, n: k } as ToNames);
  });
  return {
    op: <T>(op: NamesOp, input: object) => ask<T>({ type: 'op', op, input }),
    publish: (link, items) => ask<Record<string, PutAnswer[]>>({ type: 'publish', link, items }).then((r) => new Map(Object.entries(r))),
    ids: (link, first) => ask<IdsAnswer>({ type: 'ids', link, first }),
    close: () => worker.terminate(),
  };
}

// ---- Fetching: the compiled services only ----

/** A GET or POST to one of SERVICES; anything else throws (no stored value or link can name another service). */
async function get(url: string, init?: RequestInit): Promise<Response> {
  if (!SERVICES.some((s) => url.startsWith(`${s}/`))) throw new Error(`names: not a compiled service: ${url}`);
  return fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_MS) });
}

async function text(url: string): Promise<string> {
  const r = await get(url);
  if (!r.ok) throw new Error(`names: ${url}: ${r.status}`);
  return (await r.text()).trim();
}

// ---- The agent ----

export type AgentOptions = {
  store: NamesStore;
  backend: NamesBackend;
  /** The first wait before asking again (default RETRY_MS; the tests' is 0). */
  retryMs?: number;
  log?: (s: string) => void;
};

const nowS = () => Math.floor(Date.now() / 1000);

/** Changes to a connection's titles, for its room's worker (web/room-worker.ts) in any tab. */
export const NAMES_CHANNEL = 'waarm64-names';

export class NamesAgent {
  private readonly store: NamesStore;
  private readonly b: NamesBackend;
  private readonly retryMs: number;
  private readonly log: (s: string) => void;
  /** Titles published by this agent since the page loaded (each is put once a visit, at least). */
  private readonly session = new Set<string>();
  /** Titles whose first entry is being made here (proof of work). */
  private readonly making = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private channel: BroadcastChannel | undefined;
  private passing: Promise<void> | undefined;
  private started: Promise<void> | undefined;

  constructor(o: AgentOptions) {
    this.store = o.store;
    this.b = o.backend;
    this.retryMs = o.retryMs ?? RETRY_MS;
    this.log = o.log ?? ((s) => console.log('names:', s));
    try {
      this.channel = new BroadcastChannel(NAMES_CHANNEL);
      // Node's (the tests'): it mustn't keep the process alive.
      (this.channel as { unref?: () => void }).unref?.();
    } catch { /* none: no room worker to tell */ }
  }

  // ---- N5's API ----

  /**
   * Registers `name` in connection `c`'s room, pointing at `points`: the owners' secret made at the first registration,
   * persistent storage asked for (a title is the only copy of ownership), the claim made, stamped and kept. It stays
   * private until anchored (the next passes collect it and publish it). Refused: a name the rules refuse
   * (`NamesError` `Name`), or one this connection holds already.
   */
  async register(c: NamesConn, name: string, points: ZonePoint[]): Promise<TitleView> {
    const room = roomOf(c.link);
    const secret = await this.store.addSecret(c.identityKey, hex(crypto.getRandomValues(new Uint8Array(32))));
    await this.b.op('key', { room, secret, name }); // the rules: `Name` if refused
    void (globalThis.navigator as Navigator | undefined)?.storage?.persist?.().catch(() => false);
    const have = await this.store.get(c.identityKey, room, name);
    if (have && !have.lost && !have.released && (await this.view(have)).state !== 'lapsed') throw new NamesError('Held');
    const t: TitleRecord = {
      identityKey: c.identityKey, room, link: c.link, name, item: '', stamps: {}, collect: {}, points,
      zone: { n: 0, branch: newBranch() }, made: Date.now(),
    };
    await this.store.put(t);
    const k = titleKey(t);
    this.making.add(k);
    try {
      await this.locked(t, true, async () => {
        const fresh = (await this.store.get(t.identityKey, room, name)) ?? t;
        await this.makeEntry(fresh, 'claim');
        await this.save(fresh);
      });
    } finally {
      this.making.delete(k);
    }
    return this.view((await this.store.get(t.identityKey, room, name)) ?? t);
  }

  /** Points `name` at `points`: a new zone (its `seq` never one another copy of the title uses), published if public. */
  async setZone(c: NamesConn, name: string, points: ZonePoint[]): Promise<TitleView> {
    const room = roomOf(c.link);
    await this.relink(c);
    const t = await this.locked({ identityKey: c.identityKey, room, name }, true, async () => {
      const t = await this.mustGet(c.identityKey, room, name);
      t.points = points;
      if (t.item) await this.seal(t);
      await this.save(t);
      return t;
    });
    if (t) await this.publish(t);
    return this.view((await this.store.get(c.identityKey, room, name)) ?? t!);
  }

  /**
   * Connection `c`'s titles in its room publish through its link as it is now (`c.link`): a connection rejoined with
   * other relays keeps its names, and they don't go on through relays that went away (review 2).
   */
  async relink(c: NamesConn): Promise<void> {
    const room = roomOf(c.link);
    for (const t0 of await this.store.titles(c.identityKey)) {
      if (t0.room !== room || t0.link === c.link) continue;
      await this.locked(t0, true, async () => {
        const t = await this.store.get(t0.identityKey, t0.room, t0.name);
        if (!t || t.link === c.link) return;
        t.link = c.link;
        await this.save(t);
      });
    }
  }

  /** Lets `name` go: a release made on its chain and stamped; published once anchored, like any entry. */
  async release(c: NamesConn, name: string): Promise<TitleView> {
    const room = roomOf(c.link);
    await this.relink(c);
    await this.locked({ identityKey: c.identityKey, room, name }, true, async () => {
      const t = await this.mustGet(c.identityKey, room, name);
      // Renewals waiting for their anchors go: one collected later would be a branch whose cover outlasts the
      // release's, and the name would stay (review 2).
      const waiting = (await this.status(t))?.entries.filter((e) => e.kind === 'renew' && e.time === null).map((e) => e.id) ?? [];
      if (waiting.length) await this.dropEntries(t, waiting);
      const st = await this.status(t);
      if (st?.owner && !t.lost && !st.owner.released) await this.makeEntry(t, 'release', st.owner.ids.at(-1));
      t.released = true;
      await this.save(t);
    });
    const t = await this.mustGet(c.identityKey, room, name);
    await this.publish(t);
    return this.view(t);
  }

  /**
   * The dialog's check of `name` in connection `c`'s room, as typed: not a valid name (the rules), this connection's
   * own already, or what the room's servers say through a checker: free, taken (until about when, Unix seconds), or
   * nobody can say. **The servers are asked for every id under the name's id's first byte, never the id** (a server
   * that learnt which id is about to be claimed could guess the name and stamp first): the id is looked for here.
   */
  async check(c: NamesConn, name: string): Promise<NameCheck> {
    const room = roomOf(c.link);
    let id: string;
    try {
      // The id doesn't depend on the secret: any will do, so the check makes none.
      id = (await this.b.op<{ id: string }>('key', { room, secret: '00'.repeat(32), name })).id;
    } catch (err) {
      if (err instanceof NamesError && err.code === 'Name') return { state: 'invalid' };
      throw err;
    }
    const have = await this.store.get(c.identityKey, room, name);
    if (have && !have.lost && !have.released && !['lapsed', 'released', 'lost'].includes((await this.view(have)).state)) return { state: 'yours' };
    const a = await this.b.ids(c.link, parseInt(id.slice(0, 2), 16));
    if (a.result !== 'ids') return { state: 'unknown' };
    const until = a.ids.find(([i]) => i === id)?.[1] ?? 0;
    return until > nowS() ? { state: 'taken', until } : { state: 'free' };
  }

  /** The names connection `identityKey` holds now (not let go, lost or lapsed), by name: what deleting it would lose. */
  async held(identityKey: string): Promise<string[]> {
    const live = (await this.titles(identityKey)).filter((v) => !['released', 'lost', 'lapsed'].includes(v.state));
    return [...new Set(live.map((v) => v.name))].sort();
  }

  /** Connection `identityKey`'s owners' secret and titles forgotten (its connection deleted, after the page said so). */
  async forget(identityKey: string): Promise<void> {
    await this.store.forget(identityKey);
    this.channel?.postMessage({ identityKey });
  }

  /** The titles (of one connection, or all), with their states and dates. */
  async titles(identityKey?: string): Promise<TitleView[]> {
    return Promise.all((await this.store.titles(identityKey)).map((t) => this.view(t)));
  }

  /**
   * Looks after every title (or one connection's): each under its Web Lock (another tab doing it: skipped), finished
   * anchors collected with their headers, an entry that can no longer count made again, a renewal made when due; then
   * each published (under no lock) when public and changed since, or not yet this visit.
   */
  pass(identityKey?: string): Promise<void> {
    const run = async () => {
      for (const t0 of await this.store.titles(identityKey)) {
        try {
          await this.locked(t0, false, async () => {
            const t = (await this.store.get(t0.identityKey, t0.room, t0.name)) ?? t0;
            if (await this.work(t)) await this.save(t);
          });
          const t = await this.store.get(t0.identityKey, t0.room, t0.name);
          if (t) await this.publish(t);
        } catch (err) {
          this.log(`${t0.name}: ${String(err)}`);
        }
      }
    };
    // One pass at a time in a page.
    const p = (this.passing ?? Promise.resolve()).then(run, run);
    this.passing = p.finally(() => { if (this.passing === p) this.passing = undefined; });
    return p;
  }

  /** A pass now (the page's load) and hourly, sooner when a title waits for less; once a page (the first pass's end). */
  start(): Promise<void> {
    if (this.started) return this.started;
    let first = () => {};
    this.started = new Promise<void>((resolve) => (first = resolve));
    const next = async () => {
      await this.pass().finally(first);
      let wait = PASS_MS;
      for (const t of await this.store.titles()) {
        for (const c of Object.values(t.collect)) wait = Math.min(wait, c.next - Date.now());
        if (t.remake) wait = Math.min(wait, t.remake.next - Date.now());
        if (t.putAgain) wait = Math.min(wait, t.putAgain - Date.now());
      }
      this.timer = setTimeout(() => void next(), Math.max(wait, 30_000));
    };
    void next();
    return this.started;
  }

  stop() {
    this.started = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.channel?.close();
    this.b.close();
  }

  // ---- A connection's export ----

  /** Connection `identityKey`'s owners' secret and titles, for its export (web/app/connections.ts); each copy taken in
   * from it draws a branch of its own (`importNames`), so no two reuse a zone's `seq`. */
  exportNames(identityKey: string): Promise<string | undefined> {
    return exportNames(this.store, identityKey);
  }

  importNames(identityKey: string, bundle: string): Promise<void> {
    return importNames(this.store, identityKey, bundle);
  }

  // ---- Inside ----

  private async mustGet(identityKey: string, room: string, name: string): Promise<TitleRecord> {
    const t = await this.store.get(identityKey, room, name);
    if (!t) throw new NamesError('NoTitle');
    return t;
  }

  private async save(t: TitleRecord) {
    await this.store.put(t);
    this.channel?.postMessage({ identityKey: t.identityKey });
  }

  /** `f` under the title's Web Lock: waiting for it (`wait`), or not at all when another tab has it (undefined). */
  private async locked<T>(t: { identityKey: string; room: string; name: string }, wait: boolean, f: () => Promise<T>): Promise<T | undefined> {
    const name = `waarm64-names:${t.identityKey}:${await roomHash(t.room)}:${t.name}`;
    return navigator.locks.request(name, { ifAvailable: !wait }, async (l) => (l ? f() : undefined));
  }

  private status(t: TitleRecord): Promise<TitleStatus | undefined> {
    return t.item ? this.b.op<TitleStatus>('status', { item: t.item, now: nowS() }) : Promise.resolve(undefined);
  }

  private backoff(prev: { tries: number } | undefined): { next: number; tries: number } {
    const tries = (prev?.tries ?? 0) + 1;
    return { next: Date.now() + Math.min(this.retryMs * 2 ** (tries - 1), PASS_MS), tries };
  }

  /** One title's turn under its lock: collect, drop what can't count, make what is due. Whether it changed. */
  private async work(t: TitleRecord): Promise<boolean> {
    let changed = false;
    let st = await this.status(t);
    // Finished anchors for the entries that wait for one.
    for (const e of st?.entries ?? []) {
      // One past its window may still have an anchor in it (the page wasn't open): asked now, whatever the backoff.
      if (e.time !== null || !t.stamps[e.id]?.length || (!e.stale && (t.collect[e.id]?.next ?? 0) > Date.now())) continue;
      try {
        const item = await this.collect(t, e.id);
        if (item) {
          t.item = item;
          delete t.stamps[e.id];
          delete t.collect[e.id];
          this.log(`${t.name}: an anchor for ${e.kind} ${e.id.slice(0, 8)}`);
        } else t.collect[e.id] = this.backoff(t.collect[e.id]);
      } catch (err) {
        if (!(err instanceof NamesError)) throw err;
        // Its anchor came past REF_WINDOW: it can never count. Made again. (Only that: a calendar's junk, an explorer's
        // odd run or a clock behind is asked again later, and another calendar or explorer may do: review 2.)
        this.log(`${t.name}: ${e.kind} ${e.id.slice(0, 8)} refused for good (${err.code}); made again`);
        await this.dropEntries(t, [e.id]);
        t.remake = this.backoff(t.remake);
      }
      changed = true;
    }
    st = await this.status(t);
    // An entry unanchored past its window may still have an anchor in it, finished while no page was open (a renewal
    // so collected can still link): it is kept and asked for, beside a new one where one is due, and dropped only a
    // week past its window, when the calendars would long have served it (review 2).
    const stale = (st?.entries ?? []).filter((e) => e.stale && nowS() > e.windowEnd + STALE_KEEP_S).map((e) => e.id);
    if (stale.length) {
      this.log(`${t.name}: ${stale.length} entry(s) never anchored in their window; dropped`);
      await this.dropEntries(t, stale);
      st = await this.status(t);
      changed = true;
    }
    if (t.lost || (t.remake && t.remake.next > Date.now())) return changed;
    const live = (e: EntryStatus) => e.time === null && !e.stale;
    if (!st?.best) {
      // No anchored entry yet: a claim, unless one waits for its anchor.
      if (!t.released && !st?.entries.some((e) => live(e) && e.kind === 'claim')) {
        await this.makeEntry(t, 'claim');
        changed = true;
      }
      return changed;
    }
    const o = st.owner;
    // Let go, but the release wasn't stamped (or never came): made again.
    if (t.released && o && !o.released && !st.entries.some((e) => e.kind === 'release' && !e.stale)) {
      await this.makeEntry(t, 'release', o.ids.at(-1));
      return true;
    }
    if (!o || t.released || o.released) return changed;
    // The title's own key, from its secret: a chain of another key's (a secret that doesn't sign this title) isn't
    // renewed with it.
    const secret = t.secret ?? (await this.store.secret(t.identityKey));
    const ownKey = secret ? (await this.b.op<{ owner: string }>('key', { room: t.room, secret, name: t.name })).owner : undefined;
    const last = o.ids.at(-1)!;
    const lastTime = st.entries.find((e) => e.id === last)?.time ?? 0;
    const due = nowS() >= lastTime + st.term / 2;
    if (o.owner === ownKey && due && !st.entries.some((e) => live(e) && e.prev === last)) {
      await this.makeEntry(t, 'renew', last);
      changed = true;
    }
    return changed;
  }

  private async dropEntries(t: TitleRecord, ids: string[]) {
    t.item = (await this.b.op<{ item: string }>('drop', { item: t.item, ids })).item;
    for (const id of ids) {
      delete t.stamps[id];
      delete t.collect[id];
    }
  }

  /** A `ref` block 6 deep where both explorers agree: its header and hash (the explorers' byte order). */
  private async ref(): Promise<{ header: string; hash: string }> {
    const tips = await Promise.all(EXPLORERS.map((e) => text(`${e}/blocks/tip/height`)));
    const h = Math.min(...tips.map(Number)) - 6;
    if (!Number.isSafeInteger(h) || h < 0) throw new Error('names: no block 6 deep');
    const hashes = await Promise.all(EXPLORERS.map((e) => text(`${e}/block-height/${h}`)));
    if (hashes.some((x) => x !== hashes[0]) || !/^[0-9a-f]{64}$/.test(hashes[0])) throw new Error('names: the explorers disagree');
    return { header: await text(`${EXPLORERS[0]}/block/${hashes[0]}/header`), hash: hashes[0] };
  }

  /**
   * An entry of `kind` (after `prev`) made on title `t`: `ref`, proof of work in slices, the signature, checked into
   * the title, stamped at the calendars (each receipt a pending anchor the owner key signs). With no receipt it can never
   * be anchored: dropped, made again later. A claim carries the title's zone.
   */
  private async makeEntry(t: TitleRecord, kind: 'claim' | 'renew' | 'release', prev?: string) {
    const secret = t.secret ?? (await this.store.secret(t.identityKey));
    if (!secret) throw new NamesError('NoSecret');
    const base = { room: t.room, secret, name: t.name };
    let r: { header: string; hash: string };
    try {
      r = await this.ref();
    } catch (err) {
      t.remake = this.backoff(t.remake);
      throw err;
    }
    let { entry } = await this.b.op<{ entry: string }>('make', { ...base, kind, prev, ref: r.header, hash: r.hash });
    for (;;) {
      const m = await this.b.op<{ entry: string; done: boolean }>('mine', { entry, tries: MINE_SLICE });
      entry = m.entry;
      if (m.done) break;
    }
    ({ entry } = await this.b.op<{ entry: string }>('sign', { ...base, entry }));
    const added = await this.b.op<{ item: string; id: string }>('add', { room: t.room, item: t.item || undefined, entry, ref: r.header, now: nowS() });
    let item = added.item;
    const id = added.id;
    if (kind === 'claim') item = await this.sealed(t, item);
    const receipts = await Promise.all(CALENDARS.map(async (c, calendar) => {
      try {
        const res = await get(`${c}/digest`, { method: 'POST', body: unhex(id) });
        return res.ok ? { calendar, receipt: hex(new Uint8Array(await res.arrayBuffer())) } : undefined;
      } catch {
        return undefined;
      }
    }));
    const stamps: string[] = [];
    for (const x of receipts) {
      if (!x) continue;
      try {
        const p = await this.b.op<{ item: string; pending: string }>('pending', { ...base, item, id, ...x, now: nowS() });
        item = p.item;
        stamps.push(p.pending);
      } catch (err) {
        this.log(`${t.name}: a receipt refused: ${String(err)}`);
      }
    }
    if (!stamps.length) {
      this.log(`${t.name}: no calendar stamped the ${kind}; made again later`);
      t.remake = this.backoff(t.remake);
      return;
    }
    t.item = item;
    t.stamps[id] = stamps;
    t.collect[id] = { next: Date.now() + this.retryMs, tries: 0 };
    // From the claim's own stamp: a claim made again counts its wait again (review 2).
    if (kind === 'claim' || t.stampedAt === undefined) t.stampedAt = Date.now();
    delete t.remake;
    this.log(`${t.name}: ${kind} ${id.slice(0, 8)} made, stamped at ${stamps.length} calendar(s)`);
  }

  /** The next zone `seq` for title `t` (decimal): past every one it has seen, with its own branch in the low half. */
  private nextSeq(t: TitleRecord, seen: string | undefined): string {
    t.zone.n = Math.max(t.zone.n, Number(BigInt(seen ?? 0) >> 32n)) + 1;
    return ((BigInt(t.zone.n) << 32n) | BigInt(t.zone.branch >>> 0)).toString();
  }

  /** Item `item` of title `t` with a new zone sealed for `t.points`, its `seq` past the item's and `seen`. */
  private async sealed(t: TitleRecord, item: string, seen?: string): Promise<string> {
    const secret = t.secret ?? (await this.store.secret(t.identityKey));
    const st = await this.b.op<TitleStatus>('status', { item, now: nowS() });
    const held = st.zone?.seq;
    const seq = this.nextSeq(t, seen !== undefined && (held === undefined || BigInt(seen) > BigInt(held)) ? seen : held);
    // Past four points, sixteen slots (review 2: a fifth failed with the module's bare `Zone`).
    const wide = t.points.length > ZONE_NARROW;
    return (await this.b.op<{ item: string }>('zone', { room: t.room, secret, name: t.name, seq, points: t.points, item, wide })).item;
  }

  private async seal(t: TitleRecord) {
    t.item = await this.sealed(t, t.item);
  }

  /** A finished anchor for entry `id` of title `t`, with its block's header and the six after it: the title's item with
   * it, or undefined while none is finished (a pending proof is a 404 without CORS: a failed fetch). A `NamesError`
   * when the anchor can never count (its time past the window). */
  private async collect(t: TitleRecord, id: string): Promise<string | undefined> {
    let refused: NamesError | undefined;
    for (const p of t.stamps[id] ?? []) {
      let f: { anchors: { anchor: string; height: number; root: string }[] };
      try {
        const c = await this.b.op<{ commitment: string; calendar: number }>('commitment', { pending: p, id });
        const r = await get(`${CALENDARS[c.calendar]}/timestamp/${c.commitment}`);
        if (!r.ok) continue;
        const proof = new Uint8Array(await r.arrayBuffer());
        f = await this.b.op('finish', { pending: p, id, proof: hex(proof) });
      } catch (err) {
        // Pending, the calendar unreachable, or its answer not a proof (a proxy's page, say): the next calendar, and
        // this one later.
        if (err instanceof NamesError) this.log(`${t.name}: a calendar's answer refused (${err.code})`);
        continue;
      }
      for (const a of f.anchors) {
        // Each explorer's run in turn: one may serve a run the module refuses, the other a good one.
        for (const headers of await this.runs(a.height, a.root)) {
          try {
            return (await this.b.op<{ item: string }>('anchor', { item: t.item, id, anchor: a.anchor, headers, now: nowS() })).item;
          } catch (err) {
            if (!(err instanceof NamesError)) throw err;
            this.log(`${t.name}: an anchor refused (${err.code})`);
            if (err.code === 'AnchorWindow') refused = err;
          }
        }
      }
    }
    if (refused) throw refused;
    return undefined;
  }

  /** Block `height`'s header (its Merkle root `root`, as a header carries it) and the six after it, from each explorer
   * that has them (none until six follow it). */
  private async runs(height: number, root: string): Promise<string[][]> {
    const out: string[][] = [];
    for (const e of EXPLORERS) {
      const r = await this.run(e, height, root);
      if (r) out.push(r);
    }
    return out;
  }

  /** Block `height`'s header and the six after it from explorer `e`; undefined until six follow it, or when `e` has
   * another block there (a reorganisation) or can't be reached. */
  private async run(e: string, height: number, root: string): Promise<string[] | undefined> {
    try {
      const hash = await text(`${e}/block-height/${height}`);
      const header = await text(`${e}/block/${hash}/header`);
      // Not that block at this explorer: the other's. (`root` is the anchor's, in header order.)
      if (header.slice(72, 136) !== root) return undefined;
      const out = [header];
      let at = hash;
      for (let k = 0; k < 6; k++) {
        const s = JSON.parse(await text(`${e}/block/${at}/status`)) as { next_best?: string | null };
        if (!s.next_best) return undefined;
        at = s.next_best;
        out.push(await text(`${e}/block/${at}/header`));
      }
      return out;
    } catch {
      return undefined;
    }
  }

  /**
   * Publishes title `t` (under no lock) when its claim is public (anchored) and it changed since it was last taken, or
   * wasn't put this visit or this hour: a `put` to the servers a publisher finds. A server's better chain is judged: the title's
   * own (nothing to do), another branch of it (taken into the title), another key's (the title is lost).
   */
  private async publish(t: TitleRecord): Promise<void> {
    // A lost title is put too, so that it is judged again: its own renewal, collected late, may have revived its chain
    // (review 2).
    if (!t.item) return;
    const st = await this.status(t);
    if (!st?.best) return; // a claim stays private until anchored
    const k = titleKey(t);
    // Unchanged, put this visit and within the hour: not again (the next hour's pass puts it again, so another branch
    // the room settled on, or a reset room, is seen within the hour).
    if (t.published === t.item && this.session.has(k) && Date.now() - (t.publishedAt ?? 0) < PASS_MS - 60_000) return;
    const item = t.item;
    const answers = (await this.b.publish(t.link, [{ id: st.id, item }])).get(st.id) ?? [];
    let shown = false;
    let lost: string | undefined;
    const branches: string[] = [];
    // A server that holds the title's chain but didn't take its zone (review 2): within its 10 minutes of the last
    // (put again after them), or a zone of the room's at or past ours (another copy's: counted past it).
    let zoneAgain = false;
    let roomSeq: bigint | undefined;
    for (const a of answers) {
      if (a.result === 'taken') shown = true;
      if (a.result !== 'better' || !a.item) continue;
      try {
        const j = await this.b.op<Judged>('judge', { room: t.room, item, other: a.item, now: nowS() });
        if (j.verdict === 'ours' || j.verdict === 'branch') {
          const theirs = (await this.b.op<TitleStatus>('status', { item: a.item, now: nowS() })).zone?.seq;
          const ours = st.zone?.seq;
          if (ours !== undefined && theirs !== ours) {
            zoneAgain = true;
            if (theirs !== undefined && BigInt(theirs) >= BigInt(ours)) roomSeq = roomSeq !== undefined && roomSeq > BigInt(theirs) ? roomSeq : BigInt(theirs);
          }
        }
        if (j.verdict === 'ours') shown = true;
        else if (j.verdict === 'branch') branches.push(a.item);
        else if (j.verdict === 'lost') lost = j.by;
      } catch (err) {
        this.log(`${t.name}: a server's answer refused: ${String(err)}`);
      }
    }
    if (zoneAgain) {
      shown = false; // not as put: put again

      await this.locked(t, true, async () => {
        const now = await this.mustGet(t.identityKey, t.room, t.name);
        if (roomSeq !== undefined && now.item === item) {
          now.item = await this.sealed(now, now.item, roomSeq.toString());
          this.log(`${t.name}: the room holds another copy's zone: counted past it`);
        }
        now.putAgain = Date.now() + ZONE_AGAIN_MS;
        await this.save(now);
      });
    }
    if (!shown && !lost && !branches.length) {
      this.log(`${t.name}: not published (${answers.map((a) => a.result).join(', ') || 'no answer'}); next pass`);
      return;
    }
    // Not lost while the title's own chain has lapsed as collected but an entry of it waits for its anchor: collected,
    // it may revive the chain (a renewal made in time and collected late), whose claim may be the elder (review 2). A
    // chain alive and beaten stays beaten: a renewal doesn't change its seniority.
    const waiting = !st.owner && st.entries.some((e) => e.time === null && (t.stamps[e.id]?.length ?? 0) > 0);
    if (lost && waiting) {
      this.log(`${t.name}: another key's chain owns it while an entry of ours waits for its anchor; judged again later`);
      lost = undefined;
      if (!shown && !branches.length) return;
    }
    await this.locked(t, true, async () => {
      const now = await this.mustGet(t.identityKey, t.room, t.name);
      if (lost) {
        if (!now.lost) this.log(`${t.name}: lost to a better chain (${lost.slice(0, 8)})`);
        now.lost = { at: Date.now(), by: lost };
      } else if (now.lost && (shown || branches.length)) {
        delete now.lost;
        this.log(`${t.name}: its own chain owns it again`);
      }
      for (const other of branches) {
        try {
          const j = await this.b.op<Judged>('judge', { room: now.room, item: now.item, other, now: nowS() });
          if (j.verdict === 'branch' || j.verdict === 'ours') now.item = j.item;
          this.log(`${t.name}: another branch of the title owns it in the room: taken`);
        } catch (err) {
          this.log(`${t.name}: ${String(err)}`);
        }
      }
      if (shown && now.item === item) {
        now.published = item;
        now.publishedAt = Date.now();
        delete now.putAgain;
      }
      await this.save(now);
    });
    this.session.add(k);
  }

  private async view(t: TitleRecord): Promise<TitleView> {
    const st = await this.status(t);
    const base = { identityKey: t.identityKey, room: t.room, link: t.link, name: t.name, points: t.points, publishedAt: t.publishedAt };
    if (t.lost) return { ...base, state: 'lost', lostTo: t.lost.by };
    const o = st?.owner;
    const now = nowS();
    if (o) {
      const lastTime = st.entries.find((e) => e.id === o.ids.at(-1))?.time ?? o.seniority;
      const state: TitleState = o.released || t.released ? 'released' : now < o.resolveEnd ? 'active' : 'grace';
      return { ...base, state, claimedAt: o.seniority, keptUntil: o.resolveEnd, lapsesAt: o.coverEnd, renewAt: lastTime + st.term / 2 };
    }
    if (st?.best) return { ...base, state: t.released ? 'released' : 'lapsed', claimedAt: st.best.seniority, keptUntil: st.best.resolveEnd, lapsesAt: st.best.coverEnd };
    const claim = st?.entries.find((e) => e.kind === 'claim' && !e.stale);
    if (claim && !this.making.has(titleKey(t))) return { ...base, state: 'reserved', publicAbout: (t.stampedAt ?? t.made) + PUBLIC_IN_MS };
    return { ...base, state: 'preparing' };
  }
}

const titleKey = (t: { identityKey: string; room: string; name: string }) => JSON.stringify([t.identityKey, t.room, t.name]);

// ---- Export and import (with a room connection's key) ----

/** An export's names. Version 2: zones' 64-bit `seq` (rooms are pre-release: a version 1 bundle is refused). */
type Bundle = { v: 2; secret: string; titles: Omit<TitleRecord, 'identityKey'>[] };

/** A copy's branch of a title's zone `seq`: 32 random bits. */
export const newBranch = () => crypto.getRandomValues(new Uint32Array(1))[0];

function b64url(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s: string): Uint8Array {
  const t = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(t, (c) => c.charCodeAt(0));
}

/** Connection `identityKey`'s owners' secret and titles as text (base64url of JSON), or undefined without a secret.
 * Nothing is written: each copy made from the text draws a branch of its own when it is taken in (`importNames`). */
export async function exportNames(store: NamesStore, identityKey: string): Promise<string | undefined> {
  const secret = await store.secret(identityKey);
  if (!secret) return undefined;
  const titles: Bundle['titles'] = [];
  for (const t of await store.titles(identityKey)) {
    const copy: Partial<TitleRecord> = { ...t };
    delete copy.identityKey;
    titles.push(copy as Bundle['titles'][number]);
  }
  return b64url(new TextEncoder().encode(JSON.stringify({ v: 2, secret, titles } satisfies Bundle)));
}

/** Takes an export's secret and titles as connection `identityKey`'s (a title it holds already: the two merge as a
 * server would, by the module, at the next pass's publish; here the one kept stays). Every title taken in is a copy of
 * its own, so it draws a fresh branch: the same text pasted twice gives two branches, never the exporter's. */
export async function importNames(store: NamesStore, identityKey: string, bundle: string): Promise<void> {
  const b = JSON.parse(new TextDecoder().decode(unb64url(bundle))) as Bundle;
  if (b.v !== 2 || !/^[0-9a-f]{64}$/.test(b.secret)) throw new NamesError('Bundle');
  const kept = await store.addSecret(identityKey, b.secret);
  for (const t of b.titles) {
    if (await store.get(identityKey, t.room, t.name)) continue;
    let branch = newBranch();
    while (branch === t.zone.branch) branch = newBranch();
    // The bundle's secret signs its titles: kept with each where the connection has another (review 2).
    const secret = t.secret ?? (b.secret !== kept ? b.secret : undefined);
    const copy: TitleRecord = { ...t, identityKey, zone: { n: t.zone.n, branch } };
    if (secret) copy.secret = secret;
    else delete copy.secret;
    await store.put(copy);
  }
}

// A room connection's key as it is exported, and an export pasted: web/room.ts (the wizard's, without the agent).
export { parseRoomExport, roomExport } from './room.ts';

// ---- The room's worker: the titles a running room serves ----

/**
 * The titles connection `identityKey` holds in room `room`, as the module's config takes them (`room.names.titles`): the
 * owner key from the secret (by the room's own module `m`) and the item. Lost and empty titles aren't served.
 */
export async function roomTitles(store: NamesStore, ops: (op: NamesOp, input: object) => Record<string, unknown>, identityKey: string, room: string): Promise<NamesTitle[]> {
  const kept = await store.secret(identityKey);
  const out: NamesTitle[] = [];
  for (const t of await store.titles(identityKey)) {
    const secret = t.secret ?? kept;
    if (t.room !== room || t.lost || !t.item || !secret) continue;
    try {
      out.push({ key: ops('key', { room, secret, name: t.name }).key as string, item: t.item });
    } catch { /* a name the rules refuse: not served */ }
  }
  return out;
}

// ---- The page ----


let shared: NamesAgent | undefined;

/** The page's agent (made at first use): the titles in IndexedDB, the module in a worker. */
export function namesAgent(o: { wasm?: string } = {}): NamesAgent {
  shared ??= new NamesAgent({ store: idbNamesStore(), backend: workerBackend(o.wasm) });
  return shared;
}

/** At every page load (web/app/main.ts): the agent starts (a pass now, then hourly, no machine needed) when there are
 * titles to look after; none, no worker. */
export async function startNamesAgent(o: { wasm?: string } = {}): Promise<NamesAgent | undefined> {
  const have = await idbNamesStore().titles().catch(() => []);
  if (!have.length) return undefined;
  const a = namesAgent(o);
  await a.start();
  return a;
}

/** A week: the page says so, on load, when a name is kept for less (web/app/areas/names.svelte.ts). */
export const LAST_WEEK_S = 7 * 24 * 60 * 60;

/** The titles in their last week at `now` (Unix seconds): still resolving or in their grace, kept until less than a week
 * from now; the soonest first. */
export function inLastWeek(views: TitleView[], now: number): TitleView[] {
  return views
    .filter((v) => (v.state === 'active' || v.state === 'grace') && v.keptUntil !== undefined && v.keptUntil - now < LAST_WEEK_S)
    .sort((a, b) => (a.keptUntil ?? 0) - (b.keptUntil ?? 0));
}
