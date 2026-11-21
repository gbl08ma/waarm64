// The demos' site (tools/demo-site.ts, tools/publish-demos.ts; DEMO loop 4) in Node, on small builds made here: the
// store and each demo's files laid out with one shared pieces/, the store read back as the page reads it; refused: a
// snapshot of another core format or shape, one that isn't a template, a card's download off the files, a typo in the
// source, an id twice or over another image's directory, an id's image changed; and the retention rule: a demo left
// out is retired (its files kept), and only past the budget do retired demos go, the oldest retired first, said first.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { applyPlan, describe, planSite, readSource, type Source } from '../tools/demo-site.ts';
import { exportDefinition, importDefinition, type Definition } from '../web/app/definitions.ts';
import { parseStore } from '../web/app/demo-store.ts';
import { attach, createDisk, createMachine } from '../web/app/machines.ts';
import { currentShape } from '../web/app/snapshots.ts';
import { Store } from '../web/app/store.ts';
import { memoryFiles, memoryRecords } from '../web/app/store-backends.ts';
import { crc32, SNAPSHOT_VERSION } from '../web/snapshot-file.ts';

const MiB = 2 ** 20;
const ROOT = new URL('..', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'waarm64-demo-site-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const fresh = () => new Store(memoryRecords(), memoryFiles(), { channel: false });

const chunk = (file: string, out: string, pieces: string) =>
  execFileSync('node', ['--disable-warning=ExperimentalWarning', join(ROOT, 'tools/chunk-image.ts'), file, out, '1', '--pieces', pieces], { encoding: 'utf8' });

/** A snapshot file's header alone (no frames: the tool reads only the header). */
function snapshotFile(header: Record<string, unknown>): Buffer {
  const json = Buffer.from(JSON.stringify({ format: 1, abi: 1, created: '2026-11-19T00:00:00Z', ...header }));
  const head = Buffer.alloc(16);
  head.write('WAARMSNP', 0, 'latin1');
  head.writeUInt32LE(1, 8);
  head.writeUInt32LE(json.length, 12);
  const crc = Buffer.alloc(4);
  crc.writeUInt32LE(crc32(json), 0);
  return Buffer.concat([head, json, crc]);
}

/**
 * A build as bench/demo/make-template.ts writes it, in `dir` (its pieces in `<dir>/../pieces`): an image of `mib` MiB
 * of byte `fill`, the machine's definition, and its template (`snap` changes its header: another format, shape…).
 */
async function build(name: string, o: { fill?: number; mib?: number; snap?: Record<string, unknown> | false; ramMiB?: number } = {}) {
  const dir = join(tmp, 'builds', name);
  const pieces = join(tmp, 'builds', 'pieces');
  mkdirSync(dir, { recursive: true });
  const image = join(tmp, `${name}.img`);
  const bytes = Buffer.alloc((o.mib ?? 3) * MiB, o.fill ?? 1);
  bytes.write(name); // each build's first piece its own
  writeFileSync(image, bytes);
  chunk(image, dir, pieces);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const s = fresh();
  const m = await createMachine(s, { name: 'Alpine', ncpus: 1, ramMiB: 256, display: '2d', network: true, usb: false, mouse: false, touch: false, shares: false });
  const d = await createDisk(s, { kind: 'url', url: 'http://localhost/x/manifest.json', size: 64 * MiB, bytes: manifest.size, chunked: manifest.id });
  await attach(s, m, d);
  const def: Definition = await exportDefinition(s, m.id);
  def.disks[0].url = 'manifest.json';
  // The shape the page gives the machine (the template's), from its definition imported elsewhere.
  const b = fresh();
  const { machine } = await importDefinition(b, def);
  const ds = new Map((await b.all('disks')).map((x) => [x.id, x]));
  const { shape, hash } = await currentShape(machine, (i) => ds.get(i), { display: '2d' });
  if (o.ramMiB) def.machine.ramMiB = o.ramMiB; // a definition that isn't the template's machine
  writeFileSync(join(dir, 'definition.json'), JSON.stringify(def));
  if (o.snap !== false) {
    const snap = join(tmp, `${name}.waarm64snap`);
    writeFileSync(snap, snapshotFile({ coreVersion: SNAPSHOT_VERSION, template: true, shape, shapeHash: hash, ...o.snap }));
    chunk(snap, join(dir, 'snapshot.json'), pieces);
  }
  return `builds/${name}`;
}

const source = (demos: Source['demos']): Source => ({ type: 'waarm64-demos-source', name: 'Test', demos });
const demo = (id: string, b: string, more: Record<string, unknown> = {}) => ({ build: b, name: `Demo ${id}`, demo: { id, summary: `The ${id} demo.`, view: 'serial' as const, network: 'demo' as const, ...more } });
const site = (name: string) => join(tmp, 'sites', name);
const plan = (src: Source, s: string, o: { budget?: number; now?: string } = {}) =>
  planSite(src, { root: tmp, site: s, budget: o.budget, now: o.now ? new Date(o.now) : undefined });
const refused = async (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: Error) => re.test(e.message) || assert.fail(e.message));

