// The definition format's version 2 and a store of demos (docs/machines.md §6.2; DEMO loop 4), in Node: version 1
// still reads (and loses a `demo` it shouldn't have), version 2's `demo` is checked field by field and a damaged one's
// error names the field; a store's relative URLs resolve against it, a single definition's URL is a store of one, a demo
// this page can't read is left out (said) while the rest show; a demo's machine is marked with where it came from, on
// the demo network when it asks, and a download that fails (gone, another snapshot) leaves no machine.
// The page's side (a machine from a store's demo restored at its first start): tests/page-template-first.test.ts.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { checkDefinition, exportDefinition, parseDefinition, type Definition } from '../web/app/definitions.ts';
import { demoMachines, fetchStore, findDemo, parseStore, STORE_TYPE, templatesOf } from '../web/app/demo-store.ts';
import { machineFromDemo, machineFromStoreTemplate } from '../web/app/template.ts';
import { attach, createDisk, createMachine } from '../web/app/machines.ts';
import { Connections } from '../web/app/connections.ts';
import { Store } from '../web/app/store.ts';
import { memoryFiles, memoryRecords } from '../web/app/store-backends.ts';
import { contentId, CHUNKED_FORMAT } from '../web/chunked.ts';
import { duplicateMachine } from '../web/app/machines.ts';
import { msgOf } from '../web/msg.ts';
import { createHash } from 'node:crypto';

const MiB = 2 ** 20;
const ID = 'ab'.repeat(32);
const SNAP = 'cd'.repeat(32);
const fresh = () => new Store(memoryRecords(), memoryFiles(), { channel: false });
const STORE_URL = 'https://disks.example/store.json';

/** A demo's definition as a store holds it: its URLs relative to the store. */
async function demoDef(over: Record<string, unknown> = {}): Promise<Definition> {
  const s = fresh();
  const m = await createMachine(s, { name: 'Alpine', ncpus: 2, ramMiB: 512, display: '2d', network: true, usb: false, mouse: false, touch: false, shares: false });
  const d = await createDisk(s, { kind: 'url', url: 'http://localhost:4000/alpine/manifest.json', size: 256 * MiB, bytes: 80 * MiB, chunked: ID });
  await attach(s, m, d);
  const def = await exportDefinition(s, m.id);
  def.disks[0].url = 'alpine-term/manifest.json';
  return {
    ...def,
    demo: { id: 'alpine-term', summary: 'A terminal.', thumbnail: 'alpine-term/thumb.webp', download: 30_000_000, view: 'serial', snapshot: { manifest: 'alpine-term/snapshot.json', id: SNAP }, network: 'demo', ...over },
  };
}

/** The cause's `field` of a damaged definition's error (what it names). */
function damagedField(f: () => unknown): unknown {
  try {
    f();
  } catch (e) {
    const m = msgOf(e);
    assert.equal(m?.key, 'machines:definition-check.damaged', String(e));
    return msgOf((e as Error).cause)?.params?.field;
  }
  assert.fail('not refused');
}

test('version 1 still reads, a demo in it left out; version 2 is what an export writes; a later one is refused', async () => {
  const def = await demoDef();
  assert.equal(def.version, 2, 'an export writes version 2');
  const v1 = { ...def, version: 1 };
  const read = parseDefinition(JSON.stringify(v1));
  assert.equal(read.version, 1);
  assert.equal('demo' in read, false, "version 1 has no demo: one there isn't read");
  assert.equal(read.machine.name, 'Alpine');
  assert.deepEqual(parseDefinition(JSON.stringify(def)).demo, def.demo);
  assert.throws(() => parseDefinition(JSON.stringify({ ...def, version: 3 })), /definition-check\.version/);
  assert.ok(checkDefinition({ ...def, later: { anything: 1 } }), 'a field it doesn\'t know is ignored');
});

