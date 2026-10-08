// Snapshots on the page (M8 snapshots loop 7): Save snapshot pauses the running machine, writes
// the file (a download, or through a file picker's handle) and the machine runs on; Load snapshot…
// (or a snapshot chosen or dropped like a disk) in a fresh profile, which has no OPFS, starts the
// machine where it was saved: a shell variable and a file in devtmpfs (RAM; Buildroot's kernel has no tmpfs), the terminal's saved
// tail, and the refusals (not a snapshot, truncated, another machine, devices this page can't
// make) with the machine and its disk untouched. Buildroot always (seconds); Debian, opt-in with
// WEBPC_DISTROS=debian (a boot and a restore, ~3 min alone; takes the Debian lock): a file written
// to the disk, a variable in RAM, then in a fresh profile the snapshot's machine is running, still
// logged in, with the file on the disk (read past the page cache) and the firmware's variable
// store written back beside the new overlay.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { openSnapshot, SnapshotWriter } from '../web/snapshot-file.ts';
import { unattendedQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';

const IMAGES = new URL('../target/images/', import.meta.url);
const buildroot = existsSync(new URL('buildroot/rootfs.ext4', IMAGES)) && existsSync(new URL('linux/Image', IMAGES));
const skip = !buildroot && 'SKIPPED: run images/build.sh';
const debianOn = (process.env.WEBPC_DISTROS ?? '').split(',').includes('debian');
const debianImages = existsSync(new URL('debian/disk.qcow2', IMAGES)) && existsSync(new URL('edk2/QEMU_EFI.fd', IMAGES));
const skipDebian = !debianOn ? 'SKIPPED: scripts/ci-debian.sh runs it (WEBPC_DISTROS=debian)' : !debianImages && 'SKIPPED: run npm start (or images/build.sh debian edk2)';
const BOOT_MS = 240_000;

let browser: Browser;
let base: string;
let close: () => void;
let dir: string;
before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  dir = mkdtempSync(join(tmpdir(), 'webpc-snap-'));
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
const stateOf = (page: Page) => page.evaluate(() => document.body.dataset.state!);
/** Waits for `running` (the page may pass through other states first), failing with the page's message otherwise. */
async function running(page: Page, ms = BOOT_MS) {
  await page.waitForFunction(() => ['running', 'failed', 'crashed', 'idle', 'off'].includes(document.body.dataset.state!), null, { timeout: ms, polling: 100 });
  const [state, message] = await page.evaluate(() => [document.body.dataset.state, document.getElementById('message-text')!.textContent]);
  assert.equal(state, 'running', `${message}; the terminal shows: ${await terminal(page)}`);
}
/** Waits until the page has started loading a snapshot (the boot card's title), so a following `running` is the restored machine's. */
const loadingSnapshot = (page: Page) => page.waitForFunction(() => document.getElementById('boot-title')!.textContent!.startsWith('Loading '), null, { timeout: 30_000, polling: 20 });
const message = (page: Page) => page.locator('#message-text').textContent();
const status = (page: Page) => page.evaluate(() => document.getElementById('status')!.textContent!);

/** The canvas's pixels (the guest's scanout) and whether any is not black: the screen was drawn. */
const screenOf = (page: Page) => page.evaluate(() => {
  const src = document.querySelector<HTMLCanvasElement>('#screen')!;
  const c = document.createElement('canvas');
  [c.width, c.height] = [src.width, src.height];
  const ctx = c.getContext('2d')!;
  ctx.drawImage(src, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] | d[i + 1] | d[i + 2]) lit++;
  return { size: [src.width, src.height], lit };
});

/** Clicks Save snapshot (a download: no file picker) and returns the file's path, once the page says it's saved. */
async function save(page: Page, name: string) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    page.locator('#save-snapshot').click(),
  ]);
  const path = join(dir, name);
  await download.saveAs(path);
  await page.waitForFunction(() => /^Saved the snapshot /.test(document.getElementById('message-text')!.textContent!), null, { timeout: 60_000 });
  const info = JSON.parse(await page.evaluate(() => document.getElementById('message')!.dataset.snapshot!)) as { bytes: number; pausedMs: number };
  assert.equal(info.bytes, readFileSync(path).length, 'the page counted the bytes the file has');
  return { path, filename: download.suggestedFilename(), ...info };
}

