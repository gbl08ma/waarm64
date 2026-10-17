// The page ⇄ machine-worker protocol (docs/frontend.md "The worker protocol").
// The seed of phase D's embedding API: not frozen. Types only.
import type { VcpuLiveness } from '../liveness.ts';
import type { Timeline } from '../profiler.ts';
import type { Vm } from '../vm.ts';
import type { Credential, MachineName } from './machine.ts';
import type { Shape } from './shape.ts';
import type { DiskPlan, SnapshotDisk } from '../snapshot.ts';

/**
 * loading: fetching the core and the images; booting: the VM runs, its `ready` output not seen
 * yet; running: seen; off: powered off; rebooting: the guest asked for a reset (the page starts a
 * new machine); suspended: stopped with its memory kept beside its disk (docs/frontend.md
 * "Suspend"): the next start resumes it; crashed: the guest panicked or the emulator failed; failed: the machine couldn't
 * start (a missing file, the disk in use, no memory). crashed and failed come with a `message`
 * and a `problem`.
 */
export type PowerState = 'loading' | 'booting' | 'running' | 'off' | 'suspended' | 'rebooting' | 'crashed' | 'failed';

/**
 * What went wrong, for the page to offer the right action: `missing-core` (the wasm isn't built),
 * `missing-image` (an image file isn't there), `disk-in-use` (another tab has the disk overlay
 * open), `disk-mismatch` (the overlay was written over another image), `memory` (the guest's RAM
 * couldn't be reserved), `panic` (the guest kernel's panic line), `snapshot` (a snapshot was refused:
 * its message says why and what to do), `emulator` (anything else).
 */
export type Problem = 'missing-core' | 'missing-image' | 'disk-in-use' | 'disk-mismatch' | 'memory' | 'panic' | 'snapshot' | 'emulator';

