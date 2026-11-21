// Where the introduction is (docs/frontend.md "The introduction"; docs/decisions.md "Demos"): its address, and where
// leaving it leads. DOM-free.

/** The introduction's address: this fragment on any copy of the page (and the path `/intro`, which leads to it). */
export const INTRO_HASH = '#intro';

/** The introduction's path: the page's copy `intro.html`, served at `/intro` (`/intro.html` on a host that keeps it). */
const INTRO_PATH = /\/intro(\.html)?$/;

/**
 * The page's own address for the introduction when `w` is its path's (`/intro` → `/#intro`, the query kept), else
 * undefined. The path is a way in only: the page writes this address at its load, so that leaving the introduction
 * and a reload afterwards go by the fragment, as from any other address.
 */
export const introFromPath = (w: Pick<URL, 'pathname' | 'search'>): string | undefined =>
  INTRO_PATH.test(w.pathname) ? `${w.pathname.replace(INTRO_PATH, '/')}${w.search}${INTRO_HASH}` : undefined;

/** Whether the address is the introduction's. */
export const isIntroAddress = (w: Pick<URL, 'hash'>) => w.hash === INTRO_HASH;

/**
 * Where the introduction's end and its Skip lead: the demo store's page, or Home for a visitor who has machines in
 * this browser (they know the page; their machines are what they came for).
 */
export const afterIntro = (machines: number): 'demos' | 'home' => (machines > 0 ? 'home' : 'demos');
