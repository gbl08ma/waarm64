// tools/dist.ts: the page as a static copy, Vite's build. It is a few bundled files, and in Chromium, served as plain
// files (Vite's preview server over the copy, tools/serve.ts: headers and ranges), the page opens idle and boots
// Buildroot (its images linked into the copy for the test: the copy itself has none).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { BINARIES, hostAgentProblem, VULKAN, writeDist } from '../tools/dist.ts';
import { ROOT, startServer } from '../tools/serve.ts';
import { PAGE_QUERY } from './page-query.ts';
import { t } from '../web/i18n.ts';

const skipCopy = BINARIES.some((f) => !existsSync(join(ROOT, f))) && 'SKIPPED: npm start --prepare-only builds the binaries';
const buildroot = existsSync(join(ROOT, 'target/images/buildroot/rootfs.ext4')) && existsSync(join(ROOT, 'target/images/linux/Image'));
const skip = skipCopy || (!buildroot && 'SKIPPED: run images/build.sh');
/** Vulkan's renderer is built (vk/build.sh): the copy has it and its licences. */
const vulkan = VULKAN.every((f) => existsSync(join(ROOT, f)));

let out: string;
let browser: Browser;
let base: string;
let close: () => void;
before(async () => {
  if (skipCopy) return;
  out = mkdtempSync(join(tmpdir(), 'webpc-dist-'));
  await writeDist(out, { vulkan: false, hostAgent: true });
  // The page's direct-boot machines find their images at target/images/ under the root (web/app/machine.ts).
  mkdirSync(join(out, 'target/images'), { recursive: true });
  if (buildroot) for (const d of ['linux', 'buildroot']) symlinkSync(join(ROOT, 'target/images', d), join(out, 'target/images', d));
  const server = await startServer(0, '127.0.0.1', out);
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => { await browser?.close(); close?.(); if (out) rmSync(out, { recursive: true, force: true }); });

test('the static copy is the page bundled: a few hashed files, its binaries among them, no source', { skip: skipCopy }, () => {
  const files = readdirSync(out, { recursive: true, encoding: 'utf8' }).filter((f) => statSync(join(out, f)).isFile()).map((f) => f.split(sep).join('/'));
  assert.ok(!files.some((f) => /\.(?:ts|svelte)$/.test(f)), `source in the copy: ${files.filter((f) => /\.(?:ts|svelte)$/.test(f)).join(', ')}`);
  for (const f of ['index.html', 'web/app/index.html', '_headers', '.htaccess', '.nojekyll', 'LICENSE', 'THIRD-PARTY-LICENSES.md', 'EDK2-LICENSES.txt']) assert.ok(files.includes(f), `${f} is missing`);
  for (const name of ['index', 'worker', 'vcpu-worker', 'device-worker', 'jit-compile-worker', 'gpu-worker', 'audio-worklet', 'webpc_core', 'ts', 'QEMU_EFI']) {
    assert.ok(files.some((f) => new RegExp(`^assets/${name}-[\\w-]{8}\\.(?:js|wasm|fd)$`).test(f)), `no assets/${name}-<hash>`);
  }
  // Clipboard sharing's guest agent, which the worker fetches by its hashed name (web/app/guest-agent.ts).
  const agent = files.find((f) => /^assets\/webpc-agent-[\w-]{8}$/.test(f));
  assert.ok(agent, 'no assets/webpc-agent-<hash>');
  assert.equal(Buffer.compare(readFileSync(join(out, agent)).subarray(0, 4), Buffer.from('\x7fELF', 'latin1')), 0, 'the agent is an ELF file');
  assert.ok(files.some((f) => /^assets\/worker-[\w-]{8}\.js$/.test(f) && readFileSync(join(out, f), 'utf8').includes(agent.slice('assets/'.length))), "the worker doesn't name the agent's asset");
  const scripts = files.filter((f) => f.endsWith('.js'));
  assert.ok(scripts.length < 40, `${scripts.length} scripts: the page isn't bundled`);
  assert.match(readFileSync(join(out, 'THIRD-PARTY-LICENSES.md'), 'utf8'), /@xterm\/xterm[\s\S]*svelte/);
  // Vulkan's renderer where vk/build.sh built it (`npm run dist` requires it, `--no-vulkan` and `npm start` don't), its
  // licences beside it; the GPU worker fetches it by its hashed name.
  assert.equal(files.some((f) => /^assets\/venus-[\w-]{8}\.wasm$/.test(f)), vulkan, 'assets/venus-<hash>.wasm');
  assert.equal(files.includes('VENUS-LICENSES.txt'), vulkan, 'VENUS-LICENSES.txt');
  if (vulkan) {
    assert.match(readFileSync(join(out, 'VENUS-LICENSES.txt'), 'utf8'), /virglrenderer: COPYING[\s\S]*Mesa: docs\/license\.rst[\s\S]*SoftFloat[\s\S]*Apache License[\s\S]*LLVM Exceptions/);
    const worker = files.find((f) => /^assets\/gpu-worker-[\w-]{8}\.js$/.test(f))!;
    assert.match(readFileSync(join(out, worker), 'utf8'), /venus-[\w-]{8}\.wasm/);
  }
});

test("npm run dist refuses a guest agent the host's cargo built (its HOST-BUILD marker); npm start and the tests take it", () => {
  const root = mkdtempSync(join(tmpdir(), 'webpc-dist-agent-'));
  try {
    assert.equal(hostAgentProblem(`${root}/`), undefined, 'no marker: the build in Podman');
    mkdirSync(join(root, 'target/images/agent'), { recursive: true });
    writeFileSync(join(root, 'target/images/agent/HOST-BUILD'), 'host\n');
    assert.match(hostAgentProblem(`${root}/`) ?? '', /HOST-BUILD.*for tests only.*images\/build\.sh agent/s);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the static copy's page logs its commit and opens the Machines modal", { skip: skipCopy }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const logs: string[] = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.goto(`${base}/`);
  await page.waitForFunction(() => document.body.dataset.state === 'idle', null, { timeout: 10_000 });
  // The commit the copy was built from, on the console (tools/stamp.ts `buildStamp`).
  const head = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.ok(logs.some((l) => l.startsWith(`webpc: built from ${head} (`)), `no "webpc: built from ${head}" on the console`);
  await page.click('#machines-open');
  await page.locator('.machines [data-action=new-machine]').click();
  await page.locator('.machines section.machine[data-selected]').waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});

test('the static copy opens idle and boots Buildroot in Chromium', { skip }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // The page is the root; web/app/, where it was, redirects there with the query and fragment (`?disk=<url>`).
  await page.goto(`${base}/web/app/?probe=1#here`);
  await page.waitForURL(`${base}/?probe=1#here`);
  await page.goto(`${base}/`);
  await page.waitForFunction((said) => document.body.dataset.state === 'idle' && (document.getElementById('message-text')?.textContent ?? '').includes(said), t('machine:main.openDisk.prompt'), { timeout: 10_000 });
  await page.goto(`${base}/?${PAGE_QUERY}machine=buildroot&ncpus=1`);
  await page.waitForFunction(() => document.body.dataset.state === 'running', null, { timeout: 60_000, polling: 250 });
  assert.deepEqual(errors, []);
  await context.close();
});
