// Machines as the unit on the page (docs/plans/machines.md), on Debian: a machine kept in this browser
// (IndexedDB and OPFS, web/app/store.ts) opened by `?m=<id>`, with several disks from several sources.
// Each test makes its machine's records in a fresh profile, as the modal would, then drives the guest
// on the serial terminal. Opt-in with WEBPC_DISTROS=debian (scripts/ci-debian.sh); a Debian page
// boot is ~1 min in the dev VM, ~2.5 in a cloud session.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { credentialsQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';
import { PAGE_QUERY } from './page-query.ts';

const debian = (process.env.WEBPC_DISTROS ?? '').split(',').includes('debian');
const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const skip = !debian ? 'SKIPPED: scripts/ci-debian.sh runs it (WEBPC_DISTROS=debian)' : (!existsSync(IMAGE) || !existsSync(FIRMWARE)) && 'SKIPPED: run images/build.sh debian edk2';
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
  const [state, message] = await page.evaluate(() => [document.body.dataset.state, document.getElementById('message-text')!.textContent]);
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
  await shows(page, /login: /, BOOT_MS);
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
  page.on('dialog', (d) => void d.accept());
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

/** Boots stored machine `id` on a fresh page load, logs root in on the serial terminal; says how long it took. */
async function boot(page: Page, id: string, what = '') {
  const t = Date.now();
  await page.goto(`${base}/web/app/?${PAGE_QUERY}m=${id}&view=terminal&display=simple&${credentialsQuery()}`);
  await running(page);
  await login(page);
  console.log(`# ${what} booted in ${((Date.now() - t) / 1000).toFixed(0)} s`);
}
/** Powers the guest off and waits for the page to say so (its records are refreshed then). */
async function powerOff(page: Page) {
  await type(page, 'poweroff\n');
  await page.waitForFunction(() => document.body.dataset.state === 'off', null, { timeout: 180_000 });
  await page.waitForTimeout(500);
}
/** Runs `f` in the page with the store and web/app/disks.ts. */
const inStore = <T, A>(page: Page, f: (s: { store: never; disks: never; a: A }) => Promise<T>, a: A) => page.evaluate(async ({ src, a }) => {
  const { Store } = await import('/web/app/store.ts' as string);
  const disks = await import('/web/app/disks.ts' as string);
  const store = await Store.open();
  try {
    return await (new Function(`return (${src})`)())({ store, disks, a });
  } finally {
    store.close();
  }
}, { src: f.toString(), a }) as Promise<T>;

test("a disk stored in the browser: imported, its overlays as variants (changes loaded into a new one, switched), one merged into it, then written in place", { skip, timeout: 40 * 60_000 }, () => withDebianLock(async () => {
  // A fresh profile on disk, as a user's: an off-the-record context's storage is in memory, with a quota (~1 GB here)
  // that Debian stored in the browser (~1 GB) doesn't fit.
  const profile = mkdtempSync(join(tmpdir(), 'webpc-profile-'));
  const context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  try {
  const page = context.pages()[0] ?? await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => void d.accept());
  await page.goto(`${base}/web/app/?${PAGE_QUERY}view=terminal`);
  // The import: Debian's qcow2 (95% compressed clusters) inflated into the block store.
  const t0 = Date.now();
  const imported = await inStore(page, async ({ store, disks }: any) => {
    const file = new File([await (await fetch('/target/images/debian/disk.qcow2')).blob()], 'debian.qcow2');
    const estimate = await disks.estimateStored(file);
    const d = await disks.importStored(store, file);
    const { newId } = await import('/web/app/shape.ts' as string);
    const now = Date.now();
    const id = newId();
    await store.put('machines', { id, name: 'Stored', ncpus: 2, ramMiB: 1024, display: '2d', network: true, attachments: [{ id: newId(), disk: d.id, readOnly: false }], created: now, modified: now });
    return { id, disk: d.id, size: d.size, estimate: estimate.estimate, bytes: await store.files.size(`disks/${d.id}`) };
  }, null);
  console.log(`# imported Debian in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${(imported.bytes / 1e6).toFixed(0)} MB stored, ${(imported.estimate / 1e6).toFixed(0)} MB estimated`);
  assert.ok(imported.bytes <= imported.estimate * 1.01 + (1 << 20), 'the estimate covers what it takes');
  const { id } = imported;

  // 1. Its first overlay ("Changes", made at the start) takes a file; its generation moves.
  await boot(page, id, 'over its first overlay');
  await ok(page, 'echo one > /root/one && sync');
  await powerOff(page);
  const first = await inStore(page, async ({ store, a }: any) => {
    const m = await store.get('machines', a);
    return store.get('overlays', m.attachments[0].overlay);
  }, id);
  assert.equal(first.name, 'Changes');
  assert.ok(first.generation >= 1 && first.bytes > 0, `generation ${first.generation}, ${first.bytes} bytes`);

  // 2. Its changes saved and loaded into a new overlay; an empty one beside them; the machine switched to the loaded one.
  const variants = await inStore(page, async ({ store, disks, a }: any) => {
    const { runExport } = await import('/web/app/export.ts' as string);
    const m = await store.get('machines', a);
    const d = await store.get('disks', m.attachments[0].disk);
    const r = await runExport({ mode: 'changes', compress: true, disk: await disks.diskRef(d, m.attachments[0].overlay), baseName: d.name }, () => {});
    const loaded = await disks.loadChangesInto(store, d, new File([r.blob], 'saved-changes.qcow2'), () => {});
    const empty = await disks.createOverlay(store, d, 'Fresh');
    await disks.switchOverlay(store, m, m.attachments[0].id, loaded.id);
    return { loaded: loaded.name, empty: empty.id, names: (await store.overlaysOf(d.id)).map((o: { name: string }) => o.name).sort() };
  }, id);
  assert.deepEqual(variants.names, ['Changes', 'Fresh', 'saved-changes']);
  await boot(page, id, 'over the loaded changes');
  assert.equal(await ok(page, 'cat /root/one'), 'one');
  await ok(page, 'echo two > /root/two && sync');
  await powerOff(page);

  // 3. Merged into the disk: the other overlays are deleted, the disk's generation moves; then written in place.
  const merged = await inStore(page, async ({ store, disks, a }: any) => {
    const m = await store.get('machines', a);
    const o = m.attachments[0].overlay;
    const costs = (await disks.mergeCosts(store, o)).map((x: { name: string }) => x.name).sort();
    const before = (await store.get('disks', m.attachments[0].disk)).generation;
    const blocks = await disks.mergeIntoDisk(store, o);
    const m2 = await store.get('machines', a);
    m2.attachments[0].inPlace = true;
    await store.put('machines', m2);
    return { costs, blocks, before, after: (await store.get('disks', m.attachments[0].disk)).generation, overlays: (await store.overlaysOf(m.attachments[0].disk)).length, files: await store.files.list('overlays') };
  }, id);
  assert.deepEqual(merged.costs, ['Changes', 'Fresh']);
  assert.ok(merged.blocks > 0 && merged.after === merged.before + 1, JSON.stringify(merged));
  assert.equal(merged.overlays, 0);
  assert.deepEqual(merged.files, []);
  await boot(page, id, 'in place');
  assert.equal(await ok(page, 'cat /root/one /root/two'), 'one two');
  await ok(page, 'echo three > /root/three && sync');
  await powerOff(page);
  const inPlace = await inStore(page, async ({ store, a }: any) => {
    const m = await store.get('machines', a);
    const d = await store.get('disks', m.attachments[0].disk);
    m.attachments[0].inPlace = false; // back to an overlay: a new empty one is made at the start
    await store.put('machines', m);
    return { generation: d.generation, overlays: (await store.overlaysOf(d.id)).length };
  }, id);
  assert.equal(inPlace.generation, merged.after + 1, 'writing in place moved the disk on');
  assert.equal(inPlace.overlays, 0, 'in place, no overlay');

  // 4. Over an overlay again: the disk has what was written in place.
  await boot(page, id, 'over a new overlay');
  assert.equal(await ok(page, 'cat /root/one /root/two /root/three'), 'one two three');
  await powerOff(page);
  assert.deepEqual(errors, []);
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
}));

