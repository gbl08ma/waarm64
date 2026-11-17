// The names agent's tests' rig (web/names.ts; tests/names-agent.test.ts, tests/names-room.test.ts): the agent's
// compiled services (the calendars and explorers) routed to the pretend ones (tests/net/ots-calendar.ts) by `fetch`, as
// the page tests route them in Chromium, every URL asked recorded; the module on the tests' parameters
// (target/net/ts-test.wasm, net/ts/build.sh --test-params) in this thread; titles made at a time of the test's choosing.
import { readFileSync } from 'node:fs';
import { localBackend, type NamesBackend, type PutAnswer } from '../../web/names-ops.ts';
import { CALENDARS, EXPLORERS, memoryNamesStore, NamesAgent, SERVICES, type NamesConn, type NamesStore, type TitleRecord, type TitleStatus, type ZonePoint } from '../../web/names.ts';
import { TsModule } from '../../web/ts-client.ts';
import { CALENDARS as PRETEND, type OtsCalendar } from './ots-calendar.ts';

const ROOT = new URL('../..', import.meta.url).pathname;
export const TEST_WASM = `${ROOT}target/net/ts-test.wasm`;

let mod: Promise<TsModule> | undefined;
/** The tests' module, one instance (its clients and operations share it, as the names worker's do). */
export const testModule = () => (mod ??= TsModule.load(readFileSync(TEST_WASM)));

/** What the agents asked for: every URL, and those not of a compiled service. */
export type Asked = { urls: string[]; foreign: string[]; posts: number };

/**
 * Routes the compiled services to `cal` through `globalThis.fetch` (Node's own fetch for everything else, the tests'
 * own requests to `cal` included); anything else the agent asks is recorded as `foreign` and fails. Returns the record
 * and the restore.
 */
export function routeServices(cal: OtsCalendar): { asked: Asked; restore(): void } {
  const real = globalThis.fetch;
  const asked: Asked = { urls: [], foreign: [], posts: 0 };
  const map: [string, string][] = [...CALENDARS.map((c, i): [string, string] => [c, cal.calendars[PRETEND[i]]]), ...EXPLORERS.map((e): [string, string] => [e, cal.explorer])];
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(cal.url)) return real(input, init); // the test's own
    asked.urls.push(url);
    const to = map.find(([from]) => url.startsWith(`${from}/`));
    if (!to || !SERVICES.some((s) => url.startsWith(`${s}/`))) {
      asked.foreign.push(url);
      return Promise.reject(new TypeError(`not a compiled service: ${url}`));
    }
    if (init?.method === 'POST') asked.posts++;
    return real(to[1] + url.slice(to[0].length), init);
  };
  return { asked, restore: () => { globalThis.fetch = real; } };
}

/** A publisher that answers as the test says (no room): each put recorded. */
export function fakePublish(answer: (item: string) => PutAnswer[] = () => [{ id: '', server: 's1', result: 'taken', item: null }]) {
  const puts: string[] = [];
  return {
    puts,
    wrap(b: NamesBackend): NamesBackend {
      return {
        ...b,
        publish: (_link, items) => {
          puts.push(...items.map((i) => i.item));
          return Promise.resolve(new Map(items.map((i) => [i.id, answer(i.item)])));
        },
      };
    },
  };
}

/** An agent on the tests' module, a store of its own (a browser) or the one given (another tab of it). */
export async function testAgent(o: { store?: NamesStore; publish?: ReturnType<typeof fakePublish>; log?: string[] } = {}): Promise<{ agent: NamesAgent; store: NamesStore; backend: NamesBackend }> {
  const store = o.store ?? memoryNamesStore();
  const local = localBackend(await testModule());
  const backend = o.publish ? o.publish.wrap(local) : local;
  const agent = new NamesAgent({ store, backend, retryMs: 0, log: (s) => { o.log?.push(s); } });
  return { agent, store, backend };
}

export const point = (key = 'ab'.repeat(32)): ZonePoint[] => [{ label: null, key }];

/** Mines 7 blocks at `time` (Unix seconds), so the explorers' block 6 deep, an entry's `ref`, is from then. */
export function refAt(cal: OtsCalendar, time: number) {
  cal.mine(7, time);
}

/**
 * Registers `name` with its claim anchored at about `time` (Unix seconds): the chain's `ref` then, the claim mined into a
 * block an hour after it and six more; then seven blocks now (so later entries' `ref` is recent) and a pass, which
 * collects the anchor (and renews, when that makes it due).
 */
export async function aged(cal: OtsCalendar, agent: NamesAgent, c: NamesConn, name: string, time: number, points = point()) {
  refAt(cal, time);
  await agent.register(c, name, points);
  cal.mine(7, time + 3600);
  cal.mine(7);
  await agent.pass(c.identityKey);
}

/** A title's status by the module (the agent's own view of its chains). */
export async function statusOf(backend: NamesBackend, t: TitleRecord): Promise<TitleStatus> {
  return backend.op<TitleStatus>('status', { item: t.item, now: Math.floor(Date.now() / 1000) });
}

export const DAY = 86400;
export const nowS = () => Math.floor(Date.now() / 1000);