/** The page's OPFS: each directory's files and their sizes. */
const opfs = (page: Page) => page.evaluate(async () => {
  const out: Record<string, Record<string, number>> = {};
  const root = (await navigator.storage.getDirectory()) as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> };
  for await (const [name, h] of root.entries()) {
    if (h.kind !== 'directory') continue;
    out[name] = {};
    for await (const [file, f] of (h as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) out[name][file] = (await (f as FileSystemFileHandle).getFile()).size;
  }
  return out;
});

/** Drops `path` on the page, as a user drags a file onto it (the file goes through a throwaway input to get into the page). */
async function drop(page: Page, path: string) {
  await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<input type="file" id="drop-source" hidden>'); });
  await page.setInputFiles('#drop-source', path);
  await page.evaluate(() => {
    const file = (document.getElementById('drop-source') as HTMLInputElement).files![0];
    const data = new DataTransfer();
    data.items.add(file);
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
}

/** A snapshot with nothing in it but a header: what the page and the worker check before they touch anything. */
async function headerOnly(name: string, header: Record<string, unknown>) {
  const parts: Uint8Array[] = [];
  const w = new SnapshotWriter((b) => { parts.push(b.slice()); }, { format: 1, coreVersion: 1, abi: 0, created: new Date().toISOString(), ...header });
  await w.end();
  const path = join(dir, name);
  writeFileSync(path, Buffer.concat(parts));
  return path;
}

test('the page saves a snapshot of a running machine and a fresh profile loads it: RAM state, the terminal, refusals', { skip, timeout: 8 * 60_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  await page.addInitScript(() => { (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = undefined; }); // the download path
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => void d.accept());
  await page.goto(`${base}/web/app/?machine=buildroot&ncpus=2&view=terminal`);
  await running(page);
  assert.equal(await page.locator('#save-snapshot').isEnabled(), true);

  // State that lives in RAM only: a shell variable, and a file in devtmpfs (RAM-backed; the test kernel has no tmpfs).
  // A cursor position query in the terminal's output: the terminal answers it as it arrives (busybox's line editor swallows the
  // reply), and must not answer it again when a restored page shows the saved tail (bash would print it as `;1R`).
  await onSerial(page, "printf '\\033[6n'\n");
  await page.waitForTimeout(1000);
  await onSerial(page, 'SNAPVAR=kept-$((6*7)); echo tmpfs-kept-$((6*7)) >/dev/snapfile; echo sa""ved-state\n');
  await shows(page, /saved-state/);

  // Save snapshot: the machine pauses and runs on.
  const first = await save(page, 'first.webpcsnap');
  console.log(`# snapshot (buildroot, 2 vCPUs): ${(first.bytes / 1e6).toFixed(1)} MB, machine paused ${first.pausedMs.toFixed(0)} ms`);
  assert.match(first.filename, /^buildroot-\d{4}-\d\d-\d\d-\d{4}\.webpcsnap$/);
  assert.equal(await stateOf(page), 'running');
  assert.equal(await page.locator('#save-snapshot').isEnabled(), true);
  assert.equal(await page.locator('#restart').isEnabled(), true);
  const bytes = readFileSync(first.path);
  assert.equal(bytes.subarray(0, 8).toString('latin1'), 'WEBPCSNP');
  assert.ok(bytes.length > 100_000 && bytes.length < 120e6, `a plausible size: ${bytes.length}`);
  const header = (await openSnapshot(new Blob([bytes]))).header;
  assert.deepEqual([header.machine, header.label, header.ncpus, header.disk, header.devices], ['buildroot', 'Buildroot (test guest)', 2, null, ['rng', 'blk', 'keyboard', 'tablet']]);
  assert.match(String(header.serial), /saved-state/);
  assert.equal((header.disks as { sha256?: string }[])[0].sha256, undefined, 'no hash of the base image is written');
  // It was only paused: it answers, and its steps keep counting.
  await onSerial(page, 'echo sti""ll-$((6*7)); echo var=[$SNAPVAR]\n');
  await shows(page, /still-42\s*var=\[kept-42\]/);

  // Once through a file picker's handle (a file in OPFS stands in for the user's pick).
  await page.evaluate(() => {
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async () => (await navigator.storage.getDirectory()).getFileHandle('picked.webpcsnap', { create: true });
  });
  await page.locator('#save-snapshot').click();
  await page.waitForFunction(() => /^Saved the snapshot picked\.webpcsnap/.test(document.getElementById('message-text')!.textContent!), null, { timeout: 60_000 });
  const picked = await page.evaluate(async () => {
    const f = await (await (await navigator.storage.getDirectory()).getFileHandle('picked.webpcsnap')).getFile();
    return { size: f.size, magic: new TextDecoder().decode(await f.slice(0, 8).arrayBuffer()) };
  });
  assert.equal(picked.magic, 'WEBPCSNP');
  assert.ok(Math.abs(picked.size - bytes.length) < 0.5 * bytes.length, `the picked file is as large as the downloaded one (${picked.size} against ${bytes.length})`);
  await onSerial(page, 'echo aga""in-$((6*7))\n');
  await shows(page, /again-42/);
  assert.deepEqual(errors, []);
  await context.close();

  // A fresh profile (no OPFS): the page boots Buildroot, then Load snapshot… replaces it by the saved machine.
  const fresh = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const p2 = await fresh.newPage();
  const errors2: string[] = [];
  const dialogs: string[] = [];
  p2.on('pageerror', (e) => errors2.push(String(e)));
  p2.on('dialog', (d) => { dialogs.push(`${d.type()}: ${d.message()}`); void d.accept(); });
  // What the page sends to the guest's serial port beyond plain keys: escape sequences (a terminal's replies to queries).
  await p2.addInitScript(() => {
    const send = MessagePort.prototype.postMessage;
    const escapes: string[] = [];
    (window as unknown as { escapes: string[] }).escapes = escapes;
    MessagePort.prototype.postMessage = function (this: MessagePort, m: unknown, ...rest: unknown[]) {
      if (typeof m === 'string' && m.includes('\x1b')) escapes.push(m);
      return (send as (...a: unknown[]) => void).call(this, m, ...rest);
    };
  });
  await p2.goto(`${base}/web/app/?machine=buildroot&ncpus=1&view=terminal`);
  await running(p2);
  const t0 = performance.now();
  await p2.evaluate(() => { (window as unknown as { escapes: string[] }).escapes.length = 0; });
  await p2.setInputFiles('#load-snapshot-input', first.path);
  await loadingSnapshot(p2);
  await running(p2);
  console.log(`# snapshot load (buildroot): ${((performance.now() - t0) / 1000).toFixed(2)} s from the choice to running`);
  assert.match(dialogs.at(-1)!, /^confirm: Load the snapshot first\.webpcsnap\? It holds Buildroot \(test guest\) as it was on .* \(\d.* (KB|MB), 2 vCPUs\)\..*replaced by the snapshot's changes to the disk\.$/);
  // The terminal shows the saved output's tail, and the status the snapshot's vCPUs (the page asked for 1).
  await shows(p2, /saved-state/);
  await p2.waitForFunction(() => /^2 vCPUs/.test(document.getElementById('status')!.textContent!), null, { timeout: 10_000 });
  assert.equal(await p2.locator('#boot').isHidden(), true);
  // The machine is where it was: its variable, its tmpfs file, and a shell that answers.
  await onSerial(p2, 'echo var=[$SNAPVAR]; cat /dev/snapfile; echo af""ter-$((6*7))\n');
  await shows(p2, /var=\[kept-42\]\s*tmpfs-kept-42\s*after-42/);
  // The terminal showed the saved tail, whose cursor position query it answers to nobody: nothing was sent to the guest but the keys typed.
  assert.deepEqual(await p2.evaluate(() => (window as unknown as { escapes: string[] }).escapes), [], 'no reply to the replayed output reached the guest');

  // Refusals leave the machine and the disk as they are: a file that isn't a snapshot, ...
  const junk = join(dir, 'junk.webpcsnap');
  writeFileSync(junk, Buffer.from('this is not a snapshot, only text'));
  await p2.setInputFiles('#load-snapshot-input', junk);
  await p2.waitForTimeout(500);
  assert.match(dialogs.at(-1)!, /^alert: junk\.webpcsnap: This file isn't a snapshot/);
  assert.equal(await stateOf(p2), 'running');
  // ... a snapshot of another machine, by the page (a real one on a Debian page, below, and a header-only one here) ...
  const other = await headerOnly('debian-header.webpcsnap', { machine: 'debian', label: 'Debian 13', ncpus: 2, disk: null, devices: ['rng', 'blk', 'keyboard', 'tablet'], disks: [] });
  await p2.setInputFiles('#load-snapshot-input', other);
  await p2.waitForTimeout(500);
  assert.match(dialogs.at(-1)!, /^alert: debian-header\.webpcsnap is a snapshot of Debian 13 \(\?machine=debian\), and this page runs Buildroot \(test guest\) \(\?machine=buildroot\)/);
  // ... one taken on another disk, by name ...
  const elsewhere = await headerOnly('other-disk.webpcsnap', { machine: 'buildroot', label: 'Buildroot (test guest)', ncpus: 2, disk: 'mine.qcow2', devices: ['rng', 'blk', 'keyboard', 'tablet'], disks: [] });
  await p2.setInputFiles('#load-snapshot-input', elsewhere);
  await p2.waitForTimeout(500);
  assert.match(dialogs.at(-1)!, /^alert: other-disk\.webpcsnap was taken on the disk mine\.qcow2, and the disk open now is Buildroot \(test guest\)'s own disk\. .*open that disk first \(Open disk…\)/);
  assert.equal(await stateOf(p2), 'running');
  await onSerial(p2, 'echo ali""ve-$((6*7))\n');
  await shows(p2, /alive-42/);
  const untouched = await opfs(p2);

  // ... a snapshot whose machine had a second disk this page wasn't opened with (the worker's refusal, after the confirmation) ...
  const needsDisk2 = await headerOnly('disk2.webpcsnap', { machine: 'buildroot', label: 'Buildroot (test guest)', ncpus: 2, disk: null, devices: ['rng', 'blk', 'blk-ro', 'keyboard', 'tablet'], disks: [] });
  await p2.setInputFiles('#load-snapshot-input', needsDisk2);
  await p2.waitForFunction(() => document.body.dataset.state === 'failed', null, { timeout: 30_000, polling: 50 });
  assert.match((await message(p2))!, /^disk2\.webpcsnap can't be loaded: its machine had a second disk \(\?disk2=<url>\)/);
  assert.deepEqual((await p2.locator('#message-actions button').allTextContents()), ['Start', 'Load snapshot…']);
  assert.deepEqual(await opfs(p2), untouched, 'the disk is untouched');

  // ... and a truncated snapshot: refused whole, before the disk is touched; Start boots the machine normally.
  const cut = join(dir, 'cut.webpcsnap');
  writeFileSync(cut, bytes.subarray(0, Math.floor(bytes.length * 0.6)));
  await p2.setInputFiles('#load-snapshot-input', cut);
  await p2.waitForFunction(() => document.body.dataset.state === 'failed' && /incomplete/.test(document.getElementById('message-text')!.textContent!), null, { timeout: 30_000, polling: 50 });
  assert.match((await message(p2))!, /^The snapshot couldn't be loaded: This snapshot is incomplete.*Nothing was changed.*Start boots Buildroot \(test guest\) normally/s);
  assert.deepEqual(await opfs(p2), untouched, 'the disk is untouched');
  await p2.locator('#message-actions button', { hasText: 'Start' }).click();
  await p2.waitForFunction(() => document.body.dataset.state !== 'failed', null, { timeout: 10_000, polling: 20 });
  await running(p2);
  assert.match(await status(p2), /^\d vCPUs?/);
  await onSerial(p2, 'echo var=[$SNAPVAR] boo""ted-$((6*7))\n');
  await shows(p2, /var=\[\] booted-42/); // a normal boot: the variable of the snapshot isn't there

  // A snapshot chosen or dropped like a disk is taken as one (by its magic): the same confirmation, the same machine.
  await drop(p2, first.path);
  await loadingSnapshot(p2);
  await running(p2);
  assert.match(dialogs.at(-1)!, /^confirm: Load the snapshot first\.webpcsnap\?/);
  await onSerial(p2, 'echo var=[$SNAPVAR]; cat /dev/snapfile\n');
  await shows(p2, /var=\[kept-42\]\s*tmpfs-kept-42/);
  assert.deepEqual(errors2, []);
  await fresh.close();
});

test('Suspend keeps the machine in the browser: opening the page again resumes it, once; Boot instead and Reset disk drop it', { skip, timeout: 8 * 60_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => void d.accept());
  await page.goto(`${base}/web/app/?machine=buildroot&ncpus=2&view=terminal`);
  await running(page);
  const suspendFile = async () => (await opfs(page))['webpc-buildroot']?.suspend;
  /** The shell's `SUSVAR`, asked under a fresh marker. */
  let asks = 0;
  const susvar = async () => {
    const tag = `ask${++asks}`;
    await onSerial(page, `echo ${tag}=[$SUSVAR]\n`);
    await shows(page, new RegExp(`${tag}=\\[[^\\]$]*\\]`));
    return (await terminal(page)).match(new RegExp(`${tag}=\\[([^\\]$]*)\\]`))![1];
  };
  const suspend = async () => {
    await page.locator('#suspend').click();
    await page.waitForFunction(() => document.body.dataset.state === 'suspended', null, { timeout: 60_000 });
    assert.match((await message(page))!, /^Suspended: the machine's memory is kept in this browser/);
    assert.ok((await suspendFile())! > 100_000, 'the suspended machine is beside the overlay');
    assert.equal(await page.locator('#restart').textContent(), 'Start');
  };
  assert.equal(await page.locator('#suspend').isEnabled(), true);
  await onSerial(page, 'SUSVAR=one\n');
  assert.equal(await susvar(), 'one');

  // Suspended, then the page opened again: the machine is where it was, and its suspended copy is gone.
  await suspend();
  const t0 = performance.now();
  await page.reload();
  await running(page);
  console.log(`# suspend (buildroot): resumed ${((performance.now() - t0) / 1000).toFixed(2)} s after the reload`);
  assert.match((await message(page))!, /^Resumed the suspended machine/);
  assert.equal(await suspendFile(), undefined, 'a resumed machine has no suspended copy');
  assert.equal(await susvar(), 'one');
  // Opened again without a suspend: it boots (a new shell). The planted bug (the copy kept after a resume) resumes the old one here.
  await onSerial(page, 'SUSVAR=two\n');
  assert.equal(await susvar(), 'two');
  await page.reload();
  await running(page);
  assert.doesNotMatch((await message(page)) ?? '', /Resumed/);
  assert.equal(await susvar(), '');

  // Start resumes too; Boot instead drops the suspended machine and boots; Reset disk drops it with the disk's changes.
  await onSerial(page, 'SUSVAR=three\n');
  assert.equal(await susvar(), 'three');
  await suspend();
  await page.locator('#restart').click();
  await running(page);
  assert.equal(await susvar(), 'three');
  await suspend();
  await page.locator('#message-actions button', { hasText: 'Boot instead' }).click();
  await page.waitForFunction(() => document.body.dataset.state === 'booting', null, { timeout: 30_000, polling: 20 });
  await running(page);
  assert.equal(await suspendFile(), undefined);
  assert.equal(await susvar(), '');
  await suspend();
  await page.locator('#reset-disk').click();
  await page.waitForFunction(() => document.body.dataset.state === 'booting', null, { timeout: 30_000, polling: 20 });
  await running(page);
  assert.equal(await suspendFile(), undefined);
  assert.equal(await susvar(), '');
  // A snapshot file is still what leaves the browser: a suspended machine's file is not offered anywhere.
  assert.deepEqual(errors, []);
  await context.close();
});

test('a snapshot of Buildroot on the Debian page is refused at once, before anything stops', { skip: skip || skipDebian, timeout: 25 * 60_000 }, () => withDebianLock(async () => {
  // Written by Buildroot's page: only the header matters here.
  const path = await headerOnly('buildroot-header.webpcsnap', { machine: 'buildroot', label: 'Buildroot (test guest)', ncpus: 2, disk: null, devices: ['rng', 'blk', 'keyboard', 'tablet'], disks: [] });
  const context = await browser.newContext();
  const page = await context.newPage();
  const dialogs: string[] = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); void d.accept(); });
  await page.goto(`${base}/web/app/?ncpus=2&${unattendedQuery()}`);
  await page.setInputFiles('#load-snapshot-input', path);
  await page.waitForTimeout(1000);
  assert.match(dialogs.at(-1)!, /^buildroot-header\.webpcsnap is a snapshot of Buildroot \(test guest\) \(\?machine=buildroot\), and this page runs Debian 13 \(\?machine=debian\)/);
  assert.notEqual(await stateOf(page), 'failed');
  await context.close();
}));

test('Debian on the page: a snapshot of a logged-in machine with a file on its disk, loaded in a fresh profile', { skip: skip || skipDebian, timeout: 25 * 60_000 }, () => withDebianLock(async () => {
  const query = `ncpus=2&view=both&${unattendedQuery()}`;
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(() => { (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = undefined; });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => void d.accept());
  const t0 = performance.now();
  await page.goto(`${base}/web/app/?${query}`);
  await running(page);
  console.log(`# debian snapshot: first boot running at ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  await onSerial(page, 'root\n');
  await shows(page, /root@\S+:~# /);
  await onSerial(page, 'echo lo""gged-in-$((6*7))\n');
  await shows(page, /logged-in-42/);
  await onSerial(page, 'echo disk-kept-$((6*7)) >/root/snapmark && sync && SNAPVAR=ram-kept-$((6*7)) && echo sy""nced\n');
  await shows(page, /synced/);
  const shown = await screenOf(page);
  assert.ok(shown.lit > 0, 'the screen is drawn before the save');
  const saved = await save(page, 'debian.webpcsnap');
  console.log(`# debian snapshot: ${(saved.bytes / 1e6).toFixed(1)} MB, machine paused ${saved.pausedMs.toFixed(0)} ms`);
  assert.equal(await stateOf(page), 'running');
  await onSerial(page, 'echo sti""ll-$((6*7))\n');
  await shows(page, /still-42/);
  assert.deepEqual(errors, []);
  await context.close();

  // A fresh profile: the page starts booting Debian, the snapshot replaces that machine.
  // Another window size than the one saved in: the display device is restored (the console's screen drawn again), then told the new size.
  const fresh = await browser.newContext({ viewport: { width: 1700, height: 1000 } });
  const p2 = await fresh.newPage();
  const errors2: string[] = [];
  p2.on('pageerror', (e) => errors2.push(String(e)));
  p2.on('dialog', (d) => void d.accept());
  await p2.goto(`${base}/web/app/?${query}`);
  const t1 = performance.now();
  await p2.setInputFiles('#load-snapshot-input', saved.path);
  await loadingSnapshot(p2);
  await running(p2, 120_000);
  const loadMs = performance.now() - t1;
  console.log(`# debian snapshot: load ${(loadMs / 1000).toFixed(1)} s from the choice to running`);
  assert.ok(loadMs < 60_000, `loaded in ${(loadMs / 1000).toFixed(1)} s`);
  // The display: the restored scanout is drawn at the saved size (fbcon's buffer is that size, and the console is never cropped),
  // and the guest has the new window's size as its preferred mode (the `size` message sent at `running`).
  // (The device worker draws on its own timer: poll for the first frame.)
  await p2.waitForFunction(() => {
    const src = document.querySelector<HTMLCanvasElement>('#screen')!;
    const c = document.createElement('canvas');
    [c.width, c.height] = [src.width, src.height];
    const ctx = c.getContext('2d')!;
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 4) if (d[i] | d[i + 1] | d[i + 2]) return true;
    return false;
  }, null, { timeout: 10_000, polling: 100 }).catch(() => assert.fail('the restored screen is drawn'));
  const restored = await screenOf(p2);
  assert.deepEqual(restored.size, shown.size, 'the console keeps its buffer');
  const want = await p2.evaluate(() => { const b = document.getElementById('screen-view')!; const r = b.getBoundingClientRect(); return [Math.floor(r.width / 8) * 8, Math.floor(r.height)]; });
  assert.notDeepEqual(want, shown.size, 'the window is another size');
  // The firmware's variable store is back beside the new overlay (the restore deleted the copy): written before `running` is posted.
  const flash = await p2.evaluate(async () => {
    try {
      const f = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('webpc-debian')).getFileHandle('flash')).getFile();
      return { size: f.size, written: new Uint8Array(await f.arrayBuffer()).some((b) => b !== 0xff) };
    } catch (e) {
      return String(e);
    }
  });
  assert.deepEqual(flash, { size: 1 << 20, written: true }, "the firmware's variable store was written beside the restored overlay");
  // Still logged in, in the shell it was: its variable, and the file on the disk (read past the page cache).
  await shows(p2, /logged-in-42/);
  await onSerial(p2, 'clear; echo var=[$SNAPVAR]; sync; echo 3 >/proc/sys/vm/drop_caches; cat /root/snapmark; echo re""ad\n');
  await shows(p2, /var=\[ram-kept-42\][^]*?disk-kept-42\s*read/);
  // And the disk takes writes: a new file, synced, read back from the disk.
  await onSerial(p2, 'echo after-$((6*7)) >/root/after && sync && echo 3 >/proc/sys/vm/drop_caches && cat /root/after && echo wr""itten\n');
  await shows(p2, /after-42[^]*?written/);
  // The guest's connector lists the new mode after a probe (the restored guest hasn't re-read it until then).
  await p2.waitForTimeout(2500); // the debounce, the display event
  await onSerial(p2, 'echo detect >/sys/class/drm/card0-Virtual-1/status; sleep 1; echo ==pre""f $(head -qn1 /sys/class/drm/card*-Virtual-1/modes)\n');
  await shows(p2, /==pref\s+\d+x\d+/);
  assert.match(await terminal(p2), new RegExp(`==pref\\s+${want[0]}x${want[1]}`), "the guest's preferred mode is the new window's");
  // And the console is still on the screen, whole: the window's mode is wider than fbcon's buffer, so it took the EDID's second mode
  // (its buffer's size). With no mode it can take, fbcon blanks the screen.
  const after = await screenOf(p2);
  assert.ok(after.lit > 0, 'the console is still shown after the display event');
  assert.deepEqual(after.size, shown.size, 'at its own size');
  // Suspend: the machine stops with its memory kept beside the overlay; a reload resumes it, still logged in.
  await onSerial(p2, 'SUSVAR=suspended-$((6*7)); clear; echo re""ady-to-suspend\n');
  await shows(p2, /ready-to-suspend/);
  const t2 = performance.now();
  await p2.locator('#suspend').click();
  await p2.waitForFunction(() => document.body.dataset.state === 'suspended', null, { timeout: 120_000 });
  const suspendMs = performance.now() - t2;
  const kept = (await opfs(p2))['webpc-debian'];
  assert.ok(kept.suspend > 1 << 20, JSON.stringify(kept));
  await p2.reload();
  const t3 = performance.now();
  await running(p2, 120_000);
  console.log(`# debian suspend: ${(kept.suspend / 1e6).toFixed(1)} MB kept, suspended in ${(suspendMs / 1000).toFixed(1)} s, resumed ${((performance.now() - t3) / 1000).toFixed(1)} s after the reload`);
  assert.match((await message(p2))!, /^Resumed the suspended machine/);
  assert.equal((await opfs(p2))['webpc-debian'].suspend, undefined, 'a resumed machine has no suspended copy');
  await onSerial(p2, 'clear; echo var=[$SUSVAR]; echo third-$((6*7)) >/root/third && sync && echo 3 >/proc/sys/vm/drop_caches && cat /root/snapmark /root/after /root/third && echo al""l-three\n');
  await shows(p2, /var=\[suspended-42\][^]*?disk-kept-42\s*after-42\s*third-42\s*all-three/);
  // A reload now boots the machine's disk normally (the overlay the restore wrote and the resumed machine
  // wrote on, the variable store beside it): the files are there.
  await p2.reload();
  await running(p2);
  assert.doesNotMatch((await message(p2)) ?? '', /Resumed/);
  await onSerial(p2, 'root\n');
  await shows(p2, /root@\S+:~# /);
  await onSerial(p2, 'cat /root/snapmark /root/after /root/third\n');
  await shows(p2, /cat \/root\/snapmark \/root\/after \/root\/third\s*disk-kept-42\s*after-42\s*third-42/);
  assert.deepEqual(errors2, []);
  await fresh.close();
}));
