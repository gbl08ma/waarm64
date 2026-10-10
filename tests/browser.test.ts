// Chromium end-to-end tests (CHROMIUM env var overrides the binary): what only a
// browser has (workers with a device worker, sync XHR range reads, OPFS, the
// canvas, DOM input, cross-origin isolation). Guest semantics are covered more
// cheaply natively and in Node (docs/testing.md).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { STEPS } from './steps.ts';
import { CONSOLE_INPUT_WANT } from '../web/vm.ts';

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
  assert.deepEqual(await result('/tests/browser/core.html', 'result'), { crossOriginIsolated: true, abi: 34, counter: 2 });
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
  const r = (await h.jsonValue()) as { error?: string; kind: number; x0: string; steps: number; ms: number; console: string; hvc: string; pause?: unknown; files?: unknown; pixels?: Record<string, number[]> };
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

// Console input (M8 loop 1, web/vm.ts `CONSOLE_INPUT`): a shell on the console
// reads what the host sends through the PL011's RX ring, more than the ring
// holds; deterministic under the JIT at its step count, and in parallel on 2 vCPUs.
for (const [mode, query] of [['deterministic JIT', 'jit=1'], ['parallel JIT, 2 vCPUs', 'jit=1&parallel&ncpus=2']]) {
  test(`console input reaches a shell in a worker, ${mode}`, { skip: !existsSync(IMAGES) && 'SKIPPED: run images/build.sh' }, async () => {
    const r = await bootPage(`input&${query}`, 5);
    assert.equal(r.error, undefined);
    assert.deepEqual([r.kind, r.x0], [1, '0x84000008'], `${r.steps} steps, PCs ${JSON.stringify((r as { pc?: unknown }).pc, (_, v) => (typeof v === 'bigint' ? `0x${v.toString(16)}` : v))}, console:\n${r.console}`);
    assert.ok(r.console.includes(CONSOLE_INPUT_WANT), r.console);
    if (!mode.startsWith('parallel')) assert.equal(r.steps, STEPS['console-input']);
  });
}

// Parallel SMP (M7 loop 5): a worker per vCPU (nested in the boot worker),
// realtime, so not reproducible: WEBPC_PARALLEL_RUNS boots (default 3), all must pass.
const RUNS = Number(process.env.WEBPC_PARALLEL_RUNS ?? 3);
test('Linux boots on 4 vCPUs in parallel (a worker each), JIT', { skip: !existsSync(IMAGES) && 'SKIPPED: run images/build.sh' }, async () => {
  for (let i = 1; i <= RUNS; i++) {
    const r = await bootPage('parallel&ncpus=4&jit=1', 10);
    assert.equal(r.error, undefined, `run ${i}`);
    console.log(`# chromium parallel boot ${i} (4 vCPUs, JIT): ${(r.ms / 1000).toFixed(1)} s`);
    assert.deepEqual([r.kind, r.x0], [1, '0x84000008'], r.console);
    assert.match(r.console, /smp: Brought up 1 node, 4 CPUs[^]*webpc: test ok\nwebpc: test exit 0\n/);
  }
});

// Snapshots (web/snapshot.ts): the VM saved to a file (the device worker gives the backends' state),
// closed, and a new one started from it, four times in a boot. The steps and the console are the
// unbroken boot's.
test('Linux boots under the JIT through 4 snapshot files', { skip: !existsSync(IMAGES) && 'SKIPPED: run images/build.sh' }, async () => {
  const whole = await bootPage('jit=1', 10);
  const r = await bootPage('jit=1&snapshots=3000000,14000000,26000000,38000000', 10);
  assert.equal(r.error, undefined);
  const files = r.files as { bytes: number; saveMs: number; restoreMs: number }[];
  console.log(`# chromium snapshots: ${files.map((f) => `${(f.bytes / 2 ** 20).toFixed(1)} MiB, saved in ${f.saveMs.toFixed(0)} ms, started from in ${f.restoreMs.toFixed(0)} ms`).join('; ')}`);
  assert.equal(files.length, 4);
  assert.deepEqual([r.kind, r.x0, r.steps], [1, '0x84000008', STEPS.buildroot], r.console);
  assert.equal(r.console, whole.console);
  assert.equal(r.hvc, whole.hvc);
});

