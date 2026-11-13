// A template's restore (docs/devices.md "A template's identity"), on Debian: a snapshot flagged as a template
// (tools/snapshot-template.ts, web/snapshot-file.ts `asTemplate`) restored in a fresh profile has the guest agent make
// the guest's identity its own (RENEW: the kernel's entropy, /etc/machine-id, systemd's random seed, the SSH host keys
// where ssh-keygen is there); the same snapshot without the flag restores as it was saved (its identity kept).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, openAsBlob, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { RENEWED } from '../web/agent-frame.ts';
import { asTemplate } from '../web/snapshot-file.ts';
import { words } from './words.ts';
import { unattendedQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';
import { PAGE_QUERY } from './page-query.ts';
import { answerAsks } from './page-ask.ts';

const debian = (process.env.WAARM64_DISTROS ?? '').split(',').includes('debian');
const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const AGENT = new URL('../target/images/agent/waarm64-agent', import.meta.url);
const skip = !debian ? 'SKIPPED: scripts/ci-debian.sh --platform runs it (WAARM64_DISTROS=debian)' : (!existsSync(IMAGE) || !existsSync(FIRMWARE) || !existsSync(AGENT)) && 'SKIPPED: run images/build.sh debian edk2 agent';

let browser: Browser;
let base: string;
let close: () => void;
let dir: string;
before(async () => {
  if (skip) return;
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  dir = mkdtempSync(join(tmpdir(), 'waarm64-template-'));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => { await browser?.close(); close?.(); if (dir) rmSync(dir, { recursive: true }); });

const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
const shows = (page: Page, re: RegExp, ms = 60_000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: ms, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the terminal shows: ${await terminal(page)}`); });
const message = (page: Page) => page.evaluate(() => document.getElementById('message-text')?.textContent ?? '');
async function onSerial(page: Page, text: string) {
  await page.locator('.xterm').click();
  await page.keyboard.type(text, { delay: 10 });
}
let runs = 0;
/** Runs `cmd` on the serial shell: its output on one line, between markers of its own. */
async function run(page: Page, cmd: string, ms = 60_000) {
  const re = new RegExp(`<<${++runs}:([^<>]*)>>`);
  await onSerial(page, `clear; echo "<<${runs}:$({ ${cmd}; } 2>&1 | tr '\\n<>' ' []')>"">"\n`);
  await shows(page, re, ms);
  return re.exec(await terminal(page))![1].trim();
}
async function running(page: Page, ms = 300_000) {
  await page.waitForFunction(() => ['running', 'failed', 'crashed', 'idle', 'off'].includes(document.body.dataset.state!), null, { timeout: ms, polling: 250 });
  assert.equal(await page.evaluate(() => document.body.dataset.state), 'running', await message(page));
}
type Agent = { agent?: unknown; renewed?: { done: number; failed: number } };
const agentUp = (page: Page) =>
  page.waitForFunction(() => !!(window as unknown as { __agent?: Agent }).__agent?.agent, null, { timeout: 120_000, polling: 200 });
/** What identifies this copy of the guest: its machine id, its random seed's and SSH host keys' hashes. */
const identity = async (page: Page) => ({
  id: await run(page, 'cat /etc/machine-id'),
  seed: await run(page, 'sha256sum /var/lib/systemd/random-seed 2>/dev/null | cut -c1-16'),
  keys: await run(page, 'sha256sum /etc/ssh/ssh_host_*_key 2>/dev/null | cut -c1-16 | tr "\\n" " "'),
});

/** A fresh profile with the snapshot in `file` restored, the agent up, root's shell on the serial terminal. */
async function restore(file: string, query: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await answerAsks(page);
  await page.goto(`${base}/web/app/?${PAGE_QUERY}${query}`);
  await page.setInputFiles('#load-snapshot-input', file);
  await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('boot-title')!.textContent!), words('machine:runner.boot.loading', {}, { start: true }).source, { timeout: 30_000 });
  await running(page, 180_000);
  await agentUp(page);
  await onSerial(page, '\n');
  return { context, page };
}

test("a template's restore has the agent renew the guest's identity; the same snapshot unflagged keeps it", { skip, timeout: 20 * 60_000 }, () => withDebianLock(async () => {
  const query = `ncpus=2&view=both&agent=1&${unattendedQuery()}`;
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => { (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = undefined; });
  await answerAsks(page);
  await page.goto(`${base}/web/app/?${PAGE_QUERY}${query}`);
  await running(page);
  await shows(page, /login: /);
  await onSerial(page, 'root\n');
  await shows(page, /root@\S+:~# /);
  await agentUp(page);
  const keygen = (await run(page, 'command -v ssh-keygen || echo none')) !== 'none';
  const before = await identity(page);
  console.log(`# the template's identity: ${JSON.stringify(before)}; ssh-keygen ${keygen ? 'there' : 'not there'}`);
  assert.match(before.id, /^[0-9a-f]{32}$/);
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 180_000 }), page.locator('#save-snapshot').click()]);
  const plain = join(dir, 'debian.waarm64snap');
  await download.saveAs(plain);
  await context.close();
  const template = join(dir, 'template.waarm64snap');
  await writeFile(template, (await asTemplate(await openAsBlob(plain))).stream());

  // Unflagged: the restore is the saved machine, its identity and all.
  const a = await restore(plain, query);
  assert.deepEqual(await identity(a.page), before, 'a snapshot of ours keeps its identity');
  assert.equal(await a.page.evaluate(() => (window as unknown as { __agent: Agent }).__agent.renewed), undefined, 'no RENEW');
  await a.context.close();

  // A template: the agent renews what there is.
  const b = await restore(template, query);
  const renewed = await b.page.waitForFunction(() => (window as unknown as { __agent: Agent }).__agent.renewed, null, { timeout: 120_000, polling: 250 }).then((h) => h.jsonValue() as Promise<{ done: number; failed: number }>);
  const want = RENEWED.ENTROPY | RENEWED.MACHINE_ID | (before.seed ? RENEWED.SEED : 0) | (keygen && before.keys ? RENEWED.SSH : 0);
  assert.deepEqual(renewed, { done: want, failed: 0 }, `RENEWED; the agent says: ${await run(b.page, 'journalctl -b -u waarm64-agent -o cat --no-pager | grep renew | tail -4')}`);
  const after = await identity(b.page);
  console.log(`# the copy's identity: ${JSON.stringify(after)}`);
  assert.match(after.id, /^[0-9a-f]{12}4[0-9a-f]{19}$/, 'a new version 4 machine id');
  assert.notEqual(after.id, before.id);
  if (before.seed) assert.notEqual(after.seed, before.seed, 'a new random seed');
  if (keygen && before.keys) {
    assert.notEqual(after.keys, before.keys, 'new SSH host keys');
    assert.equal(after.keys.split(' ').length, before.keys.split(' ').length, 'as many as before');
    assert.equal(await run(b.page, 'ls /etc/ssh | grep -c "\\.new" || true'), '0', 'none left half made');
  }
  // Nothing in the guest minded.
  assert.equal(await run(b.page, 'systemctl --failed --no-legend | wc -l'), '0');
  await b.context.close();
}));