test("a damaged definition's error names the field at fault: the machine's, a disk's, the demo's", async () => {
  const def = await demoDef();
  const bad = (f: (d: Definition & Record<string, unknown>) => void) => {
    const d = structuredClone(def) as Definition & Record<string, unknown>;
    f(d);
    return damagedField(() => checkDefinition(d));
  };
  assert.equal(bad((d) => (d.machine.ramMiB = 1)), 'machine.ramMiB');
  assert.equal(bad((d) => delete d.disks[0].url), 'disks[0].url', 'a URL disk has its URL');
  assert.equal(bad((d) => (d.disks[0].url = 'javascript:alert(1)')), 'disks[0].url');
  assert.equal(bad((d) => (d.disks[0].serial = 'x')), 'disks[0].serial');
  assert.equal(bad((d) => (d.demo!.id = 'Alpine Term')), 'demo.id', 'an id fits in a link');
  assert.equal(bad((d) => (d.demo!.view = 'tty' as 'serial')), 'demo.view');
  assert.equal(bad((d) => (d.demo!.download = 0)), 'demo.download');
  assert.equal(bad((d) => (d.demo!.summary = 'x'.repeat(1001))), 'demo.summary');
  assert.equal(bad((d) => (d.demo!.snapshot = { manifest: 's.json', id: 'short' })), 'demo.snapshot');
  assert.equal(bad((d) => (d.demo!.network = 'local' as 'demo')), 'demo.network');
  assert.equal(bad((d) => (d.demo!.replaces = ['alpine-term'])), 'demo.replaces', 'not itself');
  assert.equal(bad((d) => (d.demo!.template = 'yes' as unknown as boolean)), 'demo.template');
  assert.equal(bad((d) => (d.demo = 'yes' as unknown as Definition['demo'])), 'demo');
  assert.equal(
    bad((d) => {
      d.machine.network = false;
      delete d.machine.macs;
    }),
    'demo.network',
    'the demo network needs an adapter',
  );
  const { snapshot: _s, thumbnail: _t, network: _n, ...plain } = def.demo!;
  assert.ok(checkDefinition({ ...def, demo: plain }), 'snapshot, thumbnail and network are optional');
});

test("a store's URLs resolve against it; a demo it can't read is left out and said, the rest shown", async () => {
  const good = await demoDef();
  const next = await demoDef({ id: 'alpine-term-2', replaces: ['alpine-term'] });
  const newer = { ...(await demoDef({ id: 'later' })), version: 9 };
  const text = JSON.stringify({ type: STORE_TYPE, version: 1, name: 'Ours', demos: [good, newer, next, good, { ...good, demo: undefined }] });
  const s = parseStore(text, STORE_URL);
  assert.equal(s.name, 'Ours');
  assert.deepEqual(s.demos.map((d) => d.def.demo.id), ['alpine-term', 'alpine-term-2']);
  const d = findDemo(s, 'alpine-term')!;
  assert.equal(d.store, STORE_URL);
  assert.equal(d.def.disks[0].url, 'https://disks.example/alpine-term/manifest.json');
  assert.equal(d.def.demo.snapshot?.manifest, 'https://disks.example/alpine-term/snapshot.json');
  assert.equal(d.def.demo.thumbnail, 'https://disks.example/alpine-term/thumb.webp');
  assert.deepEqual(
    s.skipped.map((x) => [x.index, x.id, x.error.msg.key]),
    [
      [1, 'later', 'machines:definition-check.version'],
      [3, 'alpine-term', 'machines:demo-store.duplicate'],
      [4, undefined, 'machines:demo-store.notDemo'],
    ],
  );
});

test("a single demo definition's URL is a store of that demo; anything else is refused in words", async () => {
  const def = await demoDef();
  def.disks[0].url = 'manifest.json';
  const one = parseStore(JSON.stringify(def), 'https://disks.example/alpine-term/definition.json');
  assert.equal(one.demos.length, 1);
  assert.equal(one.demos[0].store, 'https://disks.example/alpine-term/definition.json');
  assert.equal(one.demos[0].def.disks[0].url, 'https://disks.example/alpine-term/manifest.json');
  const cause = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return [msgOf(e)?.key, msgOf((e as Error).cause)?.key];
    }
    return [];
  };
  assert.deepEqual(cause(() => parseStore(JSON.stringify({ ...def, demo: undefined }), STORE_URL)), ['machines:demo-store.notDemo', 'machines:demo-store.notDemo.cause']);
  assert.deepEqual(cause(() => parseStore('<html>', STORE_URL)), ['machines:demo-store.failed', 'machines:demo-store.notJson']);
  assert.deepEqual(cause(() => parseStore('{"type":"other"}', STORE_URL)), ['machines:demo-store.failed', 'machines:demo-store.notStore']);
  assert.deepEqual(cause(() => parseStore(`{"type":"${STORE_TYPE}","version":2,"demos":[]}`, STORE_URL)), ['machines:demo-store.failed', 'machines:demo-store.version']);
  assert.deepEqual(cause(() => parseStore(`{"type":"${STORE_TYPE}","version":1}`, STORE_URL)), ['machines:demo-store.failed', 'machines:demo-store.damaged']);
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
/** `fetch` answering from `files` by URL (404 otherwise); a URL in `down` fails as a network error. */
function serve(files: Record<string, string>, down: string[] = []) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (down.includes(url)) throw new TypeError('Failed to fetch');
    return url in files ? new Response(files[url]) : new Response('no', { status: 404 });
  }) as typeof fetch;
}