// The installer flow (docs/plans/machines.md §4.1): an installer ISO read-only and a blank disk; the guest installs
// itself onto the blank disk (its bootloader and an EFI boot entry, kept in the machine's variable store); the ISO is
// detached and the machine boots what was installed. Alpine's virt ISO installs offline (its packages are on it).
// The ISO: `mkdir -p target/iso && curl -o target/iso/alpine-virt-3.24.2-aarch64.iso
// https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/aarch64/alpine-virt-3.24.2-aarch64.iso` (its SHA-256 is
// images/build.sh's ALPINE_ISO_SHA256).
const ISO = new URL('../target/iso/alpine-virt-3.24.2-aarch64.iso', import.meta.url);
const skipInstall = skip || (!existsSync(ISO) && 'SKIPPED: fetch the Alpine virt ISO into target/iso (tests/page-machines.test.ts says how)');
test('the installer flow: an ISO read-only and a blank disk, an install, the ISO detached, the installed disk boots', { skip: skipInstall, timeout: 40 * 60_000 }, () => withDebianLock(async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => void d.accept());
  await page.goto(`${base}/web/app/?${PAGE_QUERY}view=terminal`);
  const iso = readFileSync(ISO).length;
  const { id, serials } = await makeMachine(page, {
    ncpus: 2, ramMiB: 1024,
    disks: [
      { kind: 'url', name: 'alpine-virt.iso', size: iso, url: '/target/iso/alpine-virt-3.24.2-aarch64.iso', readOnly: true, identity: { kind: 'url', path: '/target/iso/alpine-virt-3.24.2-aarch64.iso', bytes: iso } },
      { kind: 'blank', name: 'System', size: 2048 * MiB, identity: null },
    ],
  });
  const target = `/dev/disk/by-id/virtio-${serials[1]}`;
  await page.goto(`${base}/web/app/?${PAGE_QUERY}m=${id}&view=terminal&display=simple`);
  await running(page);
  await login(page);
  // The live system's packages are the ISO's: setup-disk installs from them (no network).
  const disk = (await ok(page, `readlink -f ${target}`)).trim();
  await ok(page, `ERASE_DISKS=${disk} setup-disk -m sys -s 0 ${disk} > /tmp/setup.log 2>&1 || { tail -20 /tmp/setup.log; false; }`, 1_500_000);
  await ok(page, 'efibootmgr 2>/dev/null | head -5; true');
  await type(page, 'poweroff\n');
  await page.waitForFunction(() => document.body.dataset.state === 'off', null, { timeout: 180_000 });

  // The ISO detached (the machine is off); the installed disk boots on its own.
  await page.evaluate(async (id) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { editAttachment } = await import('/web/app/machines.ts' as string);
    const store = await Store.open();
    const m = await store.get('machines', id);
    await editAttachment(store, m, m.attachments[0].id, { detach: true });
    store.close();
  }, id);
  await page.goto(`${base}/web/app/?${PAGE_QUERY}m=${id}&view=terminal&display=simple`);
  await running(page);
  await login(page);
  assert.match(await ok(page, 'cat /etc/alpine-release; findmnt -no SOURCE /'), /^3\.24\.2 \/dev\/vda/);
  assert.deepEqual(errors, []);
  await context.close();
}));
