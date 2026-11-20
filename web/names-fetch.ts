// The names' services (web/names.ts; docs/networking/names.md): the calendars and explorers compiled in, the only URLs
// the agent or a room's server fetches.

/** The calendars, in the module's order (net/ts/src/room/names/anchor.rs `Calendar`: a pending anchor's index). */
export const CALENDARS = [
  'https://alice.btc.calendar.opentimestamps.org',
  'https://bob.btc.calendar.opentimestamps.org',
  'https://finney.calendar.eternitywall.com',
] as const;
/** The explorers (Esplora's API): an anchor's block's header, from one (the other when it fails). */
export const EXPLORERS = ['https://blockstream.info/api', 'https://mempool.space/api'] as const;
/** Every service the agent talks to: nothing else is ever fetched (`get`). */
export const SERVICES: readonly string[] = [...CALENDARS, ...EXPLORERS];

/** A fetch's longest wait. */
const FETCH_MS = 15_000;
// ---- Fetching: the compiled services only ----

/** Whether `url` is one of SERVICES': the only URLs the agent or a room's server fetches. */
export const isService = (url: string) => SERVICES.some((s) => url.startsWith(`${s}/`));

/** A GET or POST to one of SERVICES; anything else throws (no stored value or link can name another service). */
export async function get(url: string, init?: RequestInit): Promise<Response> {
  if (!isService(url)) throw new Error(`names: not a compiled service: ${url}`);
  return fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_MS) });
}

/**
 * A room's server's fetch (the module's action 12: net/ts/src/room/names/outside.rs, a renewal finished at a calendar,
 * a block checked at an explorer), as the room's worker makes it: a GET of one of SERVICES, its status and body; status 0
 * when it failed or `url` isn't a compiled service's (nothing is fetched then). The module builds its URLs from the same
 * compiled lists (anchor.rs `Calendar`, `EXPLORERS`), never from a record; this holds the page to them too.
 */
export async function serviceFetch(url: string): Promise<{ status: number; body: Uint8Array }> {
  try {
    const r = await get(url);
    return { status: r.status, body: new Uint8Array(await r.arrayBuffer()) };
  } catch {
    return { status: 0, body: new Uint8Array() };
  }
}

export async function text(url: string): Promise<string> {
  const r = await get(url);
  if (!r.ok) throw new Error(`names: ${url}: ${r.status}`);
  return (await r.text()).trim();
}
