// The demos' build's pieces that run without a guest (tools/build-demos.ts; DEMO loop 5): a recipe's definition gives
// the same shape hash at every build (its MAC and serial fixed), and another MAC, serial or image another; the source's
// recipe read and checked; a build moved under --out (its thumbnail with it); the core taken from a copy of the page;
// the builds' pieces no manifest names removed.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { checkRecipe, CHECKOUT_CORE, coreOf, placed, prunePieces, recipeDefinition } from '../tools/build-demos.ts';
import { readSource, shapeHashOf, type Recipe } from '../tools/demo-site.ts';
import { checkDefinition } from '../web/app/definitions.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'waarm64-build-demos-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** The definition make-template.ts imports: the recipe's, its disk filled in from an image's manifest. */
function filled(r: Recipe, image = 'a'.repeat(64)) {
  const def = recipeDefinition(r);
  Object.assign(def.disks[0], { url: 'http://localhost:1/x/manifest.json', name: 'Alpine', size: 2 ** 30, identity: { kind: 'url', chunked: image, bytes: 73007104 } });
  return checkDefinition(def);
}

test("the source's recipe: read, and its definition's shape hash the same at every build", async () => {
  const src = readSource(join(ROOT, 'deploy/disks/demos.json'));
  const term = src.demos.find((d) => d.demo.id === 'alpine-term');
  assert.ok(term?.recipe, 'alpine-term has a recipe');
  const r = checkRecipe(term.recipe, 'alpine-term');
  const h = await shapeHashOf(filled(r));
  assert.equal(await shapeHashOf(filled(r)), h, 'two builds, one shape');
  assert.equal(await shapeHashOf(filled(structuredClone(r))), h);
  const mac = structuredClone(r);
  (mac.machine as { macs: string[] }).macs = ['52:54:00:00:00:01'];
  assert.notEqual(await shapeHashOf(filled(mac)), h, 'the MAC is in the shape');
  assert.notEqual(await shapeHashOf(filled({ ...r, serial: '000000000001' })), h, 'the serial is in the shape');
  assert.notEqual(await shapeHashOf(filled(r, 'b'.repeat(64))), h, 'the image is in the shape');
});

test('a recipe checked', () => {
  const ok = { image: 'alpine-demo', machine: { name: 'A' }, serial: 's1' };
  assert.deepEqual(checkRecipe(ok, 'x'), ok);
  assert.throws(() => checkRecipe({ ...ok, imgae: 'x' }, 'x'), /unknown fields imgae/);
  assert.throws(() => checkRecipe({ ...ok, image: '../etc' }, 'x'), /images\/build\.sh name/);
  assert.throws(() => checkRecipe({ ...ok, serial: '' }, 'x'), /serial/);
  assert.throws(() => checkRecipe([], 'x'), /recipe is/);
  // A desktop's (DEMO loop 12): its image a file made by hand, its session checked (its commands are typed into a shell).
  const desk = { ...ok, image: 'target/arch/desktop.qcow2', session: { user: 'arch', screen: '1280x800', apps: [{ run: 'gtk4-demo --run=shadertoy', window: 'org.gtk.Demo4' }], settle: 20 } };
  assert.deepEqual(checkRecipe(desk, 'x'), desk);
  assert.throws(() => checkRecipe({ ...ok, image: 'target/../etc/x.qcow2' }, 'x'), /images\/build\.sh name or a \.qcow2/);
  assert.throws(() => checkRecipe({ ...ok, image: '/etc/x.qcow2' }, 'x'), /images\/build\.sh name or a \.qcow2/);
  assert.throws(() => checkRecipe({ ...desk, session: { ...desk.session, apps: [{ run: "sh -c 'rm -rf /'", window: 'x' }] } }, 'x'), /no quotes/);
  assert.throws(() => checkRecipe({ ...desk, session: { ...desk.session, user: 'a b' } }, 'x'), /login name/);
  assert.throws(() => checkRecipe({ ...desk, session: { ...desk.session, screen: 'big' } }, 'x'), /<w>x<h>/);
  assert.throws(() => checkRecipe({ ...desk, session: { ...desk.session, extra: 1 } }, 'x'), /unknown fields extra/);
  checkRecipe({ ...desk, session: { ...desk.session, cmdline: 'init_on_free=1 quiet' } }, 'x');
  assert.throws(() => checkRecipe({ ...desk, session: { ...desk.session, cmdline: 'a=$(x)' } }, 'x'), /kernel parameters/);
});

