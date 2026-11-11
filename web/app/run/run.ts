// One run of the machine (docs/frontend.md "The page's code"): its worker, input and ports, from a start to the next
// stop. One machine at a time: a restart stops it and starts a new run (fresh memory, fresh ports, a fresh canvas).
// What a run hears after another took its place is dropped in one place, `guard`.
import type { Input } from '../../input.ts';
import type { UsbPorts } from '../usb-live.ts';

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
  /** The guest has suspended itself (`Status.asleep`): a key or a click wakes it. */
  asleep = false;
  readonly #holder: RunHolder;

  constructor(
    holder: RunHolder,
    o: { worker: Worker; input: Input; serial: MessagePort; display: MessagePort; usb?: UsbPorts },
  ) {
    this.#holder = holder;
    this.worker = o.worker;
    this.input = o.input;
    this.serial = o.serial;
    this.display = o.display;
    this.usb = o.usb;
  }

  /** It is the page's run (not one stopped, or replaced by a restart). A call, not a getter: it changes across awaits. */
  live() {
    return this.#holder.run === this;
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