test("a site: the store with each demo's definition inline, its files under its id, one pieces/, read back as the page reads it", async () => {
  const a = await build('a');
  const s = site('one');
  mkdirSync(join(s, 'desktop/pieces'), { recursive: true });
  writeFileSync(join(s, 'desktop/manifest.json'), '{}');
  writeFileSync(join(s, 'desktop/pieces/x.bin'), 'x');
  const p = await plan(source([demo('alpine-term', a, { replaces: ['alpine-old'], template: true })]), s);
  applyPlan(p, s);
  const store = parseStore(readFileSync(join(s, 'store.json'), 'utf8'), 'https://vmdisks.example/store.json');
  assert.equal(store.skipped.length, 0);
  const d = store.demos[0].def;
  assert.equal(d.machine.name, 'Demo alpine-term');
  assert.equal(d.disks[0].url, 'https://vmdisks.example/alpine-term/manifest.json');
  assert.equal(d.demo.snapshot?.manifest, 'https://vmdisks.example/alpine-term/snapshot.json');
  assert.deepEqual(d.demo.replaces, ['alpine-old']);
  assert.equal(d.demo.template, true, "the card's template mark carried");
  assert.equal(d.demo.room, undefined, 'no room unless the card asks');
  const snapManifest = JSON.parse(readFileSync(join(s, 'alpine-term/snapshot.json'), 'utf8'));
  assert.equal(d.demo.snapshot?.id, snapManifest.id, "the card names the snapshot's content");
  assert.equal(d.demo.download, snapManifest.size, 'no download given: what a visit fetches at least (the snapshot)');
  const alone = parseStore(readFileSync(join(s, 'alpine-term/definition.json'), 'utf8'), 'https://vmdisks.example/alpine-term/definition.json');
  assert.equal(alone.demos[0].def.disks[0].url, d.disks[0].url, 'the definition alone: the same URLs');
  for (const f of ['alpine-term/manifest.json', 'alpine-term/snapshot.json']) {
    const m = JSON.parse(readFileSync(join(s, f), 'utf8'));
    assert.equal(m.pieces, '../pieces/{hash}.bin');
    for (const h of m.hashes) assert.ok(existsSync(join(s, 'pieces', `${h}.bin`)), `${f}'s piece ${h}`);
  }
  assert.ok(existsSync(join(s, 'desktop/pieces/x.bin')), "another image's files stay as they are");
  assert.equal(readFileSync(join(s, '.assetsignore'), 'utf8'), '.publish.json\n', 'the ledger is not deployed');
  const again = await plan(source([demo('alpine-term', a, { replaces: ['alpine-old'], template: true })]), s);
  assert.deepEqual([again.added, again.removed], [[], []], 'published again: nothing changes');
  // With a thumbnail (a file linked in, not written), published twice: the second time its files are already hard
  // links to the build's, and rename() leaves both names of one file, so the staged name must go too (a deploy once
  // uploaded three `thumb.webp.publishing`).
  writeFileSync(join(tmp, a, 'thumb.webp'), 'webp');
  const pictured = source([{ ...demo('alpine-term', a, { replaces: ['alpine-old'], template: true }), thumbnail: `${a}/thumb.webp` }]);
  applyPlan(await plan(pictured, s), s);
  applyPlan(await plan(pictured, s), s);
  assert.ok(existsSync(join(s, 'alpine-term/thumb.webp')), 'the thumbnail in place');
  const left = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? left(join(dir, e.name)) : e.name.endsWith('.publishing') ? [join(dir, e.name)] : []));
  assert.deepEqual(left(s), [], 'no staged file left behind');
});

