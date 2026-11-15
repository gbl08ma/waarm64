// Ad-hoc: the desktop snapshot loaded on the page, then saved N times (the download path); each save's phases.
//   WAARM64_DOWNLOADS=<dir> node probe-save.ts <file.waarm64snap> [saves=2] [settleS=20]
import { openSession } from '../gpu/guest-session.ts';

const [file, n = '2', settle = '20'] = process.argv.slice(2);
const s = await openSession({ gpu: 'virgl', image: 'target/archarm/desktop.qcow2', out: new URL('../results/local/snapz-probe/', import.meta.url).pathname, disk2: '/target/ffpages/pages.ext4', snapshot: file });
console.log('restored', JSON.stringify(s.restored));
const { page } = s;
for (let k = 0; k < +n; k++) {
  await new Promise((r) => setTimeout(r, +settle * 1000));
  const before = await page.evaluate(() => document.getElementById('message')?.dataset.snapshot ?? '');
  const download = page.waitForEvent('download', { timeout: 600_000 });
  const t0 = performance.now();
  await page.locator('#save-snapshot').click();
  await page.waitForFunction((b) => (document.getElementById('message')?.dataset.snapshot ?? '') !== b, before, { timeout: 300_000, polling: 50 });
  const wallMs = Math.round(performance.now() - t0);
  const d = await download;
  await d.delete();
  const snap = JSON.parse(await page.evaluate(() => document.getElementById('message')!.dataset.snapshot!));
  for (const [k2, v] of Object.entries(snap.phases ?? {})) snap.phases[k2] = Math.round(v as number);
  console.log('save', k, JSON.stringify({ wallMs, ...snap }));
}
await s.close();
process.exit(0);
