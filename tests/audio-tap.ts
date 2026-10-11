// What the page's sound sounds like, for the Chromium tests (tests/audio-browser.test.ts, tests/page-debian.test.ts):
// the page exposes its PageAudio as `__audio` with `?snd=` (web/app/main.ts).
import type { Page } from 'playwright-core';

/** The two loudest peaks of the spectrum after the volume (Hz), averaged over a few reads, and the loudest bin (dB). */
export const peaks = (page: Page) => page.evaluate(async () => {
  const a = (window as unknown as { __audio: { tap(): AnalyserNode } }).__audio.tap();
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
