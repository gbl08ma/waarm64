// Bulk transfers through tailcat (bench/net/REPORT.md "Batches"): the page's Debian on tests/net-tailcat.test.ts's rig,
// 8 MB down and 8 MB up over IPv4, two rounds; for each transfer the wall time, the guest's busy CPU time (/proc/stat,
// all CPUs: user+nice+system+irq+softirq) and its interface's packet counts. One boot per run. With a page that logs
// `tsbatch rx {…} tx {…}` (packets for the guest and WebSocket sends per pump, web/ts-client.ts) and `netbatch deliver
// {…}` (frames per virtio-net delivery, web/devices.ts) histograms, it records their difference over each transfer:
// those counters aren't in the tree (the report says what they counted).
// Usage: node bench/net/transfer.ts <label> <out.json>
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { chromium } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';
import { withDebianLock } from '../../tests/debian-lock.ts';
import { loginRoot, run as runIn } from '../../tests/serial-console.ts';

const [label, out] = process.argv.slice(2);
const ROOT = new URL('../../', import.meta.url).pathname;
const script = `${ROOT}tests/net/tailcat.sh`;
const SIZE = 8 << 20;
const v4 = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)!.address;
const env = Object.fromEntries(execFileSync(script, ['up'], { encoding: 'utf8', timeout: 300_000 }).trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
const big = Buffer.alloc(SIZE, 'x');
const http = createServer((req, res) => {
  if (req.url === '/small') return res.end('x');
  if (req.url !== '/up') return res.end(big);
  const h = createHash('sha256');
  let n = 0;
  req.on('data', (d: Buffer) => { h.update(d); n += d.length; });
  req.on('end', () => res.end(`${n} ${h.digest('hex')}\n`));
});
await new Promise<void>((resolve) => http.listen(0, '::', resolve));
const port = (http.address() as { port: number }).port;
const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
const results: Record<string, number>[] = [];
try {
  await withDebianLock(async () => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    // The TEMP batching histograms (web/ts-client.ts `tsbatch`, web/devices.ts `netbatch`): the latest of each.
    const latest: Record<string, Record<string, number>> = {};
    page.on('console', (m) => {
      const t = m.text();
      let g = /^tsbatch rx (\{.*\}) tx (\{.*\})$/.exec(t);
      if (g) { latest.rx = JSON.parse(g[1]); latest.tx = JSON.parse(g[2]); }
      g = /^netbatch deliver (\{.*\})$/.exec(t);
      if (g) latest.deliver = JSON.parse(g[1]);
    });
    const snap = () => JSON.parse(JSON.stringify(latest)) as typeof latest;
    const diff = (a: typeof latest, b: typeof latest) => Object.fromEntries(['rx', 'tx', 'deliver'].map((k) => {
      const d: Record<string, number> = {};
      for (const [n, c] of Object.entries(b[k] ?? {})) if (c - (a[k]?.[n] ?? 0)) d[n] = c - (a[k]?.[n] ?? 0);
      return [k, d];
    }));
    await page.goto(`${base}/tests/browser/core.html`);
    await page.evaluate(async () => (await navigator.storage.getDirectory()).removeEntry('waarm64-offload-ab', { recursive: true }).catch(() => {}));
    await page.goto(`${base}/tests/browser/tailnet.html?${new URLSearchParams({ tailcat: env.WAARM64_TAILCAT_ADDR, overlay: 'waarm64-offload-ab' })}`);
    await page.waitForFunction('window.harness?.tailscale().state === "Running"', null, { timeout: 60_000, polling: 250 });
    const run = (cmd: string, ms = 120_000) => runIn(page, cmd, ms, async () => '');
    await loginRoot(page, 240_000, async () => '');
    await run("mkdir -p /run/systemd/network && printf '[Match]\\nName=e*\\n[Network]\\nDHCP=yes\\n' > /run/systemd/network/20-eth.network");
    await run('systemctl start systemd-networkd');
    for (let k = 0; k < 40 && !(await run("ip -4 -o addr show scope global")).trim(); k++) await page.waitForTimeout(1000);
    console.log(`# ${label}: ${(await run('cat /sys/bus/virtio/drivers/virtio_net/virtio*/features')).trim()}`);
    await run(`head -c ${SIZE} /dev/urandom > /tmp/up`);
    const stat = async () => {
      const [cpu, tx, rx] = (await run("head -1 /proc/stat; cat /sys/class/net/eth0/statistics/tx_packets /sys/class/net/eth0/statistics/rx_packets")).trim().split('\n');
      const f = cpu.trim().split(/\s+/).slice(1).map(Number);
      return { busy: (f[0] + f[1] + f[2] + f[5] + f[6]) / 100, tx: Number(tx), rx: Number(rx) };
    };
    for (let round = 0; round < 2; round++) {
      for (const dir of ['down', 'up'] as const) {
        const a = await stat();
        const h0 = snap();
        const t0 = performance.now();
        const got = (await run(dir === 'down' ? `curl -s -m 100 -o /dev/null -w '%{size_download}' http://${v4}:${port}/big` : `curl -s -m 100 --data-binary @/tmp/up http://${v4}:${port}/up`)).trim();
        const wall = (performance.now() - t0) / 1000;
        const b = await stat();
        await page.waitForTimeout(300);
        await run(`curl -s -m 10 -o /dev/null http://${v4}:${port}/small`);
        await page.waitForTimeout(300);
        const hist = diff(h0, snap());
        console.log(`# ${label} ${dir} ${round} batches: ${JSON.stringify(hist)}`);
        const r = { round, up: dir === 'up' ? 1 : 0, wall, guestCpu: b.busy - a.busy, tx: b.tx - a.tx, rx: b.rx - a.rx, mbit: SIZE * 8 / wall / 1e6 };
        console.log(`# ${label} ${dir} ${round}: ${got.slice(0, 20)} ${JSON.stringify(r)}`);
        results.push({ ...r, hist } as never);
      }
    }
    await ctx.close();
  });
} finally {
  writeFileSync(out, JSON.stringify({ label, size: SIZE, chromium: browser.version(), results }, null, 1));
  await browser.close();
  server.close();
  http.close();
  spawnSync(script, ['down']);
}
