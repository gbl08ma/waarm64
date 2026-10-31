// Machines as the unit on the page (docs/machines.md), on Debian: a machine kept in this browser
// (IndexedDB and OPFS, web/app/store.ts) opened by `?m=<id>`, with several disks from several sources.
// Each test makes its machine's records in a fresh profile, as the modal would, then drives the guest
// on the serial terminal. Opt-in with WEBPC_DISTROS=debian (scripts/ci-machines.sh); a Debian page
// boot is ~40 s in the dev VM, ~2.5 min in a cloud session. The stored disk's tests are tests/page-stored.test.ts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { credentialsQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';
import { PAGE_QUERY } from './page-query.ts';
import { answerAsks } from './page-ask.ts';

const debian = (process.env.WEBPC_DISTROS ?? '').split(',').includes('debian');
const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const skip = !debian ? 'SKIPPED: scripts/ci-machines.sh runs it (WEBPC_DISTROS=debian)' : (!existsSync(IMAGE) || !existsSync(FIRMWARE)) && 'SKIPPED: run images/build.sh debian edk2';
const BOOT_MS = 420_000;

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

/** Waits until the page settles in `running` (from another state than `from`). */
async function running(page: Page, from?: string, ms = BOOT_MS) {
  await page.waitForFunction((from) => document.body.dataset.state !== from && ['running', 'failed', 'crashed', 'idle', 'off'].includes(document.body.dataset.state!), from, { timeout: ms, polling: 250 })
    .catch(async (e) => { throw new Error(`${e}; the page is ${await page.evaluate(() => document.body.dataset.state)}; the terminal shows: ${await terminal(page)}`); });
  const [state, message] = await page.evaluate(() => [document.body.dataset.state, (document.getElementById('message-text')?.textContent ?? '')]);
  assert.equal(state, 'running', message ?? '');
}

async function type(page: Page, text: string) {
  await page.locator('.xterm').click();
  await page.keyboard.type(text, { delay: 5 });
}

let tag = 0;
/**
 * Runs `cmd` in the guest's shell and returns what it printed between two markers (on one line: the unquoted `$o`
 * joins its lines with spaces), with its exit status. The markers are made by the shell, so the echoed command never matches.
 */
async function sh(page: Page, cmd: string, ms = 120_000): Promise<{ out: string; status: number }> {
  const t = ++tag;
  await type(page, `o=$( { ${cmd} ; } 2>&1 ); s=$?; echo "<$((${t}*1))<"$o">$s>${t}>"\n`);
  const re = new RegExp(`<${t}<(.*?)>(\\d+)>${t}>`);
  await shows(page, re, ms);
  const m = re.exec(await terminal(page))!;
  return { out: m[1].trim(), status: Number(m[2]) };
}
const ok = async (page: Page, cmd: string, ms?: number) => {
  const r = await sh(page, cmd, ms);
  assert.equal(r.status, 0, `${cmd}: ${r.out}`);
  return r.out;
};

async function login(page: Page) {
  await shows(page, /login: /, 60_000);
  await type(page, 'root\n');
  await shows(page, /(?:root@\S+|\S+):~# /); // Debian's prompt, Alpine's
}

/** Makes a machine's records in the page's store (as the modal does); returns its id. */
async function makeMachine(page: Page, m: { ncpus: number; ramMiB: number; disks: { kind: string; name: string; size: number; url?: string; readOnly?: boolean; identity: unknown }[] }) {
  return page.evaluate(async (m) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { newId } = await import('/web/app/shape.ts' as string);
    const store = await Store.open();
    const now = Date.now();
    const attachments = [];
    for (const d of m.disks) {
      const id = newId();
      await store.put('disks', { id, kind: d.kind, name: d.name, size: d.size, url: d.url, identity: d.kind === 'url' ? d.identity : { kind: d.kind, id, bytes: d.size }, created: now });
      attachments.push({ id: newId(), disk: id, readOnly: !!d.readOnly });
    }
    const id = newId();
    await store.put('machines', { id, name: 'Test machine', ncpus: m.ncpus, ramMiB: m.ramMiB, display: '2d', network: true, attachments, created: now, modified: now });
    store.close();
    return { id, serials: attachments.map((a) => `webpc-${a.id}`) };
  }, m);
}

const MiB = 2 ** 20;

