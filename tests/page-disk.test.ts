// Your own disk on the page (M8 phase B loop 4): a local qcow2 chosen with the picker boots through
// UEFI, its changes live in an overlay of their own (keyed by the file's name, size and modification
// time), and choosing the same file again in a fresh page finds them. Two Debian boots, ~2 min
// alone; opt-in with WEBPC_DISTROS=debian, like the other page tests on Debian.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { unattendedQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';

const debian = (process.env.WEBPC_DISTROS ?? '').split(',').includes('debian');
const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const skip = !debian ? 'SKIPPED: set WEBPC_DISTROS=debian' : (!existsSync(IMAGE) || !existsSync(FIRMWARE)) && 'SKIPPED: run npm start (or images/build.sh debian edk2)';
const BOOT_MS = 240_000;

let browser: Browser;
let base: string;
let close: () => void;
let dir: string;
before(async () => {
  if (skip) return;
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  dir = mkdtempSync(join(tmpdir(), 'webpc-disk-'));
});
after(async () => { await browser?.close(); close?.(); if (dir) rmSync(dir, { recursive: true }); });

const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
const shows = (page: Page, re: RegExp, ms = 60_000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: ms, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the terminal shows: ${await terminal(page)}`); });
async function onSerial(page: Page, text: string) {
  await page.locator('.xterm').click();
  await page.keyboard.type(text, { delay: 10 });
}
/** Waits for the machine's `running` after the page left `from`. */
async function running(page: Page, from: string) {
  await page.waitForFunction((from) => document.body.dataset.state !== from && ['running', 'failed', 'crashed', 'idle', 'off'].includes(document.body.dataset.state!), from, { timeout: BOOT_MS, polling: 250 });
  const [state, message] = await page.evaluate(() => [document.body.dataset.state, document.getElementById('message-text')!.textContent]);
  assert.equal(state, 'running', `${message}; the terminal shows: ${await terminal(page)}`);
}
/** The names of the OPFS directories. */
const overlays = (page: Page) => page.evaluate(async () => {
  const names: string[] = [];
  for await (const [name] of (await navigator.storage.getDirectory() as unknown as { entries(): AsyncIterable<[string]> }).entries()) names.push(name);
  return names;
});

test('a disk chosen on the page boots through UEFI, keeps its changes in its own overlay, and has them again when chosen again', { skip, timeout: 15 * 60_000 }, () => withDebianLock(async () => {
  // The same bytes under a name of the user's own (the page keys the disk by name, size and modification time).
  const file = join(dir, 'mydisk.qcow2');
  symlinkSync(new URL(IMAGE).pathname, file);
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => void d.accept()); // "Boot mydisk.qcow2? The machine restarts…"
  const choose = async () => {
    const from = await page.evaluate(() => document.body.dataset.state!);
    await page.setInputFiles('#open-disk-input', file);
    await page.waitForFunction((t) => document.getElementById('machine')!.textContent!.includes('mydisk.qcow2'), null, { timeout: 10_000 });
    await running(page, from);
  };

  await page.goto(`${base}/web/app/?ncpus=2&view=both&${unattendedQuery()}`);
  await choose();
  assert.equal(await page.locator('#machine').textContent(), 'Debian 13 · mydisk.qcow2');
  await onSerial(page, 'root\n');
  await shows(page, /root@\S+:~# /);
  await onSerial(page, 'echo webpc-own-$((6*7)) >/root/own-mark && sync && echo sy""nced\n');
  await shows(page, /synced/);
  // Its overlay is its own: the default Debian's (`webpc-debian`) wasn't touched by a disk written meanwhile.
  const names = await overlays(page);
  assert.ok(names.some((n) => /^webpc-disk-[0-9a-f]{16}$/.test(n)), `OPFS has ${names}`);
  await page.waitForFunction(async () => {
    for await (const [name, h] of (await navigator.storage.getDirectory() as unknown as { entries(): AsyncIterable<[string, FileSystemDirectoryHandle]> }).entries()) {
      if (!name.startsWith('webpc-disk-')) continue;
      try {
        const f = await (await h.getFileHandle('flash')).getFile(); // the variable store is kept beside it
        return f.size === 1 << 20 && new Uint8Array(await f.arrayBuffer()).some((b) => b !== 0xff);
      } catch { /* not yet */ }
    }
    return false;
  }, null, { timeout: 30_000, polling: 500 });

  // A reload goes back to the machine's own disk (a File isn't remembered); choosing the file again finds its changes.
  await page.reload();
  await choose();
  await onSerial(page, 'root\n');
  await shows(page, /root@\S+:~# /);
  await onSerial(page, 'cat /root/own-mark\n');
  await shows(page, /cat \/root\/own-mark\s*webpc-own-42/);
  assert.deepEqual(errors, []);
  await context.close();
}));
