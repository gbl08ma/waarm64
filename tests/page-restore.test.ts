// A kept snapshot restored on the page (web/app/areas/snapshot-restore.ts, docs/machines.md §5.2) in Chromium without a
// guest: the machine worker is a stand-in that records the start message and says the machine is off, so what is
// checked is what the page sends it. The page review's findings (RESIZE loop 5b): the restore plans and commits on the
// machine's records as they are then (the Home page's Restore after its records were read again, an edit made in
// another tab meanwhile), and the start opens the fork the commit attached; a ramdisk grown in another tab is another
// shape for a restore from this page.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { t } from '../web/i18n.ts';
import { answerAsks, barSays, type Question } from './page-ask.ts';
import { words } from './words.ts';

let browser: Browser;
let base: string;
let close: () => void;
before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => { await browser?.close(); close?.(); });

type Start = { disks: { overlay?: string; size?: number; source: Record<string, unknown> }[]; plan?: { slot: number; action: string; overlay?: string }[]; snapshot: boolean };

/** The machine worker as a stand-in: each start is recorded (`window.__starts`) and answered "off"; a stop, "stopped". */
const standIn = (page: Page) => page.addInitScript(() => {
  const Real = window.Worker;
  const starts: unknown[] = [];
  (window as unknown as { __starts: unknown[] }).__starts = starts;
  window.Worker = class extends Real {
    #fake: boolean;
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.#fake = /\/app\/worker\.ts/.test(String(url));
    }
    postMessage(m: unknown, t?: unknown) {
      if (!this.#fake) return super.postMessage(m as never, t as never);
      const msg = m as { type?: string; disks?: { overlay?: string; size?: number; source: Record<string, unknown> }[]; plan?: unknown; snapshot?: unknown };
      const answer = (data: unknown) => setTimeout(() => this.onmessage?.(new MessageEvent('message', { data })));
      if (msg.type === 'start') {
        starts.push({ disks: (msg.disks ?? []).map((d) => ({ overlay: d.overlay, size: d.size, source: Object.fromEntries(Object.entries(d.source).filter(([, v]) => typeof v !== 'object')) })), plan: msg.plan, snapshot: !!msg.snapshot });
        answer({ type: 'state', state: 'off' });
      }
      if (msg.type === 'stop') answer({ type: 'stopped' });
    }
  };
});

const starts = (page: Page) => page.evaluate(() => (window as unknown as { __starts: Start[] }).__starts);
const stateIs = (page: Page, state: string) => page.waitForFunction((s) => document.body.dataset.state === s, state, { timeout: 30_000, polling: 50 });

/** Keeps a snapshot of machine `id` at its shape as the page has it now (`page.shapeNow`), pinning its first disk's slot as `pin`; its id. */
const keepSnapshot = (page: Page, id: string, pin: Record<string, unknown>) =>
  page.evaluate(async ([id, pin]) => {
    const { Store, snapshotPath } = await import('/web/app/store.ts' as string);
    const { page: p } = await import('/web/app/page.ts' as string);
    const { SnapshotWriter, crc32, SNAPSHOT_VERSION } = await import('/web/snapshot-file.ts' as string);
    const { opfsDir } = await import('/web/overlay.ts' as string);
    const store = await Store.open();
    const m = await store.get('machines', id);
    const disks = new Map((await store.all('disks')).map((d: { id: string }) => [d.id, d]));
    const { shape, hash } = await p.shapeNow(m, disks, await store.all('overlays'));
    const pins = [{ slot: shape.disks[0].slot, ...pin }];
    const sid = 'eeeeeeeeeee1';
    const header = { format: 1, coreVersion: SNAPSHOT_VERSION, abi: 0, created: new Date().toISOString(), shape, shapeHash: hash, disks: pins };
    const parts: Uint8Array[] = [];
    const stored = { id: 0, compress: async (b: Uint8Array) => b, decompress: async (b: Uint8Array) => b, crc32 };
    const w = new SnapshotWriter((b: Uint8Array) => { parts.push(b.slice()); }, header, { codec: stored });
    await w.end();
    const path: string = snapshotPath(id, sid);
    const dir = await opfsDir(path.slice(0, path.lastIndexOf('/')), true);
    const out = await (await dir.getFileHandle(sid, { create: true })).createWritable();
    await out.write(new Blob(parts as BlobPart[]));
    await out.close();
    await store.put('snapshots', { id: sid, machine: id, name: 'Kept', created: Date.now(), bytes: 0, shape, shapeHash: hash, pins });
    store.close();
    return sid;
  }, [id, pin] as const);

