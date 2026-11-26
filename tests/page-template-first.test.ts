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

// PERF loop 78's backlog entry and review disk-locks 2: the first start cleared `restoreFirst` before its start, so one
// cut off before the snapshot loaded left a machine that booted its image next time, the demo's snapshot never restored.
test("a template's first start cut off before its snapshot loaded restores it again at the next start; the mark goes once it loaded", async () => {
  const made = await make(browser, base);
  const visitor = await browser.newContext();
  const page = await visitor.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => { errors.push(`asked: ${d.message()}`); void d.dismiss(); });
  await standIn(page, false, false, 1); // the first restore never says it loaded
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
  const startsAre = (n: number) => page.waitForFunction((n) => (window as unknown as { __starts: unknown[] }).__starts.length === n, n, { timeout: 30_000, polling: 50 });
  const record = () => page.evaluate(async (id) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    const m = await store.get('machines', id);
    return { restoreFirst: m.restoreFirst as string | undefined, restoring: m.restoring as unknown, overlay: await store.get('overlays', m.attachments[0].overlay) };
  }, id);
  await startsAre(1);
  await page.waitForFunction(() => document.body.dataset.state === 'off', null, { timeout: 30_000, polling: 50 });
  assert.ok((await record()).restoreFirst, 'cut off: the mark stays');
  await page.evaluate(async () => {
    const { page: p } = await import('/web/app/page.ts' as string);
    await p.restart();
  });
  await startsAre(2);
  const starts = await page.evaluate(() => (window as unknown as { __starts: Start[] }).__starts);
  assert.deepEqual(starts.map((s) => s.snapshot), [true, true], 'the next start restores the snapshot again, not a boot');
  assert.deepEqual(starts[1].plan?.map((p) => p.action), ['write'], "the snapshot's blocks written again");
  await page.waitForFunction(() => document.body.dataset.state === 'off', null, { timeout: 30_000, polling: 50 });
  const after = await record();
  assert.equal(after.restoreFirst, undefined, 'loaded: the mark cleared');
  assert.equal(after.restoring, undefined, "and its overlay the machine's");
  assert.deepEqual(errors, []);
  await visitor.close();
});

// Review disk-locks 6: a template's first start at the page's load ran outside `exclusively`, so a Start meanwhile ran
// a second one: two restores, two starts, the first one's worker never stopped.
test("a Start while a template's first start is under way at the page's load starts nothing beside it", async () => {
  const made = await make(browser, base);
  const visitor = await browser.newContext();
  const page = await visitor.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await standIn(page);
  const PIECE = createHash('sha256').update(new Uint8Array(made.snapshot)).digest('hex');
  await page.route('**/site/**', (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path.endsWith('/definition.json')) return r.fulfill({ json: { ...made.def, disks: made.def.disks.map((x: object) => ({ ...x, url: 'manifest.json' })) } });
    const piece = new Uint8Array(made.snapshot);
    if (path.endsWith('/snapshot.json'))
      return r.fulfill({ json: { format: 'waarm64-chunked-1', size: piece.length, piece: 2 << 20, pieces: '../pieces/{hash}.bin', hashes: [PIECE], id: createHash('sha256').update(PIECE).digest('hex') } });
    return r.fulfill({ body: Buffer.from(piece) });
  });
  await page.goto(`${base}/web/app/?autostart=1`);
  await page.waitForFunction(() => document.body.dataset.state === 'idle', null, { timeout: 30_000, polling: 50 });
  const id = await page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { machineFromUrls } = await import('/web/app/template.ts' as string);
    const { machine } = await machineFromUrls(await Store.open(), '/site/alpine/definition.json', 'snapshot.json');
    return machine.id as string;
  });
  // The Start comes while the first start's restore is under way: when it asks for the machine's lock (before its commit).
  await page.addInitScript(() => {
    const request = navigator.locks.request.bind(navigator.locks) as (...a: unknown[]) => Promise<unknown>;
    let once = false;
    (navigator.locks as unknown as { request: unknown }).request = (...a: unknown[]) => {
      // The start's own take (web/app/run/machine-lock.ts), not a reading's (the undo's at the page's load).
      if (!once && String(a[0]).startsWith('waarm64-machine:') && /machine-lock\.ts/.test(new Error().stack ?? '')) {
        once = true;
        (window as unknown as { __restarted: Promise<unknown> }).__restarted = import('/web/app/page.ts' as string).then((mod) => mod.page.restart());
      }
      return request(...a);
    };
  });
  await page.goto(`${base}/web/app/?autostart=1&m=${id}`);
  await page.waitForFunction(() => (window as unknown as { __starts: unknown[] }).__starts.length >= 1, null, { timeout: 30_000, polling: 50 });
  await page.waitForFunction(() => !!(window as unknown as { __restarted?: unknown }).__restarted, null, { timeout: 30_000, polling: 50 });
  await page.evaluate(() => (window as unknown as { __restarted: Promise<unknown> }).__restarted);
  await page.waitForFunction(() => document.body.dataset.state === 'off', null, { timeout: 30_000, polling: 50 });
  const starts = await page.evaluate(() => (window as unknown as { __starts: Start[] }).__starts);
  assert.deepEqual(starts.map((s) => s.snapshot), [true], 'one start, the restore');
  assert.deepEqual(errors, []);
  await visitor.close();
});

// Review restore-marks 7: a template's first restore whose commit failed (the storage full) cleared the mark and booted:
// the machine never tried its template again, and nothing said it booted instead.
test("a template's first start whose commit fails keeps the mark and says so; its Retry restores the template", async () => {
  const made = await make(browser, base);
  const visitor = await browser.newContext();
  const page = await visitor.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => { errors.push(`asked: ${d.message()}`); void d.dismiss(); });
  await standIn(page);
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
  // The restore's commit refused once by the store (its write of the machine's record, from the restore's plan).
  await page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const put = Store.prototype.put;
    let armed = true;
    Store.prototype.put = function (this: unknown, kind: string, value: unknown) {
      if (armed && kind === 'machines' && /\/web\/app\/snapshots\.ts/.test(new Error().stack ?? '')) {
        armed = false;
        return Promise.reject(new DOMException('the storage is full', 'QuotaExceededError'));
      }
      return put.call(this, kind, value);
    };
  });
  const id = await page.evaluate(() => window.__waarm64FromTemplate!('/site/alpine/definition.json', 'snapshot.json'));
  await page.waitForFunction(() => document.body.dataset.state === 'failed', null, { timeout: 30_000, polling: 50 });
  const record = () => page.evaluate(async (id) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    const m = await store.get('machines', id);
    return { restoreFirst: m.restoreFirst as string | undefined };
  }, id);
  assert.equal(await page.evaluate(() => (window as unknown as { __starts: unknown[] }).__starts.length), 0, 'no boot instead');
  assert.ok((await record()).restoreFirst, 'the mark stays');
  await page.locator('#message-actions button', { hasText: t('machine:problems.retry') }).click();
  await page.waitForFunction(() => (window as unknown as { __starts: unknown[] }).__starts.length === 1, null, { timeout: 30_000, polling: 50 });
  const starts = await page.evaluate(() => (window as unknown as { __starts: Start[] }).__starts);
  assert.deepEqual(starts.map((x) => x.snapshot), [true], 'Retry restores the template');
  await page.waitForFunction(() => document.body.dataset.state === 'off', null, { timeout: 30_000, polling: 50 });
  assert.equal((await record()).restoreFirst, undefined, 'loaded: the mark cleared');
  assert.deepEqual(errors, []);
  await visitor.close();
});