/** Page → worker. One machine per worker: a restart is a new worker (the page's `stop`, then `terminate`). */
export type ToWorker =
  | {
    type: 'start';
    machine: MachineName;
    ncpus: number;
    /** The guest's RAM, MiB (the machine's default, or the page's choice; a snapshot's own size wins). */
    ramMiB: number;
    /** The page's sound (web/audio.ts `attach`): the ring the virtio-snd plays into, the microphone's ring it records from, and the port it says its streams' starts and stops on. */
    sound?: { ring: SharedArrayBuffer; mic: SharedArrayBuffer; port: MessagePort };
    /** virtio-input's ports (web/input.ts sends to them; the keyboard's LEDs come back). */
    keyboard: MessagePort;
    tablet: MessagePort;
    /** Bytes or strings for the PL011 (`BootOptions.serialIn`). */
    serial: MessagePort;
    /** The screen's canvas (`transferControlToOffscreen`, sized as the machine's framebuffer): the worker draws it (web/display.ts). Not on a 3D machine: the GPU worker has it. */
    screen?: OffscreenCanvas;
    /**
     * A 3D machine (the page's default where WebGL2 is; `?gpu=2d` turns it off): the GPU worker's port (web/gpu-worker.ts, which has the
     * screen) and the caps it gives the guest (web/virgl-caps.ts). The virtio-gpu gets virgl and renders there.
     */
    renderer?: MessagePort;
    caps?: Uint8Array;
    /** The display port (web/gpu-present.ts): `mode` messages from a virtio-gpu, and the page's `size` to it. */
    display: MessagePort;
    /** The display's size at the start (the page's screen box, `wantedSize` in main.ts): the console and the firmware get it with no event. Default: the machine's. */
    size?: { width: number; height: number };
    /** Use the `simple-framebuffer` on a machine that has a virtio-gpu (the page's `?display=simple`). */
    simple?: boolean;
    /** The display reports its draw latencies (`draw-stats` on the display port, kept in `window.__drawStats`; the page's `?displaystats`, for bench/gpu). */
    displayStats?: boolean;
    /** The display posts `flash` when a draw turns the screen's centre bright (the page's `?avprobe`: A/V sync, bench/audio/avsync.ts; times in `window.__flashes`). */
    avProbe?: boolean;
    /**
     * The vCPUs' optional features (`BootOptions.rng`, `e0pd`), all on by default; the page's `?rng=0`, `?e0pd=0`
     * turn one off (development: the A/B of bench/boot/REPORT.md "M9: FEAT_RNG and FEAT_E0PD"). A snapshot's are its own.
     */
    cpu?: { rng?: boolean; e0pd?: boolean };
    /** Extra kernel parameters (the page's `?params=`, for development: e.g. a rescue shell). Not for a `firmware` machine: its bootloader owns the command line. */
    params?: string;
    /**
     * Systemd credentials to give a `firmware` machine over fw_cfg beyond its own (the page's
     * `?credential=name:value`, for development and tests: `login.noauth:yes` and the `firstboot.*`
     * ones boot Debian unattended). The release page passes none.
     */
    credentials?: Credential[];
    /** The machine's disks in slot order (docs/plans/machines.md §4.1: at most `MAX_DISKS`), resolved by the page. */
    disks: StartDisk[];
    /**
     * The OPFS directory of the machine's own files: the firmware's variable store (`flash`) and a suspended machine
     * (`suspend`). A stored machine's `machines/<id>`; a transient one's is its first writable disk's overlay. None:
     * neither is kept.
     */
    home?: string;
    /**
     * The gateway's end of the machine's IP port (web/gateway.ts `portBackend`): the machine gets a
     * network card (virtio-net) and its `network` command line. The page keeps the other end and
     * gives it to a Tailscale client (web/app/network.ts). Only for a machine with `network`.
     */
    ip?: MessagePort;
    /**
     * Start from this snapshot file (the page's Load snapshot) instead of booting: the machine, its
     * devices and its vCPU count are the header's (below, docs/frontend.md "Snapshots"), the disk's
     * overlay is replaced by the file's blocks. `ncpus` and `ramMiB` are then ignored.
     */
    snapshot?: File;
    /**
     * False: boot even if a suspended machine is kept beside the disk (it is dropped). Otherwise a
     * start resumes one if there is one and its pins match (docs/frontend.md "Suspend").
     */
    resume?: boolean;
    /**
     * The machine as its snapshots describe it (docs/plans/machines.md §5.1): its name, shape and the shape's hash, and
     * the URLs of its URL disks by slot (a file restored elsewhere can make its machine). A snapshot whose shape hash
     * isn't this one is refused. Transient machines (the tests') have none: their snapshots are checked by devices.
     */
    about?: { name: string; shape: Shape; shapeHash: string; urls: Record<number, string> };
    /** What a restore does with each writable disk the snapshot pins (web/snapshot.ts `DiskPlan`); none: replace each. */
    plan?: DiskPlan[];
  }
  /**
   * Suspend the running machine: it pauses, its snapshot (without the disk's changes, which stay
   * in the overlay) is written beside the overlay, and it stops: state `suspended`. On a failure it
   * runs on, with a `snapshot-error`. Progress comes as `snapshot-progress`.
   */
  | { type: 'suspend' }
  /**
   * Save a snapshot of the running machine (`running` or `booting`): it pauses, the file is written,
   * it runs on. The bytes go to `handle`'s writable stream (from `showSaveFilePicker`), or, without
   * one, back in `snapshot-chunk` messages, or, with `keep`, to that OPFS file (a kept snapshot: docs/plans/machines.md
   * §5.2). A disk written in place has its blocks in the file only with `whole` (its whole store). Answered by
   * `snapshot-done` or `snapshot-error`.
   */
  | { type: 'snapshot'; handle?: FileSystemFileHandle; keep?: string; whole?: boolean }
  /** Stop the vCPUs and release the disk overlay; answered by `stopped`. */
  | { type: 'stop' }
  /** Benchmarks (`?displaystats`, bench/gpu/sway-load.ts): start or stop the guest PC sampler over every vCPU; a stop is answered by `profile`. */
  | { type: 'profile'; on: boolean }
  /** Benchmarks: start or stop the vCPU timeline (web/profiler.ts `startTimeline`); a stop is answered by `timeline`. */
  | { type: 'timeline'; on: boolean };

