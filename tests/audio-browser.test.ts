// Sound on the page, realtime (docs/audio.md "Tests"; docs/frontend.md "Sound"): the snd test guest
// (images/snd/init.c) plays its 440/660 Hz tone through virtio-snd, the device worker's ring sink and the page's
// AudioWorklet. Its writes block on the worklet's pace, so the guest's own clock says the tone took its length;
// an analyser after the volume hears both frequencies, and mute silences it. The stream's time on the device (START
// to its stop) is the sound's length plus the gaps the ring counted (the worklet's or the sink's), within 40 ms; the
// gaps under 10% of the sound: a guest starved of its vCPU for longer than its 85 ms buffer underruns for real, but no
// time may go missing uncounted. Realtime and timed, so scripts/ci-audio.sh runs it alone, not npm test beside the
// other files (under that load it failed now and then: docs/backlog.md). (The guest's own time, from its first
// write, also has its computing of the periods before START in it: up to ~100 ms more under that load.) S2's exit
// (no underrun in a minute, the guest's own time) is measured alone (bench/audio/snd-page.ts, docs/audio.md "Measurements"); the
// numbers are printed here.
// A context that isn't running (the browser's autoplay rule: headless Chromium doesn't apply it, so the test
// suspends the context itself) leaves the guest playing on the device worker's clock, the page says sound waits
// for a click, and a click brings it back.
// A snapshot saved while the tone plays (a 12 s tone, 2 s in; audio S4, docs/audio.md "Linux driver behavior") loads in a fresh profile and plays on: the restored
// device posts its held messages again and the guest writes the rest of its tone (its clock stands still until its
// vCPUs run, and the sink never completes a whole buffer it hasn't seen).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { GAP_FRAMES, LATENCY, QUANTA, READ, UNDERRUNS, WRITE } from '../web/audio-ring.ts';
import { peaks } from './audio-tap.ts';
import { fnv1a } from '../web/snd.ts';

const IMAGES = new URL('../target/images/', import.meta.url);
const skip = process.env.WEBPC_AUDIO_TESTS !== '1' ? 'SKIPPED: scripts/ci-audio.sh runs it (WEBPC_AUDIO_TESTS=1)'
  : !existsSync(new URL('linux-snd/Image', IMAGES)) && 'SKIPPED: run images/build.sh linux-snd';