// The same on 4 parallel vCPUs: paused, saved, closed (its vCPU workers and device worker end), and a
// new VM with new workers started from the file.
test('Linux boots on 4 vCPUs in parallel through snapshot files, JIT', { skip: !existsSync(IMAGES) && 'SKIPPED: run images/build.sh' }, async () => {
  for (let i = 1; i <= RUNS; i++) {
    const r = await bootPage('parallel&ncpus=4&jit=1&snapshots=5000000,11000000,18000000,26000000,35000000', 10);
    assert.equal(r.error, undefined, `run ${i}`);
    const files = r.files as { bytes: number; saveMs: number; restoreMs: number }[];
    console.log(`# chromium parallel snapshots ${i}: ${files.map((f) => `${(f.bytes / 2 ** 20).toFixed(1)} MiB, ${f.saveMs.toFixed(0)} + ${f.restoreMs.toFixed(0)} ms`).join('; ')}`);
    assert.ok(files.length >= 4, `${files.length} snapshots`);
    assert.deepEqual([r.kind, r.x0], [1, '0x84000008'], r.console);
    assert.match(r.console, /smp: Brought up 1 node, 4 CPUs[^]*webpc: test ok\nwebpc: test exit 0\n/);
    assert.equal(r.hvc.replaceAll('\r\n', '\n'), 'webpc: hvc0 ok\n');
  }
});

// Pause and resume (web/vm.ts `pause`): the same boot paused every ~30 ms by the boot worker (`?pauses`);
// the device worker serves the doorbell there. It must still reach its end, and nothing runs while paused.
test('Linux boots on 4 vCPUs in parallel through 10+ pauses and resumes, JIT', { skip: !existsSync(IMAGES) && 'SKIPPED: run images/build.sh' }, async () => {
  for (let i = 1; i <= RUNS; i++) {
    const r = await bootPage('parallel&ncpus=4&jit=1&pauses=1', 10);
    assert.equal(r.error, undefined, `run ${i}`);
    const p = r.pause as { n: number; ms: number[]; bad: string };
    assert.equal(p.bad, '');
    assert.ok(p.n >= 10, `${p.n} pauses in ${r.ms} ms`);
    const ms = [...p.ms].sort((a, b) => a - b);
    console.log(`# chromium pauses ${i}: ${p.n} in a ${(r.ms / 1000).toFixed(1)} s boot, latency median ${ms[ms.length >> 1].toFixed(1)} ms, worst ${ms.at(-1)!.toFixed(1)} ms`);
    assert.deepEqual([r.kind, r.x0], [1, '0x84000008'], r.console);
    assert.match(r.console, /smp: Brought up 1 node, 4 CPUs[^]*webpc: test ok\nwebpc: test exit 0\n/);
  }
});

// The litmus image's tests and atomics stress on 4 parallel vCPUs (M7 loop 7;
// tests/boot-node.test.ts has the rest of its runs).
const LITMUS = new URL('../target/images/litmus/initramfs.cpio', import.meta.url);
const GPU_IMAGE = new URL('../target/images/linux-gpu/Image', import.meta.url);
test('litmus and atomics stress on 4 vCPUs in parallel, JIT', { skip: !existsSync(LITMUS) && 'SKIPPED: run images/build.sh linux litmus' }, async () => {
  const r = await bootPage('litmus=-s,1000,-r,10&stress=-n,100000&parallel&ncpus=4&jit=1', 5);
  assert.equal(r.error, undefined);
  console.log(`# chromium litmus and stress (4 vCPUs, JIT): ${(r.ms / 1000).toFixed(1)} s; ${r.console.match(/stress: spin ok .*/g)?.join('; ')}`);
  assert.deepEqual([r.kind, r.x0], [1, '0x84000008'], r.console);
  assert.match(r.console, /litmus: all ok, 0 skipped\nwebpc: stress on 4 CPUs[^]*\nwebpc: test ok\n/, r.console);
});

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

