// A machine from a template on the page (docs/machines.md §6.1, web/app/template.ts; DEMO loop 1), in Chromium without
// a guest: the machine worker is a stand-in that records the start message and says the machine is off. A template's
// machine in one fresh profile (a chunked image's disk), its definition and a snapshot of it made there; in another
// fresh profile the page's hook makes the machine from both and opens it, and its first start restores the snapshot
// without asking: a fork onto the machine's overlay, the mark cleared, the snapshot kept. The same from a store's demo
// (web/app/demo-store.ts; DEMO loop 4): the store's file with the definition inline, its URLs relative to the store, the
// machine marked with the demo it came from. A 3D template whose 3D can't start here (the GPU worker fails) boots
// instead at its first start, said, its overlay no fork of the template. (The whole of it with a guest, timed:
// bench/demo/run.ts waarm64-template.)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { t } from '../web/i18n.ts';
import { makeTemplate as make, standIn, type Start } from './demo-fixture.ts';

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

test("a machine from a template, made in a fresh profile, restores the template at its first start: a fork onto its overlay, nothing asked", async () => {
  const made = await make(browser, base);
  // A visitor's fresh profile: the hook (a demo's click) makes the machine from the definition and the snapshot.
  const visitor = await browser.newContext();
  const page = await visitor.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => { errors.push(`asked: ${d.message()}`); void d.dismiss(); });
  await standIn(page);
  // The site: the definition beside its disk's manifest, the snapshot chunked into one piece in a shared pieces/.
  const PIECE = createHash('sha256').update(new Uint8Array(made.snapshot)).digest('hex');
  await page.route('**/site/**', (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path.endsWith('/definition.json')) return r.fulfill({ json: { ...made.def, disks: made.def.disks.map((x: object) => ({ ...x, url: 'manifest.json' })) } });
    const piece = new Uint8Array(made.snapshot);
    if (path.endsWith('/snapshot.json'))
      return r.fulfill({ json: { format: 'waarm64-chunked-1', size: piece.length, piece: 2 << 20, pieces: '../pieces/{hash}.bin', hashes: [PIECE], id: createHash('sha256').update(PIECE).digest('hex') } });
    return r.fulfill({ body: Buffer.from(piece) });
  });
  await page.goto(`${base}/web/app/?autostart=1&hooks`);
  await page.waitForFunction(() => document.body.dataset.state === 'idle', null, { timeout: 30_000, polling: 50 });
  const id = await page.evaluate(() => window.__waarm64FromTemplate!('/site/alpine/definition.json', 'snapshot.json'));
  await page.waitForFunction(() => (window as unknown as { __starts: unknown[] }).__starts.length === 1, null, { timeout: 30_000, polling: 50 });
  const [start] = await page.evaluate(() => (window as unknown as { __starts: Start[] }).__starts);
  const after = await page.evaluate(async (id) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    const m = await store.get('machines', id);
    const disk = await store.get('disks', m.attachments[0].disk);
    return { m, disk, snapshots: await store.all('snapshots'), overlays: await store.all('overlays') };
  }, id);
  assert.equal(start.snapshot, true, 'the first start is the restore');
  const overlay = after.m.attachments[0].overlay as string;
  assert.deepEqual(start.plan?.map((p) => [p.action, p.overlay]), [['write', `overlays/${overlay}`]], "the fork: the snapshot's blocks into the machine's overlay");
  assert.ok(start.disks.some((d) => d.overlay === `overlays/${overlay}`));
  assert.equal(after.overlays.length, 1, 'one overlay: the fork');
  assert.equal(after.m.restoreFirst, undefined, 'the mark cleared');
  assert.deepEqual(after.snapshots.map((s: { machine: string; shapeHash: string }) => [s.machine, s.shapeHash]), [[id, made.hash]], 'the template kept as its snapshot');
  assert.equal(after.disk.url, `${base}/site/alpine/manifest.json`, "its disk's URL resolved against the definition's");
  assert.deepEqual(after.disk.identity, { kind: 'url', chunked: 'ab'.repeat(32), bytes: 1 << 20 });
  assert.deepEqual(errors, []);
  await visitor.close();
});

