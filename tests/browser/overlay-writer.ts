// A test's worker (tests/page-surface.test.ts): writes blocks into an overlay's files in this browser, as a machine's
// device worker would (sync access handles need a worker), so the page sees an overlay with known changes without a
// guest. `writes`: bytes `fill` at `at` for `len`; `zeros`: ranges zeroed (held as zeros, no slot).
import { openOverlay, overlay } from '../../web/overlay.ts';
import { zeroDisk } from '../../web/stored.ts';

type Job = { dir: string; size: number; writes: { at: number; len: number; fill: number }[]; zeros: { at: number; len: number }[] };

self.onmessage = async (e: MessageEvent<Job>) => {
  const j = e.data;
  try {
    const files = await openOverlay(j.dir, undefined);
    try {
      const o = overlay(zeroDisk(j.size), files.data, files.map, files.meta);
      for (const w of j.writes) if (!(await o.write(w.at, new Uint8Array(w.len).fill(w.fill)))) throw new Error(`write at ${w.at} failed`);
      for (const z of j.zeros) if (!(await o.zero(z.at, z.len))) throw new Error(`zero at ${z.at} failed`);
      o.flush();
    } finally {
      files.close();
    }
    self.postMessage('done');
  } catch (err) {
    self.postMessage(String(err));
  }
};
