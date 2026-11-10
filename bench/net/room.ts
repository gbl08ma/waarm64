// R0 (docs/plans/networking-p2p.md §7): a room's data path against the DERP path, in headless Chromium with no guest.
// Each round, in an order that alternates, three arms on fresh pages: `direct` (two members of a fresh room on the
// tailcat rig's relay, tests/browser/room.html: the first echo through the relay, then the data channel), `relay`
// (the same, the dialer relay only: everything through DERP) and `raw` (bench/net/rtc-raw.html: the same echoes over a
// bare data channel between two workers, no WireGuard). Per arm: the time to the first echo back after `Running`, the
// direct path's setup after the handshake, the RTT (one echo at a time), throughput (1,280-byte IP packets, i.e.
// 1,232-byte UDP payloads, 32 in flight, each way) and the CPU over the throughput run: every Chromium process and the
// derper (from /proc), per Mbit/s of the two directions together. Needs nothing else running.
// Usage: node bench/net/room.ts [rounds] [echoes] [out.json]
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';

const ROOT = new URL('../..', import.meta.url).pathname;
const rounds = Number(process.argv[2] ?? 3);
const n = Number(process.argv[3] ?? 10000);
const out = process.argv[4];
const script = `${ROOT}tests/net/tailcat.sh`;
const RELAY = '127.0.0.1:8444';
const PACKET = 1280;

/** CPU seconds (utime + stime) of every Chromium process and the rig's derper. */
function cpu() {
  const derper = readFileSync(`${ROOT}target/net/tailcat-test/run/derper.pid`, 'utf8').trim();
  const exe = process.env.CHROMIUM ?? '/usr/bin/chromium';
  let ticks = 0;
  for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (pid !== derper && !cmd.startsWith(exe)) continue;
      const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
      ticks += Number(f[11]) + Number(f[12]);
    } catch { /* gone */ }
  }
  return ticks / 100;
}

type Echoes = { back: number; ms: number; rtts: number[] };
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;

async function page(browser: Browser, url: string, ready: string): Promise<Page> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log(`# page error: ${e}`));
  await p.goto(url);
  await p.waitForFunction(ready, null, { timeout: 30_000, polling: 20 });
  return p;
}

async function measure(dialer: Page, to: string) {
  const small = await dialer.evaluate(`window.harness.echoes(${to}, 500, 32, 1)`) as Echoes;
  const c0 = cpu();
  const big = await dialer.evaluate(`window.harness.echoes(${to}, ${n}, ${PACKET - 48}, 32)`) as Echoes;
  const c1 = cpu();
  const mbps = big.back * PACKET * 8 / big.ms / 1000;
  return { rttMs: median(small.rtts), back: big.back, mbpsEachWay: mbps, coreMsPerMbit: (c1 - c0) * 1000 / (big.ms / 1000) / (2 * mbps) };
}

async function arm(browser: Browser, base: string, kind: 'direct' | 'relay' | 'raw') {
  if (kind === 'raw') {
    const p = await page(browser, `${base}/bench/net/rtc-raw.html`, 'window.harness');
    try {
      const setupMs = await p.evaluate('window.harness.setupMs') as number;
      return { setupMs, ...await measure(p, 'null') };
    } finally { await p.context().close(); }
  }
  const room = `bench ${Math.random()}`;
  const url = (q: Record<string, string>) => `${base}/tests/browser/room.html?${new URLSearchParams({ room, relay: RELAY, ...q })}`;
  const running = 'window.harness?.room().state === "Running"';
  const b = await page(browser, url({}), running);
  try {
    const bs = await b.evaluate('window.harness.room().self') as { key: string; address6: number[] };
    const a = await page(browser, url({ peer: bs.key, ...(kind === 'relay' ? { relayOnly: '1' } : {}) }), running);
    try {
      const to = JSON.stringify(bs.address6);
      const firstMs = await a.evaluate(`window.harness.first(${to})`) as number;
      let directMs: number | undefined;
      if (kind === 'direct') {
        await a.waitForFunction(`window.harness.room().peers.some((p) => p.path === 'direct')`, null, { timeout: 15_000, polling: 10 });
        const ev = await a.evaluate('window.harness.events()') as { ms: number; type: string; path?: string }[];
        directMs = ev.find((e) => e.type === 'path' && e.path === 'direct')!.ms - ev.find((e) => e.type === 'peer')!.ms;
        const left = await a.evaluate(`window.harness.room().peers[0].path`);
        if (left !== 'direct') throw new Error('the path left direct');
      } else {
        await a.evaluate(`window.harness.echoes(${to}, 20, 32, 1)`);
      }
      const m = await measure(a, to);
      const path = await a.evaluate(`window.harness.room().peers[0].path`);
      if (path !== (kind === 'direct' ? 'direct' : 'relay')) throw new Error(`${kind}: the path was ${path} at the end`);
      return { firstMs, directMs, ...m };
    } finally { await a.context().close(); }
  } finally { await b.context().close(); }
}

execFileSync(script, ['up'], { encoding: 'utf8', timeout: 300_000 });
const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
const results: Record<string, unknown>[] = [];
try {
  const arms = ['direct', 'relay', 'raw'] as const;
  for (let r = 0; r < rounds; r++) {
    const order = r % 2 ? [...arms].reverse() : arms;
    for (const kind of order) {
      const row = { round: r, arm: kind, ...await arm(browser, base, kind) };
      results.push(row);
      console.log(JSON.stringify(row));
    }
  }
} finally {
  const version = browser.version();
  await browser.close();
  server.close();
  spawnSync(script, ['down']);
  if (out) {
    writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), chromium: version, host: `${process.platform} ${process.arch}`, cpus: (await import('node:os')).cpus().length, rounds, echoes: n, packet: PACKET, results }, null, 2) + '\n');
  }
}
