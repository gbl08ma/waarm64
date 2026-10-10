// Sound on the page, realtime (docs/plans/audio.md §6, §13; docs/frontend.md "Sound"): the snd test guest
// (images/snd/init.c) plays its 440/660 Hz tone through virtio-snd, the device worker's ring sink and the page's
// AudioWorklet. Its writes block on the worklet's pace, so the guest's own clock says the tone took its length;
// an analyser after the volume hears both frequencies, and mute silences it. The stream's time on the device (START
// to its stop) is the sound's length plus the gaps the ring counted (the worklet's or the sink's), within 40 ms; the
// gaps under 10% of the sound: npm test runs test files side by side, and a guest starved of its vCPU for longer than
// its 85 ms buffer underruns for real, but no time may go missing uncounted. (The guest's own time, from its first
// write, also has its computing of the periods before START in it: up to ~100 ms more under that load.) S2's exit
// (no underrun in a minute, the guest's own time) is measured alone (bench/audio/snd-page.ts, audio.md §13); the
// numbers are printed here.
// A context that isn't running (the browser's autoplay rule: headless Chromium doesn't apply it, so the test
// suspends the context itself) leaves the guest playing on the device worker's clock, the page says sound waits
// for a click, and a click brings it back.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { GAP_FRAMES, LATENCY, QUANTA, READ, UNDERRUNS, WRITE } from '../web/audio-ring.ts';

const IMAGES = new URL('../target/images/', import.meta.url);
const skip = !existsSync(new URL('linux-snd/Image', IMAGES)) && 'SKIPPED: run images/build.sh linux-snd';

let browser: Browser;
let base: string;
let close: () => void;
before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => { await browser?.close(); close?.(); });

type W = { __serialLog: () => string; __audio: { header(): Int32Array; context(): AudioContext; waiting(): boolean; playing: boolean; tap(): AnalyserNode; stats: unknown[]; spans: number[] } };
const serial = (page: Page) => page.evaluate(() => (window as unknown as W).__serialLog?.() ?? '');
const until = (page: Page, re: RegExp, timeout = 60_000) => page.waitForFunction((src) => new RegExp(src).test((window as unknown as W).__serialLog?.() ?? ''), re.source, { timeout, polling: 100 })
  .catch(async (e) => { throw new Error(`${e}; the serial console:\n${(await serial(page)).slice(-3000)}`); });
const header = (page: Page) => page.evaluate(() => [...(window as unknown as W).__audio.header()]);
/** Checks the guest's time against the sound's length, and the ring's gaps; prints both. */
async function inTime(page: Page, what: string) {
  const r = report(await serial(page));
  const h = await header(page);
  await page.waitForFunction(() => (window as unknown as W).__audio.spans.length > 0, null, { timeout: 5_000 });
  const [span] = await page.evaluate(() => (window as unknown as W).__audio.spans);
  const length = (1000 * r.frames) / 48000;
  const said = `${r.frames} frames (${length.toFixed(0)} ms) ran ${span.toFixed(0)} ms from START to its stop (the guest's time ${r.ms} ms); ${h[UNDERRUNS]} underruns, ${h[GAP_FRAMES]} frames of gaps; the worklet played ${h[QUANTA] * 128}`;
  console.log(`# ${what}: ${said}`);
  assert.ok(Math.abs(span - length - (1000 * h[GAP_FRAMES]) / 48000) < 40, said);
  assert.ok(h[GAP_FRAMES] < 0.1 * r.frames, said);
  assert.equal(h[READ], h[WRITE]);
  assert.equal(h[WRITE], r.frames);
  return { r, h };
}
/** The guest's report: frames written, and the time from its first write to the end of its drain (guest ms). */
const report = (log: string) => {
  const [, frames] = /snd: wrote (\d+) frames/.exec(log) ?? [];
  const [, end, ms] = /snd: \d+ frames queued at the end, (drain|drop) ok after (\d+) ms/.exec(log) ?? [];
  assert.ok(frames && ms && /webpc: snd test ok/.test(log), `the guest didn't finish:\n${log.slice(-2000)}`);
  return { frames: Number(frames), ms: Number(ms), end };
};

