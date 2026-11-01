// The local helper against tailcat (docs/plans/networking-local.md L0, bench/net/REPORT.md "The local helper"): the
// page's Debian on one connection, and from the guest the round trip and bulk TCP each way to a server on this machine's
// LAN address, with the CPU of the renderer's threads over each transfer. One boot per arm.
//   local        the helper here, frames over a WebSocket on loopback (tests/browser/netguest.html?ws=)
//   tailcat      an exit node here through tests/net/tailcat.sh's derper on 127.0.0.1 (what the relay costs apart from its distance)
//   public       an exit node here through tailcat's public relays
// Usage: node bench/net/local.ts <out.json> <arm>[:<helper MTU>][:<client flags, comma-separated>] ... [--rounds n] [--mib n]
// Client flags (`batch`, `worker`) and an MTU past 1500 need bench/net/results/local-helper/variants.patch applied.
// (public moves a quarter of --mib: its relay is rate-limited.) (bench --out rule: <out.json> relative to the repo's root.) The guest's curl writes to /dev/null and reads from tmpfs.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces, totalmem, cpus } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';
import { withDebianLock } from '../../tests/debian-lock.ts';
import { loginRoot, run as runIn } from '../../tests/serial-console.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const argv = process.argv.slice(2);
const opt = (name: string, d: number) => {
  const k = argv.indexOf(`--${name}`);
  return k < 0 ? d : Number(argv.splice(k, 2)[1]);
};
const rounds = opt('rounds', 3);
const mib = opt('mib', 64);
const [out, ...arms] = argv;
const script = `${ROOT}tests/net/tailcat.sh`;
const v4 = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)!.address;
const payload = Buffer.alloc(1 << 20, 'x');

// A server on this machine's LAN address: /<MiB> sends that many, a POST swallows.
const http = createServer((req, res) => {
  if (req.method === 'POST') {
    req.on('data', () => {}).on('end', () => res.end('ok\n'));
    return;
  }
  let left = Number(req.url!.slice(1)) || 0;
  res.writeHead(200, { 'content-length': left << 20 });
  const more = () => {
    while (left > 0) {
      left--;
      if (!res.write(payload)) return void res.once('drain', more);
    }
    res.end();
  };
  more();
});
await new Promise<void>((r) => http.listen(0, '0.0.0.0', r));
const port = (http.address() as { port: number }).port;
const url = `http://${v4}:${port}`;

const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
const version = browser.version();

/** CPU seconds of each thread of Chromium's renderers, by thread id. `CrRendererMain` is the page's main thread. */
function threads() {
  const m = new Map<string, { comm: string; s: number }>();
  for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    let cmd: string;
    try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
    if (!cmd.includes('--type=renderer')) continue;
    for (const tid of readdirSync(`/proc/${pid}/task`)) {
      try {
        const comm = tid === pid ? 'CrRendererMain' : readFileSync(`/proc/${pid}/task/${tid}/comm`, 'utf8').trim();
        const f = readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8').split(') ')[1].split(' ');
        m.set(tid, { comm, s: (Number(f[11]) + Number(f[12])) / 100 });
      } catch { /* the thread ended */ }
    }
  }
  // The WebSocket's and the relay's socket work happens in the network service, and the helper is a process of its own.
  for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    let cmd: string;
    try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
    const comm = cmd.includes('network.mojom.NetworkService') ? 'network' : cmd.startsWith(`${ROOT}target/net/webpc-net`) ? 'helper' : undefined;
    if (!comm) continue;
    try {
      const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
      m.set(`p${pid}`, { comm, s: (Number(f[11]) + Number(f[12])) / 100 });
    } catch { /* it ended */ }
  }
  return m;
}

/** What each kind of thread burned since `before`, the busiest first: the main thread, and the workers by size. */
function cpuSince(before: ReturnType<typeof threads>, wall: number) {
  const main: number[] = [];
  const workers: number[] = [];
  let other = 0;
  let network = 0;
  let helper = 0;
  for (const [tid, t] of threads()) {
    const d = t.s - (before.get(tid)?.s ?? 0);
    if (t.comm.startsWith('CrRendererMain')) main.push(d);
    else if (t.comm.startsWith('DedicatedWorker')) workers.push(d);
    else if (t.comm === 'network') network += d;
    else if (t.comm === 'helper') helper += d;
    else other += d;
  }
  const r = (x: number) => Math.round(x / wall * 1000) / 1000;
  return { main: r(Math.max(0, ...main)), workers: workers.filter((w) => w > 0.01 * wall).sort((a, b) => b - a).map(r), other: r(other), network: r(network), helper: r(helper) };
}

