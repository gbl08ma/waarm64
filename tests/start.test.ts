// `npm start` (tools/start.js, tools/start.ts, tools/debian.ts; M8 loop 5): its
// checks, and a run on a copy of the repository as a fresh clone has it (tracked and
// untracked files, nothing ignored: no node_modules, no target/), up to the page
// booting Debian in Chromium (the firmware's output). The copy gets the core and the firmware built here unless
// WEBPC_START_COLD=1 (then it builds its own, the firmware with Podman: minutes); Debian comes from this
// checkout's download cache (WEBPC_DL), so nothing is downloaded.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { PIN, download, downloads } from '../tools/debian.ts';
import { ROOT, startServer } from '../tools/serve.ts';
import { FIRMWARE, WASM, firmwareStale, npmStale, podmanProblem, wasmInputs } from '../tools/start.ts';
import { withDebianLock } from './debian-lock.ts';

const tmp = (what: string) => mkdtempSync(join(tmpdir(), `webpc-${what}-`));
const write = (root: string, path: string, data: string | object) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), typeof data === 'string' ? data : JSON.stringify(data));
};

test('npmStale: node_modules against package-lock.json', () => {
  const d = tmp('npm');
  try {
    const lock = { packages: { '': {}, 'node_modules/a': { version: '1.0.0', integrity: 'sha512-a' }, 'node_modules/b-other-os': { version: '2.0.0', optional: true } } };
    write(d, 'package-lock.json', lock);
    assert.equal(npmStale(d), 'node_modules is missing');
    mkdirSync(join(d, 'node_modules'));
    assert.equal(npmStale(d), 'node_modules has no record of what npm installed');
    write(d, 'node_modules/.package-lock.json', { packages: { 'node_modules/a': { version: '1.0.0', integrity: 'sha512-a' } } });
    assert.equal(npmStale(d), undefined); // an optional package for another platform may be absent
    write(d, 'node_modules/.package-lock.json', { packages: { 'node_modules/a': { version: '0.9.0' } } });
    assert.equal(npmStale(d), "a 1.0.0 isn't installed");
    write(d, 'node_modules/.package-lock.json', { packages: { 'node_modules/a': { version: '1.0.0' }, 'node_modules/gone': { version: '1.0.0' } } });
    assert.equal(npmStale(d), 'gone is installed but not in package-lock.json');
  } finally {
    rmSync(d, { recursive: true });
  }
});

test('wasmInputs: the core rebuilds when its sources change, not when their mtimes do', () => {
  const d = tmp('wasm');
  try {
    write(d, 'Cargo.toml', '[workspace]');
    write(d, 'core/src/lib.rs', 'fn a() {}');
    write(d, 'core/src/jit/mod.rs', 'fn b() {}');
    const a = wasmInputs(d);
    write(d, 'core/src/lib.rs', 'fn a() {}');
    assert.equal(wasmInputs(d), a);
    write(d, 'core/src/jit/mod.rs', 'fn c() {}');
    assert.notEqual(wasmInputs(d), a);
    write(d, 'core/src/jit/mod.rs', 'fn b() {}');
    write(d, 'rust-toolchain.toml', '[toolchain]');
    assert.notEqual(wasmInputs(d), a);
  } finally {
    rmSync(d, { recursive: true });
  }
});

