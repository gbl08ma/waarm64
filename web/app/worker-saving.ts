// The machine worker's save in progress (a snapshot's or a suspend's: web/app/worker-snapshot.ts): one at a time, and
// the worker's `stop` waits for it (web/app/worker.ts).
import { SAVE_STOP_MS } from './run/run.ts';

let saving = false;
/** The save or suspend in progress ends: resolves then. */
let inFlight: Promise<void> = Promise.resolve();

/** Whether a save or suspend is in progress. */
export const snapshotting = () => saving;

/** A save or suspend starts: in progress until the returned call. */
export function begin() {
  saving = true;
  let end!: () => void;
  inFlight = new Promise((r) => (end = r));
  return () => {
    saving = false;
    end();
  };
}

/**
 * Resolves once the save or suspend in progress has ended (at once without one), or after `ms`: the worker's `stop`
 * waits for it, so a guest that powers off while a staged file is still copied after the resume doesn't cut it off.
 */
export async function saveSettled(ms = SAVE_STOP_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([inFlight, new Promise((r) => (timer = setTimeout(r, ms)))]);
  clearTimeout(timer);
}
