// Your own disk on the page (M8 phase B loop 4) and the serial terminal's keys (loop 3), on the
// same boots: a local qcow2 chosen with the picker boots through UEFI, its changes live in an
// overlay of their own (keyed by the file's name, size and modification time), are saved from the
// page (the changes over the base as a qcow2 that `qemu-img` accepts, by a download and by a file
// picker's handle), and choosing the same file again in a fresh page finds them. Its first boot
// goes through the keys, end to end through xterm.js (arrows, Enter, Esc, F2, Ctrl-N/E/X): GRUB's
// menu (arrows) -> "UEFI Firmware Settings" (the guest resets; the chosen disk's flash bank kept
// the variable that asks for the setup, over the page's restart of the machine) -> EDK2's boot menu
// and setup forms -> Continue -> the disk's loader again -> GRUB's editor (e, F2's command line,
// Esc, arrows, typing) -> Ctrl-X boots the edited entry, and the kernel's command line has what
// was typed. `?display=simple` keeps GRUB's menu on the serial console. Three Debian boots and two
// firmware starts, ~4 min alone; opt-in with WEBPC_DISTROS=debian (scripts/ci-debian.sh).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { credentialsQuery, unattendedQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';
import { PAGE_QUERY } from './page-query.ts';
import { answerAsks } from './page-ask.ts';

