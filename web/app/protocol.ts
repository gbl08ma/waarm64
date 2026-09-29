// The page ⇄ machine-worker protocol (docs/frontend.md "The worker protocol").
// The seed of phase D's embedding API: not frozen. Types only.
import type { MachineName } from './machine.ts';

/** booting: the VM runs, its `ready` output not seen yet; running: seen; off: powered off; crashed: see `message`. */
export type PowerState = 'loading' | 'booting' | 'running' | 'off' | 'rebooting' | 'crashed';

/** Page → worker. One machine per worker: a restart is a new worker (the page's `stop`, then `terminate`). */
export type ToWorker =
  | {
    type: 'start';
    machine: MachineName;
    ncpus: number;
    /** virtio-input's ports (web/input.ts sends to them; the keyboard's LEDs come back). */
    keyboard: MessagePort;
    tablet: MessagePort;
    /** Bytes or strings for the PL011 (`BootOptions.serialIn`). */
    serial: MessagePort;
    /** The screen's canvas (`transferControlToOffscreen`, sized as the machine's framebuffer): the worker draws it (web/display.ts). */
    screen: OffscreenCanvas;
  }
  /** Stop the vCPUs and release the disk overlay; answered by `stopped`. */
  | { type: 'stop' };

/** Worker → page. */
export type FromWorker =
  | { type: 'state'; state: PowerState; message?: string }
  /** What the guest wrote to its serial console (UTF-8 decoded). */
  | { type: 'serial'; data: string }
  | { type: 'status'; status: Status }
  | { type: 'stopped' };

/** Once a second while the machine runs. */
export type Status = {
  ncpus: number;
  ramMiB: number;
  /** ms since the VM started running. */
  uptime: number;
  /** Guest instructions retired (all vCPUs). */
  steps: number;
  jitBlocks: number;
  jitCompileMs: number;
  irqs: number;
};
