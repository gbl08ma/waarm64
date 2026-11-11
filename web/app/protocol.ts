// The page ⇄ machine-worker protocol (docs/frontend.md "The worker protocol").
// The seed of phase D's embedding API: not frozen. Types only.
import type { VcpuLiveness } from '../liveness.ts';
import type { Timeline } from '../profiler.ts';
import type { Vm } from '../vm.ts';
import type { FolderSpec } from '../9p-folders.ts';
import type { Credential, MachineName } from './machine.ts';
import type { Shape } from './shape.ts';
import type { GuestWords } from './guest-unit.ts';
import type { DiskPlan, SnapshotDisk } from '../snapshot.ts';
import type { Msg, WireError } from '../msg.ts';

/**
 * loading: fetching the core and the images; booting: the VM runs, its `ready` output not seen
 * yet; running: seen; off: powered off; rebooting: the guest asked for a reset (the page starts a
 * new machine); suspended: stopped with its memory kept beside its disk (docs/frontend.md
 * "Suspend"): the next start resumes it; crashed: the guest panicked or the emulator failed; failed: the machine couldn't
 * start (a missing file, the disk in use, no memory). crashed and failed come with an `error`
 * and a `problem`.
 */
export type PowerState = 'loading' | 'booting' | 'running' | 'off' | 'suspended' | 'rebooting' | 'crashed' | 'failed';

/**
 * What went wrong, for the page to offer the right action: `missing-core` (the wasm isn't built),
 * `missing-image` (an image file isn't there), `disk-in-use` (another tab has the disk overlay
 * open), `disk-mismatch` (the overlay was written over another image), `memory` (the guest's RAM
 * couldn't be reserved), `panic` (the guest kernel's panic line), `snapshot` (a snapshot was refused:
 * its error says why and what to do), `emulator` (anything else).
 */
export type Problem =
  'missing-core' | 'missing-image' | 'disk-in-use' | 'disk-mismatch' | 'memory' | 'panic' | 'snapshot' | 'emulator';

