// One run of the machine (docs/frontend.md "The page's code"): its worker, input and ports, from a start to the next
// stop. One machine at a time: a restart stops it and starts a new run (fresh memory, fresh ports, a fresh canvas).
// What a run hears after another took its place is dropped in one place, `guard`.
import type { Input } from '../../input.ts';
import type { UsbPorts } from '../usb-live.ts';
import type { Sample } from '../statusbar-metrics.ts';
import type { FromWorker, ToWorker } from '../protocol.ts';
import type { Msg } from '../../msg.ts';
import type { Channels } from './start-message.ts';

/** A save in progress (a snapshot, a suspend): the worker's messages for it, by its id (web/app/run/worker-messages.ts). */
export type SnapshotJob = {
  progress(phase: Msg, fraction: number): void;
  /** The file's next bytes (no handle, no keep), theirs only during the call: it copies what it keeps. */
  chunk(data: Uint8Array): void;
  done(m: Extract<FromWorker, { type: 'snapshot-done' | 'suspend-done' }>): void;
  error(e: unknown): void;
};
/** A save's message, without the id `Run.save` gives it. */
type Save = { [K in 'snapshot' | 'suspend']: Omit<Extract<ToWorker, { type: K }>, 'id'> }['snapshot' | 'suspend'];

/** Who holds the page's run now. */
export type RunHolder = { run: Run | undefined };

export class Run {
  readonly worker: Worker;
  readonly input: Input;
  readonly serial: MessagePort;
  readonly display: MessagePort;
  gpu?: Worker;
  readonly usb?: UsbPorts;
  /** Its USB devices went on (once it ran). */
  usbStarted = false;
  /** The page's end of each network card's link (`{type: 'flap'}`: web/app/areas/lease-actions.ts). */
  readonly netLinks: MessagePort[];
  /** The guest has suspended itself (`Status.asleep`): a key or a click wakes it. */
  asleep = false;
  /** The run's last status (the status bar's rates are since it). */
  last: Sample | undefined;
  /** A stored machine as this run's snapshots describe it (its start's `about`: the shape it runs with). */
  about?: Extract<ToWorker, { type: 'start' }>['about'];
  readonly #holder: RunHolder;
  /** The saves in progress, by id. */
  readonly #jobs = new Map<number, SnapshotJob>();
  #lastJob = 0;

  constructor(
    holder: RunHolder,
    o: { worker: Worker; input: Input; ch: Pick<Channels, 'serial' | 'display' | 'netLinks'>; usb?: UsbPorts },
  ) {
    this.#holder = holder;
    this.worker = o.worker;
    this.input = o.input;
    this.serial = o.ch.serial.port1;
    this.display = o.ch.display.port1;
    this.usb = o.usb;
    this.netLinks = o.ch.netLinks;
  }

  /** It is the page's run (not one stopped, or replaced by a restart). A call, not a getter: it changes across awaits. */
  live() {
    return this.#holder.run === this;
  }

  /** Posts save `m` with an id of its own: the worker's messages for it go to `job` until its end (done, error). */
  save(m: Save, job: SnapshotJob) {
    const id = ++this.#lastJob;
    this.#jobs.set(id, job);
    this.worker.postMessage({ ...m, id });
  }
  /** Save `id`'s job; with `end`, its last message (it's dropped). */
  job(id: number, end = false) {
    const j = this.#jobs.get(id);
    if (end) this.#jobs.delete(id);
    return j;
  }
  /** Every save in progress fails with `e` (the worker failed). */
  failJobs(e: unknown) {
    for (const j of this.#jobs.values()) j.error(e);
    this.#jobs.clear();
  }

  /** `f`, called only while this is the page's run: what an old run's workers and ports say after is dropped. */
  guard<A extends unknown[]>(f: (...args: A) => void): (...args: A) => void {
    return (...args) => {
      if (this.live()) f(...args);
    };
  }
}

/** A handler per message `type`, each given its own message's type. */
export type Handlers<M extends { type: string }> = { [K in M['type']]?: (m: Extract<M, { type: K }>) => void };

/** Hands message `m` to its type's handler, if there is one. */
export function dispatch<M extends { type: string }>(handlers: Handlers<M>, m: M) {
  // The table's key and the message's type are the same union member: TypeScript can't correlate the two.
  const f = handlers[m.type as M['type']] as ((m: M) => void) | undefined;
  f?.(m);
}