test("a store that can't be fetched says why: unreachable, or the server's status", async () => {
  serve({}, [STORE_URL]);
  await assert.rejects(fetchStore(STORE_URL), (e) => msgOf((e as Error).cause)?.key === 'machines:demo-store.unreachable');
  serve({});
  await assert.rejects(fetchStore(STORE_URL), (e) => msgOf((e as Error).cause)?.params?.status === 404);
});

test("a demo's machine: marked with its store and id, its adapter on the demo network; a failed download makes none", async () => {
  const { snapshot: _, ...noSnap } = (await demoDef()).demo!;
  serve({ [STORE_URL]: JSON.stringify({ type: STORE_TYPE, version: 1, demos: [{ ...(await demoDef()), demo: noSnap }, await demoDef({ id: 'gone' }), await demoDef({ id: 'other', snapshot: { manifest: 'other/snapshot.json', id: SNAP } })] }), 'https://disks.example/other/snapshot.json': JSON.stringify({ id: ID }) });
  const s = await fetchStore(STORE_URL);
  const store = fresh();
  const { machine } = await machineFromDemo(store, findDemo(s, 'alpine-term')!);
  assert.deepEqual(machine.fromDemo, { store: STORE_URL, id: 'alpine-term' });
  const conn = (await new Connections(store).list()).find((c) => c.id === machine.adapters?.[0].connection);
  assert.equal(conn?.kind, 'demo', 'the first adapter on the demo network');
  const { mine, older } = await demoMachines(store, findDemo(s, 'alpine-term')!);
  assert.deepEqual(mine.map((m) => m.id), [machine.id], 'started before: found');
  assert.equal(older.length, 0);
  await assert.rejects(machineFromDemo(store, findDemo(s, 'gone')!), (e) => msgOf(e)?.key === 'machines:template.gone');
  await assert.rejects(machineFromDemo(store, findDemo(s, 'other')!), (e) => msgOf(e)?.key === 'machines:template.otherSnapshot');
  assert.equal((await store.all('machines')).length, 1, 'no machine from a failed download');
});

test("templates (New machine's): only the demos marked so; a template's machine is the definition's, cold, the user's own", async () => {
  const text = JSON.stringify({ type: STORE_TYPE, version: 1, demos: [await demoDef({ template: true }), await demoDef({ id: 'only-demo' }), await demoDef({ id: 'not', template: false })] });
  const s = parseStore(text, STORE_URL);
  assert.deepEqual(templatesOf(s).map((d) => d.def.demo.id), ['alpine-term'], 'only `template: true`');
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    asked.push(String(input instanceof Request ? input.url : input));
    return new Response('no', { status: 404 });
  }) as typeof fetch;
  const store = fresh();
  const d = templatesOf(s)[0];
  const { machine, toPick } = await machineFromStoreTemplate(store, d);
  assert.deepEqual(asked, [], 'nothing fetched: no template snapshot');
  assert.deepEqual(toPick, []);
  assert.equal(machine.name, 'Alpine');
  assert.deepEqual([machine.ncpus, machine.ramMiB, machine.display], [2, 512, '2d'], "the definition's settings");
  assert.equal(machine.fromDemo, undefined, "not the demo's: its card doesn't find it");
  assert.equal(machine.restoreFirst, undefined, 'a cold boot');
  assert.equal((await store.all('snapshots')).length, 0);
  assert.equal(machine.adapters?.length, 1);
  assert.equal(machine.adapters?.[0].connection, undefined, 'no demo network: the adapter without a connection');
  assert.equal((await new Connections(store).list()).length, 0);
  const disks = await store.all('disks');
  assert.deepEqual(disks.map((x) => [x.kind, x.url]), [['url', 'https://disks.example/alpine-term/manifest.json']], "the definition's disk, its URL resolved");
  assert.equal((await demoMachines(store, d)).mine.length, 0);
  const again = await machineFromStoreTemplate(store, d);
  assert.equal(again.machine.name, 'Alpine (2)', 'another, named past the first');
  assert.equal((await store.all('disks')).length, 1, 'the same disk, by identity');
});

