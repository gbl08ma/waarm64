// Booted-Debian fixtures (docs/testing.md "Booted-Debian fixtures"): a snapshot of the harness's Debian
// (tests/browser/tailnet-worker.ts) at its login prompt, made once per shape and key and kept in target/ci/, which the
// tests that need Debian but not its boot start from instead of booting (~1 s against ~50 s). The shape is what the
// worker builds the machine from (the card's credential, the cards and their backends, the disk); the key, what the
// boot made of it: the image (its `.inputs` key, or the file's size and time), EDK2, the core's snapshot format and ABI,
// and the sources that say what the machine is and what it is given at boot (the DT, SMBIOS, fw_cfg, virtio, the
// credentials). A file whose key moved is made again; parallel test files wait for one maker (a lock directory beside
// the file, as tests/debian-lock.ts's). WAARM64_DEBIAN_FIXTURES=0 boots instead.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { withDebianLock } from './debian-lock.ts';
import { shows } from './serial-console.ts';

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
  return sha(JSON.stringify({
    shape, image, version, abi,
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

/** What makes the page's own machine, besides `fixtureKey`'s sources: the worker's devices and its start. */
const PAGE_SOURCES = ['web/app/worker-devices.ts', 'web/app/worker-start.ts', 'web/app/worker-header.ts', 'web/app/machine.ts'];

/**
 * The page's own transient machine of `query` (web/app/?<query>, the tests' `PAGE_QUERY` and `unattendedQuery()`
 * in it) at its serial login prompt, saved with the page's Snapshot: its local path, for Load snapshot
 * (bench/snapshot-start.ts `loadSnapshotFile`), or '' with WAARM64_DEBIAN_FIXTURES=0. A page loads it only into a
 * machine of the same query (the machine's name, its disk and its devices: web/app/worker-header.ts).
 */
export async function pageFixture(browser: Browser, base: string, query: string): Promise<string> {
  if (process.env.WAARM64_DEBIAN_FIXTURES === '0') return '';
  const key = sha(JSON.stringify([fixtureKey({}), query, PAGE_SOURCES.map((f) => sha(readFileSync(join(ROOT, f))))])).slice(0, 16);
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
