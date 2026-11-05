// Clipboard sharing's channel on Debian (docs/plans/clipboard.md §2, step 1): a machine with `?clipboard=1` has the
// agent's device (web/agent-device.ts), whose port Debian's virtio_console names and udev links as
// /dev/virtio-ports/org.webpc.agent.0. The page's end (web/app/agent-link.ts, `window.__agent`) sees the guest open
// and close it, and frames the page sends come back unchanged through `cat` echoing the port into itself: a small one,
// and 320 KiB of 64 KiB frames, past the link's window, so the guest's buffers and the window's flow both turn over.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { unattendedQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';
import { PAGE_QUERY } from './page-query.ts';
import { answerAsks } from './page-ask.ts';

const debian = (process.env.WEBPC_DISTROS ?? '').split(',').includes('debian');
const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const skip = !debian ? 'SKIPPED: scripts/ci-debian.sh runs it (WEBPC_DISTROS=debian)' : (!existsSync(IMAGE) || !existsSync(FIRMWARE)) && 'SKIPPED: run images/build.sh debian edk2';

let browser: Browser;
let base: string;
let close: () => void;
before(async () => {
  if (skip) return;
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => { await browser?.close(); close?.(); });

const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
const shows = (page: Page, re: RegExp, ms = 60_000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: ms, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the terminal shows: ${await terminal(page)}`); });
const message = (page: Page) => page.evaluate(() => document.getElementById('message-text')?.textContent ?? '');
async function onSerial(page: Page, text: string) {
  await page.locator('.xterm').click();
  await page.keyboard.type(text, { delay: 10 });
}
type Link = { open: boolean; broken: boolean; backlog: number; send(type: number, payload?: Uint8Array): boolean; onFrame?: (f: { type: number; payload: Uint8Array }) => void };
const isOpen = (page: Page, open: boolean) =>
  page.waitForFunction((want) => (window as unknown as { __agent?: Link }).__agent?.open === want, open, { timeout: 60_000, polling: 100 });

test('clipboard sharing\'s port: Debian names it; the page sees the guest open and close it; frames come back through it unchanged', { skip, timeout: 10 * 60_000 }, () => withDebianLock(async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/?${PAGE_QUERY}ncpus=2&view=both&clipboard=1&${unattendedQuery()}`);
  await page.waitForFunction(() => ['running', 'failed', 'crashed', 'idle', 'off'].includes(document.body.dataset.state!), null, { timeout: 300_000, polling: 250 });
  assert.equal(await page.evaluate(() => document.body.dataset.state), 'running', await message(page));
  await onSerial(page, 'root\n');
  await shows(page, /root@\S+:~# /);

  // The port, by its name; no console on it (no hvc).
  await onSerial(page, 'clear; ls /dev/virtio-ports/; cat /sys/class/virtio-ports/*/name; ls /dev/hvc0 2>&1 | wc -w; echo li""sted\n');
  await shows(page, /org\.webpc\.agent\.0\s*org\.webpc\.agent\.0\s*(\d+)\s*listed/);
  assert.equal(await page.evaluate(() => (window as unknown as { __agent?: Link }).__agent?.open), false, 'nobody holds it open yet');

  // `cat` holds it open, echoing it into itself.
  await onSerial(page, 'clear; exec 3<>/dev/virtio-ports/org.webpc.agent.0; cat <&3 >&3 & echo st""arted\n');
  await shows(page, /started/);
  await isOpen(page, true);
  const echoed = await page.evaluate(async () => {
    const link = (window as unknown as { __agent: Link }).__agent;
    const sum = (b: Uint8Array) => b.reduce((a, x) => (a * 31 + x) >>> 0, 7);
    const sent: [number, number, number][] = [];
    const got: [number, number, number][] = [];
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${got.length} of ${sent.length} frames back after 120 s (broken: ${link.broken}, backlog ${link.backlog})`)), 120_000);
      link.onFrame = (f) => {
        got.push([f.type, f.payload.length, sum(f.payload)]);
        if (got.length === sent.length) { clearTimeout(timer); resolve(); }
      };
    });
    const frames: [number, Uint8Array][] = [[1, new TextEncoder().encode('hello from the page')]];
    for (let i = 0; i < 5; i++) frames.push([4, Uint8Array.from({ length: 65536 }, (_, k) => (k * 7 + i * 13) & 0xff)]);
    for (const [type, payload] of frames) {
      sent.push([type, payload.length, sum(payload)]);
      if (!link.send(type, payload)) throw new Error('the link refused a frame');
    }
    await done;
    return { sent, got };
  });
  assert.deepEqual(echoed.got, echoed.sent);

  // Closed: the page hears it.
  await onSerial(page, 'clear; kill %1; exec 3<&-; echo cl""osed\n');
  await shows(page, /closed/);
  await isOpen(page, false);
  assert.deepEqual(errors, []);
  await page.close();
}));
