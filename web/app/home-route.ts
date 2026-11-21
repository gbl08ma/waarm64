// Where the Home page is (docs/frontend.md "The Home page"): its level, parsed from the address and written to it, and
// what its column's Back leads to. The root is `#home` (the older `#machines` too); a connection's page, one level down,
// is `#home/connections/<id>` (its Details), `…/settings` and `…/domains`. Where the user came from (`From`) isn't in
// the address: an address, a link or a reload enters from Connections. DOM-free, so tests/home-route.test.ts runs it in
// Node; web/app/areas/machines-nav.svelte.ts keeps the state and web/app/areas/page-window.ts the address.

/** A connection's sections on its page: what it gives out, what can be changed, a room's domains. */
export type ConnectionSection = 'details' | 'settings' | 'domains';

/** A machine's tabs on the Home page (MachinePane.svelte). */
export const MACHINE_TABS = ['settings', 'disks', 'network', 'usb', 'folders', 'snapshots'] as const;
export type MachineTab = (typeof MACHINE_TABS)[number];

/**
 * Where a level was entered from, which its Back leads to: Connections, a machine's pane (at `tab`; its Network tab
 * when none is said), or the machine's screen.
 */
export type From = { to: 'connections' } | { to: 'tab'; machine: string; tab?: MachineTab } | { to: 'screen' };

/** A level under the root: a connection's page. */
export type HomeContext = { kind: 'connection'; id: string; section: ConnectionSection; from: From };

/** What the address says of Home: its root, or a connection's section (`connection`). */
export type HomeRoute = { connection?: { id: string; section: ConnectionSection } };

const SECTION_PATH: Record<ConnectionSection, string> = { details: '', settings: '/settings', domains: '/domains' };
const PATH_SECTION: Record<string, ConnectionSection | undefined> = { settings: 'settings', domains: 'domains' };

/**
 * The Home page that fragment `hash` asks for, or undefined when it isn't Home's. An id that isn't percent-encoded
 * properly, or a section that isn't one, is the root: Connections, which is where an unknown connection leads too.
 */
export function homeRoute(hash: string): HomeRoute | undefined {
  if (hash === '#home' || hash === '#machines') return {};
  // `#home/connections/<id>`, and a section after it.
  const [home, connections, id, ...rest] = hash.split('/');
  if (home !== '#home' || connections !== 'connections' || !id || rest.length > 1) return undefined;
  const section = rest.length ? PATH_SECTION[rest[0]] : 'details';
  if (!section) return {};
  try {
    return { connection: { id: decodeURIComponent(id), section } };
  } catch {
    return {}; // a malformed escape: no connection has that id
  }
}

/** The fragment for Home at `at` (a connection's section), or its root. */
export function homeHash(at?: { id: string; section: ConnectionSection }): string {
  return at ? `#home/connections/${encodeURIComponent(at.id)}${SECTION_PATH[at.section]}` : '#home';
}

/** What the page knows of a connection, for the level it opens. */
export type Known = { id: string; kind: string };

/**
 * The level as the page can show it: none once the connection is gone (the root, at Connections); a section the
 * connection hasn't (Domains of one that isn't a room's) is its Details.
 */
export function shownContext(ctx: HomeContext | undefined, find: (id: string) => Known | undefined) {
  if (!ctx) return undefined;
  const c = find(ctx.id);
  if (!c) return undefined;
  return ctx.section === 'domains' && c.kind !== 'room' ? { ...ctx, section: 'details' as const } : ctx;
}

/** Where a level's Back leads now: a machine gone, or the screen with no machine on the page, is Connections. */
export type BackTo =
  { to: 'connections' } | { to: 'tab'; machine: string; tab?: MachineTab; name: string } | { to: 'screen' };

/** Where Back from a level entered from `from` leads, given the page's machines (by id) and whether one is on the page. */
export function backOf(from: From, o: { loaded: boolean; machineName: (id: string) => string | undefined }): BackTo {
  if (from.to === 'screen') return o.loaded ? from : { to: 'connections' };
  if (from.to === 'tab') {
    const name = o.machineName(from.machine);
    return name === undefined ? { to: 'connections' } : { ...from, name };
  }
  return from;
}

/**
 * What a level's entry of the browser's history keeps (`history.state.home`): where it was entered from, which the
 * address doesn't say, and whether it was pushed on top of that place (then the column's Back goes back in the history).
 */
export type HomeState = { home: { from: From; pushed?: boolean } };

const FROM_TO = new Set(['connections', 'tab', 'screen']);

/** The level's part of a history entry's state, if it has a well-formed one. */
export function homeState(state: unknown): HomeState['home'] | undefined {
  const h = (state as { home?: { from?: { to?: unknown; machine?: unknown; tab?: unknown }; pushed?: unknown } } | null)
    ?.home;
  const to = h?.from?.to;
  if (typeof to !== 'string' || !FROM_TO.has(to)) return undefined;
  if (to === 'tab' && typeof h?.from?.machine !== 'string') return undefined;
  const tab = h?.from?.tab;
  if (to === 'tab' && tab !== undefined && !(MACHINE_TABS as readonly unknown[]).includes(tab)) return undefined;
  return h as HomeState['home'];
}
