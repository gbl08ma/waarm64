// The demo store's page for tools/screens.ts (docs/frontend.md "Screenshots", "The demo store"): our store
// (vmdisks.tny.im) and another's (demos.example) answered here, without the network, with three demos shaped like the
// published ones (a terminal, a desktop, a 3D desktop; their thumbnails drawn stand-ins), and the states the page has
// without a guest: the list and a chosen demo, a demo started before, a start's download partway and its failure,
// another store's consent step and its demos once accepted, an id the store doesn't have, the store's server down, a
// check that warns. Wide and 720 px.
import { createHash } from 'node:crypto';
import type { Browser, BrowserContext, Page, Route } from 'playwright-core';

const OURS = 'https://vmdisks.tny.im';
const OTHER = 'https://demos.example';
const CORS = { 'Access-Control-Allow-Origin': '*' };
const MIB = 1 << 20;
const sha = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');

/** A demo's snapshot as three pieces of 1 MiB (the first is answered, the others held: a download partway). */
const PIECES = [1, 2, 3].map((fill) => Buffer.alloc(MIB, fill));
const HASHES = PIECES.map(sha);
const SNAPSHOT = { format: 'waarm64-chunked-1', size: 3 * MIB, piece: MIB, pieces: '../pieces/{hash}.bin', hashes: HASHES, id: sha(HASHES.join('\n')) };

/** A thumbnail's stand-in, 480×300: a terminal's lines, or a desktop's window over a bar. */
const thumb = (kind: 'terminal' | 'desktop' | '3d') => {
  const lines = [0, 1, 2, 3, 4].map((i) => `<rect x="16" y="${16 + i * 18}" width="${[150, 300, 220, 260, 60][i]}" height="8" fill="#9aa3ad"/>`).join('');
  const desktop = `<rect width="480" height="300" fill="#2d4a5e"/><rect width="480" height="16" fill="#1b1f24"/><rect x="60" y="50" width="360" height="210" rx="4" fill="${kind === '3d' ? '#51306b' : '#e8eaed'}"/><rect x="60" y="50" width="360" height="20" rx="4" fill="#3a4048"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 300">${kind === 'terminal' ? `<rect width="480" height="300" fill="#0c0e10"/>${lines}` : desktop}</svg>`;
};

type Card = { id: string; name: string; kind: 'terminal' | 'desktop' | '3d'; ramMiB: number; download: number; summary: string };
const CARDS: Card[] = [
  { id: 'alpine-term', name: 'Alpine (terminal)', kind: 'terminal', ramMiB: 512, download: 15835257, summary: "Alpine Linux at a root prompt, in a few seconds. Type a command it doesn't have and it installs it; apk reaches Alpine's package mirror." },
  { id: 'arch-desktop', name: 'Arch Linux (desktop)', kind: 'desktop', ramMiB: 2048, download: 65322416, summary: "Arch Linux's sway desktop, started as the machine resumes, with a terminal open; Firefox starts a few seconds later (Ctrl+C in the terminal stops it and keeps the terminal). Chromium is installed too, and pacman installs more software. Websites load slowly on the demo network." },
  { id: 'arch-3d', name: 'Arch Linux (3D)', kind: '3d', ramMiB: 2048, download: 72394917, summary: "OpenGL on Arch Linux's sway desktop: a few seconds after it starts, a shader demo opens, drawn by the guest's Mesa through virgl onto your browser's WebGL2. pacman installs more software." },
];
const definition = (c: Card, i: number) => ({
  type: 'waarm64-machine',
  version: 2,
  machine: { name: c.name, ncpus: c.kind === 'terminal' ? 2 : 4, ramMiB: c.ramMiB, keyboard: 'browser', display: c.kind === 'terminal' ? '2d' : '3d', network: true, macs: [`52:54:00:00:00:${10 + i}`, `52:54:00:00:01:${10 + i}`], clock: true },
  disks: [{ kind: 'url', name: c.name, size: 1 << 30, identity: { kind: 'url', chunked: sha(c.id), bytes: 62062592 }, url: `${c.id}/manifest.json`, readOnly: false, serial: sha(c.id).slice(0, 12) }],
  demo: { id: c.id, summary: c.summary, thumbnail: `${c.id}/thumb.svg`, download: c.download, view: c.kind === 'terminal' ? 'serial' : 'screen', snapshot: { manifest: `${c.id}/snapshot.json`, id: SNAPSHOT.id }, network: 'demo', room: 'global' },
});
const store = (name: string) => ({ type: 'waarm64-store', version: 1, name, demos: CARDS.map(definition) });

/** How a store's server answers: `down` unreachable, `gone` its snapshots 404. */
type Site = { down?: boolean; gone?: boolean };
const site = (name: string, s: Site) => async (r: Route) => {
  const path = new URL(r.request().url()).pathname;
  const card = CARDS.find((c) => path.startsWith(`/${c.id}/`));
  if (s.down) return r.abort('connectionrefused');
  if (path === '/store.json') return r.fulfill({ headers: CORS, json: store(name) });
  if (card && path.endsWith('/thumb.svg')) return r.fulfill({ headers: CORS, contentType: 'image/svg+xml', body: thumb(card.kind) });
  if (card && path.endsWith('/snapshot.json') && !s.gone) return r.fulfill({ headers: CORS, json: SNAPSHOT });
  if (path === `/pieces/${HASHES[0]}.bin`) return r.fulfill({ headers: CORS, body: PIECES[0] });
  if (path.startsWith('/pieces/')) return; // held: the download stays partway
  return r.fulfill({ status: 404, headers: CORS });
};

