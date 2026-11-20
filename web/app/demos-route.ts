// Where the demo store's page is (docs/frontend.md "The demo store"; docs/decisions.md "Demos"): its address,
// parsed once. The page is the store at `/demos` (the page's copy `demos.html` beside `index.html`, served there by the
// host's trailing-slash handling: the assets stay `./assets/…`) and at `#demos` on any copy. Its parameters go in the
// query, never the path: `?id=<id>` opens our store's demo `<id>`, `?store=<url>` another store's cards (or a single
// definition's demo), `&id=` one of its demos; in the fragment's form, after `#demos?`. The page's own knobs never
// take these names, so the rest of the query is the page's (`pageQuery`). DOM-free.
import { OUR_STORE } from './demo-store.ts';

/** The store's page as the address asks for it. */
export type DemosRoute = {
  /** The store's URL (absolute): ours unless `?store=` names another. */
  store: string;
  /** The demo to open at its interstitial (`?id=`). */
  id?: string;
  /** Our store's (vmdisks.tny.im): another's gets a warning before anything past its JSON is fetched. */
  ours: boolean;
};

/** The query's names the store's page takes (the page's knobs never use them). */
export const DEMO_PARAMS = ['store', 'id'] as const;

/** The path of the store's page: its own copy of the page, `/demos` (or `/demos.html` on a host that doesn't drop it). */
const DEMOS_PATH = /\/demos(\.html)?$/;

type Where = Pick<URL, 'pathname' | 'search' | 'hash' | 'href'>;

/** The fragment's form, `#demos` or `#demos?…`: its query, or undefined when the fragment is another. */
function hashQuery(hash: string): URLSearchParams | undefined {
  if (hash !== '#demos' && !hash.startsWith('#demos?')) return undefined;
  return new URLSearchParams(hash.slice('#demos'.length));
}

/** Whether the address is the store's page's (its path, or `#demos`). */
export const isDemosAddress = (w: Where) => DEMOS_PATH.test(w.pathname) || hashQuery(w.hash) !== undefined;

/** The store's URL the query names (relative to the page), absolute; ours by default; undefined if it isn't a URL. */
function storeUrl(q: URLSearchParams, page: string): string | undefined {
  const s = q.get('store');
  if (!s) return OUR_STORE;
  try {
    const u = new URL(s, page);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The store's page that address `w` asks for (undefined: the address isn't the store's page). Its parameters come from
 * the query and, in the fragment's form, the fragment's own query (which wins). A `?store=` that isn't an http(s) URL
 * opens our store.
 */
export function demosRoute(w: Where): DemosRoute | undefined {
  const inHash = hashQuery(w.hash);
  if (!DEMOS_PATH.test(w.pathname) && !inHash) return undefined;
  const q = new URLSearchParams(w.search);
  for (const [k, v] of inHash ?? []) q.set(k, v);
  const store = storeUrl(q, w.href) ?? OUR_STORE;
  const id = q.get('id') ?? undefined;
  return { store, ...(id ? { id } : {}), ours: store === OUR_STORE };
}

/** The query without the store's parameters: what the page's own knobs read (none: the page's address has no query). */
export function pageQuery(search: string): string {
  const q = new URLSearchParams(search);
  for (const k of DEMO_PARAMS) q.delete(k);
  const s = q.toString();
  return s ? `?${s}` : '';
}

/**
 * The page's address once the store's page closes: its path back to the page's (`/demos` → `./`, which is where
 * `index.html` is), the store's parameters dropped, no fragment.
 */
export function leftDemos(w: Where): string {
  const path = DEMOS_PATH.test(w.pathname) ? w.pathname.replace(DEMOS_PATH, '/') : w.pathname;
  return `${path}${pageQuery(w.search)}`;
}

/** The store's parameters for `r` (our store's left out: it's the default). */
function demoQuery(r: { store?: string; id?: string }) {
  const q = new URLSearchParams();
  if (r.store && r.store !== OUR_STORE) q.set('store', r.store);
  if (r.id) q.set('id', r.id);
  return q;
}

/**
 * The address of the store's page showing `r` from address `w`, kept by a reload: on the page's own path
 * (`/demos?id=…`, the page's other parameters kept), else in the fragment's form (`#demos?id=…`).
 */
export function demosAddress(w: Where, r: { store?: string; id?: string }): string {
  const q = demoQuery(r);
  if (DEMOS_PATH.test(w.pathname)) {
    const page = new URLSearchParams(pageQuery(w.search));
    for (const [k, v] of q) page.set(k, v);
    const s = page.toString();
    return `${w.pathname}${s ? `?${s}` : ''}`;
  }
  const s = q.toString();
  return `${w.pathname}${pageQuery(w.search)}${s ? `#demos?${s}` : '#demos'}`;
}

/**
 * Whether the page's load is a first visit, which opens the introduction (web/app/intro-route.ts; docs/decisions.md "Demos"): no machines kept in this browser,
 * and an address with nothing to open (no query, no fragment). Not under automation (the tests open the page bare in
 * fresh profiles), unless the query asks for it (`?firstvisit=1`).
 */
export function firstVisit(w: Pick<URL, 'search' | 'hash'>, machines: number, automated: boolean): boolean {
  const q = new URLSearchParams(pageQuery(w.search));
  const asked = q.get('firstvisit') === '1';
  q.delete('firstvisit');
  return machines === 0 && q.size === 0 && !w.hash && (!automated || asked);
}
