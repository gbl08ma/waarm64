// The RAM map's scanner (docs/frontend.md "RAM's map"): a worker the machine worker starts when the page first asks
// about RAM and ends once it hasn't for a while (web/app/worker-ram.ts). It holds the machine's RAM (its shared
// buffers, `parts` first) and a fingerprint per page (web/ram-scan.ts `RamScan`), and answers `ram-surface` with a
// new pass and `ram-range` from the last, so the passes run on a thread of their own, never the machine worker's.
import { RamScan, type RamPart } from '../ram-scan.ts';
import { answerBuffers, type InspectAnswer, type InspectQuery } from '../surface.ts';

export type ToRamScan = { type: 'parts'; parts: RamPart[] } | { type: 'ask'; id: number; query: InspectQuery };
export type FromRamScan = { id: number; answer: InspectAnswer };

let scan: RamScan | undefined;

/** The answer to `q` from `s`: a new pass and its surface, or a range of the last pass. */
function answer(s: RamScan, q: InspectQuery): InspectAnswer {
  if (q.kind === 'ram-surface') {
    const cost = s.pass();
    const surface = s.surface(q.cells);
    surface.cost = cost;
    return { kind: 'ram-surface', surface, layout: s.layout };
  }
  if (q.kind === 'ram-range') {
    if (s.passes === 0) s.pass();
    const detail = s.range(q.range);
    return detail ? { kind: 'ram-range', detail } : { kind: 'none' };
  }
  return { kind: 'none' };
}

self.onmessage = (e: MessageEvent<ToRamScan>) => {
  const m = e.data;
  if (m.type === 'parts') scan = new RamScan(m.parts);
  else {
    const a = scan ? answer(scan, m.query) : { kind: 'none' as const };
    self.postMessage({ id: m.id, answer: a } satisfies FromRamScan, { transfer: answerBuffers(a) });
  }
};
