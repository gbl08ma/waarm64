// WebUSB's sizing (docs/usb.md "Findings", bench/usb/REPORT.md): Chromium's WebUSB in a dedicated worker against
// the dummy_hcd Gadget Zero (tests/usb/gadget.sh up zero zero-a zero-b). A sizing of what a guest can expect, not a
// benchmark: the dev VM's other work shares the CPU.
//
//   node bench/usb/run.ts [runs=5] [--out file.json]   transfers' round trips and bulk throughput, `runs` browsers
//   node bench/usb/run.ts --order [launches=5]          getDevices() order of zero-a and zero-b, worker and page
//
// The page is served on 127.0.0.1:8190, an origin tests/usb/gadget.sh install's policy grants the gadgets to.
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';
import { summarize } from '../stats.ts';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? args.splice(outAt, 2)[1] : 'bench/results/local/usb/sizing.json';
const order = args[0] === '--order';
if (order) args.shift();
const runs = Number(args[0] ?? 5);

const server = await startServer(8190);
const url = 'http://127.0.0.1:8190/bench/usb/index.html';
const exe = process.env.CHROMIUM ?? '/usr/bin/chromium';

async function withPage<T>(f: (page: import('playwright-core').Page) => Promise<T>): Promise<T> {
  const browser = await chromium.launch({ executablePath: exe });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    return await f(page);
  } finally {
    await browser.close();
  }
}

const opts = { serial: 'waarm64-zero', n: 200, sizes: [4096, 65536, 1048576], depths: [1, 4, 8], ms: 1500 };

if (order) {
  const seen: { worker: string[][]; page: string[] }[] = [];
  for (let i = 0; i < runs; i++) {
    seen.push(await withPage(async (page) => {
      const worker: string[][] = [];
      for (let k = 0; k < 3; k++) {
        const r = await page.evaluate(() => (window as any).inWorker({ type: 'list' }));
        worker.push(r.devices.filter((d: any) => d.serialNumber === null).map((d: any) => d.version));
      }
      return { worker, page: await page.evaluate(() => (window as any).onPage()) };
    }));
    console.log(JSON.stringify(seen.at(-1)));
  }
} else {
  const version = await withPage(async (page) => page.context().browser()!.version());
  const samples: any[] = [];
  for (let i = 0; i < runs; i++) {
    const r = await withPage((page) => page.evaluate((o) => (window as any).inWorker({ type: 'run', opts: o }), opts));
    samples.push(r);
    const lat = Object.fromEntries(Object.entries(r.lat as Record<string, number[]>).map(([k, v]) => [k, +summarize(v).median.toFixed(3)]));
    console.log(`run ${i + 1}: median ms ${JSON.stringify(lat)}`);
  }
  const lat: Record<string, unknown> = {};
  for (const k of Object.keys(samples[0].lat)) {
    const all = samples.flatMap((s) => s.lat[k] as number[]);
    lat[k] = { ...summarize(all), p99: [...all].sort((a, b) => a - b)[Math.floor(all.length * 0.99)], runMedians: samples.map((s) => summarize(s.lat[k]).median) };
  }
  const tput = samples[0].tput.map((t: any, j: number) => ({
    size: t.size,
    depth: t.depth,
    inMBps: summarize(samples.map((s) => s.tput[j].in / 1e6)),
    outMBps: summarize(samples.map((s) => s.tput[j].out / 1e6)),
  }));
  // The native baseline (bench/usb/native.c): the same transfers through usbfs, no browser, after the browsers closed.
  if (!existsSync('target/usb/native')) {
    mkdirSync('target/usb', { recursive: true });
    execFileSync('cc', ['-O2', '-o', 'target/usb/native', 'bench/usb/native.c']);
  }
  const sys = '/sys/bus/usb/devices';
  const at = readdirSync(sys).find((d) => {
    try { return readFileSync(`${sys}/${d}/serial`, 'utf8').trim() === opts.serial; } catch { return false; }
  });
  if (!at) throw new Error(`no host device with serial ${opts.serial}`);
  const num = (f: string) => String(Number(readFileSync(`${sys}/${at}/${f}`, 'utf8'))).padStart(3, '0');
  const native: any[] = [];
  for (let i = 0; i < runs; i++) native.push(JSON.parse(execFileSync('target/usb/native', [`/dev/bus/usb/${num('busnum')}/${num('devnum')}`, String(opts.n)]).toString()));
  const nativeSummary = {
    latencyMs: Object.fromEntries(Object.keys(native[0].latencyMs).map((k) => [k, summarize(native.map((r) => r.latencyMs[k].median))])),
    throughput: native[0].throughput.map((t: any, j: number) => ({ size: t.size, inMBps: summarize(native.map((r) => r.throughput[j].inMBps)), outMBps: summarize(native.map((r) => r.throughput[j].outMBps)) })),
  };
  const result = {
    date: new Date().toISOString(),
    host: execFileSync('uname', ['-srm']).toString().trim(),
    chromium: version,
    gadget: 'dummy_hcd (high speed) + configfs SourceSink/Loopback, tests/usb/gadget.sh zero',
    packet: samples[0].packet,
    opts,
    runs,
    latencyMs: lat,
    throughput: tput,
    samples,
    native: nativeSummary,
    nativeSamples: native,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 1));
  for (const [k, v] of Object.entries(lat)) console.log(k, JSON.stringify(v, (key, x) => (key === 'runMedians' ? undefined : typeof x === 'number' ? +x.toFixed(3) : x)));
  for (const t of tput) console.log(`size ${t.size} depth ${t.depth}: IN ${t.inMBps.median.toFixed(1)} MB/s (IQR ${t.inMBps.iqr.toFixed(1)}), OUT ${t.outMBps.median.toFixed(1)} MB/s (IQR ${t.outMBps.iqr.toFixed(1)})`);
  for (const [k, v] of Object.entries(nativeSummary.latencyMs)) console.log(`native ${k}: median of run medians ${v.median.toFixed(3)} ms`);
  for (const t of nativeSummary.throughput) console.log(`native size ${t.size}: IN ${t.inMBps.median.toFixed(1)} MB/s, OUT ${t.outMBps.median.toFixed(1)} MB/s`);
  console.log(`wrote ${out}`);
}
server.close();
