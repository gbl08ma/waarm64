// The machine worker's messages to the page (web/app/worker.ts; web/app/protocol.ts `FromWorker`).
import { toWire, type Msg } from '../msg.ts';
import type { FromWorker, PowerState, Problem } from './protocol.ts';

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
