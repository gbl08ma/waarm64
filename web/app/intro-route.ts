// Where the introduction is (docs/frontend.md "The introduction"; docs/decisions.md "Demos"): its address, and where
// leaving it leads. DOM-free.

/** The introduction's address: this fragment on any copy of the page. */
export const INTRO_HASH = '#intro';

/** Whether the address is the introduction's. */
export const isIntroAddress = (w: Pick<URL, 'hash'>) => w.hash === INTRO_HASH;

/**
 * Where the introduction's end and its Skip lead: the demo store's page, or Home for a visitor who has machines in
 * this browser (they know the page; their machines are what they came for).
 */
export const afterIntro = (machines: number): 'demos' | 'home' => (machines > 0 ? 'home' : 'demos');
