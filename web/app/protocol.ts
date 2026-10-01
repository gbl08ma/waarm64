// The page ⇄ machine-worker protocol (docs/frontend.md "The worker protocol").
// The seed of phase D's embedding API: not frozen. Types only.
import type { VcpuLiveness } from '../liveness.ts';
import type { Credential, DiskChoice, MachineName } from './machine.ts';

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
    /** Extra kernel parameters (the page's `?params=`, for development: e.g. a rescue shell). Not for a `firmware` machine: its bootloader owns the command line. */
    params?: string;
    /**
     * Systemd credentials to give a `firmware` machine over fw_cfg beyond its own (the page's
     * `?credential=name:value`, for development and tests: `login.noauth:yes` and the `firstboot.*`
     * ones boot Debian unattended). The release page passes none.
     */
    credentials?: Credential[];
    /**
     * The root disk to boot instead of the machine's own (the page's picker, a dropped file or
     * `?disk=<url>`): a `File` goes to the device worker as is, read in slices. Its `overlay` is the
     * OPFS directory for what the machine writes and for the variable store.
     */
    disk?: DiskChoice;
    /** A second, read-only virtio-blk (the page's `?disk2=<url>`, for tests: /dev/vdb), served over HTTP ranges like the root. */
    disk2?: string;
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
  /** Blocks compiled since boot (all vCPUs; a flush doesn't reset it), and how often the code cache was flushed (its byte budget, docs/jit.md "Memory"). */
  jitBlocks: number;
  jitFlushes: number;
  jitCompileMs: number;
  irqs: number;
  /** The worker's run loop: the longest gap between its iterations since the last status (ms), and ms since the last one now (the stress test, bench/stress). */
  loopMaxMs: number;
  loopAgeMs: number;
  /** Each vCPU worker's timing of its `vm_run_cpu` calls (web/liveness.ts). */
  vcpus: VcpuLiveness[];
};
