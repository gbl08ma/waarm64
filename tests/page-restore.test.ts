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
import { openHome } from './page-home.ts';

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

/**
 * The machine worker as a stand-in: each start is recorded (`window.__starts`) and answered "off"; a stop, "stopped".
 * `failing`: the first that many snapshot starts are answered as a start that failed with the disk in use, before the
 * snapshot loaded.
 */
const standIn = (page: Page, failing = 0, unrecorded = 0) => page.addInitScript(([failing, unrecorded]) => {
  let fails = failing;
  let refusals = unrecorded;
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
        if (msg.snapshot && fails-- > 0)
          return answer({ type: 'state', state: 'failed', problem: 'disk-in-use', error: { name: 'Error', text: 'the disk is in use' } });
        // `unrecorded`: the page's record of the load refused, as the storage full does (`refuseRecords`).
        if (msg.snapshot) (window as unknown as { __unrecorded: boolean }).__unrecorded = refusals-- > 0;
        if (msg.snapshot) answer({ type: 'loaded', phases: {} });
        answer({ type: 'state', state: 'off' });
      }
      if (msg.type === 'stop') answer({ type: 'stopped' });
    }
  };
}, [failing, unrecorded] as const);

/** The store refuses the next write of a machine's record with no restore to undo while the stand-in says so (`unrecorded`). */
const refuseRecords = (page: Page) => page.evaluate(async () => {
  const { Store } = await import('/web/app/store.ts' as string);
  const w = window as unknown as { __unrecorded?: boolean };
  const refused = (kind: string, value: { restoring?: unknown } | undefined) => {
    if (!w.__unrecorded || kind !== 'machines' || !value || value.restoring !== undefined) return false;
    w.__unrecorded = false;
    return true;
  };
  const full = () => new DOMException('the storage is full', 'QuotaExceededError');
  const put = Store.prototype.put;
  Store.prototype.put = function (this: unknown, kind: string, value: { restoring?: unknown }) {
    return refused(kind, value) ? Promise.reject(full()) : put.call(this, kind, value);
  };
  const update = Store.prototype.update;
  Store.prototype.update = function (this: unknown, kind: string, id: string, f: (was: unknown) => { restoring?: unknown } | undefined) {
    return update.call(this, kind, id, (was: unknown) => {
      const next = f(was);
      if (refused(kind, next)) throw full();
      return next;
    });
  };
});

/** A stored machine with a blank disk and one overlay of it chosen, made through the page's modules; its ids. */
const blankMachine = (page: Page, name: string) => page.evaluate(async (name) => {
  const { Store } = await import('/web/app/store.ts' as string);
  const { attach, createDisk, createMachine } = await import('/web/app/machines.ts' as string);
  const { createOverlay, switchOverlay } = await import('/web/app/disks.ts' as string);
  const store = await Store.open();
  const m = await createMachine(store, { name });
  const d = await createDisk(store, { kind: 'blank', size: 1 << 20, name: 'Scratch' }); // i18n-ignore: a name the test gives
  const a = await attach(store, m, d);
  const o = await createOverlay(store, d, 'First');
  await switchOverlay(store, m, a.id, o.id);
  store.close();
  return { m: m.id as string, a: a.id as string, o: o.id as string };
}, name);

/** Machine `id`'s record as the store has it: its first attachment's overlay, its restore to undo, the overlays there are. */
const recordOf = (page: Page, id: string) => page.evaluate(async (id) => {
  const { Store } = await import('/web/app/store.ts' as string);
  const store = await Store.open();
  const r = await store.get('machines', id);
  const overlays = await store.all('overlays');
  store.close();
  return { overlay: r.attachments[0].overlay as string, restoring: !!r.restoring, overlays: (overlays as { id: string }[]).map((o) => o.id).sort() };
}, id);

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
  await page.goto(`${base}/web/app/?autostart=1`);
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
  await page.goto(`${base}/web/app/?autostart=1&m=${ids.m}`);
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
  await openHome(page);
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
  await page.goto(`${base}/web/app/?autostart=1`);
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
  await page.goto(`${base}/web/app/?autostart=1&m=${ids.m}`);
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