let browser: Browser;
let base: string;
let close: () => void;
let micDir: string;
/** The fake microphone's tone (Hz): Chromium plays a WAV as its capture device (`--use-file-for-fake-audio-capture`). */
const MIC_HZ = 500;
before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  micDir = mkdtempSync(join(tmpdir(), 'webpc-mic-'));
  const wav = join(micDir, 'tone.wav');
  writeFileSync(wav, toneWav(MIC_HZ, 48000, 10));
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`],
  });
});
after(async () => { await browser?.close(); close?.(); if (micDir) rmSync(micDir, { recursive: true }); });

/** A mono S16 WAV of a sine at half scale. */
function toneWav(hz: number, rate: number, seconds: number) {
  const n = rate * seconds;
  const b = Buffer.alloc(44 + 2 * n);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + 2 * n, 4);
  b.write('WAVEfmt ', 8, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(2 * rate, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(2 * n, 40);
  for (let k = 0; k < n; k++) b.writeInt16LE(Math.round(16384 * Math.sin((2 * Math.PI * hz * k) / rate)), 44 + 2 * k);
  return b;
}

type W = { __serialLog: () => string; __audio: { header(): Int32Array; context(): AudioContext; waiting(): boolean; playing: boolean; tap(): AnalyserNode; stats: unknown[]; spans: number[] } };
const serial = (page: Page) => page.evaluate(() => (window as unknown as W).__serialLog?.() ?? '');
const until = (page: Page, re: RegExp, timeout = 60_000) => page.waitForFunction((src) => new RegExp(src).test((window as unknown as W).__serialLog?.() ?? ''), re.source, { timeout, polling: 100 })
  .catch(async (e) => { throw new Error(`${e}; the serial console:\n${(await serial(page)).slice(-3000)}`); });
/** How far the stream's time on the device may be from its sound plus its counted gaps, ms (npm test's load). */
const TOLERANCE_MS = 40;
const header = (page: Page) => page.evaluate(() => [...(window as unknown as W).__audio.header()]);
/** Checks the guest's time against the sound's length, and the ring's gaps; prints both. */
async function inTime(page: Page, what: string) {
  const r = report(await serial(page));
  const h = await header(page);
  await page.waitForFunction(() => (window as unknown as W).__audio?.spans.length > 0, null, { timeout: 5_000 });
  const [span] = await page.evaluate(() => (window as unknown as W).__audio.spans);
  const length = (1000 * r.frames) / 48000;
  const said = `${r.frames} frames (${length.toFixed(0)} ms) ran ${span.toFixed(0)} ms from START to its stop (the guest's time ${r.ms} ms); ${h[UNDERRUNS]} underruns, ${h[GAP_FRAMES]} frames of gaps; the worklet played ${h[QUANTA] * 128}`;
  console.log(`# ${what}: ${said}`);
  assert.ok(Math.abs(span - length - (1000 * h[GAP_FRAMES]) / 48000) < TOLERANCE_MS, said);
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

test('the snd guest plays a tone on the page in real time: its length in its own time, no underrun, 440 and 660 Hz heard, mute silences it', { skip }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/web/app/?machine=snd&view=terminal&params=snd_seconds=4&snd=stats`);
  await page.mouse.click(5, 5);
  await until(page, /snd: hw params/);
  await page.waitForFunction(() => (window as unknown as W).__audio?.context()?.state === 'running', null, { timeout: 10_000 });
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
  // Then it records 16 periods, in real time (this browser has a fake microphone; silence: the Microphone-off test).
  // The microphone opens while it records: the switch from the clock's silence to the microphone starts the period
  // in progress again (micSource), up to 21 ms more than the 341.
  const rec = recorded(await serial(page));
  console.log(`# recorded 16 periods in ${rec.ms} ms of the guest's time`);
  assert.ok(rec.ms > 330 && rec.ms < 341 + 60, `${rec.ms} ms`);
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
  await page.waitForFunction(() => (window as unknown as W).__audio?.context()?.state === 'running', null, { timeout: 60_000 });
  await page.evaluate(() => (window as unknown as W).__audio.context().suspend());
  await page.waitForFunction(() => (window as unknown as W).__audio?.waiting() && /click/.test(document.getElementById('sound-summary')!.textContent ?? ''), null, { timeout: 5_000 });
  const quanta = (await header(page))[QUANTA];
  await page.waitForTimeout(1500);
  const h = await header(page);
  assert.equal(h[QUANTA], quanta, 'the worklet played while suspended');
  assert.ok(h[READ] > 0 && !/snd test/.test(await serial(page)), 'the guest should be playing on the device worker clock');
  await page.mouse.click(5, 5);
  await page.waitForFunction(() => !(window as unknown as W).__audio?.waiting() && (window as unknown as W).__audio?.context().state === 'running', null, { timeout: 5_000 });
  await until(page, /snd test (ok|failed)/, 30_000);
  await inTime(page, 'suspended, then resumed');
  assert.ok((await header(page))[QUANTA] > quanta, 'the worklet played again after the click');
  assert.match(await page.locator('#sound-summary').textContent() ?? '', /^Sound$/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a snapshot saved while the tone plays (12 s, saved 2 s in) loads in a fresh profile and plays on: heard, in time, to its end', { skip, timeout: 4 * 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'webpc-snd-snap-'));
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(() => { (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = undefined; }); // the download path
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${base}/web/app/?machine=snd&view=terminal&params=snd_seconds=12&snd=stats`);
    await page.mouse.click(5, 5);
    await until(page, /snd: hw params/);
    await page.waitForFunction(() => (window as unknown as W).__audio?.context()?.state === 'running', null, { timeout: 10_000 });
    await page.waitForTimeout(2000);
    const before = (await header(page))[READ];
    // Watched from before the click: the guest's power-off replaces the page's message.
    const saved = page.waitForFunction(() => /^Saved the snapshot /.test(document.getElementById('message-text')!.textContent!), null, { timeout: 60_000, polling: 20 })
      .catch(async (e) => { throw new Error(`${e}; the page says: ${await page.locator('#message-text').textContent()}`); });
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.locator('#save-snapshot').click()]);
    const path = join(dir, 'snd.webpcsnap');
    await download.saveAs(path);
    await saved;
    const after = (await header(page))[READ];
    // The saved machine plays on through the pause, and ends in time.
    await until(page, /snd test (ok|failed)/, 30_000);
    await inTime(page, 'saved while playing');
    assert.deepEqual(errors, []);
    await context.close();

    // A fresh profile loads it over its own snd guest: the restored guest's stream starts again where it was (the
    // messages it had posted, posted again), the page plays it and the guest writes the rest of its tone.
    const fresh = await browser.newContext();
    const p2 = await fresh.newPage();
    const errors2: string[] = [];
    p2.on('pageerror', (e) => errors2.push(String(e)));
    const logs2: string[] = [];
    p2.on('console', (m) => logs2.push(m.text()));
    p2.on('dialog', (d) => void d.accept());
    await p2.goto(`${base}/web/app/?machine=snd&view=terminal&params=snd_seconds=60&snd=stats`);
    await p2.mouse.click(5, 5);
    await until(p2, /snd: hw params/);
    await p2.setInputFiles('#load-snapshot-input', path);
    await p2.waitForFunction(() => document.getElementById('boot-title')!.textContent!.startsWith('Loading '), null, { timeout: 30_000, polling: 20 });
    await p2.waitForFunction(() => document.body.dataset.state !== 'running', null, { timeout: 30_000, polling: 20 }); // the old machine is gone
    await p2.waitForFunction(() => document.body.dataset.state === 'running' && (window as unknown as W).__audio?.playing && (window as unknown as W).__audio?.context()?.state === 'running', null, { timeout: 60_000, polling: 100 });
    // Listened to once the restored stream flows (half a second on the new ring): under load its vCPUs start late.
    await p2.waitForFunction((at) => (window as unknown as W).__audio?.header()[at] >= 24000, READ, { timeout: 30_000, polling: 50 })
      .catch(async (e) => { throw new Error(`${e}: the ring ${await header(p2)}, the page ${await p2.evaluate(() => document.body.dataset.state)} (${await p2.locator('#message-text').textContent()}); the terminal: ${await p2.evaluate(() => document.querySelector('.xterm-rows')?.textContent?.slice(-2500))}; console: ${logs2.slice(-10).join(' | ')}; kernel: ${(await serial(p2)).split('\n').filter((l) => /virtio|head|range|broken|BUG|WARN|error|nobody|disabl|irq [0-9]+:/i.test(l)).slice(-12).join(' / ')}`); });
    const heard = await peaks(p2);
    assert.ok(Math.abs(heard.hz[0] - 440) < 12 && Math.abs(heard.hz[1] - 660) < 12, `heard ${heard.hz} Hz after the load (the ring ${await header(p2)}; the serial console's end: ${(await serial(p2)).slice(-300)})`);
    await until(p2, /snd test (ok|failed)/, 30_000);
    const r = report(await serial(p2));
    assert.equal(r.end, 'drain');
    await p2.waitForFunction(() => (window as unknown as W).__audio?.spans.length > 0, null, { timeout: 5_000 });
    const [span] = await p2.evaluate(() => (window as unknown as W).__audio.spans);
    const h = await header(p2);
    // The new ring has what the guest hadn't had completed when it was saved: whole periods, the old ring having played
    // that much (within a buffer: the messages in flight) between the click and the end of the save.
    const done = r.frames - h[WRITE];
    const said = `saved with ${done} frames completed (the old ring played ${before} to ${after} around the save); restored, the ring played ${h[WRITE]} in ${span.toFixed(0)} ms, ${h[UNDERRUNS]} underruns, ${h[GAP_FRAMES]} frames of gaps`;
    console.log(`# loaded: ${said}`);
    assert.equal(h[READ], h[WRITE]);
    assert.ok(done % 1024 === 0 && done >= before - 4096 && done <= after, said);
    assert.ok(Math.abs(span - (1000 * (h[WRITE] + h[GAP_FRAMES])) / 48000) < TOLERANCE_MS, said);
    // The re-posted buffer plays while the vCPUs start: a gap until the guest writes again, counted.
    assert.ok(h[GAP_FRAMES] < 0.1 * h[WRITE], said);
    assert.deepEqual(errors2, []);
    await fresh.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});

type Mic = { micState: string; micHeader(): Int32Array | undefined; micSettings(): MediaTrackSettings | undefined };
/** The open microphone's processing (echo cancellation, noise suppression, gain control). */
const processing = (page: Page) => page.evaluate(() => { const s = (window as unknown as { __audio: Mic }).__audio.micSettings(); return [s?.echoCancellation, s?.noiseSuppression, s?.autoGainControl]; });
/** The guest's recording line: frames, hash, its own ms, and each channel's Hz. */
const recorded = (log: string) => {
  const [, frames, hash, ms, left, right] = /^snd: recorded (\d+) frames fnv1a ([0-9a-f]{8}) in (\d+) ms, (\d+) Hz left, (\d+) Hz right$/m.exec(log.replaceAll('\r\n', '\n')) ?? [];
  assert.ok(frames, `no recording: ${log.slice(-1500)}`);
  return { frames: Number(frames), hash, ms: Number(ms), left: Number(left), right: Number(right) };
};
/** A page of the snd machine with these settings kept, its guest playing 0.2 s and then recording (`rec` seconds, or 16 periods). */
async function micPage(stored: Record<string, unknown>, rec?: number, init?: () => void) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript((s) => localStorage.setItem('webpc.settings', JSON.stringify(s)), stored);
  if (init) await page.addInitScript(init);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const params = encodeURIComponent(`snd_seconds=0.2${rec ? ` snd_rec_seconds=${rec}` : ''}`);
  await page.goto(`${base}/web/app/?machine=snd&view=terminal&params=${params}&snd=stats`);
  await page.mouse.click(5, 5);
  return { context, page, errors };
}
const silence16 = fnv1a(new Uint8Array(16384 * 4)).toString(16).padStart(8, '0');

test('the guest records the page\'s microphone (raw): the tone on both channels, in real time; the microphone closes when it stops', { skip }, async () => {
  const { context, page, errors } = await micPage({ micRaw: true }, 3);
  await page.waitForFunction(() => (window as unknown as { __audio: Mic }).__audio?.micState === 'on', null, { timeout: 60_000 });
  await page.waitForFunction(() => /· mic/.test(document.getElementById('sound-summary')!.textContent ?? ''), null, { timeout: 5_000 });
  assert.deepEqual(await processing(page), [false, false, false], 'raw');
  await until(page, /snd test (ok|failed)/, 30_000);
  const r = recorded(await serial(page));
  const h = (await page.evaluate(() => [...(window as unknown as { __audio: Mic }).__audio.micHeader()!]));
  console.log(`# recorded the microphone: ${r.frames} frames in ${r.ms} ms, ${r.left} and ${r.right} Hz (the tone ${MIC_HZ}); the worklet wrote ${h[WRITE]} frames, dropped ${h[GAP_FRAMES]}`);
  assert.ok(Math.abs(r.left - MIC_HZ) <= 10 && Math.abs(r.right - MIC_HZ) <= 10, `${r.left}, ${r.right} Hz`);
  assert.ok(Math.abs(r.ms - (1000 * r.frames) / 48000) < 150, `${r.frames} frames took ${r.ms} ms`);
  await page.waitForFunction(() => (window as unknown as { __audio: Mic }).__audio?.micState === 'idle', null, { timeout: 5_000 });
  assert.deepEqual(errors, []);
  await context.close();
});

test('with the browser\'s processing (the default) the microphone is heard too', { skip }, async () => {
  const { context, page, errors } = await micPage({}, 2);
  await page.waitForFunction(() => (window as unknown as { __audio: Mic }).__audio?.micState === 'on', null, { timeout: 60_000 });
  assert.deepEqual(await processing(page), [true, true, true]);
  await until(page, /snd test (ok|failed)/, 60_000);
  const r = recorded(await serial(page));
  console.log(`# recorded the processed microphone: ${r.left} and ${r.right} Hz`);
  assert.notEqual(r.hash, fnv1a(new Uint8Array(r.frames * 4)).toString(16).padStart(8, '0'), 'silence');
  assert.deepEqual(errors, []);
  await context.close();
});

test('Microphone off: the page never asks for it and the guest records silence in real time; refused: silence, and the menu says so', { skip }, async () => {
  const counting = () => {
    const w = window as unknown as { __asked: number };
    w.__asked = 0;
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (c) => { w.__asked++; return real(c); };
  };
  const off = await micPage({ mic: false }, undefined, counting);
  await until(off.page, /snd test (ok|failed)/, 60_000);
  const r = recorded(await serial(off.page));
  assert.equal(r.hash, silence16);
  assert.ok(Math.abs(r.ms - 341) < 40, `${r.ms} ms`);
  assert.equal(await off.page.evaluate(() => (window as unknown as { __asked: number }).__asked), 0);
  assert.equal(await off.page.evaluate(() => (window as unknown as { __audio: Mic }).__audio.micState), 'off');
  assert.deepEqual(off.errors, []);
  await off.context.close();

  const refusing = () => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('refused', 'NotAllowedError')); };
  const no = await micPage({}, undefined, refusing);
  await no.page.waitForFunction(() => (window as unknown as { __audio: Mic }).__audio?.micState === 'denied', null, { timeout: 60_000 });
  await no.page.locator('#sound-menu summary').click();
  assert.match(await no.page.locator('#mic-hint').textContent() ?? '', /refused the microphone/);
  assert.equal(await no.page.locator('#mic-hint').isVisible(), true);
  await until(no.page, /snd test (ok|failed)/, 30_000);
  assert.equal(recorded(await serial(no.page)).hash, silence16);
  assert.deepEqual(no.errors, []);
  await no.context.close();
});