test('the firmware: built when missing or stale, and Podman, which builds it, said with how to get it', () => {
  const d = tmp('fw');
  try {
    assert.equal(firmwareStale(d), "the UEFI firmware isn't built");
    write(d, FIRMWARE, 'firmware'); // present, but no images/build.sh to say it is current: out of date
    assert.equal(firmwareStale(d), 'the UEFI firmware is out of date');
    assert.equal(firmwareStale(), existsSync(join(ROOT, FIRMWARE)) ? undefined : "the UEFI firmware isn't built"); // this checkout: what scripts/ci.sh builds
  } finally {
    rmSync(d, { recursive: true });
  }
  const none = podmanProblem({ PATH: '' });
  assert.match(none!, /^Podman isn't installed\. The page boots Debian through UEFI firmware \(EDK2\), which `npm start` builds in a rootless Podman container[^]*Install Podman[^]*then run `npm start` again\.$/);
});

test('the download: streamed to a .part file, checked against the pin, then kept and checked again', async () => {
  const d = tmp('dl');
  const server = await startServer();
  const saved = process.env.WEBPC_DL;
  try {
    process.env.WEBPC_DL = d;
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const body = readFileSync(join(ROOT, 'tests/ext4/manifest.json'));
    const sha512 = createHash('sha512').update(body).digest('hex');
    const pin = { version: 'test', file: 'image.bin', url: `${base}/tests/ext4/manifest.json`, sha512 };
    const log: string[] = [];
    assert.equal(await download(pin, (s) => log.push(s)), join(d, 'image.bin'));
    assert.deepEqual(readFileSync(join(d, 'image.bin')), body);
    assert.equal(existsSync(join(d, 'image.bin.part')), false);
    assert.equal(await download({ ...pin, url: `${base}/nothing` }, (s) => log.push(s)), join(d, 'image.bin')); // cached: checked, not fetched
    assert.match(log.at(-1)!, /^Checking .*image\.bin \(SHA512\)/);
    await assert.rejects(download({ ...pin, sha512: '0' }), /image\.bin doesn't match the pinned SHA512 .* delete it/);
    await assert.rejects(download({ ...pin, file: 'other.bin', sha512: '0' }), /doesn't match the pinned SHA512 \(images\/debian\.json\); it was deleted/);
    assert.deepEqual(readdirSync(d), ['image.bin']);
    await assert.rejects(download({ ...pin, file: 'missing.bin', url: `${base}/nothing` }), /Couldn't download Debian from .*\/nothing: HTTP 404\.\nCheck the network, or put missing\.bin in /);
  } finally {
    if (saved === undefined) delete process.env.WEBPC_DL; else process.env.WEBPC_DL = saved;
    server.close();
    rmSync(d, { recursive: true });
  }
});

const node = (args: string[], env: NodeJS.ProcessEnv) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 30_000 });

test('the prerequisites: Node 26 and rustup, each said with how to get it', () => {
  const old = node(['--import', 'data:text/javascript,Object.defineProperty(process.versions, "node", { value: "22.12.0" })', 'tools/start.js'], process.env);
  assert.equal(old.status, 1);
  assert.match(old.stderr, /webpc needs Node 26 or newer .* this is Node 22\.12\.0\.\nInstall it from https:\/\/nodejs\.org\//);
  const home = tmp('home'); // a PATH with Node alone
  try {
    mkdirSync(join(home, 'bin'));
    symlinkSync(process.execPath, join(home, 'bin/node'));
    const r = node(['tools/start.js', '--prepare-only'], { PATH: join(home, 'bin'), HOME: home });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /rustup isn't installed[^]*https:\/\/rustup\.rs[^]*sh\.rustup\.rs \| sh\nthen run `npm start` again/);
  } finally {
    rmSync(home, { recursive: true });
  }
});

// The run as a user makes it, up to the machine's first output on the serial console (~5 s alone with npm's cache warm), gated like Debian's other page tests.
const debian = (process.env.WEBPC_DISTROS ?? '').split(',').includes('debian');
const cached = existsSync(join(downloads(), PIN.file));
const cold = process.env.WEBPC_START_COLD === '1';
test('npm start on a fresh copy of the repository: install, build, prepare Debian, serve; the page boots it', {
  skip: !debian ? 'SKIPPED: scripts/ci-debian.sh runs it (WEBPC_DISTROS=debian)' : !cached ? 'SKIPPED: no Debian download (run images/build.sh debian)'
    : !cold && firmwareStale() && 'SKIPPED: no UEFI firmware (run images/build.sh edk2), or WEBPC_START_COLD=1 to build it in the copy',
  timeout: cold ? 30 * 60_000 : 15 * 60_000, // with the wait for the other Debian page tests' boots (tests/debian-lock.ts)
}, async () => {
  const d = tmp('clone');
  const files = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\0')
    .filter((f) => f && !f.startsWith('.claude/') && existsSync(join(ROOT, f)) && statSync(join(ROOT, f)).isFile()); // .claude/: the agent's worktrees
  for (const f of files) {
    mkdirSync(dirname(join(d, f)), { recursive: true });
    copyFileSync(join(ROOT, f), join(d, f));
  }
  assert.ok(!existsSync(join(d, 'node_modules')) && !existsSync(join(d, 'target')));
  if (!cold) {
    const wasm = join(d, WASM.slice(ROOT.length));
    mkdirSync(dirname(wasm), { recursive: true });
    copyFileSync(WASM, wasm);
    writeFileSync(wasm + '.inputs', wasmInputs(d) + '\n');
  }
  if (!cold) { // the firmware comes from this checkout too (its inputs are the same files); cold builds it with Podman
    mkdirSync(join(d, 'target/images/edk2'), { recursive: true });
    for (const f of ['QEMU_EFI.fd', 'LICENSES.txt', '.inputs']) copyFileSync(join(ROOT, 'target/images/edk2', f), join(d, 'target/images/edk2', f));
  }
  const env = { ...process.env, PORT: '0', WEBPC_DL: downloads(), WEBPC_TAILSCALE: '0' }; // (no Go build in the copy: tests/tailscale-build.test.ts has it)
  const start = performance.now();
  let served = 0;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'tools/start.js'], { cwd: d, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const t = setInterval(() => {
        const m = out.match(/open (http:\/\/127\.0\.0\.1:\d+\/web\/app\/) in Chromium/);
        if (m) { clearInterval(t); served = performance.now() - start; resolve(m[1]); }
      }, 100);
      void exited.then((code) => { clearInterval(t); reject(new Error(`npm start exited (${code}) before serving:\n${out}`)); });
    });
    assert.match(out, /Installing the npm packages \(node_modules is missing\): npm ci/);
    assert.match(out, cold ? /Building the emulator core/ : /^(?![^]*emulator core)/);
    assert.match(out, /Debian 13 ready, in \d/); // the disk alone: the page boots it unmodified, so no kernel or initrd is taken out
    assert.match(out, cold ? /Building the UEFI firmware/ : /^(?![^]*Building the UEFI firmware)/);
    assert.ok(existsSync(join(d, 'target/images/debian/disk.qcow2')) && !existsSync(join(d, 'target/images/debian/Image')));
    assert.ok(existsSync(join(d, FIRMWARE)) && existsSync(join(d, 'target/images/edk2/LICENSES.txt')));
    // The copy's firmware is this checkout's (current: images/SHA256SUMS) unless built cold, and
    // tests/page-debian.test.ts boots Debian to a login three times; so here the page only has to
    // start the copy's machine: its module graph, core and images load and the firmware (or whatever is further by then) writes to the serial console.
    // Only the page takes the Debian lock: the install and the build before it boot nothing.
    await withDebianLock(async () => {
      const t0 = performance.now();
      const page = await browser.newPage();
      await page.goto(url);
      await page.waitForFunction(() => (document.querySelector('.xterm-rows')?.textContent ?? '').trim() !== '' || ['failed', 'crashed', 'off'].includes(document.body.dataset.state!), null, { timeout: 120_000, polling: 250 })
        .catch(async (e) => { throw new Error(`${e}; the page is ${await page.evaluate(() => `${document.body.dataset.state}: ${document.getElementById('message-text')?.textContent}; ${document.querySelector('.xterm-rows')?.textContent}`)}`); });
      const state = await page.evaluate(() => document.body.dataset.state);
      assert.ok(state === 'booting' || state === 'running', `${state}: ${await page.evaluate(() => document.getElementById('message-text')?.textContent ?? '')}`);
      // The boot card hides at the firmware's first graphics mode (the screen has its screens): nothing to assert about it.
      console.log(`# npm start${cold ? ' (cold)' : ''}: the URL after ${(served / 1000).toFixed(1)} s, the firmware's output ${((performance.now() - t0) / 1000).toFixed(1)} s after the page opened`);
      await page.close();
    });
  } finally {
    await browser.close();
    child.kill();
    await exited;
  }
  // Again, with everything current: nothing to do.
  const t0 = performance.now();
  const again = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'tools/start.js', '--prepare-only'], { cwd: d, env, encoding: 'utf8', timeout: 60_000 });
  const ms = performance.now() - t0;
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /^Ready in \d+\.\d s \(not serving: --prepare-only\)\.\n$/);
  console.log(`# npm start again, with nothing to do: ${ms.toFixed(0)} ms`);
  assert.ok(ms < 5000, `${ms} ms`);
  rmSync(d, { recursive: true });
});