// Review disk-locks 5: Retry after a restore's start failed (the disk in use, a file disk's permission) restarted the
// machine: a boot on the disks it had (the restore's forks undone), under a headline that said the restore failed.
test("Retry after a restore's start failed restores the snapshot again, not a boot", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await standIn(page, 1);
  await answerAsks(page); // Restore: yes; keep the overlay (so the restore forks): yes
  await page.goto(`${base}/web/app/?autostart=1`);
  const ids = await page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { attach, createDisk, createMachine } = await import('/web/app/machines.ts' as string);
    const { createOverlay, switchOverlay } = await import('/web/app/disks.ts' as string);
    const store = await Store.open();
    const m = await createMachine(store, { name: 'Retried' });
    const d = await createDisk(store, { kind: 'blank', size: 1 << 20, name: 'Scratch' }); // i18n-ignore: a name the test gives
    const a = await attach(store, m, d);
    const o = await createOverlay(store, d, 'First');
    await switchOverlay(store, m, a.id, o.id);
    store.close();
    return { m: m.id as string, o: o.id as string };
  });
  await page.goto(`${base}/web/app/?autostart=1&m=${ids.m}`);
  await stateIs(page, 'off');
  const sid = await keepSnapshot(page, ids.m, { overlay: `overlays/${ids.o}`, generation: 7, blocks: 0 });
  await page.evaluate(async (sid) => {
    const { page: p } = await import('/web/app/page.ts' as string);
    await p.restoreKept(sid);
  }, sid);
  await stateIs(page, 'failed');
  await page.locator('#message-actions button', { hasText: t('machine:problems.retry') }).click();
  await page.waitForFunction(() => (window as unknown as { __starts: unknown[] }).__starts.length === 3, null, { timeout: 30_000, polling: 50 });
  await stateIs(page, 'off');
  const all = await starts(page);
  assert.deepEqual(all.map((x) => x.snapshot), [false, true, true], 'the boot at the page load, the restore, the restore again');
  const rec = await page.evaluate(async (m) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    const r = await store.get('machines', m);
    const overlays = await store.all('overlays');
    store.close();
    return { overlay: r.attachments[0].overlay as string, restoring: r.restoring as unknown, overlays: (overlays as { id: string }[]).map((o) => o.id) };
  }, ids.m);
  assert.equal(all[2].disks[0].overlay, `overlays/${rec.overlay}`, 'the second restore starts on the fork it attached');
  assert.notEqual(rec.overlay, ids.o);
  assert.deepEqual(rec.overlays.sort(), [ids.o, rec.overlay].sort(), "the first restore's fork undone");
  assert.equal(rec.restoring, undefined, "the second's the machine's once it loaded");
  assert.deepEqual(errors, []);
  await context.close();
});

// Review disk-locks 4: Import changes into another machine held no lock (it could start in another tab while the
// question was open or the file loaded) and wrote back the record the click had, reverting what was written since.
test('Import changes into another machine keeps what was written to its record since the click, and is refused when it starts meanwhile', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const other = await context.newPage(); // another tab, same browser profile
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await standIn(page);
  let startElsewhere = false;
  await answerAsks(page, () => {
    // While the question is open, the machine starts in the other tab (it takes the machine's lock).
    if (startElsewhere)
      return other.evaluate((id) => new Promise<boolean>((held) => {
        void navigator.locks.request(`waarm64-machine:${id}`, () => (held(true), new Promise(() => {})));
      }), ids.x) as unknown as boolean; // exposeFunction waits for a promise: the answer once the lock is held
    return true;
  });
  await page.goto(`${base}/web/app/?autostart=1`);
  await other.goto(`${base}/web/app/`);
  const ids = await page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { attach, createDisk, createMachine } = await import('/web/app/machines.ts' as string);
    const { createOverlay, switchOverlay } = await import('/web/app/disks.ts' as string);
    const store = await Store.open();
    const x = await createMachine(store, { name: 'Target' });
    const d = await createDisk(store, { kind: 'blank', size: 1 << 20, name: 'Scratch' }); // i18n-ignore: a name the test gives
    const a = await attach(store, x, d);
    const o = await createOverlay(store, d, 'First');
    await switchOverlay(store, x, a.id, o.id);
    store.close();
    return { x: x.id as string, a: a.id as string, o: o.id as string };
  });
  await stateIs(page, 'idle');
  /** Exports the target's changes, then calls Import changes with the record as read at the click, edited since. */
  const importStale = (rename: string) => page.evaluate(async ([ids, rename]) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const disks = await import('/web/app/disks.ts' as string);
    const { runExport } = await import('/web/app/export.ts' as string);
    const { page: p } = await import('/web/app/page.ts' as string);
    const store = await Store.open();
    const clicked = await store.get('machines', ids.x);
    const d = await store.get('disks', clicked.attachments[0].disk);
    const r = await runExport({ mode: 'changes', compress: false, disk: await disks.diskRef(d, clicked.attachments[0].overlay), baseName: d.name }, () => {});
    await store.put('machines', { ...clicked, name: rename, modified: Date.now() }); // another tab's edit since the click
    await p.importChanges(new File([r.blob], 'changes.qcow2'), { machine: clicked, attachment: ids.a });
    const after = await store.get('machines', ids.x);
    store.close();
    return { name: after.name as string, overlay: after.attachments[0].overlay as string };
  }, [ids, rename] as const);
  const first = await importStale('Renamed elsewhere');
  assert.equal(first.name, 'Renamed elsewhere', 'the edit made since the click stays');
  assert.notEqual(first.overlay, ids.o, 'switched to the imported overlay');
  startElsewhere = true;
  const second = await importStale('Renamed again');
  await barSays(page, words('disks:disk-changes.changes.runsElsewhere', { name: 'Renamed elsewhere' }, { start: true }));
  assert.equal(second.overlay, first.overlay, 'started meanwhile: nothing switched');
  assert.deepEqual(errors, []);
  await context.close();
});

