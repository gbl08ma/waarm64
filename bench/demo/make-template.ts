// Makes the spike's Alpine template (bench/demo/REPORT.md "DEMO loop 1"; the real demo's build is loop 5's): the
// image chunked into a site laid out as vmdisks.tny.im's will be (bench/demo/site.ts: one shared `pieces/`), a stored
// machine made on the page (the dev server) with that image by its URL on the site, booted in a fresh profile to its
// root prompt on the serial console, a snapshot saved there, flagged as a template (tools/snapshot-template.ts) and
// chunked beside the image with the machine's definition (its disk's URL relative to it):
//   <site>/pieces/<sha256>.bin, <site>/<name>/manifest.json, definition.json, snapshot.json, template.json (what it holds)
//   node bench/demo/make-template.ts [--image target/images/remote/alpine-spike.qcow2] [--name alpine-spike]
//     [--site bench/results/local/demo/site] [--ram 512] [--cpus 2] [--drop] [--compact] [--settle 5]
// `--drop` drops the guest's page cache before the snapshot (`echo 3 > /proc/sys/vm/drop_caches`), `--compact` that and
// compacts its memory (`echo 1 > /proc/sys/vm/compact_memory`: free memory in whole blocks the guest reports); `--settle` waits
// that many seconds at the prompt first (free page reporting hands the freed memory back: SNAPZ leaves it out).
// The image: bench/demo/spike-image.sh. Bounded: run it under `timeout 600`.
import { execFileSync } from 'node:child_process';
import { mkdirSync, openAsBlob, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Page } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';
import { chromiumEnv } from '../../tools/nosme.ts';
import { asTemplate } from '../../web/snapshot-file.ts';
import { siteServer, type Served } from './site.ts';
import { snapInfo } from './snapinfo.ts';

const { values: a } = parseArgs({
  options: {
    image: { type: 'string', default: 'target/images/remote/alpine-spike.qcow2' },
    name: { type: 'string', default: 'alpine-spike' },
    site: { type: 'string', default: 'bench/results/local/demo/site' },
    ram: { type: 'string', default: '512' },
    cpus: { type: 'string', default: '2' },
    drop: { type: 'boolean', default: false },
    compact: { type: 'boolean', default: false },
    settle: { type: 'string', default: '5' },
  },
});
const ROOT = new URL('../../', import.meta.url).pathname;
const site = resolve(ROOT, a.site!);
const dir = join(site, a.name!);
const work = join(ROOT, 'bench/results/local/demo/template-work');
const log = (...x: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...x);
const chunk = (file: string, out: string, label: string) =>
  log(execFileSync('node', [join(ROOT, 'tools/chunk-image.ts'), file, out, '2', '--name', label, '--pieces', join(site, 'pieces')], { encoding: 'utf8' }).trim());

rmSync(dir, { recursive: true, force: true });
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
chunk(resolve(ROOT, a.image!), dir, 'Alpine (DEMO spike)');