test("the source's desktops: their recipes check, and each its own MAC and serial", () => {
  const src = readSource(join(ROOT, 'deploy/disks/demos.json'));
  const desks = src.demos.filter((d) => d.recipe?.session);
  assert.ok(desks.length >= 2, 'the desktop and the 3D demo');
  for (const d of desks) checkRecipe(d.recipe, d.demo.id);
  const all = src.demos.filter((d) => d.recipe).map((d) => d.recipe!);
  assert.equal(new Set(all.map((r) => r.serial)).size, all.length, 'serials differ');
  assert.equal(new Set(all.map((r) => (r.machine as { macs: string[] }).macs[0])).size, all.length, 'MACs differ');
});

test('--out: the build under it, its thumbnail with it (one elsewhere kept)', () => {
  const d = { build: 'target/demos/a', thumbnail: 'target/demos/a/thumb.webp', demo: { id: 'a', summary: '', view: 'serial' as const } };
  assert.equal(placed(d), d);
  assert.deepEqual(placed(d, '/o'), { ...d, build: '/o/a', thumbnail: '/o/a/thumb.webp' });
  const other = { ...d, thumbnail: 'deploy/a.png' };
  assert.deepEqual(placed(other, '/o'), { ...other, build: '/o/a' });
});

test("the core: the checkout's, a file, or a copy's assets with its stamp", () => {
  assert.equal(coreOf(undefined).wasm, CHECKOUT_CORE);
  const copy = join(tmp, 'dist');
  mkdirSync(join(copy, 'assets'), { recursive: true });
  writeFileSync(join(copy, 'index.html'), '<meta name="waarm64-build" content="0123456789ab (2026-11-19T00:00:00Z)">');
  assert.throws(() => coreOf(copy), /found 0/);
  writeFileSync(join(copy, 'assets', 'waarm64_core-AbC1.wasm'), '');
  writeFileSync(join(copy, 'assets', 'ts-x.wasm'), '');
  assert.deepEqual(coreOf(copy), { wasm: join(copy, 'assets', 'waarm64_core-AbC1.wasm'), stamp: '0123456789ab (2026-11-19T00:00:00Z)' });
  assert.deepEqual(coreOf(join(copy, 'assets', 'ts-x.wasm')), { wasm: join(copy, 'assets', 'ts-x.wasm') });
  assert.throws(() => coreOf(join(tmp, 'none')), /no core/);
});

test('pieces no build names go (an old template\'s), the rest stay', () => {
  const site = join(tmp, 'site');
  mkdirSync(join(site, 'pieces'), { recursive: true });
  mkdirSync(join(site, 'a'));
  for (const h of ['i1', 'i2', 's1', 'old']) writeFileSync(join(site, 'pieces', `${h}.bin`), h);
  writeFileSync(join(site, 'a', 'manifest.json'), JSON.stringify({ pieces: '../pieces/{hash}.bin', hashes: ['i1', 'i2'] }));
  writeFileSync(join(site, 'a', 'snapshot.json'), JSON.stringify({ pieces: '../pieces/{hash}.bin', hashes: ['s1'] }));
  assert.equal(prunePieces(site), 1);
  assert.deepEqual(readdirSync(join(site, 'pieces')).sort(), ['i1.bin', 'i2.bin', 's1.bin']);
  assert.equal(prunePieces(join(tmp, 'none')), 0);
});
