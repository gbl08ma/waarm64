// The machine worker's messages to the page (web/app/worker.ts; web/app/protocol.ts `FromWorker`).
import { toWire, type Msg } from '../msg.ts';
import type { FromWorker, LoadPhases, PowerState, Problem } from './protocol.ts';

export const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, { transfer });
/** Posts the machine's state: with an error (what stopped it, or what went wrong on the way) or a note (resumed, suspended). */
export const state = (s: PowerState, o: { error?: unknown; note?: Msg; problem?: Problem } = {}) =>
  post({
    type: 'state',
    state: s,
    error: o.error === undefined ? undefined : toWire(o.error),
    note: o.note,
    problem: o.problem,
  });
/** A snapshot's (or a suspension's) progress, `phase` at `fraction`. */
export const progress = (id: number, phase: Msg, fraction: number) =>
  post({ type: 'snapshot-progress', id, phase, fraction });
/** A progress callback that posts at most every 100 ms, and the last. */
export function throttled(id: number, phase: Msg) {
  let posted = 0;
  return (done: number, total: number) => {
    const now = performance.now();
    if (now - posted < 100 && done < total) return;
    posted = now;
    progress(id, phase, total ? done / total : 0);
  };
}

/** The page's answer to `loaded` awaited (`postLoaded`), or none. */
let answered: (() => void) | undefined;
/**
 * Posts `loaded` (a start from a snapshot loaded it: where its time went) and waits for the page's answer (`recorded`:
 * a restore's disks recorded as the machine's, docs/machines.md §5.2 "A restore's records") or a stop, either of which
 * calls `answerLoaded`: the guest runs only after, so it writes nothing before that record.
 */
export async function postLoaded(phases: LoadPhases) {
  const answer = new Promise<void>((resolve) => (answered = resolve));
  post({ type: 'loaded', phases });
  await answer;
  answered = undefined;
}
/** The page answered `loaded`, or the machine is being stopped: a start waiting in `postLoaded` goes on. */
export const answerLoaded = () => answered?.();
