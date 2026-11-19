// Booted-Debian fixtures (docs/testing.md "Booted-Debian fixtures"): a snapshot of the harness's Debian
// (tests/browser/tailnet-worker.ts) at its login prompt, made once per shape and key and kept in target/ci/, which the
// tests that need Debian but not its boot start from instead of booting (~1 s against ~50 s). The shape is what the
// worker builds the machine from (the card's credential, the cards and their backends, the disk); the key, what the
// boot made of it: the image (its `.inputs` key, or the file's size and time), EDK2, the core's snapshot format, ABI and MIDR,
// and the sources that say what the machine is and what it is given at boot (the DT, SMBIOS, fw_cfg, virtio, the
// credentials). A file whose key moved is made again; parallel test files wait for one maker (a lock directory beside
// the file, as tests/debian-lock.ts's). WAARM64_DEBIAN_FIXTURES=0 boots instead.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { t } from '../web/i18n.ts';
import type { Question } from './page-ask.ts';
import { PAGE_QUERY } from './page-query.ts';
import { withDebianLock } from './debian-lock.ts';
import { credentialsQuery } from './debian-unattended.ts';
import { shows } from './serial-console.ts';
import { words } from './words.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const DIR = join(ROOT, 'target/ci');

/** What the harness's worker builds the machine from (tests/browser/fixture.html's `shape`). */
export type Shape = { page?: boolean; ip?: boolean; ports?: number; adapters?: number; disk?: string };

/** The shapes the network tests start from. */
export const SHAPES = {
  /** tailnet.html: one card on an IP port, no card credential (the test sets networkd up). */
  ip: { ip: true },
  /** tailnet.html with debian-tools' disk (an SSH server). */
  'ip-tools': { ip: true, disk: '/target/images/debian-tools/disk.qcow2' },
  /** netguest.html `port=1`: the card's credential, one card on an IP port whose lease the test sends. */
  port: { page: true, ip: true },
  /** netguest.html `ports=2`, adapters.html: the card's credential, two cards on IP ports. */
  ports2: { page: true, ports: 2 },
  /** netguest.html `adapters=3`: three cards on the echo backend (their leases taken at boot). */
  echo3: { page: true, adapters: 3 },
} satisfies Record<string, Shape>;

const SOURCES = [
  'tests/browser/tailnet-worker.ts', 'tests/debian-unattended.ts', 'web/app/machine.ts', 'web/app/guest-unit.ts',
  'core/src/fdt.rs', 'core/src/smbios.rs', 'core/src/fw_cfg.rs', 'core/src/virtio.rs', 'core/src/boot.rs', 'core/src/snapshot.rs',
];

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

