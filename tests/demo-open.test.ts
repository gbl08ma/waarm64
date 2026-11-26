// A demo's machine as the page finds it (docs/frontend.md "The demo store", docs/machines.md §6.2), in Node with the
// in-memory store and overlays: "started before" says whether it has changes since the demo started (none: not started
// yet, or its overlays the template's forks as its first restore left them; disk: written since, or another overlay;
// suspended), a start's check of its disks says only that its files are gone (`goneOnly`), and a template's first start
// whose restore never loaded leaves the overlay it wrote into no fork of the template (`undoCutRestores`).
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { changesOf, checkDisks, isGone } from '../web/app/demo-open.ts';
import { createOverlay } from '../web/app/disks.ts';
import { attach, createDisk, createMachine } from '../web/app/machines.ts';
import { undoCutRestores } from '../web/app/snapshot-undo.ts';
import { machineDir, overlayDir, Store, type OverlayRecord } from '../web/app/store.ts';
import { memoryFiles, memoryRecords } from '../web/app/store-backends.ts';
import { msgOf } from '../web/msg.ts';
import { dropSuspend, openOverlay, overlayMeta, readMeta, suspendWriter, writeMeta } from '../web/overlay.ts';
import type { MachineRecord } from '../web/app/shape.ts';

const MiB = 2 ** 20;
const MANIFEST = 'https://disks.example/alpine/manifest.json';
const fresh = () => new Store(memoryRecords(), memoryFiles(), { channel: false });

/** A demo's machine with one chunked URL disk under an overlay marked as the template's fork (`restoreFirst`'s, generation 1). */
async function demoMachine(s: Store) {
  const m = await createMachine(s, { name: 'Alpine', ncpus: 1, ramMiB: 512, display: '2d', network: false, usb: false, mouse: false, touch: false, shares: false });
  const d = await createDisk(s, { kind: 'url', url: MANIFEST, size: 256 * MiB, bytes: 80 * MiB, chunked: 'ab'.repeat(32) });
  await attach(s, m, d);
  const rec = (await s.get('machines', m.id))!;
  const o = await createOverlay(s, d, 'Template', { snapshot: 'template', generation: 1 });
  const overlay = o.id;
  const attachments = rec.attachments.map((a) => ({ ...a, overlay }));
  const marked: MachineRecord = { ...rec, attachments, fromDemo: { store: 'https://disks.example/store.json', id: 'alpine-term' } };
  await s.put('machines', marked);
  return { m: marked, overlay };
}

/** Sets overlay `id`'s files' generation (what the device worker bumps before an opening's first change). */
async function setGeneration(id: string, generation: number, token?: string) {
  const f = await openOverlay(overlayDir(id), undefined);
  writeMeta(f.meta, { ...readMeta(f.meta), generation, ...(token ? { token } : {}) });
  f.close();
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
/** `fetch` answering every URL with `status` (or refusing: `undefined`), the URLs asked kept in `asked`. */
function answer(status: number | undefined, asked: string[] = []) {
  globalThis.fetch = (async (url: string | URL) => {
    asked.push(String(url));
    if (status === undefined) throw new TypeError('fetch failed');
    return new Response('{}', { status });
  }) as typeof fetch;
  return asked;
}

test('changes: none before the first start and while the overlay is the fork its restore left; disk once written or another overlay; suspended', async () => {
  const s = fresh();
  const { m, overlay } = await demoMachine(s);
  assert.equal(await changesOf(s, { ...m, restoreFirst: 'template' }), 'none', 'made, not started: the demo as it is');
  await setGeneration(overlay, 1); // the first restore wrote the fork
  assert.equal(await changesOf(s, m), 'none', 'the fork as the restore left it');
  await setGeneration(overlay, 2); // the guest wrote
  assert.equal(await changesOf(s, m), 'disk');
  await setGeneration(overlay, 1);
  const o = (await s.get('overlays', overlay)) as OverlayRecord;
  await s.put('overlays', { ...o, fork: undefined });
  assert.equal(await changesOf(s, m), 'disk', 'an overlay that is no fork of the template: the user\'s');
  const w = await suspendWriter(machineDir(m.id));
  await w.write(new Uint8Array([1, 2, 3]));
  w.close();
  assert.equal(await changesOf(s, m), 'suspended', 'a suspended copy: it resumes where it was');
  await dropSuspend(machineDir(m.id));
});

test("a start's check says only that a demo's files are gone; the store's Open my machine says the server down too", async () => {
  const s = fresh();
  const { m } = await demoMachine(s);
  const asked = answer(200);
  await checkDisks(s, m, { goneOnly: true });
  assert.deepEqual(asked, [MANIFEST], "the chunked disk's manifest, nothing else");
  answer(404);
  const gone = await checkDisks(s, m, { goneOnly: true }).then(() => undefined, (e: unknown) => e);
  assert.ok(isGone(gone), `gone: ${String(gone)}`);
  assert.equal(msgOf(gone)?.key, 'machines:template.gone');
  answer(undefined);
  await checkDisks(s, m, { goneOnly: true }); // unreachable: the start goes on (the guest's reads say it, or the cache serves them)
  const down = await checkDisks(s, m).then(() => undefined, (e: unknown) => e);
  assert.ok(msgOf(down) && !isGone(down), `Open my machine: the server down, said: ${String(down)}`);
  answer(500);
  await checkDisks(s, m, { goneOnly: true });
});

test("a template's first start whose restore never loaded (it booted instead, or was cut off): the overlay it wrote into is no fork of the template at the next load, and reads as empty", async () => {
  const s = fresh();
  const { m, overlay } = await demoMachine(s);
  // The first restore's commit, into the machine's fresh overlay (no fork of the template until it loaded).
  const { fork: _, ...unforked } = (await s.get('overlays', overlay))!;
  await s.put('overlays', unforked);
  const token = 'ab12cd34ef56';
  const committed: MachineRecord = { ...m, restoring: [{ attachment: m.attachments[0].id, how: 'into', overlay, generation: 0, fork: { snapshot: 'template', name: 'Template' }, token }] };
  await s.put('machines', committed);
  await setGeneration(overlay, 1, token); // its fill done (its token left in the meta), its RAM never loaded
  await navigator.locks.request(`waarm64-overlay:${overlayDir(overlay)}`, async () => {}); // let go
  const after = await undoCutRestores(s, committed);
  assert.equal(after.attachments[0].overlay, overlay, 'the machine keeps the overlay');
  assert.equal(after.restoring, undefined, 'its restore undone');
  const o = (await s.get('overlays', overlay))!;
  assert.equal(o.fork, undefined, 'no fork of the snapshot');
  assert.equal(await changesOf(s, after), 'disk', 'started before: not the demo as it was');
  assert.equal((await overlayMeta(overlayDir(overlay))).filling, true, 'marked as a fill cut off: its next opening reads it as empty');
  assert.equal((await s.get('machines', m.id))!.attachments[0].overlay, overlay);
});