// Review disk-locks 1 (the start's side): a start opened the overlays the record named when the page read it, before it
// took the machine's lock; an overlay a merge or a delete took away in between was opened anew, no record naming it.
test("a start opens its machine's record as it is once it holds the machine's lock, not as the page read it", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await standIn(page);
  // The GPU worker as a stand-in that says it's ready only when the test says so: the start waits for it, after the
  // page read the record and before it takes the machine's lock.
  await page.addInitScript(() => {
    const Real = window.Worker;
    window.Worker = class extends Real {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (!/\/gpu-worker\.ts/.test(String(url))) return;
        (window as unknown as { __gpuGo: () => void }).__gpuGo = () =>
          this.onmessage?.(new MessageEvent('message', { data: { type: 'ready', caps: new Uint8Array(0), renderer: 'stand-in' } }));
      }
      postMessage(m: unknown, t?: unknown) {
        if ((m as { type?: string }).type === 'init') return; // the stand-in's: nothing reaches a real one
        super.postMessage(m as never, t as never);
      }
    };
  });
  await page.goto(`${base}/web/app/?autostart=1`);
  const ids = await page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { attach, createDisk, createMachine } = await import('/web/app/machines.ts' as string);
    const { createOverlay, switchOverlay } = await import('/web/app/disks.ts' as string);
    const store = await Store.open();
    const m = await createMachine(store, { name: 'In 3D', display: '3d' });
    const d = await createDisk(store, { kind: 'blank', size: 1 << 20, name: 'Scratch' }); // i18n-ignore: a name the test gives
    const a = await attach(store, m, d);
    const o = await createOverlay(store, d, 'Taken away');
    await switchOverlay(store, m, a.id, o.id);
    store.close();
    return { m: m.id as string, o: o.id as string };
  });
  await page.goto(`${base}/web/app/?autostart=1&m=${ids.m}`);
  await page.waitForFunction(() => typeof (window as unknown as { __gpuGo?: unknown }).__gpuGo === 'function', null, { timeout: 30_000, polling: 50 });
  // Meanwhile another tab merges the overlay into the blank disk (what its records then say): the disk a stored disk
  // of its blocks, the overlay gone, the machine left without one.
  await page.evaluate(async (o) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { deleteOverlayAsked } = await import('/web/app/disks.ts' as string);
    const store = await Store.open();
    const d = await store.get('disks', (await store.get('overlays', o)).disk);
    await deleteOverlayAsked(store, o);
    await store.put('disks', { ...d, kind: 'stored', identity: { kind: 'stored', id: d.id, bytes: 0 }, generation: 1, bytes: 0 });
    store.close();
  }, ids.o);
  await page.evaluate(() => (window as unknown as { __gpuGo: () => void }).__gpuGo());
  await page.waitForFunction(() => (window as unknown as { __starts: unknown[] }).__starts.length === 1, null, { timeout: 30_000, polling: 50 });
  const [start] = await starts(page);
  const rec = await page.evaluate(async (m) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    const r = await store.get('machines', m);
    store.close();
    return r.attachments[0].overlay as string;
  }, ids.m);
  assert.notEqual(start.disks[0].overlay, `overlays/${ids.o}`, 'not the deleted overlay, made anew');
  assert.equal(start.disks[0].overlay, `overlays/${rec}`, 'the new overlay its record names');
  assert.ok('stored' in start.disks[0].source, `over the disk as it is now, stored: ${JSON.stringify(start.disks[0].source)}`);
  assert.deepEqual(errors, []);
  await context.close();
});