// Snapshots carry the disk's changes (web/snapshot.ts): the same first boot through three snapshot
// files, each restore replacing the OPFS overlay with the file's blocks from the machine's worker
// (the old VM's device worker has closed it), takes the unbroken boot's steps and writes the same
// file, which the next boot finds.
test('a boot that writes its disk goes through snapshot files, and the overlay is the last file\'s plus what followed', { skip: !existsSync(IMAGES) && 'SKIPPED: run images/build.sh' }, async () => {
  const [plain, name] = ['webpc-test-snap-plain', 'webpc-test-snap-rw'];
  await removeOverlay(plain);
  await removeOverlay(name);
  const whole = await bootPage(`overlay=${plain}&script=/test-rw.sh&jit=1`, 10);
  assert.equal(whole.error, undefined);
  const wrote = whole.console.match(/rw: wrote (.*)\n/)?.[1];
  assert.ok(wrote, whole.console);
  const at = [8_000_000, 5_000_000, 3_000_000, 1_000_000].map((k) => whole.steps - k);
  const r = await bootPage(`overlay=${name}&script=/test-rw.sh&jit=1&snapshots=${at.join(',')}`, 10);
  assert.equal(r.error, undefined);
  const files = r.files as { bytes: number }[];
  console.log(`# chromium rw boot through snapshots: files ${files.map((f) => (f.bytes / 2 ** 20).toFixed(1)).join(', ')} MiB`);
  assert.deepEqual([r.kind, r.x0, r.steps, files.length], [1, '0x84000008', whole.steps, 4], r.console);
  assert.equal(r.console, whole.console);
  const next = await bootPage(`overlay=${name}&script=/test-rw.sh&jit=1`, 10);
  assert.equal(next.console.match(/rw: kept (.*)\n/)?.[1], wrote, next.console);
  await removeOverlay(plain);
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

// The gpu test kernel on a virtio-gpu served by the device worker (M8 graphics G1): the same steps, console and
// scanout and cursor hashes as the native twin and Node (core/tests/gpu_guest.rs, tests/boot-node-suite.ts).
for (const jit of [0, 1]) test(`the gpu guest draws, sends damage, sets a cursor and follows a display event, deterministic mode${jit ? ', JIT' : ''}`, { skip: !existsSync(GPU_IMAGE) && 'SKIPPED: run images/build.sh linux-gpu' }, async () => {
  const want = JSON.parse(readFileSync(new URL('./gpu/guest.json', import.meta.url), 'utf8')) as { resizeAfter: string; screen: string; cursor: string; trace1: string; trace2: string; trace3: string };
  const r = await bootPage(`gpu=${want.resizeAfter}&jit=${jit}`, 10) as Awaited<ReturnType<typeof bootPage>> & { gpu?: { width: number; screen: string; trace: string[]; cursor: { hash: string } } };
  assert.equal(r.error, undefined);
  console.log(`# chromium gpu boot${jit ? ' (JIT)' : ''}: ${r.steps} steps`);
  assert.deepEqual([r.kind, r.x0], [1, '0x84000008'], r.console);
  assert.ok(r.console.includes('webpc: gpu test ok\n'), r.console);
  assert.equal(r.steps, STEPS.gpu);
  assert.deepEqual([r.gpu?.width, r.gpu?.screen, r.gpu?.cursor.hash], [800, want.screen, want.cursor]);
  assert.deepEqual(r.gpu?.trace, [want.trace1, want.trace2, want.trace3]);
});

// The overlay's hand-over (M8 loop 8): OPFS sync access handles are exclusive, so a machine
// opens the overlay only once the one before it closed it. openOverlay takes a Web Lock that
// the holder keeps until its handles are closed (web/overlay.ts `lockOverlay`); a terminated
// holder drops both; one that holds on past the wait is "in use".
test("the overlay's hand-over: a second opener waits for the holder to close it, a terminated holder lets go, one held too long is in use", async () => {
  const page = await context.newPage();
  await page.goto(`${base}/tests/browser/core.html`);
  const r = await page.evaluate(async () => {
    type Answer = { type: string; at: number; message?: string };
    const spawn = () => new Worker('/tests/browser/overlay-worker.ts', { type: 'module' });
    const ask = (w: Worker, m: object) => new Promise<Answer>((resolve) => { w.onmessage = (e) => resolve(e.data); w.postMessage(m); });
    const name = 'webpc-test-handover';
    const [a, b] = [spawn(), spawn()];
    const opened = await ask(a, { type: 'open', name });
    const waiting = ask(b, { type: 'open', name }); // at once: it waits for `a`
    await new Promise((resolve) => setTimeout(resolve, 300));
    const closed = await ask(a, { type: 'close' });
    const second = await waiting;
    // Terminated while it holds the overlay (a machine worker that didn't answer `stop`): the next opens it at once.
    const terminated: Answer[] = [];
    let holder = b;
    for (let i = 0; i < 20; i++) {
      holder.terminate();
      holder = spawn();
      terminated.push(await ask(holder, { type: 'open', name }));
    }
    const c = spawn();
    const busy = await ask(c, { type: 'open', name, waitMs: 300 });
    holder.terminate();
    c.terminate();
    // The terminated holder's handles are released a moment after `terminate()` returns (under load, later).
    for (let i = 0; ; i++) {
      try {
        await (await navigator.storage.getDirectory()).removeEntry(name, { recursive: true });
        break;
      } catch (e) {
        if (i === 50 || (e as DOMException).name !== 'NoModificationAllowedError') throw e;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return { opened: opened.type, second: second.type, waited: second.at >= closed.at, terminated: terminated.filter((t) => t.type !== 'opened').map((t) => t.message), busy: busy.message };
  });
  assert.deepEqual(r, { opened: 'opened', second: 'opened', waited: true, terminated: [], busy: 'Error: overlay webpc-test-handover is in use: another machine held it for 0.3 s' });
  await page.close();
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
// WEBPC_DISTROS=alpine (scripts/ci.sh sets it when the image is current). Debian boots through UEFI on the page (tests/page-debian.test.ts), not here.
const alpine = (process.env.WEBPC_DISTROS ?? '').split(',').includes('alpine');
{
  const img = new URL('../target/images/alpine/Image', import.meta.url);
  const skip = !alpine ? 'SKIPPED: set WEBPC_DISTROS=alpine' : !existsSync(img) && 'SKIPPED: run images/build.sh alpine';
  test('alpine boots from virtio-blk in a worker, deterministic mode, JIT', { skip }, async () => {
    const r = await bootPage('distro=alpine&jit=1', 10);
    assert.equal(r.error, undefined);
    console.log(`# chromium alpine boot (JIT): ${r.steps} steps in ${(r.ms / 1000).toFixed(1)} s (${(r.steps / r.ms / 1000).toFixed(1)} MIPS)`);
    assert.deepEqual([r.kind, r.x0], [1, '0x84000008'], r.console);
    assert.match(r.console, /webpc: alpine 3\.24\.2 6\.18\.53-0-virt\n[^]*\/dev\/vda \/ ext4 ro,[^]*1 packets received[^]*webpc: 9p hello from the host\n[^]*webpc: drm 640x480\nwebpc: test ok\n/);
    assert.equal(r.steps, STEPS.alpine);
  });

  test('alpine boots on 4 vCPUs in parallel (a worker each), JIT', { skip }, async () => {
    for (let i = 1; i <= Math.min(RUNS, 2); i++) {
      const r = await bootPage('distro=alpine&parallel&ncpus=4&jit=1', 10);
      assert.equal(r.error, undefined, `run ${i}`);
      console.log(`# chromium alpine parallel boot ${i} (4 vCPUs, JIT): ${(r.ms / 1000).toFixed(1)} s`);
      assert.deepEqual([r.kind, r.x0], [1, '0x84000008'], r.console);
      assert.match(r.console, /smp: Brought up 1 node, 4 CPUs[^]*webpc: test ok\n/);
    }
  });
}

// web/display.ts puts only the rows that changed since the last frame on the canvas (M8 loop 3).
test('the screen draws the rows that changed', async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/web/display.ts`); // the origin; the module is imported below
  const r = await page.evaluate(async (url) => {
    const { showFramebuffer } = (await import(url)) as typeof import('../web/display.ts');
    const memory = new WebAssembly.Memory({ initial: 1 });
    const canvas = document.body.appendChild(document.createElement('canvas'));
    const screen = showFramebuffer(canvas, memory, { addr: 64, width: 64, height: 32 });
    screen.stop(); // draws only when asked below
    const px = new Uint32Array(memory.buffer, 64, 64 * 32);
    const ctx = canvas.getContext('2d')!;
    const at = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data];
    const rows = [screen.draw(), screen.draw()];
    px[5 * 64 + 3] = 0xff0000;
    px[9 * 64 + 60] = 0x0000ff;
    rows.push(screen.draw(), screen.draw());
    return { rows, red: at(3, 5), blue: at(60, 9), black: at(0, 0) };
  }, '/web/display.ts');
  assert.deepEqual(r, { rows: [[0, 32], [0, 0], [5, 10], [0, 0]], red: [255, 0, 0, 255], blue: [0, 0, 255, 255], black: [0, 0, 0, 255] });
  await page.close();
});

// The page (web/app/, M8 loop 2) on the Buildroot guest, a shell on its serial
// console: the machine worker boots, serial output reaches xterm.js and keys
// typed there reach the shell, a key pressed on the screen reaches the guest's
// keyboard (read from /dev/input/event0), the shell's exit powers it off,
// Start boots a new machine and Restart replaces a running one. xterm.js's DOM renderer puts the text in `.xterm-rows`.
test('the page runs a machine: serial terminal both ways, keyboard, power off, start again', { skip: !existsSync(IMAGES) && 'SKIPPED: run images/build.sh' }, async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/web/app/?machine=buildroot&ncpus=2&view=both`);
  const state = (s: string, ms = 60_000) => page.waitForFunction((s) => document.body.dataset.state === s || document.body.dataset.state === 'crashed', s, { timeout: ms, polling: 100 })
    .then(async () => assert.equal(await page.evaluate(() => document.body.dataset.state), s, await page.locator('#message').textContent() ?? ''));
  const terminal = () => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
  const shows = (re: RegExp, ms = 20_000) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: ms, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the terminal shows: ${await terminal()}`); });
  await state('running');
  assert.deepEqual(await page.evaluate(() => { const c = document.querySelector('canvas')!; return [c.width, c.height, Number.isInteger(Number(c.dataset.scale))]; }), [640, 480, true]);
  // The machine worker draws the screen (a transferred canvas): two pixels written to /dev/fb0 show.
  await page.locator('.xterm').click();
  await page.keyboard.type("printf '\\377\\377\\377\\377' >/dev/fb0; printf '\\0\\0\\377\\0' | dd of=/dev/fb0 bs=4 seek=64010 2>/dev/null; echo dr\"\"awn\n");
  await shows(/drawn/);
  await page.waitForFunction(() => {
    const c = Object.assign(document.createElement('canvas'), { width: 640, height: 480 });
    const ctx = c.getContext('2d')!;
    ctx.drawImage(document.querySelector('#screen')!, 0, 0);
    const at = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data].join();
    return at(0, 0) === '255,255,255,255' && at(10, 100) === '255,0,0,255' && at(5, 5) === '0,0,0,255';
  }, null, { timeout: 5_000, polling: 100 });
  await page.locator('.xterm').click();
  await page.keyboard.type('echo webpc-$((6*7)); echo re""ady; dd bs=24 count=1 </dev/input/event0 2>/dev/null | od -An -j16 -N4 -tu2\n');
  await shows(/webpc-42.*ready/);
  await page.waitForTimeout(300); // dd opens the device
  await page.locator('#screen').click();
  await page.keyboard.press('KeyA');
  await shows(/ready\s+1\s+30\b/); // EV_KEY KEY_A
  // (M8 loop 3.) Each check reads what the guest got through /dev/input (one event per dd: type, code, value).
  const events = (dev: number, n: number, marker: string) =>
    `echo ${marker.slice(0, 2)}""${marker.slice(2)}: $(for i in $(seq ${n}); do dd bs=24 count=1 2>/dev/null | od -An -j16 -N6 -tu2; done </dev/input/event${dev}) :end\n`;
  // A key held when the screen loses the focus is released then (the keyup goes elsewhere): no stuck keys.
  await page.locator('.xterm').click();
  await page.keyboard.type(events(0, 3, 'held'));
  await page.waitForTimeout(300); // dd opens the device
  await page.locator('#screen').click();
  await page.keyboard.down('KeyS');
  await page.locator('.xterm').click();
  await page.keyboard.up('KeyS');
  await shows(/held: 1 31 1 0 0 0 1 31 0 :end/); // not a repeat (1 31 2): a stuck key autorepeats
  // A chord from the Keys menu, in order and released in reverse.
  await page.keyboard.type(events(0, 12, 'chord'));
  await page.waitForTimeout(300);
  await page.locator('#keys summary').click();
  await page.locator('[data-chord="ControlLeft AltLeft F12"]').click();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'screen');
  await shows(/chord: 1 29 1 0 0 0 1 56 1 0 0 0 1 88 1 0 0 0 1 88 0 0 0 0 1 56 0 0 0 0 1 29 0 0 0 0 :end/);
  // The tablet through the canvas's scaling (stacked views below 1100 px: the screen scaled down).
  await page.setViewportSize({ width: 700, height: 800 });
  await page.waitForFunction(() => Number(document.querySelector('canvas')!.dataset.scale) < 1, null, { timeout: 5_000 });
  await page.locator('.xterm').click();
  await page.keyboard.type(events(1, 2, 'tablet'));
  await page.waitForTimeout(300);
  const box = (await page.locator('#screen').boundingBox())!;
  await page.mouse.move(box.x + box.width / 4, box.y + (box.height * 3) / 4);
  await shows(/tablet: 3 0 \d+ 3 1 \d+ :end/);
  const [x, y] = (await terminal()).match(/tablet: 3 0 (\d+) 3 1 (\d+) :end/)!.slice(1).map(Number);
  assert.ok(Math.abs(x - 8192) < 200 && Math.abs(y - 24575) < 200, `tablet at ${x}, ${y}`);
  await page.setViewportSize({ width: 1400, height: 900 });
  // A paste larger than the console's 4 KiB RX ring (xterm.js turns \n into \r; the tty turns it back).
  const pasted = Array.from({ length: 200 }, (_, i) => `${String(i).padStart(3, '0')}${'x'.repeat(46)}\n`).join('');
  await page.locator('.xterm').click();
  await page.keyboard.type('md5sum; echo pa""sted\n');
  await page.waitForTimeout(300); // md5sum reads (the shell's line editor would take a paste typed ahead as commands)
  await page.evaluate((text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    document.querySelector('.xterm-helper-textarea')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, pasted);
  await page.keyboard.press('Control+D');
  await shows(new RegExp(`${createHash('md5').update(pasted).digest('hex')}\\s+-\\s*pasted`));
  // Full screen (the Keyboard Lock is Chromium's; headless may refuse it, which the page tolerates).
  await page.locator('#fullscreen').click();
  await page.waitForFunction(() => document.fullscreenElement?.tagName === 'MAIN', null, { timeout: 5_000 });
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'screen');
  await page.evaluate(() => document.exitFullscreen());
  await page.locator('.xterm').click();
  await page.keyboard.type('clear; exit\n');
  await state('off');
  assert.equal(await page.locator('#restart').textContent(), 'Start');
  await page.locator('#restart').click();
  await state('running');
  assert.doesNotMatch(await terminal(), /webpc-42/); // a new machine, a cleared terminal
  // Restart while running (after a confirmation): the old machine releases its disk overlay for the new one.
  page.once('dialog', (d) => void d.accept());
  await page.locator('#restart').click();
  await page.waitForFunction(() => document.body.dataset.state !== 'running', null, { timeout: 10_000, polling: 50 });
  await state('running');
  const t = await terminal();
  assert.equal(t.match(/Run \/init as init process/g)?.length, 1, t); // one boot's log
  assert.deepEqual(errors, []);
  await page.close();
});

// Restart, repeatedly, while the guest writes to its disk (M8 loop 8: a Restart once failed with
// "disk in use"): each new machine opens the overlay the one before had open. Half of them
// restart again while the new machine is still loading or booting (its device worker may have the
// overlay open before the machine worker has the VM), and one is a double click (a second machine
// started beside the first would keep the overlay). No state may be `failed` in between.
test('the page restarts over and over while the guest writes to its disk, also during a boot', { skip: !existsSync(IMAGES) && 'SKIPPED: run images/build.sh' }, async () => {
  const page = await browser.newPage();
  page.on('dialog', (d) => void d.accept());
  await page.goto(`${base}/web/app/?machine=buildroot&ncpus=2&view=terminal`);
  await page.evaluate(() => {
    const w = window as unknown as { states: string[] };
    w.states = [];
    new MutationObserver(() => w.states.push(document.body.dataset.state!)).observe(document.body, { attributeFilter: ['data-state'] });
  });
  const state = () => page.evaluate(() => document.body.dataset.state!);
  const running = () => page.waitForFunction(() => ['running', 'failed', 'crashed'].includes(document.body.dataset.state!), null, { timeout: 60_000, polling: 20 });
  for (let i = 0; i < 6; i++) {
    await running();
    assert.equal(await state(), 'running', await page.locator('#message-text').textContent() ?? '');
    // The root's first 2 MiB written over with themselves (same bytes: the mounted filesystem doesn't mind), synced, in a loop.
    await page.locator('.xterm').click();
    await page.keyboard.type('(while :; do dd if=/dev/vda of=/dev/vda bs=64k count=32 2>/dev/null; sync; done) & echo wr""iting\n');
    await page.waitForFunction(() => /writing/.test(document.querySelector('.xterm-rows')?.textContent ?? ''), null, { timeout: 20_000, polling: 50 });
    await page.waitForTimeout(100 + 150 * i);
    if (i === 4) await page.evaluate(() => { const b = document.getElementById('restart')!; b.click(); b.click(); }); // a double click: one restart
    else await page.locator('#restart').click();
    if (i % 2) {
      // Once the new machine is loading (the button is disabled until the old one has stopped), or booting.
      await page.waitForFunction((i) => document.body.dataset.state === (i % 4 === 1 ? 'loading' : 'booting'), i, { timeout: 30_000, polling: 5 });
      await page.locator('#restart').click();
    }
    await page.waitForFunction(() => document.body.dataset.state === 'loading', null, { timeout: 10_000, polling: 5 });
  }
  await running();
  const states = await page.evaluate(() => (window as unknown as { states: string[] }).states);
  assert.ok(!states.includes('failed') && !states.includes('crashed'), `${states.join(' ')}: ${await page.locator('#message-text').textContent()}`);
  await page.close();
});

type Page = import('playwright-core').Page;
/** The page's state once it settles, with its message and the message's actions. */
/** (`from`: a state it's leaving, e.g. after a click on Retry.) */
const settled = (page: Page, ms = 30_000, from?: string) =>
  page.waitForFunction((from) => document.body.dataset.state !== from && ['running', 'failed', 'crashed', 'idle', 'off'].includes(document.body.dataset.state!), from, { timeout: ms, polling: 50 })
    .then(() => page.evaluate(() => ({ state: document.body.dataset.state, text: document.getElementById('message-text')!.textContent, actions: [...document.querySelectorAll('#message-actions button')].map((b) => b.textContent) })));

// The page's messages (M8 loop 4): what stops a machine from starting says what to do.
test("the page says what's wrong: no cross-origin isolation, a missing script, core or image (then Retry), too little memory", { skip: !existsSync(IMAGES) && 'SKIPPED: run images/build.sh' }, async () => {
  const ctx = await browser.newContext();
  const open = async (route?: (page: Page) => Promise<unknown>) => {
    const page = await ctx.newPage();
    await route?.(page);
    await page.goto(`${base}/web/app/?machine=buildroot&ncpus=1`);
    return page;
  };
  // Served without COOP/COEP: no worker is started.
  let page = await open((p) => p.route((u) => u.pathname === '/web/app/', async (r) => {
    const res = await r.fetch();
    await r.fulfill({ response: res, headers: Object.fromEntries(Object.entries(res.headers()).filter(([k]) => !k.startsWith('cross-origin'))) });
  }));
  let r = await settled(page);
  assert.equal(r.state, 'failed');
  assert.match(r.text!, /cross-origin isolation[^]*npm start/);
  assert.equal(await page.locator('#restart').isHidden(), true);
  await page.close();
  // xterm.js not installed: the module graph fails to load.
  page = await open((p) => p.route('**/xterm.mjs', (r) => r.fulfill({ status: 404 })));
  await page.waitForFunction(() => document.getElementById('state')!.dataset.state === 'failed', null, { timeout: 10_000, polling: 50 });
  assert.match(await page.locator('#message-text').textContent() ?? '', /scripts didn't load[^]*npm start/);
  await page.close();
  // The core, then an image: 404s from the machine worker's fetches; Retry once they're back.
  for (const [pattern, want] of [
    ['**/webpc_core.wasm', /emulator core isn't built: target\/wasm32-unknown-unknown\/release\/webpc_core\.wasm answered HTTP 404[^]*npm start/],
    ['**/buildroot/rootfs.ext4', /Buildroot \(test guest\)'s image isn't there: target\/images\/buildroot\/rootfs\.ext4 answered HTTP 404[^]*images\/build\.sh/],
  ] as const) {
    page = await open((p) => p.route(pattern, (r) => r.fulfill({ status: 404 })));
    r = await settled(page);
    assert.equal(r.state, 'failed', r.text!);
    assert.match(r.text!, want);
    assert.deepEqual(r.actions, ['Retry']);
    await page.unroute(pattern);
    await page.locator('#message-actions button').click();
    assert.equal((await settled(page, 30_000, 'failed')).state, 'running');
    await page.close();
  }
  // A device that reports 1 GB: the page asks before starting a machine that needs more.
  page = await open((p) => p.addInitScript(() => Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 1 })));
  r = await settled(page);
  assert.equal(r.state, 'idle');
  assert.match(r.text!, /needs about 1\.6 GB of memory \(256 MiB of guest RAM plus the emulator, 1 vCPU\), and this device reports 1 GB/);
  assert.deepEqual(r.actions, ['Start anyway']);
  await page.locator('#message-actions button').click();
  assert.equal((await settled(page, 30_000, 'idle')).state, 'running');
  await page.close();
  // A saved disk written over another image: the way out is a reset.
  const prep = await ctx.newPage();
  await prep.goto(`${base}/tests/browser/core.html`); // any page of the origin
  await prep.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('webpc-buildroot', { create: true });
    const w = await (await dir.getFileHandle('base', { create: true })).createWritable();
    await w.write('{"path":"/elsewhere.img","size":4096}');
    await w.close();
  });
  await prep.close();
  page = await open();
  r = await settled(page);
  assert.equal(r.state, 'failed', r.text!);
  assert.match(r.text!, /^Buildroot \(test guest\)'s saved disk was written over a different image[^]*Reset the disk/);
  assert.deepEqual(r.actions, ['Reset disk…']);
  page.once('dialog', (d) => void d.accept());
  await page.locator('#message-actions button').click();
  assert.equal((await settled(page, 30_000, 'failed')).state, 'running');
  await page.close();
  await ctx.close();
});

// A panic, the serial log, the disk in use by another tab, the disk reset, the remembered view (M8 loop 4).
test('the page: a panic with its serial log, the disk in use elsewhere, the disk reset, the view remembered', { skip: !existsSync(IMAGES) && 'SKIPPED: run images/build.sh' }, async () => {
  const ctx = await browser.newContext({ acceptDownloads: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
  const shows = (page: Page, re: RegExp) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: 20_000, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the terminal shows: ${await terminal(page)}`); });
  // A guest panic (Buildroot resets at once, panic=-1): the page keeps it on show, with the log to copy and save.
  let page = await ctx.newPage();
  await page.goto(`${base}/web/app/?machine=buildroot&ncpus=1&view=screen&params=init=/nonexistent`);
  let r = await settled(page);
  assert.equal(r.state, 'crashed');
  assert.match(r.text!, /^The guest's kernel panicked: Kernel panic - not syncing: Requested init \/nonexistent failed/);
  assert.deepEqual(r.actions, ['Show serial log', 'Copy serial log', 'Save serial log']);
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => document.body.dataset.state), 'crashed'); // not restarted by the reset
  await page.getByText('Copy serial log').click();
  await page.getByText('Copied').waitFor({ timeout: 5_000 });
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(copied, /Booting Linux on physical CPU[^]*Kernel panic - not syncing: Requested init/);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByText('Save serial log').click()]);
  assert.match(download.suggestedFilename(), /^webpc-buildroot-serial-.*\.log$/);
  assert.equal((await readFile((await download.path())!)).toString(), copied);
  await page.getByText('Show serial log').click();
  assert.equal(await page.evaluate(() => document.body.dataset.view), 'both');
  await page.close();
  // The view chosen last is remembered (the panic's "Show serial log" doesn't count); ?view= overrides it.
  page = await ctx.newPage();
  await page.goto(`${base}/web/app/?machine=buildroot&ncpus=1`);
  assert.equal(await page.evaluate(() => document.body.dataset.view), 'screen');
  await page.getByText('Serial terminal').click();
  assert.equal((await settled(page)).state, 'running');
  // The disk: a file written (the root remounted read-write for it), kept over a restart.
  await page.locator('.xterm').click();
  await page.keyboard.type('mount -o remount,rw / && echo webpc-mark >/mark && mount -o remount,ro / && echo wr""itten\n');
  await shows(page, /written/);
  const second = await ctx.newPage(); // another tab: the disk is the first one's
  await second.goto(`${base}/web/app/?machine=buildroot&ncpus=1`);
  assert.equal(await second.evaluate(() => document.body.dataset.view), 'terminal');
  r = await settled(second);
  assert.equal(r.state, 'failed', r.text!);
  assert.match(r.text!, /^Buildroot \(test guest\)'s disk is in use: another tab/);
  assert.deepEqual(r.actions, ['Retry']);
  page.once('dialog', (d) => void d.accept());
  await page.locator('#restart').click();
  await page.waitForFunction(() => document.body.dataset.state !== 'running', null, { timeout: 10_000, polling: 50 });
  assert.equal((await settled(page)).state, 'running');
  await page.locator('.xterm').click();
  await page.keyboard.type('echo "[$(cat /mark)]"\n');
  await shows(page, /\[webpc-mark\]/);
  // Reset: a confirmation (with what the overlay holds), a stop, the overlay deleted, a boot from the image.
  let asked = '';
  page.once('dialog', (d) => { asked = d.message(); void d.accept(); });
  await page.locator('#reset-disk').click();
  await page.waitForFunction(() => document.body.dataset.state !== 'running', null, { timeout: 10_000, polling: 50 });
  assert.equal((await settled(page)).state, 'running');
  assert.match(asked, /^Reset Buildroot \(test guest\)'s disk\? Everything the machine wrote to it \(\d+ KB\) is deleted/);
  await page.locator('.xterm').click();
  await page.keyboard.type('cat /mark || echo n""one\n');
  await shows(page, /No such file or directory\s*none/);
  // The other tab starts once this one lets the disk go.
  await page.close();
  await second.locator('#message-actions button').click();
  assert.equal((await settled(second, 30_000, 'failed')).state, 'running');
  await second.close();
  await ctx.close();
});
