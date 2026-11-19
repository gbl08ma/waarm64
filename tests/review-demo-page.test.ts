// Proof tests for REVIEW.md (review/demo-page): each fails on the code as reviewed. Node, memory stores, a fake `fetch`.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { exportDefinition, importDefinition, type Definition } from '../web/app/definitions.ts';
import { findDemo, parseStore, STORE_TYPE } from '../web/app/demo-store.ts';
import { machineFromDemo } from '../web/app/template.ts';
import { attach, createDisk, createMachine } from '../web/app/machines.ts';
import { Store } from '../web/app/store.ts';
import { memoryFiles, memoryRecords } from '../web/app/store-backends.ts';
import { CHUNKED_FORMAT } from '../web/chunked.ts';
import { msgOf } from '../web/msg.ts';

const MiB = 2 ** 20;
const ID = 'ab'.repeat(32);
const fresh = () => new Store(memoryRecords(), memoryFiles(), { channel: false });
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

/** A demo's definition (no snapshot unless given), its disk the chunked image `ID` at `url`. */
async function demoDef(url: string, demo: Record<string, unknown> = {}): Promise<Definition> {
  const s = fresh();
  const m = await createMachine(s, { name: 'Alpine', ncpus: 2, ramMiB: 512, display: '2d', network: true, usb: false, mouse: false, touch: false, shares: false });
  const d = await createDisk(s, { kind: 'url', url: 'http://localhost:4000/alpine/manifest.json', size: 256 * MiB, bytes: 80 * MiB, chunked: ID });
  await attach(s, m, d);
  const def = await exportDefinition(s, m.id);
  def.disks[0].url = url;
  return { ...def, demo: { id: 'alpine-term', summary: 'A terminal.', download: 1, view: 'serial', ...demo } };
}
const storeOf = (defs: Definition[], at: string) =>
  parseStore(JSON.stringify({ type: STORE_TYPE, version: 1, demos: defs }), at);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("R1: another store's demo claiming an image's content id doesn't decide where the project's demo reads its disk", async () => {
  const store = fresh();
  const evil = storeOf([await demoDef('https://evil.example/fake/manifest.json')], 'https://evil.example/store.json');
  await machineFromDemo(store, findDemo(evil, 'alpine-term')!);
  const ours = storeOf([await demoDef('alpine-term/manifest.json')], 'https://vmdisks.tny.im/store.json');
  const { machine } = await machineFromDemo(store, findDemo(ours, 'alpine-term')!);
  const disk = await store.get('disks', machine.attachments[0].disk);
  assert.equal(disk?.url, 'https://vmdisks.tny.im/alpine-term/manifest.json', "the project's demo reads another store's URL");
});

test("R2: a definition's blank disk whose identity names an existing record's id doesn't overwrite that record", async () => {
  const store = fresh();
  const base = await demoDef('https://disks.example/a/manifest.json');
  const blank = (bytes: number) => ({
    ...base,
    disks: [...base.disks, { kind: 'blank' as const, name: 'scratch', size: bytes, identity: { kind: 'blank' as const, id: 'aaaaaaaaaaaa', bytes }, readOnly: false, serial: '0123456789ab' }],
  });
  const a = await importDefinition(store, blank(MiB));
  await importDefinition(store, blank(2 * MiB));
  const disk = await store.get('disks', a.machine.attachments[1].disk);
  assert.equal(disk?.size, MiB, "machine A's blank disk was overwritten by B's import");
});

/** A chunked file of `bytes`: its manifest (id `id`, by default its real one) and its piece, served under `dir`. */
function chunked(dir: string, bytes: Uint8Array, id?: string) {
  const h = sha(bytes);
  const manifest = { format: CHUNKED_FORMAT, size: bytes.length, piece: MiB, pieces: '{hash}.bin', hashes: [h], id: id ?? sha(h) };
  return { manifest, files: { [`${dir}/${h}.bin`]: bytes } as Record<string, Uint8Array> };
}
function serve(files: Record<string, string | Uint8Array | (() => string)>) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const f = files[url];
    if (f === undefined) return new Response('no', { status: 404 });
    return new Response(typeof f === 'function' ? f() : (f as BodyInit));
  }) as typeof fetch;
}

test("R3a: a template snapshot manifest whose id isn't its content's is refused", async () => {
  const D = 'https://disks.example/alpine-term';
  const good = chunked(D, new Uint8Array(4096).fill(1));
  const other = chunked(D, new Uint8Array(4096).fill(2));
  const def = await demoDef('alpine-term/manifest.json', { snapshot: { manifest: 'alpine-term/snapshot.json', id: good.manifest.id } });
  const s = storeOf([def], 'https://disks.example/store.json');
  // (a) the manifest says the right id over other content
  serve({ [`${D}/snapshot.json`]: JSON.stringify({ ...other.manifest, id: good.manifest.id }), ...other.files });
  await assert.rejects(machineFromDemo(fresh(), findDemo(s, 'alpine-term')!), (e) => msgOf(e)?.key === 'machines:template.otherSnapshot', 'a forged id is taken');
});

test("R3b: the manifest swapped between template.ts's checked fetch and fetchChunked's is refused", async () => {
  const D = 'https://disks.example/alpine-term';
  const good = chunked(D, new Uint8Array(4096).fill(1));
  const other = chunked(D, new Uint8Array(4096).fill(2));
  const def = await demoDef('alpine-term/manifest.json', { snapshot: { manifest: 'alpine-term/snapshot.json', id: good.manifest.id } });
  const s = storeOf([def], 'https://disks.example/store.json');
  let n = 0;
  serve({ [`${D}/snapshot.json`]: () => JSON.stringify(n++ === 0 ? good.manifest : other.manifest), ...good.files, ...other.files });
  await assert.rejects(machineFromDemo(fresh(), findDemo(s, 'alpine-term')!), (e) => msgOf(e)?.key === 'machines:template.otherSnapshot', "the second manifest isn't checked");
});

test('R4: a template snapshot that fails to import (not a snapshot here; the storage full on the page) leaves no machine', async () => {
  const D = 'https://disks.example/alpine-term';
  const snap = chunked(D, new Uint8Array(4096).fill(3)); // its id is its content's: the download is fine
  const def = await demoDef('alpine-term/manifest.json', { snapshot: { manifest: 'alpine-term/snapshot.json', id: snap.manifest.id } });
  const s = storeOf([def], 'https://disks.example/store.json');
  serve({ [`${D}/snapshot.json`]: JSON.stringify(snap.manifest), ...snap.files });
  const store = fresh();
  await assert.rejects(machineFromDemo(store, findDemo(s, 'alpine-term')!));
  const left = await store.all('machines');
  assert.equal(left.length, 0, `a machine was left behind: ${JSON.stringify(left.map((m) => ({ name: m.name, fromDemo: m.fromDemo, restoreFirst: m.restoreFirst })))}`);
});