export type Shots = {
  base: string;
  /** Runs a state (skipped unless `--only` matches; a failure is listed and the run goes on). */
  state: (name: string, f: () => Promise<void>) => Promise<void>;
  shot: (page: Page, name: string) => Promise<void>;
  /** A stylesheet for every page (`--css`). */
  css?: string;
};

/** A profile of its own for the store's page (its machines aren't Home's seed), with the stores answered. */
async function visitor(browser: Browser, viewport: { width: number; height: number }, ours: Site): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport, colorScheme: 'dark', locale: 'en-US', timezoneId: 'UTC' });
  ctx.setDefaultTimeout(5000);
  await ctx.route(`${OURS}/**`, site("waarm64's demos", ours));
  await ctx.route(`${OTHER}/**`, site('Example demos', {}));
  return ctx;
}

/** A machine made from our store's Alpine demo, as a visitor who started it has. */
const startedBefore = (page: Page) => page.evaluate(async (store) => {
  const { Store } = await import('/web/app/store.ts' as string);
  const { createMachine } = await import('/web/app/machines.ts' as string);
  const s = await Store.open();
  const m = await createMachine(s, { name: 'Alpine (terminal)', ncpus: 2, ramMiB: 512 });
  await s.put('machines', { ...m, fromDemo: { store, id: 'alpine-term' }, modified: Date.UTC(2026, 10, 1, 12) });
  s.close();
}, `${OURS}/store.json`);

/** The store's page's states at one width (`suffix`: `-narrow` at 720 px). */
async function at(browser: Browser, o: Shots, viewport: { width: number; height: number }, suffix: string) {
  const ours: Site = {};
  const narrowed = suffix !== '';
  const ctx = await visitor(browser, viewport, ours);
  const open = async (query = '') => {
    const page = await ctx.newPage();
    await page.goto(`${o.base}/web/app/#demos${query}`);
    if (o.css) await page.addStyleTag({ path: o.css });
    return page;
  };
  /** State `name`: the store's page at `query`, once `wait` shows (and after `then`). */
  const take = (name: string, query: string, wait: string, then?: (page: Page) => Promise<void>) =>
    o.state(`demos-${name}${suffix}`, async () => {
      const page = await open(query);
      await page.locator(wait).first().waitFor({ timeout: 30_000 });
      await then?.(page);
      await page.waitForFunction(() => [...document.images].every((i) => i.complete));
      await o.shot(page, `demos-${name}${suffix}`);
      await page.close();
    });
  const start = '[data-action="start-demo"]:not([disabled])';
  const theirs = `?store=${encodeURIComponent(`${OTHER}/store.json`)}`;

  await take('list', '', '[data-demo="arch-3d"]');
  await take('chosen', '?id=arch-desktop', start);
  await take('unknown', '?id=alpine-2019', '[data-field="unknown-id"]');
  await take('other-store', `${theirs}&id=arch-desktop`, '[data-field="not-ours"]');
  await take('other-store-accepted', theirs, '[data-field="not-ours"]', async (page) => {
    await page.click('[data-action="accept-store"]');
    await page.locator('[data-demo="arch-3d"]').first().waitFor();
  });
  await take('downloading', '?id=alpine-term', start, async (page) => {
    await page.click(start);
    await page.locator('[data-field="progress"] progress:not([value="0"])').waitFor({ timeout: 30_000 });
  });
  await take('stop', '?id=alpine-term', start, async (page) => {
    // Another demo's row while the download runs: the question first.
    await page.click(start);
    await page.locator('[data-field="progress"] progress:not([value="0"])').waitFor({ timeout: 30_000 });
    await page.click(narrowed ? '[data-action="all-demos"]' : '.cards [data-demo="arch-3d"]');
    await page.locator('#ask[open]').waitFor();
  });
  await take('checks', '?id=arch-desktop', start, async (page) => {
    await page.click('[data-field="checks-met"] summary'); // the requirements unfolded
  });
  ours.gone = true;
  await take('failed', '?id=alpine-term', start, async (page) => {
    await page.click(start);
    await page.locator('article[data-demo] [role="alert"]').waitFor({ timeout: 30_000 });
  });
  ours.gone = false;
  // A computer with little memory: the desktop's check warns (it may still run).
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'deviceMemory', { get: () => 2 }));
  await take('warned', '?id=arch-desktop', '[data-check="memory"][data-level="warn"]');
  // Started before: the visitor's machine from the Alpine demo (after the states above, which have none).
  await o.state(`demos-mine${suffix}`, async () => {
    const page = await open();
    await page.locator('[data-demo="alpine-term"]').first().waitFor({ timeout: 30_000 });
    await startedBefore(page);
    await page.close();
  });
  await take('mine', '?id=alpine-term', '[data-field="started-before"]');
  await take('mine-list', '', '[data-mark="mine"]');
  ours.down = true;
  await take('down', '', '[data-field="store-error"]');
  await ctx.close();
}

/** The demo store's page's states, wide and narrow. */
export async function demoScreens(browser: Browser, o: Shots, wide: { width: number; height: number }, narrow: { width: number; height: number }) {
  await at(browser, o, wide, '');
  await at(browser, o, narrow, '-narrow');
}
