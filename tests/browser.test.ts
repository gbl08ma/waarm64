// Chromium end-to-end tests (CHROMIUM env var overrides the binary): what only a
// browser has (workers with a device worker, sync XHR range reads, OPFS, the
// canvas, DOM input, cross-origin isolation). Guest semantics are covered more
// cheaply natively and in Node (docs/testing.md).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { STEPS } from './steps.ts';

let browser: Browser;
let context: BrowserContext; // one origin storage (OPFS) for the boot pages; browser.newPage() gets a fresh one each time
let base: string;
let close: () => void;

before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  context = await browser.newContext();
});
after(async () => { await browser?.close(); close?.(); });

async function result(path: string, global: string) {
  const page = await browser.newPage();
  await page.goto(base + path);
  const h = await page.waitForFunction((g) => (window as never)[g], global, { timeout: 120_000 });
  const v = await h.jsonValue();
  await page.close();
  return v as Record<string, unknown>;
}

test('core wasm runs in a cross-origin isolated worker', async () => {
  assert.deepEqual(await result('/tests/browser/core.html', 'result'), { crossOriginIsolated: true, abi: 22, counter: 2 });
});

test('three core instances run guests concurrently on one memory in workers (M7)', async () => {
  const r = (await result('/tests/browser/threads.html', 'result')) as { error?: string; reference: number; checks: { what: string; done: number; ms: number; tls: number; registers: boolean; ram: boolean }[] };
  assert.equal(r.error, undefined);
  assert.equal(r.reference, 30_000_000);
  for (const c of r.checks) {
    console.log(`# chromium ${c.what}: ${c.done} steps in ${c.ms.toFixed(0)} ms`);
    assert.deepEqual({ done: c.done, tls: c.tls, registers: c.registers, ram: c.ram }, { done: 30_000_000, tls: 1, registers: true, ram: true }, c.what);
  }
});

test('spike page runs', async () => {
  const r = await result('/bench/spike/index.html?quick&only=simd', 'benchResult');
  assert.equal(r.error, undefined);
  assert.equal(r.crossOriginIsolated, true);
  assert.ok((r.results as unknown[]).length > 0);
});

/** Boots tests/browser/boot.html with `query` and returns the worker's result. */
async function bootPage(query: string, minutes: number) {
  const page = await context.newPage();
  await page.goto(`${base}/tests/browser/boot.html?${query}`);
  const h = await page.waitForFunction(() => (window as never)['result'], null, { timeout: minutes * 60_000, polling: 1000 });
  const r = (await h.jsonValue()) as { error?: string; kind: number; x0: string; steps: number; ms: number; console: string; hvc: string; pixels?: Record<string, number[]> };
  await page.close();
  return { ...r, console: r.console?.replaceAll('\r\n', '\n') };
}

/** Deletes an OPFS overlay directory (the origin's, shared by the pages of `context`). */
async function removeOverlay(name: string) {
  const page = await context.newPage();
  await page.goto(`${base}/tests/browser/core.html`); // any page of the origin
  await page.evaluate(async (n) => (await navigator.storage.getDirectory()).removeEntry(n, { recursive: true }).catch(() => {}), name);
  await page.close();
}

const IMAGES = new URL('../target/images/linux/Image', import.meta.url);
for (const [mode, query] of [['deterministic', ''], ['realtime', '?realtime'], ['deterministic JIT', '?jit=1'], ['deterministic JIT, 4 vCPUs', '?jit=1&ncpus=4']]) {
  test(`Linux boots in a worker with virtio devices (root on virtio-blk over HTTP), ${mode} mode`, { skip: !existsSync(IMAGES) && 'SKIPPED: run images/build.sh' }, async () => {
    const page = await browser.newPage();
    await page.goto(base + '/tests/browser/boot.html' + query);
    const h = await page.waitForFunction(() => (window as never)['result'], null, { timeout: 30 * 60_000, polling: 1000 });
    const r = (await h.jsonValue()) as { error?: string; kind: number; x0: string; steps: number; ms: number; console: string; hvc: string };
    await page.close();
    assert.equal(r.error, undefined);
    console.log(`# chromium boot (${mode}): ${r.steps} steps in ${(r.ms / 1000).toFixed(1)} s (${(r.steps / r.ms / 1000).toFixed(1)} MIPS)`);
    assert.deepEqual([r.kind, r.x0], [1, '0x84000008'], r.console);
    if (mode !== 'realtime') assert.equal(r.steps, mode.endsWith('4 vCPUs') ? STEPS['buildroot-4cpu'] : STEPS.buildroot);
    const out = r.console.replaceAll('\r\n', '\n');
    assert.match(out, /answer: 42\n[^]*hwrng: [0-9a-f]{32}\n[^]*\/dev\/root \/ ext4 ro,[^]*vda magic: 53ef\nwebpc: test ok\nwebpc: test exit 0\n/);
    assert.equal(r.hvc.replaceAll('\r\n', '\n'), 'webpc: hvc0 ok\n');
  });
}

