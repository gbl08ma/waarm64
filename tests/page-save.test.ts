// Saving the disk from the page (M8 phase B loop 5), on the small Buildroot guest (no Debian): from a
// running machine (it stops, the file downloads, the machine starts again), the whole disk as raw
// (the image's bytes) and as qcow2 (`qemu-img compare` says identical), and the changes file (a
// valid qcow2 over the image, empty here: the root is mounted read-only). The Debian page test
// (tests/page-disk.test.ts) saves a disk with real changes. Skipped without qemu-img or the image.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { startServer } from '../tools/serve.ts';

const IMAGE = new URL('../target/images/buildroot/rootfs.ext4', import.meta.url);
const KERNEL = new URL('../target/images/linux/Image', import.meta.url);
const skip = spawnSync('qemu-img', ['--version']).status !== 0 ? 'SKIPPED: no qemu-img' : (!existsSync(IMAGE) || !existsSync(KERNEL)) && 'SKIPPED: run images/build.sh';

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
  dir = mkdtempSync(join(tmpdir(), 'webpc-save-'));
});
after(async () => { await browser?.close(); close?.(); if (dir) rmSync(dir, { recursive: true }); });

test('the page saves the disk of a running machine: whole disk as raw and as qcow2, and the changes over the image', { skip, timeout: 180_000 }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => { (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = undefined; }); // the download path
  page.on('dialog', (d) => void d.accept()); // "Stop the machine to save its disk?"
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/web/app/?machine=buildroot&ncpus=1&view=terminal`);
  await page.waitForFunction(() => document.body.dataset.state === 'running', null, { timeout: 60_000 });

  const save = async (mode: string, name: string) => {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 120_000 }),
      (async () => { await page.locator('#save summary').click(); await page.locator(`[data-save=${mode}]`).click(); })(),
    ]);
    assert.equal(download.suggestedFilename(), name);
    const path = join(dir, name);
    await download.saveAs(path);
    // The machine was running: it starts again.
    await page.waitForFunction(() => document.body.dataset.state === 'running', null, { timeout: 60_000 });
    return path;
  };
  const image = new URL(IMAGE).pathname;
  const qemu = (...args: string[]) => execFileSync('qemu-img', args, { encoding: 'utf8' });

  const raw = await save('raw', 'rootfs.ext4.img');
  assert.ok(readFileSync(raw).equals(readFileSync(image)), 'the raw export is the image, byte for byte');

  const whole = await save('qcow2', 'rootfs.ext4.qcow2');
  qemu('check', whole);
  assert.match(qemu('compare', '-f', 'qcow2', '-F', 'raw', whole, image), /Images are identical/);

  symlinkSync(image, join(dir, 'rootfs.ext4'));
  const changes = await save('changes', 'rootfs.ext4-changes.qcow2');
  qemu('check', changes);
  assert.match(qemu('info', changes), /backing file: rootfs\.ext4/);
  assert.match(qemu('compare', '-f', 'qcow2', '-F', 'raw', changes, image), /Images are identical/);
  assert.deepEqual(errors, []);
  await context.close();
});
