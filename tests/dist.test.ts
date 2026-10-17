// tools/dist.ts: the page as a static copy. Its modules name no .ts file, and in Chromium, served as plain files
// (tools/serve.ts over the copy: headers and ranges, nothing stripped), the page opens idle and boots Buildroot (its
// images linked into the copy for the test: the copy itself has none).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { BINARIES, compileModule, writeDist } from '../tools/dist.ts';
import { ROOT, startServer } from '../tools/serve.ts';
import { runtimeFiles } from '../tools/svelte.ts';
import { PAGE_QUERY } from './page-query.ts';

const skipCopy = BINARIES.some((f) => !existsSync(join(ROOT, f))) && 'SKIPPED: npm start --prepare-only builds the binaries';
const buildroot = existsSync(join(ROOT, 'target/images/buildroot/rootfs.ext4')) && existsSync(join(ROOT, 'target/images/linux/Image'));
const skip = skipCopy || (!buildroot && 'SKIPPED: run images/build.sh');

let out: string;
let browser: Browser;
let base: string;
let close: () => void;
before(async () => {
  if (skipCopy) return;
  out = mkdtempSync(join(tmpdir(), 'webpc-dist-'));
  writeDist(out);
  if (buildroot) for (const d of ['linux', 'buildroot']) symlinkSync(join(ROOT, 'target/images', d), join(out, 'target/images', d));
  const server = await startServer(0, '127.0.0.1', out);
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => { await browser?.close(); close?.(); if (out) rmSync(out, { recursive: true, force: true }); });

test('compileModule renames .ts specifiers and URLs, and lists them', () => {
  const { js, deps } = compileModule("import { a } from './a.ts';\nimport type { B } from '../b.ts';\nconst w = new Worker(new URL(`./w.ts${location.search}`, import.meta.url));\nconst x: number = 1; // web/c.ts\n");
  assert.deepEqual(deps, ['./a.ts', './w.ts']);
  assert.match(js, /from '\.\/a\.js'/);
  assert.match(js, /`\.\/w\.js\$\{location\.search\}`/);
  assert.match(js, /web\/c\.ts/); // a comment stays
});

test('compileModule compiles a Svelte component and renames its specifiers', () => {
  const { js, deps } = compileModule("<script lang=\"ts\">import { f } from './f.ts'; import Other from './Other.svelte'; let n: number = $state(0);</script><Other />{f(n)}", 'web/app/X.svelte');
  assert.deepEqual(deps, ['./f.ts', './Other.svelte']);
  assert.match(js, /from '\.\/f\.js'/);
  assert.match(js, /from '\.\/Other\.svelte\.js'/);
  assert.match(js, /from 'svelte\/internal\/client'/);
});

test('compileModule compiles a module with runes (.svelte.ts): types stripped, its state Svelte\'s', () => {
  const { js, deps } = compileModule("import type { T } from './t.ts';\nimport { g } from './g.ts';\nexport const s = $state({ n: 1 as number, t: undefined as T | undefined });\nexport const h = () => g(s.n);", 'web/app/x.svelte.ts');
  assert.deepEqual(deps, ['./g.ts']);
  assert.match(js, /from '\.\/g\.js'/);
  assert.match(js, /from 'svelte\/internal\/client'/);
  assert.doesNotMatch(js, /\$state|as number/);
});

test('the static copy names no .ts module, and its Svelte runtime is complete', { skip: skipCopy }, () => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  const files = walk(join(out, 'web'));
  assert.ok(!files.some((f) => f.endsWith('.ts')), 'a .ts file in the copy');
  for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), /['"`]\.{1,2}\/[\w./-]*\.(?:ts|svelte)(?:['"`]|\$\{)/, `${f} names a .ts module or an uncompiled component`);
  for (const f of runtimeFiles()) assert.ok(existsSync(join(out, f.replace(/^node_modules\//, 'vendor/'))), `${f} is in vendor/`);
});

test("the static copy's page opens the Machines modal (Svelte's runtime from vendor/)", { skip: skipCopy }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/web/app/`);
  await page.waitForFunction(() => document.body.dataset.state === 'idle', null, { timeout: 10_000 });
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
  await page.goto(`${base}/`);
  await page.waitForFunction(() => document.body.dataset.state === 'idle' && /Open a disk image/.test((document.getElementById('message-text')?.textContent ?? '')), null, { timeout: 10_000 });
  await page.goto(`${base}/web/app/?${PAGE_QUERY}machine=buildroot&ncpus=1`);
  await page.waitForFunction(() => document.body.dataset.state === 'running', null, { timeout: 60_000, polling: 250 });
  assert.deepEqual(errors, []);
  await context.close();
});