// Review restore-marks 4: a `loaded` whose record couldn't be written (the storage full) was only logged; the machine ran
// on, and its next load undid the restore it ran on, deleting the fork with what the guest wrote.
test("a restore that loaded but couldn't be recorded stops the machine, says so, and its Retry restores the snapshot again", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await standIn(page, 0, 1);
  await answerAsks(page);
  await page.goto(`${base}/web/app/?autostart=1`);
  const ids = await blankMachine(page, 'Unrecorded');
  await page.goto(`${base}/web/app/?autostart=1&m=${ids.m}`);
  await stateIs(page, 'off');
  await refuseRecords(page);
  const sid = await keepSnapshot(page, ids.m, { overlay: `overlays/${ids.o}`, generation: 7, blocks: 0 });
  await page.evaluate(async (sid) => {
    const { page: p } = await import('/web/app/page.ts' as string);
    await p.restoreKept(sid);
  }, sid);
  await barSays(page, words('snapshots:restore-loaded.notRecorded'), words('snapshots:restore-loaded.notRecorded.cause'));
  await stateIs(page, 'failed');
  const unrecorded = await recordOf(page, ids.m);
  assert.ok(unrecorded.restoring, 'still a restore that never loaded');
  await page.locator('#message-actions button', { hasText: t('machine:problems.retry') }).click();
  await page.waitForFunction(() => (window as unknown as { __starts: unknown[] }).__starts.length === 3, null, { timeout: 30_000, polling: 50 });
  await stateIs(page, 'off');
  assert.deepEqual((await starts(page)).map((x) => x.snapshot), [false, true, true], 'the boot at the page load, the restore, the restore again');
  const rec = await recordOf(page, ids.m);
  assert.equal(rec.restoring, false, 'recorded once it loaded');
  assert.ok(!rec.overlays.includes(unrecorded.overlay), "the unrecorded restore's fork undone");
  assert.deepEqual(rec.overlays, [ids.o, rec.overlay].sort());
  assert.deepEqual(errors, []);
  await context.close();
});

// Review restore-marks 5: `Runner.again` outlived the failure it was set for: after a failed restore, Import changes on
// the page's machine stopped it, failed, and its Retry ran the old restore.
test("Retry after a failed restore is no restore once something else stopped the machine (Import changes, refused)", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const other = await context.newPage(); // another tab, same browser profile
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await standIn(page, 1);
  await answerAsks(page);
  await page.goto(`${base}/web/app/?autostart=1`);
  await other.goto(`${base}/web/app/`);
  const ids = await blankMachine(page, 'Retried');
  await page.goto(`${base}/web/app/?autostart=1&m=${ids.m}`);
  await stateIs(page, 'off');
  const sid = await keepSnapshot(page, ids.m, { overlay: `overlays/${ids.o}`, generation: 7, blocks: 0 });
  await page.evaluate(async (sid) => {
    const { page: p } = await import('/web/app/page.ts' as string);
    await p.restoreKept(sid);
  }, sid);
  await stateIs(page, 'failed'); // the restore's start failed: its Retry would restore again
  // The machine starts in the other tab meanwhile: Import changes here stops it and finds it held.
  await other.evaluate((id) => new Promise<void>((held) => {
    void navigator.locks.request(`waarm64-machine:${id}`, () => (held(), new Promise<void>((r) => { (window as unknown as { release: () => void }).release = r; })));
  }), ids.m);
  await page.evaluate(async (ids) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const disks = await import('/web/app/disks.ts' as string);
    const { runExport } = await import('/web/app/export.ts' as string);
    const { page: p } = await import('/web/app/page.ts' as string);
    const store = await Store.open();
    const m = await store.get('machines', ids.m);
    const d = await store.get('disks', m.attachments[0].disk);
    const r = await runExport({ mode: 'changes', compress: false, disk: await disks.diskRef(d, ids.o), baseName: d.name }, () => {});
    store.close();
    await p.importChanges(new File([r.blob], 'changes.qcow2'), { machine: m, attachment: ids.a });
  }, ids);
  await barSays(page, words('machine:machine-hold.runsElsewhere', { name: 'Retried' }));
  await other.evaluate(() => (window as unknown as { release: () => void }).release());
  await page.locator('#message-actions button', { hasText: t('machine:problems.retry') }).click();
  await page.waitForFunction(() => (window as unknown as { __starts: unknown[] }).__starts.length === 3, null, { timeout: 30_000, polling: 50 });
  assert.deepEqual((await starts(page)).map((x) => x.snapshot), [false, true, false], "Retry starts the machine: the restore's failure is behind it");
  assert.deepEqual(errors, []);
  await context.close();
});

