// The definition format's version 2 and a store of demos (docs/machines.md §6.2; DEMO loop 4), in Node: version 1
// still reads (and loses a `demo` it shouldn't have), version 2's `demo` is checked field by field and a damaged one's
// error names the field; a store's relative URLs resolve against it, a single definition's URL is a store of one, a demo
// this page can't read is left out (said) while the rest show; a demo's machine is marked with where it came from, on
// the demo network when it asks, and a download that fails (gone, another snapshot) leaves no machine.
// The page's side (a machine from a store's demo restored at its first start): tests/page-template-first.test.ts.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { checkDefinition, exportDefinition, parseDefinition, type Definition } from '../web/app/definitions.ts';
import { demoMachines, fetchStore, findDemo, parseStore, STORE_TYPE } from '../web/app/demo-store.ts';
import { machineFromDemo } from '../web/app/template.ts';
import { attach, createDisk, createMachine } from '../web/app/machines.ts';
import { Connections } from '../web/app/connections.ts';
import { Store } from '../web/app/store.ts';
import { memoryFiles, memoryRecords } from '../web/app/store-backends.ts';
import { msgOf } from '../web/msg.ts';

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
  const def = await demoDef();
  const manifest = { format: 'waarm64-chunked-1', size: 2 * MiB, piece: 2 * MiB, pieces: '../pieces/{hash}.bin', hashes: ['ef'.repeat(32)], id: SNAP };
  serve({ [STORE_URL]: JSON.stringify({ type: STORE_TYPE, version: 1, demos: [def] }), 'https://disks.example/alpine-term/snapshot.json': JSON.stringify(manifest) }, [`https://disks.example/pieces/${'ef'.repeat(32)}.bin`]);
  const s = await fetchStore(STORE_URL);
  const store = fresh();
  await assert.rejects(machineFromDemo(store, findDemo(s, 'alpine-term')!), (e) => msgOf(e)?.key === 'machines:template.cutOff' && msgOf((e as Error).cause)?.params?.host === 'disks.example');
  assert.equal((await store.all('machines')).length, 0, 'no machine');
});