/**
 * Where a disk's bytes come from: an image by URL (read by ranges) or as a `File` (read in slices), a blank disk of
 * `blank` bytes (zeros), a ramdisk of `ramdisk` bytes, or a disk stored in the browser (its OPFS directory,
 * `disks/<id>`, and size: web/stored.ts). A stored disk written in place is a blank source with the store as its
 * overlay.
 */
export type DiskSource = { url: string } | { file: File } | { blank: number } | { ramdisk: number } | { stored: string; size: number };

/**
 * A disk of the machine being started (docs/plans/machines.md §4.2): where its bytes come from (a URL read by
 * ranges, a `File` read in slices in the device worker, a blank disk of `blank` bytes reading as zeros, a ramdisk
 * of `ramdisk` bytes, empty at every start), and the OPFS overlay its writes go to. Without an overlay a disk is
 * read-only, unless it is a ramdisk.
 */
export type StartDisk = {
  /** Its name in messages (a file's, a URL's last part). */
  name: string;
  source: DiskSource;
  /** The OPFS directory of its changes (web/overlay.ts). */
  overlay?: string;
  /** What the overlay belongs to (default: the source's, web/devices.ts `diskIdentity`). */
  identity?: string;
  /** What the guest's GET_ID gets (default `webpc-blk`). */
  serial?: string;
  /** The machine's own image (`MachineSpec.disk`): a snapshot's header names no disk for it (`disk: null`). */
  own?: true;
};

/** A disk for the disk jobs (export, changes in): its source, the overlay of its changes and what that overlay belongs to (default `diskIdentity`'s). */
export type DiskRef = { source: DiskSource; overlay?: string; identity?: string };

/** Worker → page. */
export type FromWorker =
  | { type: 'state'; state: PowerState; message?: string; problem?: Problem }
  /** Download progress while `loading` (the core, the kernel, the initrd), in bytes. */
  | { type: 'progress'; loaded: number; total: number }
  /** The screen first showed something (the guest's console took it): once per machine. */
  | { type: 'screen' }
  /**
   * What the guest wrote to its serial console (UTF-8 decoded). `replay`: the saved tail of a
   * snapshot's terminal, shown again: the terminal's answers to queries in it (cursor position)
   * aren't sent to the guest, which isn't asking now.
   */
  | { type: 'serial'; data: string; replay?: boolean }
  /** The guest has (or no longer has) a driver using the keyboard: while it hasn't, the page sends the screen's keys to the serial console (the firmware's menus, GRUB). */
  | { type: 'keyboard'; live: boolean }
  | { type: 'status'; status: Status }
  /** What a `loading` machine started from a snapshot is doing (it has no download to report). */
  | { type: 'phase'; text: string }
  /** A save's progress: the phase and the fraction done of it (0 when unknown). */
  | { type: 'snapshot-progress'; phase: string; fraction: number }
  /** The next bytes of the file, when the save had no `handle` (transferred, in order). */
  | { type: 'snapshot-chunk'; data: Uint8Array }
  /** The file is complete: its size, ms the machine was paused (from the pause request to the resume), and the disks it pins. */
  | { type: 'snapshot-done'; bytes: number; pausedMs: number; pins: SnapshotDisk[] }
  /** The save failed (the machine runs on, unless it had ended): a message for the user. */
  | { type: 'snapshot-error'; message: string }
  /** The PC sampler's histogram since `profile` started it: [pc in hex, samples] (any vCPU). */
  | { type: 'profile'; samples: [string, number][] }
  /** The vCPU timeline since `timeline` started it (web/profiler.ts `Timeline`). */
  | { type: 'timeline'; timeline: Timeline }
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
  /** Instructions retired in JIT code (the rest were interpreted) and the wasm bytes compiled since boot (all vCPUs). */
  jitSteps: number;
  jitBytes: number;
  irqs: number;
  /** The worker's run loop: the longest gap between its iterations since the last status (ms), and ms since the last one now (the stress test, bench/stress). */
  loopMaxMs: number;
  loopAgeMs: number;
  /** Each vCPU worker's timing of its `vm_run_cpu` calls (web/liveness.ts). */
  vcpus: VcpuLiveness[];
  /** Every counter, summed over the vCPUs (`Vm.stats`): for harnesses that diff them across a run (bench/apps). */
  stats: ReturnType<Vm['stats']>;
};
