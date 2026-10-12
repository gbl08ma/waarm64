// Audio S2's exit measurement (docs/audio.md "Measurements"): the snd test guest (images/snd/init.c) plays its tone on
// the page for `--seconds` in headless Chromium, and the run is written down as JSON: the guest's own report (frames,
// the time from its first write to the end of its drain), the ring's counters at the end (underruns, their silent
// frames, the worklet's quanta, the output latency), the page's context, and the sink's stats for each second
// (`?snd=stats`: the completions' jitter around a period, the pumps, the device worker's ms in them). Runs alone.
//
//   node bench/audio/snd-page.ts [--seconds 60] [--wake worklet|timer] [--runs 1] [--out bench/results/local/snd.json]
//
// With `--runs N` and both wakes (`--wake both`), the wakes alternate, N runs each.
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';
import { EPOCH, GAP_FRAMES, LATENCY, QUANTA, RATE, READ, RUN, UNDERRUNS, WAKE, WRITE } from '../../web/audio-ring.ts';
import type { SndStats } from '../../web/snd.ts';

const { values: a } = parseArgs({ options: { seconds: { type: 'string', default: '60' }, wake: { type: 'string', default: 'worklet' }, runs: { type: 'string', default: '1' }, out: { type: 'string', default: 'bench/results/local/snd.json' } } });
const seconds = Number(a.seconds);
const wakes = a.wake === 'both' ? ['worklet', 'timer'] : [a.wake!];
const HEADER = { write: WRITE, read: READ, run: RUN, quanta: QUANTA, underruns: UNDERRUNS, gapFrames: GAP_FRAMES, latency: LATENCY, rate: RATE, epoch: EPOCH, wake: WAKE };

const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
const runs: unknown[] = [];
type W = { __serialLog(): string; __audio: { header(): Int32Array; context(): AudioContext; stats: SndStats[] } };
try {
  for (let k = 0; k < Number(a.runs); k++) {
    for (const wake of wakes) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(`${base}/web/app/?machine=snd&view=terminal&params=snd_seconds=${seconds}&snd=stats${wake === 'timer' ? ',timer' : ''}`);
      await page.mouse.click(5, 5);
      await page.waitForFunction(() => /snd test (ok|failed)/.test((window as unknown as W).__serialLog?.() ?? ''), null, { timeout: (seconds + 60) * 1000, polling: 200 });
      const r = await page.evaluate(() => {
        const w = window as unknown as W;
        const c = w.__audio.context();
        return { log: w.__serialLog(), h: [...w.__audio.header()], ctx: { state: c.state, sampleRate: c.sampleRate, baseLatency: c.baseLatency, outputLatency: c.outputLatency }, stats: w.__audio.stats };
      });
      await context.close();
      const [, frames] = /snd: wrote (\d+) frames/.exec(r.log) ?? [];
      const [, end, ms] = /snd: \d+ frames queued at the end, (drain|drop) (?:ok|.*) after (\d+) ms/.exec(r.log) ?? [];
      const guest = { ok: /webpc: snd test ok/.test(r.log), frames: Number(frames), ms: Number(ms), end, lengthMs: (1000 * Number(frames)) / 48000 };
      const ring = Object.fromEntries(Object.entries(HEADER).map(([n, i]) => [n, r.h[i]]));
      const steady = r.stats.slice(1); // the first second has the context's start in it
      const med = (f: (s: SndStats) => number) => {
        const v = steady.map(f).sort((x, y) => x - y);
        return v[v.length >> 1];
      };
      const summary = { wake, guestMs: guest.ms, lengthMs: +guest.lengthMs.toFixed(1), underruns: ring.underruns, gapFrames: ring.gapFrames, jitterP50: med((s) => s.jitterP50), jitterP99: med((s) => s.jitterP99), jitterMax: Math.max(...steady.map((s) => s.jitterMax)), busyMsPerS: med((s) => s.busyMs), pumpsPerS: med((s) => s.pumps), capped: r.stats.reduce((n, s) => n + s.capped, 0) };
      console.log(JSON.stringify(summary));
      runs.push({ wake, summary, guest, ring, ctx: r.ctx, errors, stats: r.stats });
    }
  }
  const out = {
    date: new Date().toISOString(), seconds,
    host: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, cores: os.cpus().length, memGiB: Math.round(os.totalmem() / 2 ** 30) },
    chromium: browser.version(), runs,
  };
  writeFileSync(a.out!, JSON.stringify(out, null, 1));
  console.log(`wrote ${a.out}`);
} finally {
  await browser.close();
  server.close();
}