test('the root filesystem is writable through an OPFS overlay, and it persists across boots', { skip: !existsSync(IMAGES) && 'SKIPPED: run images/build.sh' }, async () => {
  const name = 'webpc-test-rw';
  await removeOverlay(name);
  const hashes = [];
  for (const n of [1, 2]) {
    const r = await bootPage(`overlay=${name}&script=/test-rw.sh`, 10);
    assert.equal(r.error, undefined);
    console.log(`# chromium rw boot ${n}: ${r.steps} steps`);
    assert.deepEqual([r.kind, r.x0], [1, '0x84000008'], r.console);
    assert.match(r.console, new RegExp(`rw: boot ${n}\n`));
    hashes.push(r.console.match(n === 1 ? /rw: wrote (.*)\n/ : /rw: kept (.*)\n/)?.[1]);
    assert.match(r.console, /webpc: test ok\n/);
  }
  assert.ok(hashes[0]);
  assert.equal(hashes[1], hashes[0]);
  await removeOverlay(name);
});

for (const jit of [0, 1]) test(`net (loopback adapter), 9p and the framebuffer work in the guest, deterministic mode${jit ? ', JIT' : ''}`, { skip: !existsSync(IMAGES) && 'SKIPPED: run images/build.sh' }, async () => {
  const r = await bootPage(`devices&script=/test-devices.sh&jit=${jit}`, 10);
  assert.equal(r.error, undefined);
  console.log(`# chromium devices boot${jit ? ' (JIT)' : ''}: ${r.steps} steps`);
  assert.deepEqual([r.kind, r.x0], [1, '0x84000008'], r.console);
  assert.equal(r.steps, STEPS.devices);
  for (const want of ['net: mac 52:54:00:12:34:56\n', '3 packets transmitted, 3 packets received, 0% packet loss\n', '9p: hello from the host\n',
    '9p: b some text 10 -rw-r--r--\n', '9p: big 200000 ok\n', '9p: ls b big l \n', '9p: after rm b \n', '9p: top from-guest hello.txt \n', 'fb: 0 simple 640,480\n', 'webpc: test ok\n']) {
    assert.ok(r.console.includes(want), `missing ${JSON.stringify(want)}`);
  }
  // Read back from the page's canvas: row 0 red, row 1 grey, row 2 untouched.
  assert.deepEqual(r.pixels, { '0,0': [255, 0, 0, 255], '639,0': [255, 0, 0, 255], '5,1': [64, 64, 64, 255], '5,2': [0, 0, 0, 255] });
});

test('input events from the page reach the guest (keyboard LED to the page, keys and a click back), realtime mode', { skip: !existsSync(IMAGES) && 'SKIPPED: run images/build.sh' }, async () => {
  const r = await bootPage('devices&realtime&script=/test-input.sh', 10);
  assert.equal(r.error, undefined);
  assert.deepEqual([r.kind, r.x0], [1, '0x84000008'], r.console);
  for (const want of ['N: Name="webpc keyboard"\n', 'B: EV=120003\n', 'B: LED=7\n', 'N: Name="webpc tablet"\n', 'B: EV=f\n', 'B: ABS=3\n',
    'input3: 1 30 1\n', 'input3: 1 30 0\n', 'input4: 3 0 16384\n', 'input4: 3 1 8192\n', 'input4: 1 272 1\n', 'input4: 1 272 0\n', 'webpc: test ok\n']) {
    assert.ok(r.console.includes(want), `missing ${JSON.stringify(want)}`);
  }
});

// The distros, under the JIT only (interpreted they take minutes: Alpine's
// interpreter run is native, core/tests/distros.rs). Opt-in with
// WEBPC_DISTROS=alpine,debian (scripts/ci.sh sets both when their images are current).
const DISTRO_TESTS = (process.env.WEBPC_DISTROS ?? '').split(',').filter(Boolean);
for (const [distro, expect] of [['alpine', /webpc: alpine 3\.24\.2 6\.18\.53-0-virt\n[^]*\/dev\/vda \/ ext4 ro,[^]*1 packets received[^]*webpc: 9p hello from the host\n[^]*webpc: drm 640x480\nwebpc: test ok\n/], ['debian', /webpc: debian\n13\.[^]*\n6\.12\.107\+deb13-arm64\nrw,[^]*webpc: test ok\n/]] as const) {
  const img = new URL(`../target/images/${distro}/Image`, import.meta.url);
  const skip = !DISTRO_TESTS.includes(distro) ? `SKIPPED: set WEBPC_DISTROS=${distro}` : !existsSync(img) && `SKIPPED: run images/build.sh ${distro}`;
  // Debian's root is writable through an overlay (a fresh one each run); Alpine's is read-only.
  const overlay = distro === 'debian' ? `webpc-test-${distro}` : undefined;
  test(`${distro} boots from virtio-blk in a worker, deterministic mode, JIT`, { skip }, async () => {
    if (overlay) await removeOverlay(overlay);
    const r = await bootPage(`distro=${distro}${overlay ? `&overlay=${overlay}` : ''}&jit=1`, 10);
    if (overlay) await removeOverlay(overlay);
    assert.equal(r.error, undefined);
    console.log(`# chromium ${distro} boot (JIT): ${r.steps} steps in ${(r.ms / 1000).toFixed(1)} s (${(r.steps / r.ms / 1000).toFixed(1)} MIPS)`);
    assert.deepEqual([r.kind, r.x0], [1, '0x84000008'], r.console);
    assert.match(r.console, expect);
    if (distro === 'alpine') assert.equal(r.steps, STEPS.alpine);
  });
}
