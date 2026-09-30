// The page ⇄ machine-worker protocol (docs/frontend.md "The worker protocol").
// The seed of phase D's embedding API: not frozen. Types only.
import type { VcpuLiveness } from '../liveness.ts';
import type { MachineName } from './machine.ts';

/**
 * loading: fetching the core and the images; booting: the VM runs, its `ready` output not seen
 * yet; running: seen; off: powered off; rebooting: the guest asked for a reset (the page starts a
 * new machine); crashed: the guest panicked or the emulator failed; failed: the machine couldn't
 * start (a missing file, the disk in use, no memory). crashed and failed come with a `message`
 * and a `problem`.
 */
export type PowerState = 'loading' | 'booting' | 'running' | 'off' | 'rebooting' | 'crashed' | 'failed';

/**
 * What went wrong, for the page to offer the right action: `missing-core` (the wasm isn't built),
 * `missing-image` (an image file isn't there), `disk-in-use` (another tab has the disk overlay
 * open), `disk-mismatch` (the overlay was written over another image), `memory` (the guest's RAM
 * couldn't be reserved), `panic` (the guest kernel's panic line), `emulator` (anything else).
 */
export type Problem = 'missing-core' | 'missing-image' | 'disk-in-use' | 'disk-mismatch' | 'memory' | 'panic' | 'emulator';

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
    /** Extra kernel parameters (the page's `?params=`, for development: e.g. a rescue shell). */
    params?: string;
    /**
     * The gateway's end of the machine's IP port (web/gateway.ts `portBackend`): the machine gets a
     * network card (virtio-net) and its `network` command line. The page keeps the other end and
     * gives it to a Tailscale client (web/app/network.ts). Only for a machine with `network`.
     */
    ip?: MessagePort;
  }
  /** Stop the vCPUs and release the disk overlay; answered by `stopped`. */
  | { type: 'stop' };

/** Worker → page. */
export type FromWorker =
  | { type: 'state'; state: PowerState; message?: string; problem?: Problem }
  /** Download progress while `loading` (the core, the kernel, the initrd), in bytes. */
  | { type: 'progress'; loaded: number; total: number }
  /** The screen first showed something (the guest's console took it): once per machine. */
  | { type: 'screen' }
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
  /** The worker's run loop: the longest gap between its iterations since the last status (ms), and ms since the last one now (the stress test, bench/stress). */
  loopMaxMs: number;
  loopAgeMs: number;
  /** Each vCPU worker's timing of its `vm_run_cpu` calls (web/liveness.ts). */
  vcpus: VcpuLiveness[];
};