const served: Served[] = [];
const disks = await siteServer(site, served, () => 'site');
const page0 = await startServer();
const base = `http://127.0.0.1:${(page0.address() as { port: number }).port}`;
const ctx = await chromium.launchPersistentContext(join(work, 'profile'), {
  executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
  headless: true,
  env: chromiumEnv(),
  acceptDownloads: true,
  downloadsPath: work,
});
const text = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
const until = async (page: Page, re: RegExp, ms: number) => {
  const end = Date.now() + ms;
  while (!re.test(await text(page))) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${re}; the console: ${(await text(page)).slice(-600)}`);
    await page.waitForTimeout(250);
  }
};
const type = async (page: Page, s: string) => {
  await page.locator('.xterm').click();
  await page.keyboard.type(s, { delay: 10 });
};
try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on('pageerror', (e) => log('[page error]', e.message.slice(0, 300)));
  await page.addInitScript(() => {
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = undefined; // a download, not a picker
  });
  await page.goto(`${base}/web/app/?clocksync=0`);
  const url = `${disks.base}/${a.name}/manifest.json`;
  const id = await page.evaluate(
    async ([url, ram, cpus]) => {
      const { Store } = await import('/web/app/store.ts' as string);
      const { createMachine, createDisk, attach } = await import('/web/app/machines.ts' as string);
      const { checkUrl } = await import('/web/app/urlcheck.ts' as string);
      const store = await Store.open();
      const c = await checkUrl(url);
      if (!c.ok || !c.head) throw new Error(`the image's URL: ${JSON.stringify(c.problems)}`);
      // A qcow2's virtual size, at byte 24 of its header (big-endian).
      const v = new DataView(c.head.buffer, c.head.byteOffset);
      const size = v.getUint32(0) === 0x514649fb ? Number(v.getBigUint64(24)) : c.bytes;
      const m = await createMachine(store, { name: 'Alpine', ncpus: Number(cpus), ramMiB: Number(ram), display: '2d', network: true, usb: false, mouse: false, touch: false, shares: false });
      const d = await createDisk(store, { kind: 'url', url, name: c.name, size, bytes: c.bytes, chunked: c.chunked });
      await attach(store, m, d);
      return m.id as string;
    },
    [url, a.ram!, a.cpus!],
  );
  log('machine', id);
  await page.goto(`${base}/web/app/?clocksync=0&m=${id}&view=both`);
  // No login prompt (root is logged in) and no agent: the page's state stays `booting`; the prompt is the sign.
  const t0 = Date.now();
  await until(page, /~#\s*$/, 300_000);
  log('prompt after', Date.now() - t0, 'ms');
  if (process.env.MEMINFO) {
    await type(page, 'clear; free -k; grep -E "^(Cached|Buffers|Slab|SReclaimable|AnonPages|Shmem|KernelStack|PageTables|MemFree|Percpu|VmallocUsed)" /proc/meminfo; cat /sys/kernel/mm/transparent_hugepage/enabled 2>&1; cat /proc/cmdline\n');
    await page.waitForTimeout(3000);
    log('meminfo', (await page.evaluate(() => [...document.querySelectorAll('.xterm-rows > div')].map((r) => r.textContent?.trimEnd()).filter(Boolean).join('\n'))));
  }
  // Free memory the guest reports (virtio-balloon's free page reporting: whole 4 MiB blocks, 2 s after) is zero in the
  // snapshot; memory freed in small pieces isn't. `--compact` gathers it into whole blocks first.
  const prep = [a.drop || a.compact ? 'sync; echo 3 > /proc/sys/vm/drop_caches' : '', a.compact ? 'echo 1 > /proc/sys/vm/compact_memory' : '', 'clear'];
  await type(page, `${prep.filter(Boolean).join('; ')}\n`);
  await page.waitForTimeout(Number(a.settle) * 1000);
  await until(page, /~#\s*$/, 10_000);
  // The toolbar's Snapshot keeps it in the machine (a stored machine's), then the kept file is downloaded.
  await page.locator('#save-snapshot').click();
  const kept = (id: string) =>
    page.evaluate(async (id) => {
      const { Store } = await import('/web/app/store.ts' as string);
      return (await (await Store.open()).all('snapshots')).some((s: { machine: string }) => s.machine === id) as boolean;
    }, id);
  for (const end = Date.now() + 180_000; !(await kept(id)); await page.waitForTimeout(500))
    if (Date.now() > end) throw new Error('the snapshot was not kept');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.evaluate(async (id) => {
      const { Store, snapshotPath } = await import('/web/app/store.ts' as string);
      const { opfsDir } = await import('/web/overlay.ts' as string);
      const s = (await (await Store.open()).all('snapshots')).find((x: { machine: string }) => x.machine === id);
      const path: string = snapshotPath(id, s.id);
      const file = await (await (await opfsDir(path.slice(0, path.lastIndexOf('/')))).getFileHandle(s.id)).getFile();
      const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: 'alpine.waarm64snap' });
      document.body.append(link);
      link.click();
    }, id),
  ]);
  const plain = join(work, 'plain.waarm64snap');
  await download.saveAs(plain);
  const def = await page.evaluate(async (id) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { exportDefinition } = await import('/web/app/definitions.ts' as string);
    return exportDefinition(await Store.open(), id);
  }, id);
  // The disk's URL relative to the definition (the store's rule: docs/plans/first-demo.md §4), so the site moves whole.
  for (const d of def.disks) if (d.url) d.url = 'manifest.json';
  writeFileSync(join(dir, 'definition.json'), `${JSON.stringify(def, null, 1)}\n`);
  const template = join(work, 'template.waarm64snap');
  await writeFile(template, (await asTemplate(await openAsBlob(plain))).stream());
  chunk(template, join(dir, 'snapshot.json'), 'Alpine (DEMO spike), its template');
  const info = { made: new Date().toISOString(), image: a.image, ram: Number(a.ram), cpus: Number(a.cpus), drop: a.drop, compact: a.compact, settle: Number(a.settle), snapshot: snapInfo(template), siteBytesBoot: served.reduce((n, s) => n + s.bytes, 0) };
  writeFileSync(join(dir, 'template.json'), `${JSON.stringify(info, null, 1)}\n`);
  log('template', JSON.stringify(info));
} finally {
  await ctx.close();
  await new Promise((r) => page0.close(r));
  await disks.close();
}
