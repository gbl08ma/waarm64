// Disks kept in the browser, without a guest (docs/machines.md §3, §4): web/app/disks.ts in Chromium over
// IndexedDB and OPFS. An image imported as a stored disk (qcow2 with compressed clusters, and raw) exports as the
// same disk (`qemu-img compare` against the file, raw, qcow2 compressed or not); a disk's overlays as named variants
// (new, rename, switch, delete). The flows with a guest are tests/page-machines.test.ts's.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';

const qemuImg = (() => { try { execFileSync('qemu-img', ['--version']); return true; } catch { return false; } })();

let browser: Browser;
let base: string;
let close: () => void;
let dir: string;
before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  dir = mkdtempSync(join(tmpdir(), 'webpc-disks-'));
});
after(async () => { await browser?.close(); close?.(); if (dir) rmSync(dir, { recursive: true }); });

async function fresh() {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${base}/tests/browser/core.html`);
  return { context, page };
}

/** Imports the fixture `name` as a stored disk in the page and exports it in `modes`; returns the record and the files' bytes. */
const importAndExport = (page: Page, name: string, modes: { mode: string; compress?: boolean }[]) => page.evaluate(async ({ name, modes }) => {
  const { Store } = await import('/web/app/store.ts' as string);
  const { importStored, estimateStored, diskRef } = await import('/web/app/disks.ts' as string);
  const { runExport } = await import('/web/app/export.ts' as string);
  const store = await Store.open();
  const file = new File([await (await fetch(`/tests/qcow2/${name}`)).arrayBuffer()], name);
  const estimate = await estimateStored(file);
  const progress: number[] = [];
  const d = await importStored(store, file, (f: number) => progress.push(f));
  const outs: number[][] = [];
  for (const m of modes) {
    const r = await runExport({ mode: m.mode, compress: m.compress, disk: await diskRef(d), baseName: name }, () => {});
    outs.push([...new Uint8Array(await r.blob.arrayBuffer())]);
  }
  const stored = await store.files.size(`disks/${d.id}`);
  store.close();
  return { d: { kind: d.kind, size: d.size, format: d.format, name: d.name }, estimate, outs, stored, progressed: progress.length > 0 };
}, { name, modes });

test('an image imported into the browser exports as the same disk (raw, and qcow2 compressed or not), checked with qemu-img', { skip: !qemuImg && 'SKIPPED: no qemu-img' }, async () => {
  const { context, page } = await fresh();
  for (const name of ['deflate.qcow2', 'data.raw']) {
    const fixture = new URL(`qcow2/${name}`, import.meta.url).pathname;
    const r = await importAndExport(page, name, [{ mode: 'raw' }, { mode: 'qcow2', compress: true }, { mode: 'qcow2' }]);
    const info = JSON.parse(execFileSync('qemu-img', ['info', '--output=json', fixture]).toString()) as { 'virtual-size': number; format: string };
    assert.deepEqual(r.d, { kind: 'stored', size: info['virtual-size'], format: info.format === 'qcow2' ? 'qcow2' : 'raw', name });
    assert.equal(r.estimate.size, info['virtual-size']);
    assert.ok(r.stored > 0 && r.stored <= r.estimate.estimate + 64 * 1024, `${name}: stored ${r.stored} bytes, estimated ${r.estimate.estimate}`);
    r.outs.forEach((bytes, i) => {
      const out = join(dir, `${name}-${i}.${i ? 'qcow2' : 'raw'}`);
      writeFileSync(out, Buffer.from(bytes));
      if (i) execFileSync('qemu-img', ['check', out]);
      // `compare` exits non-zero when the disks' contents differ (it reads both through their formats).
      execFileSync('qemu-img', ['compare', '-q', fixture, out]);
    });
  }
  await context.close();
});

test("a disk's overlays are named variants: new, rename, switch, delete (a machine that had it chosen is left without one)", async () => {
  const { context, page } = await fresh();
  const r = await page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { createOverlay, renameOverlay, switchOverlay, deleteOverlay, inUse } = await import('/web/app/disks.ts' as string);
    const store = await Store.open();
    const d = { id: 'd0000000000a', kind: 'url', name: 'disk.img', size: 1 << 20, url: '/x', identity: { kind: 'url', path: '/x', bytes: 1 << 20 }, created: 0 };
    await store.put('disks', d);
    const a = await createOverlay(store, d, 'Changes');
    const b = await createOverlay(store, d, 'Experiment');
    const m = { id: 'aaaaaaaaaaab', name: 'M', ncpus: 1, ramMiB: 512, display: '2d', network: false, created: 0, modified: 0, attachments: [{ id: 'a0000000000a', disk: d.id, readOnly: false, overlay: a.id }] };
    await store.put('machines', m);
    await renameOverlay(store, b.id, 'Try it');
    await switchOverlay(store, m, 'a0000000000a', b.id);
    const switched = (await store.get('machines', m.id)).attachments[0].overlay === b.id;
    let refused = '';
    await switchOverlay(store, m, 'a0000000000a', 'ffffffffffff').catch((e: { msg?: { key: string } }) => { refused = e.msg?.key ?? String(e); });
    // A machine running on it (its overlay open, as a device worker holds it): deleting is refused.
    const files = await new Promise<{ close(): void }>((resolve) => {
      const w = new Worker('/tests/browser/overlay-worker.ts', { type: 'module' });
      w.onmessage = () => resolve({ close: () => w.terminate() });
      w.postMessage({ type: 'open', name: `overlays/${b.id}` });
    });
    const busy = await inUse(`overlays/${b.id}`);
    let running = '';
    await deleteOverlay(store, b.id).catch((e: { msg?: { key: string } }) => { running = e.msg?.key ?? String(e); });
    files.close();
    await new Promise((r) => setTimeout(r, 300));
    await deleteOverlay(store, b.id);
    const out = {
      names: (await store.overlaysOf(d.id)).map((o: { name: string }) => o.name),
      switched, refused, busy, running,
      left: (await store.get('machines', m.id)).attachments[0].overlay ?? null,
      files: await store.files.list('overlays'),
    };
    store.close();
    return out;
  });
  assert.deepEqual(r, { names: ['Changes'], switched: true, refused: 'disks:disks.notThisDisk', busy: true, running: 'disks:disks.overlayRunning', left: null, files: [] });
  await context.close();
});

test("a restore's plan: keep where the pin matches, fork where it moved on, reuse an unmoved fork, replace when asked; written in place, only at its generation or with the whole disk", async () => {
  const { context, page } = await fresh();
  const r = await page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { planRestore } = await import('/web/app/snapshots.ts' as string);
    const { createOverlay } = await import('/web/app/disks.ts' as string);
    const store = await Store.open();
    /** Sets overlay or store `path`'s generation, as machines would have left it. */
    const setGen = async (path: string, generation: number) => {
      const w = new Worker('/tests/browser/overlay-worker.ts', { type: 'module' });
      await new Promise<void>((resolve) => { w.onmessage = () => resolve(); w.postMessage({ type: 'meta', name: path, generation }); });
      w.terminate();
    };
    const d = { id: 'd0000000000b', kind: 'url', name: 'disk.img', size: 1 << 20, url: '/x', identity: { kind: 'url', path: '/x', bytes: 1 << 20 }, created: 0 };
    const s = { id: 'd0000000000c', kind: 'stored', name: 'stored.img', size: 1 << 20, identity: { kind: 'stored', id: 'd0000000000c', bytes: 0 }, created: 0 };
    await store.put('disks', d);
    await store.put('disks', s);
    const a = await createOverlay(store, d, 'Changes');
    const m = { id: 'aaaaaaaaaaac', name: 'M', ncpus: 1, ramMiB: 512, display: '2d', network: false, created: 0, modified: 0, attachments: [{ id: 'a0000000000b', disk: d.id, readOnly: false, overlay: a.id }, { id: 'a0000000000c', disk: s.id, readOnly: false, inPlace: true }] };
    await store.put('machines', m);
    const disks = new Map<string, unknown>([[d.id, d], [s.id, s]]);
    // Slots: rng, keyboard, tablet, gpu, snd, then the disks (5 and 6).
    const pins = (g: number, sg: number, whole = 0) => [{ slot: 5, overlay: `overlays/${a.id}`, generation: g, blocks: 3 }, { slot: 6, overlay: `disks/${s.id}`, generation: sg, blocks: whole }];
    await setGen(`overlays/${a.id}`, 4);
    await setGen(`disks/${s.id}`, 7);
    const out: Record<string, unknown> = {};
    const plan = async (p: unknown[], key = 'snap-1') => planRestore(store, structuredClone(m), disks, { name: 'snap', key, pins: p });
    // Everything as pinned: nothing written.
    const same = await plan(pins(4, 7));
    out.same = { kept: same.kept, forks: same.forks.length, plan: await same.commit(false) };
    // The overlay moved on: a fork, attached; the old overlay stays.
    const moved = await plan(pins(3, 7));
    const forkPlan = await moved.commit(false);
    const after = await store.get('machines', m.id);
    out.moved = { forks: moved.forks.map((f: { reused: boolean; replaceable?: { name: string } }) => [f.reused, f.replaceable?.name]), plan: forkPlan.map((p: { action: string; overlay?: string }) => [p.action, p.overlay === `overlays/${a.id}`]), attached: after.attachments[0].overlay !== a.id };
    const fork = after.attachments[0].overlay;
    // The fork hasn't moved since (its generation is still the restore's, 1): the same snapshot again reuses it.
    await setGen(`overlays/${fork}`, 1);
    const again = await planRestore(store, structuredClone({ ...m, attachments: [{ ...m.attachments[0], overlay: a.id }, m.attachments[1]] }), disks, { name: 'snap', key: 'snap-1', pins: pins(3, 7) });
    out.reused = { forks: again.forks.map((f: { reused: boolean }) => f.reused), plan: (await again.commit(false)).map((p: { action: string }) => p.action) };
    // Once it moved, it isn't reused; replace writes into the attached overlay instead of forking.
    await setGen(`overlays/${fork}`, 2);
    const replace = await planRestore(store, structuredClone({ ...m, attachments: [{ ...m.attachments[0], overlay: a.id }, m.attachments[1]] }), disks, { name: 'snap', key: 'snap-1', pins: pins(3, 7) });
    out.replace = { reused: replace.forks.map((f: { reused: boolean }) => f.reused), plan: (await replace.commit(true)).map((p: { action: string; overlay?: string }) => [p.action, p.overlay === `overlays/${a.id}`]) };
    // Written in place and moved on: refused without the whole disk, forked into an overlay with it.
    out.refused = (await plan(pins(4, 6))).refused?.key ?? null;
    const whole = await plan(pins(4, 6, 256));
    out.whole = (await whole.commit(false)).map((p: { action: string; whole?: boolean }) => [p.action, !!p.whole]);
    store.close();
    return out;
  });
  assert.deepEqual(r.same, { kept: ['disk.img', 'stored.img'], forks: 0, plan: [{ slot: 5, action: 'keep' }, { slot: 6, action: 'keep' }] });
  assert.deepEqual(r.moved, { forks: [[false, 'Changes']], plan: [['keep', false], ['write', false]], attached: true });
  assert.deepEqual(r.reused, { forks: [true], plan: ['keep', 'keep'] });
  assert.deepEqual(r.replace, { reused: [false], plan: [['keep', false], ['write', true]] });
  assert.equal(r.refused, 'snapshots:snapshots.writtenInPlace');
  assert.deepEqual(r.whole, [['keep', false], ['write', true]]);
  await context.close();
});