test('a machine with four disks: Debian from a URL, a blank disk formatted and kept, a ramdisk empty after a reboot, a read-only one', { skip, timeout: 30 * 60_000 }, () => withDebianLock(async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/?${PAGE_QUERY}view=terminal`); // the page's origin, waiting for a disk
  const firmware = readFileSync(FIRMWARE);
  const image = readFileSync(IMAGE);
  const size = Number(image.readBigUInt64BE(24)); // the qcow2's virtual size
  const { id, serials } = await makeMachine(page, {
    ncpus: 2, ramMiB: 1024,
    disks: [
      { kind: 'url', name: 'disk.qcow2', size, url: '/target/images/debian/disk.qcow2', identity: { kind: 'url', path: '/target/images/debian/disk.qcow2', bytes: image.length } },
      { kind: 'blank', name: 'Blank', size: 256 * MiB, identity: null },
      { kind: 'ramdisk', name: 'Ramdisk', size: 128 * MiB, identity: null },
      { kind: 'url', name: 'QEMU_EFI.fd', size: firmware.length, url: '/target/images/edk2/QEMU_EFI.fd', readOnly: true, identity: { kind: 'url', path: '/target/images/edk2/QEMU_EFI.fd', bytes: firmware.length } },
    ],
  });
  const [, blank, ram, ro] = serials.map((s) => `/dev/disk/by-id/virtio-${s}`);
  await page.goto(`${base}/web/app/?${PAGE_QUERY}m=${id}&view=terminal&display=simple&${credentialsQuery()}`);
  assert.equal(await page.locator('#machine').textContent(), 'Test machine');
  await running(page);
  await login(page);

  // The serials name the disks; their sizes and read-only flags are the attachments'.
  assert.equal(await ok(page, `for d in ${serials.map((s) => `/dev/disk/by-id/virtio-${s}`).join(' ')}; do echo $(blockdev --getsize64 --getro $d); done`), `${size} 0 ${256 * MiB} 0 ${128 * MiB} 0 ${firmware.length} 1`);
  // The read-only disk: the file's bytes, and writes refused.
  assert.equal(await ok(page, `sha256sum < ${ro} | cut -c1-64`), createHash('sha256').update(firmware).digest('hex'));
  assert.notEqual((await sh(page, `dd if=/dev/zero of=${ro} bs=4096 count=1 oflag=direct`)).status, 0);
  // The blank disk reads as zeros; formatted, mounted and written, it keeps the file.
  assert.equal(await ok(page, `cmp -n ${256 * MiB} ${blank} /dev/zero && echo zeros`), 'zeros');
  await ok(page, `mkfs.ext4 -q ${blank} && mkdir -p /mnt/b && mount ${blank} /mnt/b && echo kept-$((6*7)) > /mnt/b/file && sync`, 180_000);
  // The ramdisk: empty, then written.
  assert.equal(await ok(page, `cmp -n ${128 * MiB} ${ram} /dev/zero && echo zeros`), 'zeros');
  await ok(page, `mkfs.ext4 -q ${ram} && mkdir -p /mnt/r && mount ${ram} /mnt/r && echo gone > /mnt/r/file && sync && cat /mnt/r/file`);

  // The guest's reboot is a new machine: the ramdisk starts empty again, the blank disk has its file.
  await type(page, 'reboot\n');
  await page.waitForFunction(() => document.body.dataset.state !== 'running', null, { timeout: 120_000, polling: 100 });
  await running(page);
  await login(page);
  assert.equal(await ok(page, `cmp -n ${128 * MiB} ${ram} /dev/zero && echo zeros`), 'zeros');
  assert.equal(await ok(page, `mount ${blank} /mnt/b && cat /mnt/b/file`), 'kept-42');
  await type(page, 'poweroff\n');
  await page.waitForFunction(() => document.body.dataset.state === 'off', null, { timeout: 120_000 });

  // In the browser: the machine's flash and one overlay each for the Debian disk and the blank one (the ramdisk has none).
  const stored = await page.evaluate(async (id) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    const m = await store.get('machines', id);
    const out = { overlays: m.attachments.map((a: { overlay?: string }) => !!a.overlay), files: await store.files.list(`machines/${id}`), sizes: [] as number[] };
    for (const a of m.attachments) if (a.overlay) out.sizes.push(await store.files.size(`overlays/${a.overlay}`));
    store.close();
    return out;
  }, id);
  assert.deepEqual(stored.overlays, [true, true, false, false]);
  assert.deepEqual(stored.files, ['flash']);
  assert.ok(stored.sizes.every((n) => n > 0), `overlay sizes ${stored.sizes}`);
  assert.deepEqual(errors, []);
  await context.close();
}));