const debian = (process.env.WEBPC_DISTROS ?? '').split(',').includes('debian');
const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const skip = !debian ? 'SKIPPED: scripts/ci-debian.sh runs it (WEBPC_DISTROS=debian)' : (!existsSync(IMAGE) || !existsSync(FIRMWARE)) && 'SKIPPED: run images/build.sh debian edk2';
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
/** The terminal's rows, one per line (xterm.js's DOM renderer), trailing spaces trimmed: for the firmware's and GRUB's screens. */
const rows = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.xterm-rows > div')].map((d) => d.textContent!.replace(/\s+$/, '')).join('\n'));
const showsRows = (page: Page, re: RegExp, ms = 120_000) =>
  page.waitForFunction(([src, flags]) => new RegExp(src, flags).test([...document.querySelectorAll('.xterm-rows > div')].map((d) => d.textContent!.replace(/\s+$/, '')).join('\n')), [re.source, re.flags], { timeout: ms, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the terminal shows:\n${await rows(page)}`); });
/** Presses keys one at a time with a moment between them: the firmware's terminal driver tells a lone Esc from the start of a key sequence by waiting (~2 s). */
async function press(page: Page, ...keys: string[]) {
  for (const k of keys) {
    await page.keyboard.press(k);
    await page.waitForTimeout(k === 'Escape' ? 2500 : 150);
  }
}
/** Waits for the machine's `running` after the page left `from`. */
async function running(page: Page, from: string) {
  await page.waitForFunction((from) => document.body.dataset.state !== from && ['running', 'failed', 'crashed', 'idle', 'off'].includes(document.body.dataset.state!), from, { timeout: BOOT_MS, polling: 250 });
  const [state, message] = await page.evaluate(() => [document.body.dataset.state, (document.getElementById('message-text')?.textContent ?? '')]);
  assert.equal(state, 'running', `${message}; the terminal shows: ${await terminal(page)}`);
}
/** The names of the OPFS directories. */
const overlays = (page: Page) => page.evaluate(async () => {
  const names: string[] = [];
  for await (const [name] of (await navigator.storage.getDirectory() as unknown as { entries(): AsyncIterable<[string]> }).entries()) names.push(name);
  return names;
});

test("a disk chosen on the page boots through UEFI (the serial terminal's keys through EDK2's menus and GRUB's editor on the way), keeps its changes in its own overlay, and has them again when chosen again", { skip, timeout: 25 * 60_000 }, () => withDebianLock(async () => {
  // The same bytes under a name of the user's own (the page keys the disk by name, size and modification time).
  const file = join(dir, 'mydisk.qcow2');
  symlinkSync(new URL(IMAGE).pathname, file);
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(() => { (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = undefined; }); // headless Chromium's picker would wait for a dialog nobody answers
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page); // "Boot mydisk.qcow2? The machine restarts…"
  /** Export › `mode` of the machine's disk (its Disks tab on the Machines page), then back to the machine. */
  const exportDisk = async (mode: string) => {
    await page.locator('#machines-open').click();
    await page.locator('.machines [data-tab=disks]').click();
    await page.locator('.machines [id^=export-] summary').click();
    await page.locator(`.machines [data-save=${mode}]`).click();
  };
  const back = () => page.locator('[data-action=back]').click();
  const pick = async () => {
    await page.setInputFiles('#open-disk-input', file);
    await page.waitForFunction(() => (document.getElementById('machine')?.textContent ?? '') === 'mydisk', null, { timeout: 10_000 });
  };
  const choose = async () => {
    const from = await page.evaluate(() => document.body.dataset.state!);
    await pick();
    await running(page, from);
  };

  // The page's own machine (no `machine=`) has no disk: it starts nothing, says how to bring one, and names no distribution.
  // The serial terminal only (the keys test's GRUB menu is on it); Debian's credentials, for its unattended first boot.
  await page.goto(`${base}/web/app/?${PAGE_QUERY}ncpus=2&view=terminal&display=simple&${credentialsQuery()}`);
  await page.waitForFunction(() => document.body.dataset.state === 'idle' && /Open a disk image/.test((document.getElementById('message-text')?.textContent ?? '')), null, { timeout: 10_000 });
  assert.equal(await page.locator('#machine').textContent(), 'AArch64 machine · no disk');
  assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /debian/i);
  await page.locator('#restart').click(); // Start: still waiting for a disk
  assert.equal(await page.evaluate(() => document.body.dataset.state), 'idle');
  await pick();
  assert.equal(await page.locator('#machine').textContent(), 'mydisk', 'a machine made for the file, named after it');
  await page.locator('.xterm').click();
  // GRUB's menu: two arrows down to "UEFI Firmware Settings" (its asterisk marks the entry), Enter.
  await showsRows(page, /Advanced options for Debian/);
  await press(page, 'ArrowDown', 'ArrowDown');
  await showsRows(page, /\|\*UEFI Firmware Settings/, 10_000);
  await press(page, 'Enter');

  // The guest reset itself (the page restarts the machine) into EDK2's boot device menu: the variable that asked for it was kept in the flash bank.
  await showsRows(page, /Please select boot device/);
  await page.waitForTimeout(1000);
  await press(page, 'Enter'); // "EFI Firmware Setup"
  await showsRows(page, /Select Language\s+<Standard English>/);
  await press(page, 'ArrowDown', 'ArrowDown', 'Enter'); // Boot Manager
  await showsRows(page, /Boot Manager Menu/);
  await press(page, 'Escape');
  await showsRows(page, /Select Language\s+<Standard English>/, 10_000);
  await press(page, 'ArrowDown', 'ArrowDown'); // from Boot Manager: Boot Maintenance Manager, Continue
  await showsRows(page, /<Standard English>\s+Continue/, 10_000); // its help text
  await press(page, 'Enter');
  await showsRows(page, /Please select boot device/);
  await page.waitForTimeout(1000);
  await press(page, 'ArrowDown', 'Enter'); // "UEFI Misc Device": the disk

  // GRUB's editor: Ctrl-N goes to the last line, the arrows to the `linux` line, Ctrl-E to its end, then F2's command line and Esc.
  await showsRows(page, /Advanced options for Debian/);
  await press(page, 'e');
  await showsRows(page, /Minimum Emacs-like screen editing/);
  await page.waitForTimeout(2000);
  for (let i = 0; i < 40; i++) { await page.keyboard.press('Control+n'); await page.waitForTimeout(30); } // the last line (the editor's Emacs keys: plain bytes)
  await showsRows(page, /initrd\s+\/boot\/initrd\.img/, 10_000);
  await press(page, 'ArrowUp', 'ArrowUp', 'ArrowUp', 'Control+e'); // the `linux` line (`initrd`, `echo`, `linux`)
  await page.keyboard.type(' webpc.keytest=1', { delay: 20 });
  await showsRows(page, /webpc\.keytest=1/, 10_000);
  // F2 opens GRUB's command line (it runs a command), Esc returns to the editor with the edit kept.
  await press(page, 'F2');
  await showsRows(page, /grub>/, 10_000);
  await page.keyboard.type('echo f2-works', { delay: 20 });
  await press(page, 'Enter');
  await showsRows(page, /^f2-works\ngrub>/m, 10_000); // the prompt is back: an Esc before it would interrupt the command
  await press(page, 'Escape');
  await showsRows(page, /Minimum Emacs-like screen editing/, 10_000);
  await showsRows(page, /webpc\.keytest=1/, 10_000);
  await press(page, 'Control+x');

  // The edited entry boots; its kernel has the typed parameter (Debian's GRUB passes `quiet`: the kernel's own echo of the line isn't on the console).
  await showsRows(page, /\S+ login:$/m, 240_000);
  await page.keyboard.type('root\n', { delay: 10 });
  await showsRows(page, /root@\S+:~#/, 60_000);
  await page.keyboard.type('tr " " "\\n" </proc/cmdline | grep -x webpc.key""test=1\n', { delay: 10 }); // (the quotes keep the command's echo from matching)
  await showsRows(page, /^webpc\.keytest=1$/m, 30_000);
  await page.waitForFunction(() => document.body.dataset.state === 'running', null, { timeout: 60_000, polling: 250 });
  await onSerial(page, 'clear; echo webpc-own-$((6*7)) >/root/own-mark && sync && echo sy""nced\n');
  await shows(page, /synced/);
  // The page's disk takes DISCARD: Debian's ext4 trims its free space (what the guest frees leaves the overlay).
  await onSerial(page, 'fstrim -v / && echo tr""immed\n');
  await shows(page, /\/: [^/]*\(\d+ bytes\) trimmed\s*trimmed/);
  // A machine kept in the browser for it (docs/plans/machines.md): the disk's changes in an overlay of their own, the
  // firmware's variable store in the machine's directory.
  const names = await overlays(page);
  assert.deepEqual(names.sort(), ['machines', 'overlays'], `OPFS has ${names}`);
  await page.waitForFunction(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const [, h] of ((await root.getDirectoryHandle('machines')) as unknown as { entries(): AsyncIterable<[string, FileSystemDirectoryHandle]> }).entries()) {
      try {
        const f = await (await h.getFileHandle('flash')).getFile();
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
    exportDisk('changes'),
  ]);
  assert.equal(download.suggestedFilename(), 'mydisk-changes.qcow2');
  const downloaded = join(dir, 'mydisk-changes.qcow2');
  await download.saveAs(downloaded);
  await page.waitForFunction(() => /^Saved /.test((document.getElementById('message-text')?.textContent ?? '')), null, { timeout: 30_000 });
  await page.evaluate(() => {
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async () => (await navigator.storage.getDirectory()).getFileHandle('picked.qcow2', { create: true });
  });
  await page.locator('.machines [id^=export-] summary').click();
  await page.locator('.machines [data-save=changes]').click();
  await page.waitForFunction(() => /^Saved picked\.qcow2/.test((document.getElementById('message-text')?.textContent ?? '')), null, { timeout: 120_000 });
  await back();
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
  const image = readFileSync(IMAGE);
  const top = createHash('sha256'); // web/changes.ts `hashSource`: the SHA-256 of the 4 MiB slices' SHA-256 digests
  for (let off = 0; off < image.length; off += 4 << 20) top.update(createHash('sha256').update(image.subarray(off, off + (4 << 20))).digest());
  assert.ok(changes.subarray(0, 4096).toString('latin1').includes(top.digest('hex')), "the header names the base image's hash");
  const map = JSON.parse(qemu('map', '--output=json', `json:${JSON.stringify({ driver: 'qcow2', file: { driver: 'file', filename: downloaded }, backing: null })}`)) as { data: boolean }[];
  assert.ok(map.some((e) => e.data), 'the changes file holds the blocks the machine wrote');

  // A reload opens the machine again, which asks for its file (a File picked without a handle isn't remembered);
  // choosing the file again finds its machine and its changes.
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.state === 'idle' && /picking again/.test((document.getElementById('message-text')?.textContent ?? '')), null, { timeout: 30_000 });
  await choose();
  await onSerial(page, 'root\n');
  await shows(page, /root@\S+:~# /);
  await onSerial(page, 'cat /root/own-mark\n');
  await shows(page, /cat \/root\/own-mark\s*webpc-own-42/);

  // Saving over the running disk: the suggested name is never the disk's own, and a dialog that emptied it (Chromium
  // truncates the file it hands over; here the symlink is pointed elsewhere, which changes the file the same way for the
  // page's File, and the image stays whole) is caught before anything is written or the machine is stopped.
  const stand = join(dir, 'other.bin');
  writeFileSync(stand, 'x');
  await page.exposeFunction('webpcEmptyTheDisk', () => { unlinkSync(file); symlinkSync(stand, file); });
  await page.evaluate(() => {
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async (o: { suggestedName: string }) => {
      (window as unknown as { suggested: string }).suggested = o.suggestedName;
      await (window as unknown as { webpcEmptyTheDisk(): Promise<void> }).webpcEmptyTheDisk();
      return { name: 'mydisk.qcow2', createWritable: () => { throw new Error('wrote to the emptied disk'); } };
    };
  });
  try {
    await exportDisk('qcow2');
    await page.waitForFunction(() => /was the disk this machine runs from/.test((document.getElementById('message-text')?.textContent ?? '')), null, { timeout: 30_000 });
    assert.equal(await page.evaluate(() => (window as unknown as { suggested: string }).suggested), 'mydisk-saved.qcow2');
    assert.equal(await page.evaluate(() => document.body.dataset.state), 'running', 'the machine wasn\'t stopped for it');
    await back();
  } finally {
    unlinkSync(file);
    symlinkSync(new URL(IMAGE).pathname, file);
  }
  assert.deepEqual(errors, []);
  await context.close();

  // Changes in (loop 6): a fresh profile's Debian (the same bytes the changes were made over, under another name) plus the
  // changes file boots with the file. The overlay of the machine's own disk takes it, the page restarts the machine.
  const fresh = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page2 = await fresh.newPage();
  const dialogs: string[] = [];
  const errors2: string[] = [];
  await answerAsks(page2, (q) => { dialogs.push(q.text); });
  page2.on('pageerror', (e) => errors2.push(String(e)));
  await page2.goto(`${base}/web/app/?${PAGE_QUERY}ncpus=2&view=both&${unattendedQuery()}`);
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
