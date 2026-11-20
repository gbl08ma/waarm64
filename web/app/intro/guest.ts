// The introduction's guest, from the page's side (IntroGuest.svelte's run, intro/guest-run.svelte.ts; docs/frontend.md "The introduction"): a worker of
// its own (intro/guest-worker.ts) that runs the small machine in the first screen's frame. Not the page's machine:
// it has no record, no toolbar, nothing kept, and a stored machine running under the introduction doesn't know of it.
import type { FromGuest, GuestStats, ToGuest } from './guest-protocol.ts';

/** How long a stop waits for the worker's own teardown before the worker is ended anyway. */
const STOP_MS = 2000;

/**
 * Whether this browser can run the guest at all: shared memory (the page is cross-origin isolated) and a canvas a
 * worker can draw on. Where it can't, the first screen shows the machine's plate alone.
 */
export const canRunGuest = () =>
  typeof SharedArrayBuffer !== 'undefined' &&
  globalThis.crossOriginIsolated &&
  typeof Worker !== 'undefined' &&
  typeof DecompressionStream !== 'undefined' &&
  typeof HTMLCanvasElement !== 'undefined' &&
  'transferControlToOffscreen' in HTMLCanvasElement.prototype;

export type GuestOptions = {
  /** The frame's canvas: handed to the worker for good (a canvas is transferred once; a new start needs a new one). */
  canvas: HTMLCanvasElement;
  /** The framebuffer's pixels and the terminal's size. */
  width: number;
  height: number;
  cols: number;
  rows: number;
  /** The serial port's output, as it comes. */
  onOutput: (text: string) => void;
  /** The first frame with something on it is shown. */
  onScreen?: () => void;
  onStats?: (stats: GuestStats) => void;
  /** The guest powered off, or failed (`detail` is for the console). */
  onEnd: (state: 'off' | 'failed', detail?: string) => void;
};

export type Guest = {
  /** Types on the guest's serial port. */
  send(data: string | Uint8Array): void;
  /** No guest code runs and nothing is drawn until `resume` (scrolled out of view, a hidden tab). */
  pause(): void;
  resume(): void;
  /** Ends the guest and frees what it took; resolves once that's done. */
  stop(): Promise<void>;
};

export function startGuest(o: GuestOptions): Guest {
  const worker = new Worker(new URL('./guest-worker.ts', import.meta.url), { type: 'module' });
  const serial = new MessageChannel();
  const post = (m: ToGuest, transfer: Transferable[] = []) => worker.postMessage(m, transfer);
  let ended = false;
  let stopped: (() => void) | undefined;
  let stopping: Promise<void> | undefined;
  const end = (state: 'off' | 'failed', detail?: string) => {
    if (ended) return;
    ended = true;
    o.onEnd(state, detail);
  };
  worker.onmessage = (e: MessageEvent<FromGuest>) => {
    const m = e.data;
    if (m.type === 'stopped') stopped?.();
    else if (stopping)
      return; // nothing more is said of a run that was told to stop
    else if (m.type === 'output') o.onOutput(m.text);
    else if (m.type === 'screen') o.onScreen?.();
    else if (m.type === 'stats') o.onStats?.(m.stats);
    else end(m.state, m.detail);
  };
  // A worker that didn't load, or threw outside its own handling.
  worker.onerror = (e) => {
    e.preventDefault();
    end('failed', e.message);
  };
  const screen = o.canvas.transferControlToOffscreen();
  post({ type: 'start', screen, serial: serial.port2, width: o.width, height: o.height, cols: o.cols, rows: o.rows }, [
    screen,
    serial.port2,
  ]);
  return {
    send: (data) => serial.port1.postMessage(data),
    pause: () => post({ type: 'pause' }),
    resume: () => post({ type: 'resume' }),
    stop: () =>
      (stopping ??= new Promise<void>((resolve) => {
        ended = true; // nothing more is said of it
        const done = () => {
          clearTimeout(timer);
          worker.terminate();
          serial.port1.close();
          resolve();
        };
        const timer = setTimeout(done, STOP_MS);
        stopped = done;
        post({ type: 'stop' });
      })),
  };
}
