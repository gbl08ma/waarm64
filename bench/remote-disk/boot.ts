// A desktop boot from a disk on a server (docs/plans/remote-disks.md R0): the Arch desktop guest's qcow2 opened by its
// URL on the page (`?disk=`, `?iostats`), timed from the page's start to the serial login prompt, to the user's
// session on the screen, to sway's socket, and to Firefox's window; with the disk's base reads (count, sizes, bytes,
// time, the trace) at each mark, and the local server's request log. One JSON file a run.
//   node bench/remote-disk/boot.ts <label> <disk> [out.json]
// <disk>: a URL, or `local:<prefix>` for target/images/remote/desktop.qcow2 on bench/remote-disk/server.ts with its
// path prefix (`local:/d47/r20`: 47 ms a request, 20 MB/s; `local:` alone: neither).
// Env: NCPUS (4), RAM (2560 MiB), GPU (virgl), STOP (`firefox`, or `login`/`sway` to stop earlier).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { GUEST_USER, openSession } from '../gpu/guest-session.ts';
import { diskServer } from './server.ts';

const [label, disk, outArg] = process.argv.slice(2);
if (!label || !disk) throw new Error('usage: node bench/remote-disk/boot.ts <label> <disk URL | local:<prefix>> [out.json]');
const out = outArg ?? new URL(`../results/local/remote-disk/${label}.json`, import.meta.url).pathname;
mkdirSync(dirname(out), { recursive: true });
const STOP = process.env.STOP ?? 'firefox';

const local = disk.startsWith('local:') ? await diskServer(new URL('../../target/images/remote/', import.meta.url).pathname) : undefined;
const diskUrl = local ? `${local.url}${disk.slice(6)}/desktop.qcow2` : disk;

type Stats = Record<string, { trace: number[]; stages: Record<string, { n: number; ms: number; bytes: number }> }>;
const s = await openSession({ gpu: process.env.GPU ?? 'virgl', image: '', diskUrl, out: dirname(out), query: 'iostats', noWait: true, ncpus: Number(process.env.NCPUS ?? 4), ramMiB: Number(process.env.RAM ?? 2560) });
const { page, log } = s;
const now = () => page.evaluate(() => performance.timeOrigin + performance.now());
const origin = await page.evaluate(() => performance.timeOrigin);
const marks: Record<string, number> = {};
const mark = async (name: string) => { marks[name] = (await now()) - origin; log(name, (marks[name] / 1000).toFixed(1), 's'); };
const result: Record<string, unknown> = { label, disk: diskUrl, gl: s.gl, marks };
const serial = () => page.evaluate(() => (window as unknown as { __serialLog?: () => string }).__serialLog?.() ?? '');
try {
  // The boot loader's menu (the firmware read before it), systemd's start (the kernel is quiet: the loader read the
  // kernel and initramfs before it), then the serial getty's prompt.
  for (const [name, re] of [['loader', /Boot in \d/], ['init', /comm=systemd;type=boot|Welcome to/]] as const) {
    for (let i = 0; i < 3000 && !re.test(await serial()); i++) await page.waitForTimeout(400);
    await mark(name);
  }
  await page.waitForFunction(() => document.body.dataset.state === 'running', null, { timeout: 1_200_000, polling: 200 });
  await mark('login');
  await s.rootShell();
  if (STOP !== 'login') {
    // The user's session on the screen: the name, then the password once getty asked for it (a fixed wait: the screen
    // has no text to read), then until the user's shell runs.
    await s.onScreen(`${GUEST_USER}\n`);
    await page.waitForTimeout(3000);
    await s.onScreen(`${GUEST_USER}\n`);
    for (let i = 0; i < 600 && (await s.run(`pgrep -u ${GUEST_USER} -x bash | wc -l`)).trim() === '0'; i++) await page.waitForTimeout(1000);
    await mark('session');
    await s.onScreen('WLR_RENDERER=gles2 sway 2>/tmp/sway.log\n');
    for (let i = 0; i < 600 && (await s.run('ls /run/user/1000/ | grep -c sway-ipc')).trim() !== '1'; i++) await page.waitForTimeout(1000);
    await mark('sway');
  }
  if (STOP === 'firefox') {
    // Started through sway's IPC (again until a firefox process runs: sway may not take commands at once), then until
    // its window is in sway's tree.
    const execs: string[] = [];
    for (let i = 0; i < 30; i++) {
      execs.push(await s.run(s.asUser("swaymsg exec 'firefox about:blank > /tmp/ff.log 2>&1' 2>&1")));
      for (let k = 0; k < 10 && (await s.run('pgrep -x firefox | wc -l')).trim() === '0'; k++) await page.waitForTimeout(1000);
      if ((await s.run('pgrep -x firefox | wc -l')).trim() !== '0') break;
    }
    result.execs = execs;
    for (let i = 0; i < 900 && !(Number((await s.run(s.asUser('swaymsg -t get_tree | grep -c app_id.:..firefox'))).trim()) > 0); i++) await page.waitForTimeout(1000);
    await mark('firefox');
    // Its first paint: about:blank is white, so most of the screen turns bright (the page decodes its own screenshot).
    const bright = async () => {
      const png = (await page.locator('#screen').screenshot()).toString('base64');
      return page.evaluate(async (b64) => {
        const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]));
        const c = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')!;
        c.drawImage(bmp, 0, 0);
        const px = c.getImageData(0, 0, bmp.width, bmp.height).data;
        let n = 0;
        for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 600) n++;
        return n / (px.length / 4);
      }, png);
    };
    let painted = false;
    for (let i = 0; i < 400 && !(painted = (await bright()) >= 0.5); i++) await page.waitForTimeout(500);
    if (painted) await mark('painted');
    else result.diag = await s.runLines('(pgrep -a firefox | cut -c1-150; tail -n 30 /tmp/ff.log; dmesg | tail -n 15; free -m; uptime)');
    await page.locator('#screen').screenshot({ path: out.replace(/\.json$/, '.png') });
  }
  result.status = await page.evaluate(() => (window as unknown as { __status?: unknown }).__status);
  // What the boot's units cost (a fresh overlay is the image's first boot: its update jobs run).
  if (process.env.BLAME) result.blame = await s.runLines('systemd-analyze blame | head -12');
} catch (e) {
  result.error = String(e);
  log('failed', String(e).slice(0, 500));
} finally {
  const stats = await page.evaluate(() => (window as unknown as { __ioStats?: () => Promise<unknown> }).__ioStats?.()) as Stats | undefined;
  // The boot disk's (the one device with a trace that read anything), its trace relative to the page's start.
  const dev = Object.values(stats ?? {}).find((d) => d.trace.length);
  if (dev) {
    const t: number[] = [];
    for (let i = 0; i < dev.trace.length; i += 4) t.push(+(dev.trace[i] - origin).toFixed(1), dev.trace[i + 1], dev.trace[i + 2], dev.trace[i + 3]);
    result.io = { ...dev, trace: t };
  }
  if (local) result.server = local.log.map((r) => ({ ...r, t: +(r.t - origin).toFixed(1), ms: +r.ms.toFixed(2) }));
  writeFileSync(out, JSON.stringify(result));
  log('wrote', out);
  await s.close();
  await local?.close();
}