// Review restore-marks 9: a start that found its machine held off by Delete overlay, a resize or Import changes said it
// runs in another tab.
test('a start that finds its machine held off by a change to its disks says that, not that it runs in another tab', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await standIn(page);
  await page.goto(`${base}/web/app/?autostart=1`);
  const ids = await blankMachine(page, 'Held');
  await page.goto(`${base}/web/app/?autostart=1&m=${ids.m}`);
  await stateIs(page, 'off');
  await page.evaluate(async (id) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { holdMachines } = await import('/web/app/machine-hold.ts' as string);
    const store = await Store.open();
    const held = await holdMachines([await store.get('machines', id)]);
    store.close();
    (window as unknown as { release: () => void }).release = held.release;
    const { page: p } = await import('/web/app/page.ts' as string);
    await p.restart();
  }, ids.m);
  await barSays(page, words('machine:worker-errors.diskInUse', { machine: 'Held' }), words('machine:machine-hold.diskChanging.cause'));
  await page.evaluate(() => (window as unknown as { release: () => void }).release());
  await page.locator('#message-actions button', { hasText: t('machine:problems.retry') }).click();
  await page.waitForFunction(() => (window as unknown as { __starts: unknown[] }).__starts.length === 2, null, { timeout: 30_000, polling: 50 });
  assert.deepEqual(errors, []);
  await context.close();
});

// Review restore-records 7: Reset disk after a restore that never loaded deleted the restore's fork, and the next
// start's undo put the machine back on the overlay it had: the disk wasn't reset.
test('Reset disk after a restore that never loaded resets the disk the machine is on, the one the undo puts it back on', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await standIn(page, 1); // the restore's start fails (the disk in use) before the snapshot loaded
  await answerAsks(page); // Restore: yes; keep the overlay (it forks): yes; Reset: yes
  await page.goto(`${base}/web/app/?autostart=1`);
  const ids = await blankMachine(page, 'Resettable');
  await page.goto(`${base}/web/app/?autostart=1&m=${ids.m}`);
  await stateIs(page, 'off');
  const sid = await keepSnapshot(page, ids.m, { overlay: `overlays/${ids.o}`, generation: 7, blocks: 0 });
  await page.evaluate(async (sid) => {
    const { page: p } = await import('/web/app/page.ts' as string);
    await p.restoreKept(sid);
  }, sid);
  await stateIs(page, 'failed');
  const cut = await recordOf(page, ids.m);
  assert.ok(cut.restoring && cut.overlay !== ids.o, 'on the fork, its restore to undo');
  await page.evaluate(async () => {
    const { page: p } = await import('/web/app/page.ts' as string);
    await p.resetDisk();
  });
  await page.waitForFunction(() => (window as unknown as { __starts: unknown[] }).__starts.length === 3, null, { timeout: 30_000, polling: 50 });
  await stateIs(page, 'off');
  const all = await starts(page);
  assert.deepEqual(all.map((x) => x.snapshot), [false, true, false], 'the boot at the page load, the restore, the boot after the reset');
  const rec = await recordOf(page, ids.m);
  assert.notEqual(all[2].disks[0].overlay, `overlays/${ids.o}`, 'not on the overlay it had: that one was reset');
  assert.equal(all[2].disks[0].overlay, `overlays/${rec.overlay}`);
  assert.deepEqual(rec.overlays, [rec.overlay], 'the fork undone, the overlay it had deleted, a new empty one');
  assert.equal(rec.restoring, false);
  assert.deepEqual(errors, []);
  await context.close();
});
