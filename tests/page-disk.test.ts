// Your own disk on the page (M8 phase B loop 4): a local qcow2 chosen with the picker boots through
// UEFI, its changes live in an overlay of their own (keyed by the file's name, size and modification
// time), is saved from the page (the changes over the base as a qcow2 that `qemu-img` accepts, by a
// download and by a file picker's handle), and choosing the same file again in a fresh page finds
// its changes. Two Debian boots, ~2 min alone; opt-in with WEBPC_DISTROS=debian, like the other page tests on Debian.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
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

test('a disk chosen on the page boots through UEFI, keeps its changes in its own overlay, and has them again when chosen again', { skip, timeout: 25 * 60_000 }, () => withDebianLock(async () => {
  // The same bytes under a name of the user's own (the page keys the disk by name, size and modification time).
  const file = join(dir, 'mydisk.qcow2');
  symlinkSync(new URL(IMAGE).pathname, file);
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(() => { (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = undefined; }); // headless Chromium's picker would wait for a dialog nobody answers
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

  // Shut down, then save the changes: by a download (no file picker), then through a picker's handle (a file in OPFS).
  await onSerial(page, 'poweroff\n');
  await page.waitForFunction(() => document.body.dataset.state === 'off', null, { timeout: 60_000, polling: 250 });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    (async () => { await page.locator('#save summary').click(); await page.locator('[data-save=changes]').click(); })(),
  ]);
  assert.equal(download.suggestedFilename(), 'mydisk-changes.qcow2');
  const downloaded = join(dir, 'mydisk-changes.qcow2');
  await download.saveAs(downloaded);
  await page.waitForFunction(() => /^Saved /.test(document.getElementById('message-text')!.textContent!), null, { timeout: 30_000 });
  await page.evaluate(() => {
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async () => (await navigator.storage.getDirectory()).getFileHandle('picked.qcow2', { create: true });
  });
  await page.locator('#save summary').click();
  await page.locator('[data-save=changes]').click();
  await page.waitForFunction(() => /^Saved picked\.qcow2/.test(document.getElementById('message-text')!.textContent!), null, { timeout: 120_000 });
  const picked = Buffer.from(await page.evaluate(async () => {
    const f = await (await (await navigator.storage.getDirectory()).getFileHandle('picked.qcow2')).getFile();
    const bytes = new Uint8Array(await f.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 1 << 15) s += String.fromCharCode(...bytes.subarray(i, i + (1 << 15)));
    return btoa(s);
  }), 'base64');
  const changes = readFileSync(downloaded);
  assert.ok(changes.equals(picked), 'the download and the picked file are the same bytes');
  // qemu-img's verdict: a consistent qcow2 over the image under the name it was chosen by, whose hash the header carries.
  const qemu = (...args: string[]) => execFileSync('qemu-img', args, { encoding: 'utf8' });
  qemu('check', downloaded);
  assert.match(qemu('info', downloaded), /backing file: mydisk\.qcow2/);
  const sha = createHash('sha256').update(readFileSync(IMAGE)).digest('hex');
  assert.ok(changes.subarray(0, 4096).toString('latin1').includes(sha), "the header names the base image's SHA-256");
  const map = JSON.parse(qemu('map', '--output=json', `json:${JSON.stringify({ driver: 'qcow2', file: { driver: 'file', filename: downloaded }, backing: null })}`)) as { data: boolean }[];
  assert.ok(map.some((e) => e.data), 'the changes file holds the blocks the machine wrote');

  // A reload goes back to the machine's own disk (a File isn't remembered); choosing the file again finds its changes.
  await page.reload();
  await choose();
  await onSerial(page, 'root\n');
  await shows(page, /root@\S+:~# /);
  await onSerial(page, 'cat /root/own-mark\n');
  await shows(page, /cat \/root\/own-mark\s*webpc-own-42/);
  assert.deepEqual(errors, []);
  await context.close();

  // Changes in (loop 6): a fresh profile's Debian (the same bytes the changes were made over, under another name) plus the
  // changes file boots with the file. The overlay of the machine's own disk takes it, the page restarts the machine.
  const fresh = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page2 = await fresh.newPage();
  const dialogs: string[] = [];
  const errors2: string[] = [];
  page2.on('dialog', (d) => { dialogs.push(d.message()); void d.accept(); });
  page2.on('pageerror', (e) => errors2.push(String(e)));
  await page2.goto(`${base}/web/app/?ncpus=2&view=both&${unattendedQuery()}`);
  await page2.waitForFunction(() => ['booting', 'running'].includes(document.body.dataset.state!), null, { timeout: BOOT_MS, polling: 250 });
  await page2.setInputFiles('#load-changes-input', downloaded);
  await page2.waitForFunction(() => document.body.dataset.state === 'off', null, { timeout: 60_000, polling: 100 }); // stopped for the load
  await running(page2, 'off');
  assert.match(dialogs[0], /^Load the changes in mydisk-changes\.qcow2\?/);
  await onSerial(page2, 'root\n');
  await shows(page2, /root@\S+:~# /);
  await onSerial(page2, 'cat /root/own-mark\n');
  await shows(page2, /cat \/root\/own-mark\s*webpc-own-42/);
  assert.deepEqual(errors2, []);
  await fresh.close();
}));
