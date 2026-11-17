// Where the RAM map's numbers come from (docs/frontend.md "RAM's map"): the machine that runs on this page, asked
// through its worker (`inspect` with a `ram-*` query, answered by its scanner: web/app/worker-ram.ts), or nothing while
// none runs here. A pass reads all of RAM, so the map asks at most once a second, and seldom enough that the passes take
// under an eighth of the time (`ramDelay`).
import { msg } from '../msg.ts';
import type { InspectAnswer, InspectQuery } from '../surface.ts';
import type { ToWorker } from './protocol.ts';
import { noSource, type LiveHost, type SurfaceSource } from './surface-source.ts';

/** The map's interval (ms), and its stretch: a pass's cost stays under 1/8 of the time between two. */
export const RAM_POLL_MS = 1_000;
export const RAM_STRETCH = 8;
/** The next ask's delay after a pass that took `cost` ms. */
export const ramDelay = (cost = 0) => Math.max(RAM_POLL_MS, RAM_STRETCH * cost);
/** How long an ask may take (a pass over a large RAM takes seconds on a slow host). */
export const RAM_MS = 30_000;

const noAnswer = (): InspectAnswer => ({ kind: 'none', why: msg('machine:ram-source.noAnswer') });

/** The running machine's RAM, asked through its worker. */
export function ramSource(host: LiveHost): SurfaceSource {
  const ask = async (query: InspectQuery) => {
    const post = (id: number) => host.worker.postMessage({ type: 'inspect', id, query } satisfies ToWorker);
    const m = await host.replies.ask(post, { ms: RAM_MS, fallback: { type: 'inspected', id: 0, answer: noAnswer() } });
    return m.type === 'inspected' ? m.answer : noAnswer();
  };
  return {
    live: true,
    surface: (cells) => ask({ kind: 'ram-surface', cells }),
    range: (range) => ask({ kind: 'ram-range', range }),
    delay: ramDelay,
    close: () => undefined, // the scanner ends by itself once no query comes (web/app/worker-ram.ts)
  };
}

/** The RAM map's source: the machine running here (`host`), else nothing to show, said why. */
export const ramSourceFor = (host: LiveHost | undefined): SurfaceSource =>
  host ? ramSource(host) : noSource(msg('machine:ram-source.notRunning'));