/** The two loudest peaks of the analyser's spectrum (Hz), averaged over a few reads. */
const peaks = (page: Page) => page.evaluate(async () => {
  const a = (window as unknown as W).__audio.tap();
  const bins = new Float32Array(a.frequencyBinCount);
  const sum = new Float32Array(a.frequencyBinCount);
  for (let k = 0; k < 5; k++) {
    await new Promise((r) => setTimeout(r, 200));
    a.getFloatFrequencyData(bins);
    for (let i = 0; i < bins.length; i++) sum[i] += bins[i] / 5;
  }
  const hz = (i: number) => (i * a.context.sampleRate) / a.fftSize;
  const order = [...sum.keys()].sort((x, y) => sum[y] - sum[x]);
  const top = [order[0]];
  for (const i of order) if (top.length < 2 && Math.abs(i - top[0]) > 5) top.push(i);
  return { hz: top.map(hz).sort((x, y) => x - y), db: Math.max(...sum) };
});

test('the snd guest plays a tone on the page in real time: its length in its own time, no underrun, 440 and 660 Hz heard, mute silences it', { skip }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/web/app/?machine=snd&view=terminal&params=snd_seconds=4&snd=stats`);
  await page.mouse.click(5, 5);
  await until(page, /snd: hw params/);
  await page.waitForFunction(() => (window as unknown as W).__audio.context()?.state === 'running', null, { timeout: 10_000 });
  const heard = await peaks(page);
  assert.ok(Math.abs(heard.hz[0] - 440) < 12 && Math.abs(heard.hz[1] - 660) < 12, `heard ${heard.hz} Hz`);
  await page.locator('#sound-menu summary').click();
  await page.locator('#sound-on').uncheck();
  const muted = await peaks(page);
  assert.ok(muted.db < -200, `muted, the loudest bin is ${muted.db} dB`);
  await until(page, /snd test (ok|failed)/, 30_000);
  // The writes block until the worklet played the buffer (4 periods of 21.3 ms) ahead of them: the guest takes the
  // sound's length less that buffer, plus the drain's buffer back.
  const { r, h } = await inTime(page, 'played');
  assert.equal(r.end, 'drain');
  assert.ok(h[QUANTA] * 128 > 0.9 * r.frames, `the worklet played ${h[QUANTA] * 128} of ${r.frames} frames`);
  assert.ok(h[LATENCY] > 0, 'no output latency reported');
  // Remembered: the reload starts muted.
  await page.reload();
  await page.locator('#sound-menu summary').click();
  assert.equal(await page.locator('#sound-on').isChecked(), false);
  assert.match(await page.locator('#sound-summary').textContent() ?? '', /muted/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('with its context not running, the page says sound waits for a click; the guest plays on the device worker clock, and a click resumes it', { skip }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/web/app/?machine=snd&view=terminal&params=snd_seconds=4&snd=stats`);
  await page.waitForFunction(() => (window as unknown as W).__audio.context()?.state === 'running', null, { timeout: 60_000 });
  await page.evaluate(() => (window as unknown as W).__audio.context().suspend());
  await page.waitForFunction(() => (window as unknown as W).__audio.waiting() && /click/.test(document.getElementById('sound-summary')!.textContent ?? ''), null, { timeout: 5_000 });
  const quanta = (await header(page))[QUANTA];
  await page.waitForTimeout(1500);
  const h = await header(page);
  assert.equal(h[QUANTA], quanta, 'the worklet played while suspended');
  assert.ok(h[READ] > 0 && !/snd test/.test(await serial(page)), 'the guest should be playing on the device worker clock');
  await page.mouse.click(5, 5);
  await page.waitForFunction(() => !(window as unknown as W).__audio.waiting() && (window as unknown as W).__audio.context().state === 'running', null, { timeout: 5_000 });
  await until(page, /snd test (ok|failed)/, 30_000);
  await inTime(page, 'suspended, then resumed');
  assert.ok((await header(page))[QUANTA] > quanta, 'the worklet played again after the click');
  assert.match(await page.locator('#sound-summary').textContent() ?? '', /^Sound$/);
  assert.deepEqual(errors, []);
  await context.close();
});