/** Page → worker. One machine per worker: a restart is a new worker (the page's `stop`, then `terminate`). */
export type ToWorker =
  | {
      type: 'start';
      /** The page's query (`location.search`), for the worker's own knobs (`?snd=`, `?gpu=`, `?jit=`, `?fma=`, `?growcore`, `?vyield=`). */
      query: string;
      machine: MachineName;
      ncpus: number;
      /** The guest's RAM, MiB (the machine's default, or the page's choice; a snapshot's own size wins). */
      ramMiB: number;
      /** Its split as the user set it (`MachineRecord.ramSplit`, `?split=`), MiB, memory 0 first; absent: the automatic one. */
      ramSplit?: number[];
      /** The JIT's code cache budget, MiB (`MachineRecord.jitMiB`, `?jitmb=`; `BootOptions.jitBytes`); absent: the core's default. */
      jitMiB?: number;
      /** The guest's keyboard layout (`MachineRecord.keyboard`, `?keyboard=`; web/app/keyboard.ts), for a `firmware` machine; absent: none set. */
      keyLayout?: string;
      /** The guest takes the network's settings (`MachineRecord.netConfig`, `?netconfig=0` turns it off; web/app/guest-net.ts): the page's .network credential and the unit. */
      netConfig: boolean;
      /** The page's sound (web/audio.ts `attach`): the ring the virtio-snd plays into, the microphone's ring it records from, the port it says its streams' starts and stops on (and the volume, both ways), and the volume level and mute it starts with. */
      sound?: { ring: SharedArrayBuffer; mic: SharedArrayBuffer; port: MessagePort; level: number; muted: boolean };
      /** virtio-input's ports (web/input.ts sends to them; the keyboard's LEDs come back). */
      keyboard: MessagePort;
      tablet: MessagePort;
      /** A relative mouse's and a touchscreen's ports, for a machine that has them (a stored machine's `mouse` and `touch`, a transient one's `?mouse=1`, `?touch=1`). */
      mouse?: MessagePort;
      touch?: MessagePort;
      /** The clock device (virtio-rtc): a stored machine's `clock`, a transient one's unless `?clock=0`. */
      clock?: boolean;
      /**
       * The agent's port (web/agent-device.ts; web/app/agent-link.ts has the page's end), for a machine with clipboard
       * sharing (a stored machine's `clipboard`, a transient one's `?clipboard=1`): the machine gets the agent's device.
       */
      agent?: MessagePort;
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
      /** Vulkan through Venus beside 3D (the machine's setting or `?gpu=vulkan`; docs/devices.md "Venus"). */
      vulkan?: boolean;
      /** The display port (web/gpu-present.ts): `mode` messages from a virtio-gpu, and the page's `size` to it; `png` ("Copy the screen") to whoever draws the screen, a virtio-gpu or the framebuffer here. */
      display: MessagePort;
      /** The display's size at the start (the page's screen box, `wantedSize` in web/app/areas/screen-view.ts): the console and the firmware get it with no event. Default: the machine's. */
      size?: { width: number; height: number };
      /** Use the `simple-framebuffer` on a machine that has a virtio-gpu (the page's `?display=simple`). */
      simple?: boolean;
      /** The display reports its draw latencies (`draw-stats` on the display port, kept in `window.__drawStats`; the page's `?displaystats`, for bench/gpu). */
      displayStats?: boolean;
      /** The disks keep stage timers and a trace of their base reads, answered on the `webpc-iostats` BroadcastChannel (the page's `?iostats`, for bench/remote-disk). */
      ioStats?: boolean;
      /** A remote disk's blocks aren't kept in OPFS (the page's `?diskcache=0`: bench/remote-disk's A/B). */
      noDiskCache?: boolean;
      /** The display posts `flash` when a draw turns the screen's centre bright (the page's `?avprobe`: A/V sync, bench/audio/avsync.ts; times in `window.__flashes`). */
      avProbe?: boolean;
      /**
       * The vCPUs' optional features (`BootOptions.rng`, `e0pd`, `sha3`, `jscvt`, `rcpc`, `sb`, `flagm`, `dit`, `frintts`, `dotprod`, `i8mm`, `rdm`, `rcpc2`, `fcma`, `fp16`, `fhm`, `bf16`), all on but `i8mm`, `fcma`, `fp16`, `fhm` and `bf16` by default; the page's `?rng=0`,
       * `?e0pd=0`, `?sha3=0`, `?jscvt=0` and the rest turn one off, `?i8mm=1`, `?fcma=1`, `?fp16=1`, `?fhm=1` and `?bf16=1` turn those on (development: the A/B of bench/boot/REPORT.md "M9: FEAT_RNG and FEAT_E0PD").
       * A snapshot's are its own.
       */
      cpu?: {
        rng?: boolean;
        e0pd?: boolean;
        sha3?: boolean;
        jscvt?: boolean;
        rcpc?: boolean;
        sb?: boolean;
        flagm?: boolean;
        dit?: boolean;
        frintts?: boolean;
        dotprod?: boolean;
        i8mm?: boolean;
        rdm?: boolean;
        rcpc2?: boolean;
        fcma?: boolean;
        fp16?: boolean;
        fhm?: boolean;
        bf16?: boolean;
      };
      /** Extra kernel parameters (the page's `?params=`, for development: e.g. a rescue shell). Not for a `firmware` machine: its bootloader owns the command line. */
      params?: string;
      /**
       * Systemd credentials to give a `firmware` machine over fw_cfg beyond its own (the page's
       * `?credential=name:value`, for development and tests: `login.noauth:yes` and the `firstboot.*`
       * ones boot Debian unattended). The release page passes none.
       */
      credentials?: Credential[];
      /** The words of the units the page has the guest run (web/app/guest-words.ts): the page renders them, the worker places them. */
      guest: GuestWords;
      /** The machine's disks in slot order (docs/machines.md §4.1: at most `MAX_DISKS`), resolved by the page. */
      disks: StartDisk[];
      /**
       * The OPFS directory of the machine's own files: the firmware's variable store (`flash`) and a suspended machine
       * (`suspend`). A stored machine's `machines/<id>`; a transient one's is its first writable disk's overlay. None:
       * neither is kept.
       */
      home?: string;
      /**
       * The machine's network adapters in order (docs/network-adapters.md): each a virtio-net with its MAC on its
       * own gateway, whose end of the adapter's IP port is `ip` (web/gateway.ts `portBackend`). The page keeps the other
       * end and gives it to a client (web/app/network.ts). The machine gets its `network` credentials when it has any.
       * Only for a machine with `network`.
       */
      nets?: { mac: string; ip: MessagePort }[];
      /**
       * The machine has a USB controller (an xHCI, docs/usb.md "The page"): this port carries the page's `usb-attach` and
       * `usb-detach` to the device worker and its `usb-state` back (web/usb-device.ts `UsbToWorker`, `UsbFromWorker`). The
       * page attaches its devices once the machine runs (at a start, a resume and a restore alike: a snapshot's ports are
       * empty). None: no controller (a stored machine's `usb`, a transient one's `?usb=1`).
       */
      usb?: MessagePort;
      /**
       * The machine has shared folders (docs/shares.md): the one virtio-9p device, on what can be served now (`list`); `port`
       * carries the page's attachments and grants to the device worker (web/9p-folders.ts `FoldersToDevice`). None: no device.
       */
      folders?: { list: FolderSpec[]; port: MessagePort };
      /** The mount point the page sets in the guest (`MachineRecord.sharesPath`, web/app/shares-mount.ts), for a `firmware` machine; none: not mounted. */
      sharesPath?: string;
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
       * The machine as its snapshots describe it (docs/machines.md §5.1): its name, shape and the shape's hash, and
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
   * runs on, with a `snapshot-error`. Progress comes as `snapshot-progress`. `sleep`: the page has
   * pressed the guest's sleep key (the clock catch-up, docs/frontend.md "The guest's clock"): it waits
   * a while for the guest to suspend itself first, and the file then says it slept.
   */
  | { type: 'suspend'; sleep?: boolean }
  /**
   * Save a snapshot of the running machine (`running` or `booting`): it pauses, the file is written,
   * it runs on. The bytes go to `handle`'s writable stream (from `showSaveFilePicker`), or, without
   * one, back in `snapshot-chunk` messages, or, with `keep`, to that OPFS file (a kept snapshot: docs/machines.md
   * §5.2). A disk written in place has its blocks in the file only with `whole` (its whole store). Answered by
   * `snapshot-done` or `snapshot-error`. `sleep`: as `suspend`'s; the guest is woken once the file is written.
   */
  | { type: 'snapshot'; handle?: FileSystemFileHandle; keep?: string; whole?: boolean; sleep?: boolean }
  /** Wake the guest if it is in PSCI SYSTEM_SUSPEND (`Status.asleep`): a key or a click reached it. */
  | { type: 'wake' }
  /** Stop the vCPUs and release the disk overlay; answered by `stopped`. */
  | { type: 'stop' }
  /** Benchmarks (`?displaystats`, bench/gpu/sway-load.ts): start or stop the guest PC sampler over every vCPU; a stop is answered by `profile`. */
  | { type: 'profile'; on: boolean }
  /** Benchmarks: what the core's heap has touched (web/vm.ts `heapUse`), answered by `heap`. */
  | { type: 'heap' }
  /** Benchmarks: start or stop the vCPU timeline (web/profiler.ts `startTimeline`); a stop is answered by `timeline`. */
  | { type: 'timeline'; on: boolean };

/**
 * Where a disk's bytes come from: an image by URL (read by ranges) or as a `File` (read in slices), a blank disk of
 * `blank` bytes (zeros), a ramdisk of `ramdisk` bytes (with `swap`, a swap area of that label turned on in the guest:
 * web/app/guest-swap.ts), or a disk stored in the browser (its OPFS directory,
 * `disks/<id>`, and size: web/stored.ts). A stored disk written in place is a blank source with the store as its
 * overlay.
 */
export type DiskSource =
  | { url: string }
  | { file: File }
  | { blank: number }
  | { ramdisk: number; swap?: string }
  | { stored: string; size: number };

/**
 * A disk of the machine being started (docs/machines.md §4.2): where its bytes come from (a URL read by
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
  /**
   * The machine's state. The worker renders no words (docs/i18n.md): `error` is what stopped it or went wrong on the way
   * (web/msg.ts `toWire`: its message is the headline, its causes the details; with a `problem`, the page offers the
   * action for it; without, a note such as a suspended copy that couldn't be resumed), `note` what the page says beside
   * the state (resumed, suspended).
   */
  | { type: 'state'; state: PowerState; error?: WireError; note?: Msg; problem?: Problem }
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
  /** Something the devices say while the machine runs on (a ramdisk out of memory): the message bar shows it. */
  | { type: 'notice'; message: Msg }
  /** What a `loading` machine started from a snapshot is doing (it has no download to report). */
  | { type: 'phase'; text: Msg }
  /** A save's progress: the phase and the fraction done of it (0 when unknown). */
  | { type: 'snapshot-progress'; phase: Msg; fraction: number }
  /** The next bytes of the file, when the save had no `handle` (transferred, in order). */
  | { type: 'snapshot-chunk'; data: Uint8Array }
  /** The file is complete: its size, ms the machine was paused (from the pause request to the resume), and the disks it pins. */
  /** `stateMs`: the devices' state, of the pause (the 3D renderer's read-back is in it); `blobBytes`: their binary parts (the 3D contents), before compression. */
  | {
      type: 'snapshot-done';
      bytes: number;
      pausedMs: number;
      stateMs: number;
      blobBytes: number;
      pins: SnapshotDisk[];
      slept?: boolean;
    }
  /** The save failed (the machine runs on, unless it had ended): the error for the user (`toWire`). */
  | { type: 'snapshot-error'; error: WireError }
  /** The PC sampler's histogram since `profile` started it: [pc in hex, samples] (any vCPU). */
  | { type: 'profile'; samples: [string, number][] }
  /** `heap`'s answer (web/vm.ts `heapUse`). */
  | {
      type: 'heap';
      heap: {
        belowBytes: number;
        reserveBytes: number;
        touchedBytes: number;
        highBytes: number;
        buckets: number[];
        arenaBytes: number;
        arenaTouchedBytes: number;
        arenaHighBytes: number;
      };
    }
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
  /** What the machine holds that the host pays for (`Vm.hostUse`: RAM, the core's heap, the JIT's cache), for the page's memory signal (web/app/memory.ts). */
  memory: ReturnType<Vm['hostUse']>;
  /**
   * Each disk's bytes the guest read and wrote since this start (a restart, a resume or a snapshot's load starts again
   * at 0), counted as its virtio-blk requests complete (failed ones, flushes, discards and write-zeroes count nothing):
   * one per entry of the start message's `disks`, in its order (that is, by slot). Undefined only from a worker that
   * doesn't count them. USB mass storage isn't in it: it is in `usb`.
   */
  disks?: { read: number; written: number }[];
  /**
   * A machine with a USB controller (docs/usb.md): its devices' bytes since this start, all of them together (they come
   * and go while it runs), counted as the xHCI's transfers complete: `in` what they gave the guest, `out` what they took.
   */
  usb?: { in: number; out: number };
  /**
   * Each network adapter's bytes since this start, as the guest sees them: `rx` the frames given to the guest, `tx` the
   * frames it sent (Ethernet frames without virtio's header; a large TCP/UDP send counts once, before its segments).
   * One per entry of the start message's `nets`, in its order; undefined for a machine without `network` (its `nets`
   * then make no adapters).
   */
  nets?: { rx: number; tx: number }[];
  /**
   * Each vCPU's instructions retired and the part of them in JIT code since this start (`Vm.cpuStats`), by vCPU
   * number. Only where every vCPU counts in its own block (`Vm.parallel`, which the page's machines always are);
   * undefined in round-robin mode, where vCPU 0's block counts them all.
   */
  cpus?: { steps: number; jitSteps: number }[];
  /** The guest has suspended itself (PSCI SYSTEM_SUSPEND): it sleeps until a `wake`. */
  asleep?: boolean;
};