test('a machine from a version a demo replaces is found as older', async () => {
  const { snapshot: _, ...v1 } = (await demoDef()).demo!;
  const text = JSON.stringify({ type: STORE_TYPE, version: 1, demos: [{ ...(await demoDef()), demo: v1 }, { ...(await demoDef()), demo: { ...v1, id: 'alpine-term-2', replaces: ['alpine-term'] } }] });
  const s = parseStore(text, STORE_URL);
  const store = fresh();
  const { machine } = await machineFromDemo(store, findDemo(s, 'alpine-term')!);
  const r = await demoMachines(store, findDemo(s, 'alpine-term-2')!);
  assert.deepEqual([r.mine.length, r.older.map((m) => m.id)], [0, [machine.id]]);
  const other = parseStore(text, 'https://elsewhere.example/store.json');
  assert.equal((await demoMachines(store, findDemo(other, 'alpine-term')!)).mine.length, 0, "another store's demo of the same id isn't it");
});

test("a snapshot's download cut off partway is said as such, and makes no machine", async () => {
  const hashes = ['ef'.repeat(32)];
  const def = await demoDef({ snapshot: { manifest: 'alpine-term/snapshot.json', id: contentId(hashes) } });
  const manifest = { format: 'waarm64-chunked-1', size: 2 * MiB, piece: 2 * MiB, pieces: '../pieces/{hash}.bin', hashes, id: contentId(hashes) };
  serve({ [STORE_URL]: JSON.stringify({ type: STORE_TYPE, version: 1, demos: [def] }), 'https://disks.example/alpine-term/snapshot.json': JSON.stringify(manifest) }, [`https://disks.example/pieces/${'ef'.repeat(32)}.bin`]);
  const s = await fetchStore(STORE_URL);
  const store = fresh();
  await assert.rejects(machineFromDemo(store, findDemo(s, 'alpine-term')!), (e) => msgOf(e)?.key === 'machines:template.cutOff' && msgOf((e as Error).cause)?.params?.host === 'disks.example');
  assert.equal((await store.all('machines')).length, 0, 'no machine');
});

// REVIEW.md (review/demo-page) R3, R4, #9. A chunked file of `bytes` served under `dir`: its manifest (its real id unless
// `id`) and its one piece.
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
function chunked(dir: string, bytes: Uint8Array, id?: string) {
  const h = sha(bytes);
  const manifest = { format: CHUNKED_FORMAT, size: bytes.length, piece: MiB, pieces: '{hash}.bin', hashes: [h], id: id ?? sha(h) };
  return { manifest, files: { [`${dir}/${h}.bin`]: bytes } as Record<string, Uint8Array> };
}
/** `fetch` answering from `files` (a function: a new answer each time), counting each URL's requests in `asked`. */
function serveBytes(files: Record<string, string | Uint8Array | (() => string)>) {
  const asked = new Map<string, number>();
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.set(url, (asked.get(url) ?? 0) + 1);
    const f = files[url];
    if (f === undefined) return new Response('no', { status: 404 });
    return new Response(typeof f === 'function' ? f() : (f as BodyInit));
  }) as typeof fetch;
  return asked;
}
const D = 'https://disks.example/alpine-term';
/** A store of one demo whose snapshot is the content id `id`, without the demo network unless `network`. */
async function storeWith(id: string, network = false) {
  const { network: _, ...demo } = (await demoDef({ snapshot: { manifest: 'alpine-term/snapshot.json', id } })).demo!;
  return parseStore(JSON.stringify({ type: STORE_TYPE, version: 1, demos: [{ ...(await demoDef()), demo: network ? { ...demo, network: 'demo' } : demo }] }), STORE_URL);
}