/** A tailcat exit node through the public relays, on its own key. */
async function publicExit() {
  const bin = `${ROOT}target/net/tailcat-test/bin/tailcat`;
  const dir = `${ROOT}target/net/tailcat-public`;
  mkdirSync(dir, { recursive: true });
  const key = join(dir, 'server.json');
  if (!existsSync(key)) execFileSync(bin, ['genkey', `--key=${key}`], { stdio: 'ignore', timeout: 60_000 });
  const child = spawn(bin, ['--verbose', 'serve', `--key=${key}`, 'exit-node'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const add = (d: Buffer) => { log += d; };
  child.stdout.on('data', add);
  child.stderr.on('data', add);
  for (let k = 0; k < 300 && !(/tc[A-Za-z0-9_-]{20,}/.test(log) && /derp-\d+ connected/.test(log)); k++) await new Promise((r) => setTimeout(r, 200));
  const addr = /tc[A-Za-z0-9_-]{20,}/.exec(log)?.[0];
  if (!addr) throw new Error(`no public exit node: ${log.slice(-800)}`);
  return { addr, child };
}

async function helper(mtu: number) {
  execFileSync('go', ['build', '-o', `${ROOT}target/net/webpc-net`, '.'], { cwd: `${ROOT}net/webpc-net`, stdio: 'inherit', timeout: 300_000 });
  const token = randomBytes(32).toString('base64url');
  const listen = 18740;
  const child = spawn(`${ROOT}target/net/webpc-net`, ['--listen', `127.0.0.1:${listen}`, '--origin', base, '--mtu', String(mtu)], { env: { ...process.env, WEBPC_NET_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  for (let k = 0; k < 100 && !log.includes('listening on'); k++) await new Promise((r) => setTimeout(r, 100));
  if (!log.includes('listening on')) throw new Error(`the helper: ${log}`);
  return { ws: `ws://127.0.0.1:${listen}/${token}`, child };
}

async function measure(page: Page, label: string, mib: number, stats?: () => Promise<Record<string, number> | undefined>) {
  const run = (cmd: string, ms = 180_000) => runIn(page, cmd, ms, async () => '');
  await loginRoot(page, 240_000, async () => '');
  // Each guest takes its lease as a user would (the card's credential, or networkd's by hand for tailcat's test page).
  await run("mkdir -p /run/systemd/network && [ -e /run/systemd/network/20-eth.network ] || printf '[Match]\\nName=e*\\n[Network]\\nDHCP=yes\\n' > /run/systemd/network/20-eth.network; systemctl start systemd-networkd");
  for (let k = 0; k < 60 && !(await run('ip -4 -o route show default')).trim(); k++) await page.waitForTimeout(1000);
  const mtu = parseInt(await run("cat /sys/class/net/$(ip -4 route show default | awk '{print $5; exit}')/mtu"));
  await run(`head -c ${mib << 20} /dev/urandom > /dev/shm/up`);
  const ping = await run(`ping -c 30 -i 0.2 -q -W 2 ${v4} | tail -2`, 60_000);
  const rtt = /= ([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(ping);
  // TCP's handshake from a guest process that's already running: curl's connect time, one at a time.
  const connects = (await run(`for i in $(seq 20); do curl -s -o /dev/null -w '%{time_connect}\\n' ${url}/0; done`, 90_000)).trim().split('\n').map((s) => Number(s) * 1000).sort((a, b) => a - b);
  const r: Record<string, unknown>[] = [];
  for (let k = 0; k < rounds; k++) {
    for (const dir of ['down', 'up'] as const) {
      const st0 = await stats?.();
      const t = threads();
      const t0 = Date.now();
      const cmd = dir === 'down' ? `curl -s -m 60 -o /dev/null -w '%{speed_download} %{size_download}\\n' ${url}/${mib}` : `curl -s -m 60 -o /dev/null -w '%{speed_upload} %{size_upload}\\n' -H 'Expect:' --data-binary @/dev/shm/up ${url}/`;
      const [speed, size] = (await run(cmd)).trim().split('\n')[0].split(' ').map(Number);
      const wall = (Date.now() - t0) / 1000;
      const cpu = cpuSince(t, wall);
      const st1 = await stats?.();
      const mbit = speed * 8 / 1e6;
      const batch = st0 && st1 ? { fromGuest: (st1.txFrames - st0.txFrames) / (st1.txMessages - st0.txMessages), toGuest: (st1.rxFrames - st0.rxFrames) / (st1.rxMessages - st0.rxMessages) } : undefined;
      r.push({ dir, mbit: Math.round(mbit * 10) / 10, bytes: size, wall, cpu, mainPerMbit: Math.round(cpu.main / mbit * 1e5) / 1e5, batch });
      console.log(`# ${label} ${dir} ${mbit.toFixed(1)} Mbit/s, main ${cpu.main} workers ${cpu.workers.join(' ')} other ${cpu.other} network ${cpu.network} helper ${cpu.helper}${batch ? ` frames/msg from ${batch.fromGuest.toFixed(2)} to ${batch.toGuest.toFixed(2)}` : ''}`);
    }
  }
  return { mtu, ping: ping.trim(), rttMs: rtt && { min: Number(rtt[1]), avg: Number(rtt[2]), max: Number(rtt[3]) }, connectMs: { min: connects[0], median: connects[connects.length >> 1], max: connects[connects.length - 1] }, transfers: r };
}

const results: Record<string, unknown>[] = [];
let failed = false;
for (const spec of arms) {
  const [arm, mtuS, flags = ''] = spec.split(':');
  const mtu = Number(mtuS) || 1500;
  const overlay = 'webpc-net-bench';
  let child: ChildProcess | undefined;
  let rig = false;
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  try {
    await withDebianLock(async () => {
      await page.goto(`${base}/tests/browser/core.html`);
      await page.evaluate(async (n) => (await navigator.storage.getDirectory()).removeEntry(n, { recursive: true }).catch(() => {}), overlay);
      if (arm === 'local') {
        const h = await helper(mtu);
        child = h.child;
        await page.goto(`${base}/tests/browser/netguest.html?${new URLSearchParams({ overlay, ws: h.ws, ...(flags ? { client: flags } : {}) })}`);
      } else {
        let addr: string;
        if (arm === 'public') {
          const e = await publicExit();
          child = e.child;
          addr = e.addr;
        } else {
          addr = Object.fromEntries(execFileSync(script, ['up'], { encoding: 'utf8', timeout: 300_000 }).trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2))).WEBPC_TAILCAT_ADDR;
          rig = true;
        }
        await page.goto(`${base}/tests/browser/tailnet.html?${new URLSearchParams({ tailcat: addr, overlay })}`);
        await page.waitForFunction('window.harness?.tailscale().state === "Running"', null, { timeout: 90_000, polling: 250 });
      }
      const stats = arm === 'local' ? () => page.evaluate('window.harness.local()?.stats') as Promise<Record<string, number>> : undefined;
      results.push({ arm: spec, mib: arm === 'public' ? mib >> 2 : mib, ...await measure(page, spec, arm === 'public' ? mib >> 2 : mib, stats) });
    });
  } catch (e) {
    failed = true;
    console.error(`# ${spec} failed: ${e instanceof Error ? e.message.slice(0, 600) : e}`);
    results.push({ arm: spec, error: String(e).slice(0, 600) });
  } finally {
    await page.evaluate(async (n) => (await navigator.storage.getDirectory()).removeEntry(n, { recursive: true }).catch(() => {}), overlay).catch(() => {});
    await ctx.close();
    child?.kill();
    if (rig) execFileSync(script, ['down']);
  }
  writeFileSync(join(ROOT, out), JSON.stringify({ date: new Date().toISOString(), host: 'dev VM (Lima, M4 Mac mini)', cpus: cpus().length, memGiB: totalmem() / 2 ** 30, chromium: version, mib, rounds, results }, null, 1));
}
await browser.close();
server.close();
http.close();
process.exit(failed ? 1 : 0);
