// The inflate pool's A/B on the page (bench/io/REPORT.md): Debian's published qcow2 booted on the
// page (`?machine=debian`, served over HTTP) to its login prompt, imported as a stored disk, and exported whole
// (qcow2, uncompressed, into OPFS), timed; one JSON line. The A/B set inflatePool's default size by hand between runs.
//   node bench/io/inflate-page.ts <label> [boot,import,export]
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';
import { credentialsQuery } from '../../tests/debian-unattended.ts';
import { answerAsks } from '../../tests/page-ask.ts';

const label = process.argv[2];
const what = (process.argv[3] ?? 'boot,import,export').split(',');
const TMP = new URL('../../target/bench/', import.meta.url).pathname; // a profile with a stored Debian in it (~1 GB): not /tmp, which is RAM
const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const out: Record<string, unknown> = { label };
mkdirSync(TMP, { recursive: true });
const profile = mkdtempSync(join(TMP, 'profile-'));
const context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
try {
  const page = context.pages()[0] ?? await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  if (what.includes('boot')) {
    const t0 = Date.now();
    await page.goto(`${base}/web/app/?machine=debian&view=terminal&display=simple&${credentialsQuery()}`);
    await page.waitForFunction(() => ['running', 'failed', 'crashed'].includes(document.body.dataset.state!), null, { timeout: 240_000, polling: 100 });
    out.state = await page.evaluate(() => document.body.dataset.state);
    out.boot_ms = Date.now() - t0;
    out.ncpus = await page.evaluate(() => navigator.hardwareConcurrency);
  }
  await page.goto(`${base}/web/app/?view=terminal`);
  if (what.includes('import')) {
    out.import_ms = await page.evaluate(async () => {
      const { Store } = await import('/web/app/store.ts' as string);
      const disks = await import('/web/app/disks.ts' as string);
      const file = new File([await (await fetch('/target/images/debian/disk.qcow2')).blob()], 'debian.qcow2');
      const store = await Store.open();
      try {
        const t0 = performance.now();
        await disks.importStored(store, file);
        return performance.now() - t0;
      } finally {
        store.close();
      }
    });
  }
  if (what.includes('export')) {
    out.export_ms = await page.evaluate(async () => {
      const { runExport } = await import('/web/app/export.ts' as string);
      const handle = await (await navigator.storage.getDirectory()).getFileHandle('export.qcow2', { create: true });
      const t0 = performance.now();
      await runExport({ mode: 'qcow2', compress: false, disk: { source: { url: '/target/images/debian/disk.qcow2' } }, baseName: 'debian.qcow2', handle }, () => {});
      return performance.now() - t0;
    });
  }
  out.errors = errors;
} finally {
  await context.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
console.log(JSON.stringify(out));