test("R3a: a template snapshot's manifest whose id isn't its content's is refused", async () => {
  const good = chunked(D, new Uint8Array(4096).fill(1));
  const other = chunked(D, new Uint8Array(4096).fill(2));
  serveBytes({ [`${D}/snapshot.json`]: JSON.stringify({ ...other.manifest, id: good.manifest.id }), ...other.files });
  await assert.rejects(machineFromDemo(fresh(), findDemo(await storeWith(good.manifest.id), 'alpine-term')!), (e) => msgOf(e)?.key === 'machines:template.otherSnapshot', 'a forged id is taken');
  // A hash that isn't hex isn't spliced into a piece's URL.
  const odd = { ...good.manifest, hashes: ['../../x'], id: sha('../../x') };
  serveBytes({ [`${D}/snapshot.json`]: JSON.stringify(odd) });
  await assert.rejects(machineFromDemo(fresh(), findDemo(await storeWith(odd.id), 'alpine-term')!), (e) => msgOf(e)?.key === 'disks:chunked.malformed');
});

test("R3b: the snapshot's manifest is fetched once, and its pieces are the checked manifest's", async () => {
  const good = chunked(D, new Uint8Array(4096).fill(1));
  const other = chunked(D, new Uint8Array(4096).fill(2));
  let n = 0;
  const asked = serveBytes({ [`${D}/snapshot.json`]: () => JSON.stringify(n++ === 0 ? good.manifest : other.manifest), ...good.files, ...other.files });
  // The bytes aren't a snapshot (the import refuses them): what matters is which were fetched.
  await assert.rejects(machineFromDemo(fresh(), findDemo(await storeWith(good.manifest.id), 'alpine-term')!));
  assert.equal(asked.get(`${D}/snapshot.json`), 1, 'the manifest fetched twice');
  assert.equal(asked.get(Object.keys(other.files)[0]), undefined, "another manifest's piece was fetched");
});

test('R4: a template snapshot that fails to import, or a demo network that fails to attach, leaves nothing; trying again makes one machine', async () => {
  const snap = chunked(D, new Uint8Array(4096).fill(3)); // its id is its content's: the download is fine, the import isn't
  serveBytes({ [`${D}/snapshot.json`]: JSON.stringify(snap.manifest), ...snap.files });
  const store = fresh();
  for (let i = 0; i < 2; i++) await assert.rejects(machineFromDemo(store, findDemo(await storeWith(snap.manifest.id), 'alpine-term')!));
  assert.equal((await store.all('machines')).length, 0, 'a machine was left behind');
  assert.equal((await store.all('disks')).length, 0, 'a disk was left behind');
  assert.equal((await store.all('snapshots')).length, 0);
  // The demo network's connection can't be made (the storage refuses it): no machine either.
  const { snapshot: _, ...noSnap } = (await demoDef()).demo!;
  const s = parseStore(JSON.stringify({ type: STORE_TYPE, version: 1, demos: [{ ...(await demoDef()), demo: noSnap }] }), STORE_URL);
  const put = store.put.bind(store);
  store.put = (async (kind: string, r: unknown) => {
    if (kind === 'connections') throw new Error('refused');
    return put(kind as never, r as never);
  }) as typeof store.put;
  await assert.rejects(machineFromDemo(store, findDemo(s, 'alpine-term')!), /refused/);
  assert.equal((await store.all('machines')).length, 0, 'a machine without its demo network was left behind');
  store.put = put;
  const { machine } = await machineFromDemo(store, findDemo(s, 'alpine-term')!);
  assert.deepEqual([(await store.all('machines')).length, (await store.all('disks')).length], [1, 1]);
  assert.ok(machine.adapters?.[0].connection && machine.fromDemo, 'stored with its marks');
});

test("#9: a copy of a demo's machine isn't the demo's: its card doesn't find it as started before", async () => {
  const { snapshot: _, ...noSnap } = (await demoDef()).demo!;
  const s = parseStore(JSON.stringify({ type: STORE_TYPE, version: 1, demos: [{ ...(await demoDef()), demo: noSnap }] }), STORE_URL);
  const store = fresh();
  const { machine } = await machineFromDemo(store, findDemo(s, 'alpine-term')!);
  const copy = await duplicateMachine(store, machine.id);
  assert.equal(copy.fromDemo, undefined);
  assert.deepEqual((await demoMachines(store, findDemo(s, 'alpine-term')!)).mine.map((m) => m.id), [machine.id]);
});