test('refused: another core format, another shape, not a template, a download off the files, a typo, an id twice, a build outside target/', async () => {
  const s = site('refused');
  await refused(plan(source([demo('x', await build('format', { snap: { coreVersion: SNAPSHOT_VERSION + 1 } }))]), s), /core's format/);
  await refused(plan(source([demo('x', await build('shape', { ramMiB: 512 }))]), s), /shape hash/);
  await refused(plan(source([demo('x', await build('plain', { snap: { template: undefined } }))]), s), /isn't a template/);
  const ok = await build('ok');
  await refused(plan(source([demo('x', ok, { download: 10 })]), s), /a visit fetches/);
  await refused(plan(source([demo('x', ok, { download: 10 ** 9 })]), s), /a visit fetches/);
  assert.ok(await plan(source([demo('x', await build('cold', { snap: false }), { download: 3 * MiB })]), s), 'no snapshot: a cold boot, its download up to the image');
  const file = join(tmp, 'typo.json');
  writeFileSync(file, JSON.stringify(source([{ ...demo('x', ok), demo: { ...demo('x', ok).demo, veiw: 'serial' } as never }])));
  assert.throws(() => readSource(file), /unknown fields demo\.veiw/);
  writeFileSync(file, JSON.stringify(source([demo('x', 'target/demos/x'), demo('x', 'target/demos/y')])));
  assert.throws(() => readSource(file), /taken/);
  writeFileSync(file, JSON.stringify(source([demo('x', ok, { snapshot: {} })])));
  assert.throws(() => readSource(file), /the tool's/);
  for (const bad of ['/tmp/x', 'target', 'target/demos', 'target/demos/../x', 'target/../demos/x', 'target/demos/x/y', 'bench/demos/x']) {
    writeFileSync(file, JSON.stringify(source([{ ...demo('x', ok), build: bad }])));
    assert.throws(() => readSource(file), /build must be target/, bad);
  }
  writeFileSync(file, JSON.stringify(source([{ ...demo('x', ok), build: 'target/demos/x' }, { ...demo('y', ok), build: 'target/demos/x' }])));
  assert.throws(() => readSource(file), /another demo's/);
  writeFileSync(file, JSON.stringify(source([{ ...demo('x', ok), build: 'target/demos/x' }])));
  assert.equal(readSource(file).demos.length, 1);
  await refused(plan(source([demo('x', ok, { view: 'tty' })]), s), /demo\.view/);
  await refused(plan(source([demo('x', ok, { room: 'global' })]), s), /demo\.room/); // one adapter: none for the room
  await refused(plan(source([demo('x', ok, { template: 'yes' })]), s), /demo\.template/);
});

test("refused: an id over another image's directory; an id's image changed (a new image is a new id); past the host's budget", async () => {
  const s = site('ids');
  mkdirSync(join(s, 'desktop'), { recursive: true });
  writeFileSync(join(s, 'desktop/manifest.json'), '{}');
  const a = await build('img1');
  await refused(plan(source([demo('desktop', a)]), s), /isn't a demo's/);
  applyPlan(await plan(source([demo('alpine', a)]), s), s);
  await refused(plan(source([demo('alpine', await build('img2', { fill: 2 }))]), s), /a new image is a new id/);
  await refused(plan(source([demo('alpine', a)]), s, { budget: 3 }), /past its budget/);
});

test('retention: a demo left out is retired, its files kept; past the budget the oldest retired go first, said before', async () => {
  const s = site('retire');
  const [a, b, c] = [await build('r1', { fill: 3 }), await build('r2', { fill: 4 }), await build('r3', { fill: 5 })];
  applyPlan(await plan(source([demo('one', a), demo('two', b), demo('three', c)]), s, { now: '2026-01-01' }), s);
  applyPlan(await plan(source([demo('two', b), demo('three', c)]), s, { now: '2026-02-01' }), s);
  applyPlan(await plan(source([demo('three', c)]), s, { now: '2026-03-01' }), s);
  const ledger = JSON.parse(readFileSync(join(s, '.publish.json'), 'utf8'));
  assert.deepEqual([ledger.demos.one.retired, ledger.demos.two.retired], ['2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z']);
  assert.ok(existsSync(join(s, 'one/manifest.json')), "a retired demo's files stay");
  assert.deepEqual(parseStore(readFileSync(join(s, 'store.json'), 'utf8'), 'https://x.example/store.json').demos.map((d) => d.def.demo.id), ['three'], 'out of the store');
  const full = await plan(source([demo('three', c)]), s);
  // A budget one demo's files short: the oldest retired (one) goes, two stays.
  const tight = await plan(source([demo('three', c)]), s, { budget: full.count - 1 });
  assert.deepEqual(tight.dropped.map((d) => d.id), ['one']);
  assert.deepEqual(tight.retired, ['two']);
  assert.ok(describe(tight).some((l) => l.startsWith('DROPPED one')), 'the plan says what goes');
  assert.ok(existsSync(join(s, 'one/manifest.json')), 'nothing written by a plan');
  applyPlan(tight, s);
  assert.equal(existsSync(join(s, 'one')), false);
  const named = new Set(['two', 'three'].flatMap((id) => ['manifest.json', 'snapshot.json'].flatMap((f) => JSON.parse(readFileSync(join(s, id, f), 'utf8')).hashes as string[])));
  assert.deepEqual(new Set(readdirSync(join(s, 'pieces')).map((f) => f.replace('.bin', ''))), named, "only the pieces a manifest names stay: one's own went, the shared stayed");
});

test("a snapshot made again under its id (a new core): the old snapshot's pieces go, the image's stay", async () => {
  const s = site('remade');
  const a = await build('remade');
  applyPlan(await plan(source([demo('alpine', a)]), s), s);
  const before = JSON.parse(readFileSync(join(s, 'alpine/snapshot.json'), 'utf8')).hashes as string[];
  // The same image, a template made again (its header differs: made at another time).
  const snap = JSON.parse(readFileSync(join(tmp, 'builds/remade/snapshot.json'), 'utf8'));
  const header = JSON.parse(readFileSync(join(tmp, 'remade.waarm64snap')).subarray(16, -4).toString());
  writeFileSync(join(tmp, 'remade2.waarm64snap'), snapshotFile({ ...header, created: '2026-12-01T00:00:00Z' }));
  chunk(join(tmp, 'remade2.waarm64snap'), join(tmp, 'builds/remade/snapshot.json'), join(tmp, 'builds/pieces'));
  assert.notEqual(JSON.parse(readFileSync(join(tmp, 'builds/remade/snapshot.json'), 'utf8')).id, snap.id);
  const p = await plan(source([demo('alpine', a)]), s);
  assert.deepEqual(p.removed, before.map((h) => `pieces/${h}.bin`));
  applyPlan(p, s);
  for (const h of JSON.parse(readFileSync(join(s, 'alpine/manifest.json'), 'utf8')).hashes as string[]) assert.ok(existsSync(join(s, 'pieces', `${h}.bin`)));
});

// REVIEW.md (review/demo-page) #5: a piece that fails its check leaves the site as it was, and the next publish works.
test('--apply: a corrupt piece fails the publish before the store, the manifests or the ledger change; the next one goes through', async () => {
  const s = site('atomic');
  const a = await build('atom1');
  applyPlan(await plan(source([demo('alpine', a)]), s), s);
  const before = new Map(['store.json', '.publish.json', 'alpine/manifest.json'].map((f) => [f, readFileSync(join(s, f), 'utf8')]));
  const b = await build('atom2', { fill: 7 });
  const p = await plan(source([demo('alpine', a), demo('other', b)]), s);
  const piece = [...p.files.entries()].find(([, e]) => 'hash' in e && e.hash && 'from' in e && e.from.includes('pieces'))!;
  const from = (piece[1] as { from: string }).from;
  const good = readFileSync(from);
  writeFileSync(from, Buffer.concat([good.subarray(0, 10), Buffer.from('x'), good.subarray(11)]));
  try {
    assert.throws(() => applyPlan(p, s), /isn't the piece/);
  } finally {
    writeFileSync(from, good);
  }
  for (const [f, text] of before) assert.equal(readFileSync(join(s, f), 'utf8'), text, `${f} changed by a failed publish`);
  assert.equal(existsSync(join(s, 'other')), false, "the new demo's files went in before its pieces");
  assert.ok(!readdirSync(s, { recursive: true }).some((f) => String(f).endsWith('.publishing')), 'staged files left');
  applyPlan(await plan(source([demo('alpine', a), demo('other', b)]), s), s);
  assert.equal(parseStore(readFileSync(join(s, 'store.json'), 'utf8'), 'https://x.example/store.json').demos.length, 2);
});