test("a machine from a store's demo: the definition inline, its URLs relative to the store; marked with the demo; its first start the template's restore", async () => {
  const made = await make(browser, base);
  const visitor = await browser.newContext();
  const page = await visitor.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => { errors.push(`asked: ${d.message()}`); void d.dismiss(); });
  await standIn(page);
  const piece = new Uint8Array(made.snapshot);
  const PIECE = createHash('sha256').update(piece).digest('hex');
  const SNAP = createHash('sha256').update(PIECE).digest('hex'); // its content id (web/chunked.ts `contentId`)
  const demo = { id: 'alpine-term', summary: 'A terminal.', download: piece.length, view: 'serial', snapshot: { manifest: 'alpine/snapshot.json', id: SNAP } };
  const def = { ...made.def, version: 2, disks: made.def.disks.map((x) => ({ ...x, url: 'alpine/manifest.json' })), demo };
  await page.route('**/site/**', (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path.endsWith('/store.json')) return r.fulfill({ json: { type: 'waarm64-store', version: 1, demos: [def] } });
    if (path.endsWith('/alpine/snapshot.json'))
      return r.fulfill({ json: { format: 'waarm64-chunked-1', size: piece.length, piece: 2 << 20, pieces: '../pieces/{hash}.bin', hashes: [PIECE], id: SNAP } });
    if (path.endsWith(`/pieces/${PIECE}.bin`)) return r.fulfill({ body: Buffer.from(piece) });
    if (path.endsWith('/alpine/manifest.json')) return r.fulfill({ json: {} }); // there: a demo machine's start checks it
    return r.fulfill({ status: 404 });
  });
  await page.goto(`${base}/web/app/?autostart=1`);
  await page.waitForFunction(() => document.body.dataset.state === 'idle', null, { timeout: 30_000, polling: 50 });
  const id = await page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { fetchStore, findDemo } = await import('/web/app/demo-store.ts' as string);
    const { machineFromDemo } = await import('/web/app/template.ts' as string);
    const s = await fetchStore('/site/store.json');
    const { machine } = await machineFromDemo(await Store.open(), findDemo(s, 'alpine-term'));
    return machine.id as string;
  });
  await page.goto(`${base}/web/app/?autostart=1&m=${id}`);
  await page.waitForFunction(() => (window as unknown as { __starts: unknown[] }).__starts.length === 1, null, { timeout: 30_000, polling: 50 });
  const [start] = await page.evaluate(() => (window as unknown as { __starts: Start[] }).__starts);
  const after = await page.evaluate(async (id) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    const m = await store.get('machines', id);
    return { m, disk: await store.get('disks', m.attachments[0].disk), snapshots: await store.all('snapshots') };
  }, id);
  assert.equal(start.snapshot, true, 'the first start is the restore');
  assert.deepEqual(after.m.fromDemo, { store: `${base}/site/store.json`, id: 'alpine-term' });
  assert.equal(after.m.restoreFirst, undefined, 'the mark cleared');
  assert.deepEqual(after.snapshots.map((s: { machine: string; shapeHash: string }) => [s.machine, s.shapeHash]), [[id, made.hash]]);
  assert.equal(after.disk.url, `${base}/site/alpine/manifest.json`, "its disk's URL resolved against the store's");
  assert.deepEqual(errors, []);
  await visitor.close();
});

test("a 3D template whose 3D can't start in this browser: its first start boots instead, said; its overlay no fork of the template; the template kept", async () => {
  const made = await make(browser, base, '3d');
  const visitor = await browser.newContext();
  const page = await visitor.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => { errors.push(`asked: ${d.message()}`); void d.dismiss(); });
  await standIn(page, false, true);
  const PIECE = createHash('sha256').update(new Uint8Array(made.snapshot)).digest('hex');
  await page.route('**/site/**', (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path.endsWith('/definition.json')) return r.fulfill({ json: { ...made.def, disks: made.def.disks.map((x: object) => ({ ...x, url: 'manifest.json' })) } });
    const piece = new Uint8Array(made.snapshot);
    if (path.endsWith('/snapshot.json'))
      return r.fulfill({ json: { format: 'waarm64-chunked-1', size: piece.length, piece: 2 << 20, pieces: '../pieces/{hash}.bin', hashes: [PIECE], id: createHash('sha256').update(PIECE).digest('hex') } });
    return r.fulfill({ body: Buffer.from(piece) });
  });
  await page.goto(`${base}/web/app/?autostart=1&hooks`);
  await page.waitForFunction(() => document.body.dataset.state === 'idle', null, { timeout: 30_000, polling: 50 });
  const id = await page.evaluate(() => window.__waarm64FromTemplate!('/site/alpine/definition.json', 'snapshot.json'));
  await page.waitForFunction(() => (window as unknown as { __starts: unknown[] }).__starts.length >= 1, null, { timeout: 30_000, polling: 50 });
  const starts = await page.evaluate(() => (window as unknown as { __starts: Start[] }).__starts);
  assert.deepEqual(starts.map((s) => s.snapshot), [false], 'one start, a boot: the 3D snapshot never reaches a 2D machine');
  const after = await page.evaluate(async (id) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    return { m: await store.get('machines', id), snapshots: await store.all('snapshots'), overlays: await store.all('overlays') };
  }, id);
  assert.equal(after.m.restoreFirst, undefined, 'the mark cleared');
  assert.equal(after.overlays.length, 1);
  assert.equal(after.overlays[0].fork, undefined, 'nothing wrote the template into it: no fork of it (a later restore forks anew)');
  assert.deepEqual(after.snapshots.map((s: { machine: string }) => s.machine), [id], 'the template kept as its snapshot');
  const said = t('snapshots:snapshot-restore.firstBooted', { machine: after.m.name }).replace(/<\/?name>/g, '');
  await page.waitForFunction((said) => document.querySelector('#message')?.textContent?.includes(said), said, { timeout: 10_000, polling: 50 });
  assert.equal(await page.evaluate(() => document.body.dataset.graphics), '2d', 'the boot without 3D');
  assert.deepEqual(errors, []);
  await visitor.close();
});