test("finding 1: the Snapshots tab's Restore (machine off) commits on the records as they are, keeps an edit made meanwhile, and starts on the fork it attached", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await standIn(page);
  await answerAsks(page); // Restore: yes; keep the overlay (so the restore forks): yes
  await page.goto(`${base}/web/app/`);
  const ids = await page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { attach, createDisk, createMachine } = await import('/web/app/machines.ts' as string);
    const { createOverlay, switchOverlay } = await import('/web/app/disks.ts' as string);
    const store = await Store.open();
    const m = await createMachine(store, { name: 'Restored' });
    const d = await createDisk(store, { kind: 'blank', size: 1 << 20, name: 'Scratch' }); // i18n-ignore: a name the test gives
    const a = await attach(store, m, d);
    const o = await createOverlay(store, d, 'First');
    await switchOverlay(store, m, a.id, o.id);
    store.close();
    return { m: m.id as string, o: o.id as string };
  });
  await page.goto(`${base}/web/app/?m=${ids.m}`);
  await stateIs(page, 'off');
  // The snapshot pinned the overlay at a generation it has moved past: the restore forks.
  const sid = await keepSnapshot(page, ids.m, { overlay: `overlays/${ids.o}`, generation: 7, blocks: 0 });
  // Another tab renames the machine meanwhile.
  await page.evaluate(async (m) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    await store.put('machines', { ...(await store.get('machines', m)), name: 'Renamed elsewhere' });
    store.close();
  }, ids.m);
  await page.click('#machines-open');
  await page.locator('.machines [data-tab=snapshots]').click();
  await page.locator(`.machines [data-snapshot="${sid}"] [data-action=restore]`).click();
  await page.waitForFunction(() => (window as unknown as { __starts: unknown[] }).__starts.length === 2, null, { timeout: 30_000, polling: 50 });
  const rec = await page.evaluate(async (m) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    const r = await store.get('machines', m);
    store.close();
    return { name: r.name as string, overlay: r.attachments[0].overlay as string };
  }, ids.m);
  const [, restore] = await starts(page);
  assert.equal(restore.snapshot, true);
  assert.notEqual(rec.overlay, ids.o, 'forked');
  assert.equal(restore.disks[0].overlay, `overlays/${rec.overlay}`, 'the start opens the fork the restore attached');
  assert.deepEqual(restore.plan?.map((p) => [p.action, p.overlay]), [['write', `overlays/${rec.overlay}`]], 'the worker fills that same fork');
  assert.equal(rec.name, 'Renamed elsewhere', 'the edit made meanwhile stays');
  assert.deepEqual(errors, []);
  await context.close();
});

test('finding 9: a ramdisk grown in another tab makes a kept snapshot another shape for a restore from this page', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const asked: Question[] = [];
  await standIn(page);
  await answerAsks(page, (q) => { asked.push(q); });
  await page.goto(`${base}/web/app/`);
  const ids = await page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { attach, createDisk, createMachine } = await import('/web/app/machines.ts' as string);
    const store = await Store.open();
    const m = await createMachine(store, { name: 'With a ramdisk' });
    const r = await createDisk(store, { kind: 'ramdisk', size: 2 << 20, name: 'RAM' });
    await attach(store, m, r);
    store.close();
    return { m: m.id as string, r: r.id as string };
  });
  await page.goto(`${base}/web/app/?m=${ids.m}`);
  await stateIs(page, 'off');
  const sid = await keepSnapshot(page, ids.m, { blocks: 0, ram: true });
  // Tab B grows the ramdisk (its record: what the next start opens).
  await page.evaluate(async (r) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    await store.put('disks', { ...(await store.get('disks', r)), size: 4 << 20 });
    store.close();
  }, ids.r);
  await page.evaluate(async (sid) => {
    const { page: p } = await import('/web/app/page.ts' as string);
    await p.restoreKept(sid);
  }, sid);
  // Refused, said why in the message bar (no dialog: nothing to decide).
  await barSays(page, new RegExp(`^${t('snapshots:snapshot-restore.restore.cant')}$`), words('snapshots:snapshot-restore.restore.otherShape', { name: 'Kept', machine: 'With a ramdisk' }, { start: true }));
  assert.deepEqual(asked, [], 'nothing asked');
  assert.equal((await starts(page)).length, 1, 'nothing started');
  await context.close();
});