/** The key of `shape`'s fixture: what its boot made of the machine (above). */
export function fixtureKey(shape: Shape) {
  const disk = join(ROOT, shape.disk ?? '/target/images/debian/disk.qcow2');
  const inputs = join(disk, '../.inputs');
  const image = existsSync(inputs) ? readFileSync(inputs, 'utf8').trim() : `${statSync(disk).size}@${statSync(disk).mtimeMs}`;
  const version = /pub const VERSION: u32 = (\d+);/.exec(readFileSync(join(ROOT, 'core/src/snapshot.rs'), 'utf8'))?.[1];
  const abi = /export const ABI = (\d+);/.exec(readFileSync(join(ROOT, 'web/vm.ts'), 'utf8'))?.[1];
  // The guest's Linux caches MIDR_EL1 at boot (/proc/cpuinfo); the rest of sys.rs changes too often to key on.
  const midr = /const MIDR: u64 = (\w+);/.exec(readFileSync(join(ROOT, 'core/src/interp/sys.rs'), 'utf8'))?.[1];
  return sha(JSON.stringify({
    shape, image, version, abi, midr,
    edk2: sha(readFileSync(join(ROOT, 'target/images/edk2/QEMU_EFI.fd'))),
    sources: SOURCES.map((f) => sha(readFileSync(join(ROOT, f)))),
  })).slice(0, 16);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Runs `f` holding `lock` (a directory with the holder's pid; a dead holder's is taken over). */
async function locked<T>(lock: string, f: () => Promise<T>, ms = 15 * 60_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, 'pid'), String(process.pid));
      break;
    } catch {
      let pid = 0;
      try { pid = Number(readFileSync(join(lock, 'pid'), 'utf8')); } catch { /* being made or removed */ }
      if (pid && !alive(pid)) rmSync(lock, { recursive: true, force: true });
      if (Date.now() > until) throw new Error(`waited ${ms / 1000} s for ${lock} (held by pid ${pid})`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  try {
    return await f();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * The fixture file `file` (`debian-booted-<family>-<key>.waarm64snap` in target/ci/), made by `make(path)` if it's
 * missing, in a Debian slot; the family's files of other keys are removed after.
 */
async function fixture(family: string, key: string, make: (path: string) => Promise<void>): Promise<string> {
  const file = `debian-booted-${family}-${key}.waarm64snap`;
  const path = join(DIR, file);
  mkdirSync(DIR, { recursive: true });
  await locked(join(DIR, `debian-booted-${family}.lock`), async () => {
    if (existsSync(path)) return;
    const t0 = Date.now();
    await withDebianLock(() => make(`${path}.new`));
    renameSync(`${path}.new`, path);
    // The family's files of other keys go (its `.new` is renamed first: it shares the prefix).
    for (const old of readdirSync(DIR)) if (old.startsWith(`debian-booted-${family}-`) && old !== file) rmSync(join(DIR, old), { force: true });
    console.log(`# made the booted-Debian fixture ${file} (${(statSync(path).size / 2 ** 20).toFixed(0)} MiB) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  });
  return path;
}

/**
 * The fixture of `name`'s shape, made first if it's missing or its key moved: its path on the test server
 * (`restore=` for the harness pages), or '' with WAARM64_DEBIAN_FIXTURES=0 (the test boots). `base` is the server
 * (tools/serve.ts) serving the repository.
 */
export async function debianFixture(browser: Browser, base: string, name: keyof typeof SHAPES): Promise<string> {
  if (process.env.WAARM64_DEBIAN_FIXTURES === '0') return '';
  const shape: Shape = SHAPES[name];
  const path = await fixture(name, fixtureKey(shape), async (to) => {
    const ctx = await browser.newContext({ acceptDownloads: true });
    try {
      const page = await ctx.newPage();
      await page.goto(`${base}/tests/browser/fixture.html?${new URLSearchParams({ shape: JSON.stringify(shape) })}`);
      await shows(page, /\S+ login: /, 240_000);
      const download = page.waitForEvent('download', { timeout: 120_000 });
      await page.evaluate(() => (window as never as { harness: { save(): void } }).harness.save());
      const d = await download;
      await d.saveAs(to);
      await d.delete();
    } finally {
      await ctx.close();
    }
  });
  return `/target/ci/${path.slice(DIR.length + 1)}`;
}

/**
 * What makes the page's own machine, besides `fixtureKey`'s sources: the worker's devices and its start, and the guest
 * agent the page serves (a restored guest runs the one its boot got: a fixture of an older agent would test that one).
 */
const PAGE_SOURCES = ['web/app/worker-devices.ts', 'web/app/worker-start.ts', 'web/app/worker-header.ts', 'web/app/machine.ts', 'target/images/agent/waarm64-agent.gz'];

/** What the page's start and its stored machines make: `pageFixture`'s and `storedFixture`'s key. */
const pageSources = () => PAGE_SOURCES.map((f) => (existsSync(join(ROOT, f)) ? sha(readFileSync(join(ROOT, f))) : ''));

/** A stored machine's records (IndexedDB `machines` and `disks`: web/app/shape.ts), as a test puts them. */
export type StoredRecords = { machine: { id: string; attachments: { id: string; disk: string }[] } & Record<string, unknown>; disks: ({ id: string } & Record<string, unknown>)[] };

/** An id as `newId` makes them (12 hex digits), fixed by `label`: a stored machine's shape hash takes its disks' serials (the attachments' ids). */
export const fixedId = (label: string) => sha(label).slice(0, 12);

/** The record of a URL disk of the test server's file `path` (`/target/images/…`), under `id`. */
export function urlDisk(id: string, path: string, name = path.slice(path.lastIndexOf('/') + 1)) {
  const file = join(ROOT, path);
  const head = Buffer.alloc(32);
  const fd = openSync(file, 'r');
  try { readSync(fd, head, 0, 32, 0); } finally { closeSync(fd); }
  const size = head.readUInt32BE(0) === 0x514649fb ? Number(head.readBigUInt64BE(24)) : statSync(file).size; // a qcow2's virtual size
  return { id, kind: 'url', name, size, url: path, identity: { kind: 'url', path, bytes: statSync(file).size }, created: 0 };
}

/** Puts `r`'s records into the page's store (a page of the web app, any machine). */
export const putStored = (page: Page, r: StoredRecords) => page.evaluate(async (r) => {
  const { Store } = await import('/web/app/store.ts' as string);
  const store = await Store.open();
  try {
    const now = Date.now();
    for (const d of r.disks) await store.put('disks', { created: now, ...d });
    await store.put('machines', { created: now, modified: now, ...r.machine });
  } finally {
    store.close();
  }
}, r);

/**
 * A stored machine at its serial login prompt, `r`'s records (fixed ids: `fixedId`) opened with `query`
 * (web/app/?<query>&m=<id>: the address's devices are in the shape too), its kept snapshot downloaded from the Snapshots
 * tab: its local path, or '' with WAARM64_DEBIAN_FIXTURES=0. A test loads it with Load snapshot › From a file
 * (`loadSnapshotFile`) while its machine of the same records and query boots, answering the question whether to keep
 * the overlay written since with Replace (`replacesFixture`), so the machine keeps its one overlay.
 */
export async function storedFixture(browser: Browser, base: string, r: StoredRecords, query: string): Promise<string> {
  if (process.env.WAARM64_DEBIAN_FIXTURES === '0') return '';
  const disk = r.disks.find((d) => d.kind === 'url')?.url as string | undefined;
  const key = sha(JSON.stringify([fixtureKey({ disk }), r, query, pageSources(), sha(readFileSync(join(ROOT, 'web/app/shape.ts')))])).slice(0, 16);
  return fixture(`stored-${sha(JSON.stringify([r, query])).slice(0, 8)}`, key, async (to) => {
    const ctx = await browser.newContext({ acceptDownloads: true });
    try {
      const page = await ctx.newPage();
      await page.goto(`${base}/web/app/?${PAGE_QUERY}view=terminal`);
      await putStored(page, r);
      await page.goto(`${base}/web/app/?${query}&m=${r.machine.id}`);
      await page.waitForFunction(() => /\S+ login: /.test(document.querySelector('.xterm-rows')?.textContent ?? ''), null, { timeout: 300_000, polling: 250 });
      await page.locator('#save-snapshot').click();
      await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('message-text')?.textContent ?? ''), words('snapshots:snapshot-actions.kept', {}, { start: true }).source, { timeout: 120_000, polling: 250 });
      await page.locator('#machines-open').click();
      await page.locator('.machines [data-tab=snapshots]').click();
      const download = page.waitForEvent('download', { timeout: 120_000 });
      await page.locator('.machines [data-snapshot]').first().getByRole('button', { name: t('snapshots:Snapshots.download') }).click();
      const d = await download;
      await d.saveAs(to);
      await d.delete();
    } finally {
      await ctx.close();
    }
  });
}

/** The tests' stored machines on the tests' Debian (fixed ids, so one fixture fits any profile), opened with `STORED_QUERY`. */
export const STORED = {
  /** page-usb-guest, page-usb-gamepad: the USB controller, no network. */
  usb: () => machine('usb', { name: 'USB machine', network: false, usb: true }),
  /** page-incognito: one adapter. */
  net: () => machine('net', { name: 'Incognito', network: true }),
  /** page-snapshots: one adapter, the Debian disk and a 64 MiB ramdisk. */
  ramdisk: () => machine('ramdisk', { name: 'Snappy', network: true }, [ramdisk(fixedId('ramdisk-ram'), 64 << 20)]),
  /**
   * page-folders: shared folders and no adapter, on `image` (the tests' Debian, or debian-tools'). The folders aren't in
   * the shape: the test attaches its own (`folders`) to the records the fixture was made without.
   */
  shares: (image = '/target/images/debian/disk.qcow2') => machine(`shares-${image}`, { name: 'Debian', adapters: [], shares: true }, [], image),
  /** page-machines: one adapter; the Debian disk, a 256 MiB blank disk, a 128 MiB ramdisk, EDK2's file read-only, a 64 MiB swap ramdisk. */
  five: () => machine('five', { name: 'Test machine', network: true }, [
    blank(fixedId('five-blank'), 256 << 20),
    ramdisk(fixedId('five-ram'), 128 << 20),
    urlDisk(fixedId('five-ro'), '/target/images/edk2/QEMU_EFI.fd'),
    ramdisk(fixedId('five-swap'), 64 << 20, 'Swap'),
  ], undefined, { 3: { readOnly: true }, 4: { swap: true } }),
};
/** `STORED`'s address (the shape takes `display=simple`), with the tests' credentials. */
export const STORED_QUERY = `${PAGE_QUERY}view=terminal&display=simple&${credentialsQuery()}`;

/** A ramdisk's record. */
const ramdisk = (id: string, bytes: number, name = 'Ramdisk') => ({ id, kind: 'ramdisk', name, size: bytes, identity: { kind: 'ramdisk', id, bytes }, created: 0 }); // i18n-ignore: a name the test gives

/** A blank disk's record. */
const blank = (id: string, bytes: number) => ({ id, kind: 'blank', name: 'Blank', size: bytes, identity: { kind: 'blank', id, bytes }, created: 0 }); // i18n-ignore: a name the test gives

/**
 * Stored machine `label` (2 vCPUs, 1 GiB, 2D): `image` (the tests' Debian) first, then `more`'s disks, each attached
 * writable unless `attach` (by the disk's index) says more.
 */
function machine(label: string, fields: Record<string, unknown>, more: StoredRecords['disks'] = [], image = '/target/images/debian/disk.qcow2', attach: Record<number, { readOnly?: boolean; swap?: boolean }> = {}): StoredRecords {
  const disks = [urlDisk(fixedId(`${label}-disk`), image), ...more];
  return {
    disks,
    machine: { id: fixedId(`${label}-machine`), ncpus: 2, ramMiB: 1024, display: '2d', ...fields, attachments: disks.map((d, i) => ({ id: fixedId(`${label}-attachment-${i}`), disk: d.id, readOnly: false, ...attach[i] })) },
  };
}

/** Whether `q` asks whether to keep the overlay written since a snapshot: a fixture's load answers Replace (false). */
export const replacesFixture = (q: Question) => q.kind === 'confirm' && [1, 2].some((count) => words('snapshots:snapshot-restore.restore.keep', { count }).test(q.text));

/**
 * The page's own transient machine of `query` (web/app/?<query>, the tests' `PAGE_QUERY` and `unattendedQuery()`
 * in it, or a `disk=` of its own) at its serial login prompt, saved with the page's Snapshot: its local path, for Load snapshot
 * (bench/snapshot-start.ts `loadSnapshotFile`), or '' with WAARM64_DEBIAN_FIXTURES=0. A page loads it only into a
 * machine of the same query (the machine's name, its disk and its devices: web/app/worker-header.ts).
 */
export async function pageFixture(browser: Browser, base: string, query: string): Promise<string> {
  if (process.env.WAARM64_DEBIAN_FIXTURES === '0') return '';
  const disk = new URLSearchParams(query).get('disk') ?? undefined; // the query's disk (a `?disk=` URL machine), else the tests' Debian
  const key = sha(JSON.stringify([fixtureKey({ disk }), query, pageSources()])).slice(0, 16);
  return fixture(`page-${sha(query).slice(0, 8)}`, key, async (to) => {
    const ctx = await browser.newContext({ acceptDownloads: true });
    try {
      const page = await ctx.newPage();
      await page.addInitScript(() => { (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = undefined; }); // a download
      await page.goto(`${base}/web/app/?${query}`);
      await page.waitForFunction(() => /\S+ login: /.test(document.querySelector('.xterm-rows')?.textContent ?? ''), null, { timeout: 300_000, polling: 250 });
      const download = page.waitForEvent('download', { timeout: 120_000 });
      await page.locator('#save-snapshot').click();
      const d = await download;
      await d.saveAs(to);
      await d.delete();
    } finally {
      await ctx.close();
    }
  });
}
