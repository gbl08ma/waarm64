// The page ⇄ machine-worker protocol (docs/frontend.md "The worker protocol").
// The seed of phase D's embedding API: not frozen. Types only.
import type { VcpuLiveness } from '../liveness.ts';
import type { Timeline } from '../profiler.ts';
import type { Vm } from '../vm.ts';
import type { FolderSpec } from '../9p-folders.ts';
import type { Credential, MachineName } from './machine.ts';
import type { CpuFeature, Display, Shape } from './shape.ts';
import type { GuestWords } from './guest-unit.ts';
import type { DiskPlan, RestorePhases, SavePhases, SnapshotDisk } from '../snapshot.ts';
import type { Msg, WireError } from '../msg.ts';
import type { DevKnobs } from './run/dev-knobs.ts';
import type { InspectAnswer, InspectQuery } from '../surface.ts';

/**
 * loading: fetching the core and the images; booting: the VM runs, its `ready` output not seen
 * yet (nor the guest's own sign: `up`); running: seen; off: powered off; rebooting: the guest asked for a reset (the page starts a
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

/**
 * What the machine is, as the page resolved it (web/app/run/config.ts, docs/frontend.md "Query parameters"): built
 * once per start from the address, the stored machine's record, the browser's settings and what this browser can do.
 * The worker lays its devices out from it (`slots`, as the page's shape does) and finds each one's channel in the
 * start's `ports`. A snapshot's header decides what it says of the size, the devices and the features instead.
 */
export type MachineConfig = {
  machine: MachineName;
  ncpus: number;
  /** The guest's RAM, MiB, and its split as the user set it (`MachineRecord.ramSplit`, `?split=`), memory 0 first; no split: the automatic one. */
  ram: { mib: number; split?: number[] };
  /** The JIT's code cache budget, MiB (`MachineRecord.jitMiB`, `?jitmb=`; `BootOptions.jitBytes`); none: the core's default. */
  jitMiB?: number;
  /**
   * The vCPUs' features (web/cpu-features.ts, `BootOptions.cpu`): the defaults unless the page's `?<feature>=0` turns
   * one off or `?<feature>=1` another on (development: the A/B of bench/boot/REPORT.md "M9: FEAT_RNG and FEAT_E0PD").
   */
  cpu: CpuFeature[];
  /**
   * The display (the page's `effectiveDisplay`): `none` for the `simple-framebuffer` (a machine without a virtio-gpu,
   * or the page's `?display=simple`), else a virtio-gpu, with virgl when the ports have a `renderer` (`3d`).
   */
  display: Display | 'none';
  /** Vulkan through Venus beside 3D (the machine's setting or `?gpu=vulkan`; docs/devices.md "Venus"): only with a `renderer`. */
  vulkan: boolean;
  /**
   * The devices besides the fixed ones (`slots`): the network adapters (one per `ports.nets`; none without `network`),
   * a relative mouse and a touchscreen, the clock (virtio-rtc), shared folders (virtio-9p) and the USB controller (an
   * xHCI, docs/usb.md "The page"); and what the guest agent does over vsock (`agent`: delivered at all; `clipboard`:
   * shares the clipboard), which isn't a device of its own.
   */
  devices: {
    nets: number;
    mouse: boolean;
    touch: boolean;
    clock: boolean;
    shares: boolean;
    agent: boolean;
    clipboard: boolean;
    usb: boolean;
  };
  /** What the page sets in the guest of a `firmware` machine (docs/frontend.md "What the page sets in the guest") and a direct-boot one's command line. */
  guest: {
    /** The keyboard layout (`MachineRecord.keyboard`, `?keyboard=`; web/app/keyboard.ts); none: none set. */
    keyLayout?: string;
    /** The guest takes the network's settings (`MachineRecord.netConfig`, `?netconfig=`; web/app/guest-net.ts): the page's .network credential and the unit. */
    netConfig: boolean;
    /** The shared folders' mount point (`MachineRecord.sharesPath`, web/app/shares-mount.ts); none: not mounted. */
    sharesPath?: string;
    /** Extra kernel parameters (the page's `?params=`, for development: e.g. a rescue shell). Not for a `firmware` machine: its bootloader owns the command line. */
    params?: string;
    /**
     * Systemd credentials to give a `firmware` machine over fw_cfg beyond its own (the page's
     * `?credential=name:value`, for development and tests: `login.noauth:yes` and the `firstboot.*`
     * ones boot Debian unattended). The release page passes none.
     */
    credentials: Credential[];
  };
  /** The address's development knobs for the machine worker (web/app/run/dev-knobs.ts), parsed by the page: the worker reads no query. */
  dev: DevKnobs;
};

/** The start's channels, one per device that has one (the page keeps the other ends: web/app/run/start-message.ts). */
export type MachinePorts = {
  /** virtio-input's (web/input.ts sends to them; the keyboard's LEDs come back), and a mouse's and a touchscreen's, for a machine that has them. */
  keyboard: MessagePort;
  tablet: MessagePort;
  mouse?: MessagePort;
  touch?: MessagePort;
  /** Bytes or strings for the PL011 (`BootOptions.serialIn`). */
  serial: MessagePort;
  /** The display port (web/gpu-present.ts): `mode` messages from a virtio-gpu, and the page's `size` to it; `png` ("Copy the screen") to whoever draws the screen, a virtio-gpu or the framebuffer here. */
  display: MessagePort;
  /** The page's sound (web/audio.ts `attach`): the ring the virtio-snd plays into, the microphone's ring it records from, the port it says its streams' starts and stops on (and the volume, both ways), and the volume level and mute it starts with. */
  sound?: { ring: SharedArrayBuffer; mic: SharedArrayBuffer; port: MessagePort; level: number; muted: boolean };
  /**
   * The network adapters in order (docs/networking/adapters.md): each a virtio-net with its MAC on its own gateway, whose
   * end of the adapter's IP port is `ip` (web/gateway.ts `portBackend`). The page keeps the other end and gives it to a
   * client (web/app/network.ts). The machine gets its `network` credentials when it has any.
   */
  /** Each adapter's IP port, and the page's link to its card (`{type: 'flap'}`: web/app/areas/lease-actions.ts). */
  nets: { mac: string; ip: MessagePort; link?: MessagePort }[];
  /**
   * The USB controller's: the page's `usb-attach` and `usb-detach` to the device worker and its `usb-state` back
   * (web/usb-device.ts `UsbToWorker`, `UsbFromWorker`). The page attaches its devices once the machine runs (at a start,
   * a resume and a restore alike: a snapshot's ports are empty).
   */
  usb?: MessagePort;
  /**
   * Shared folders' (docs/shares.md): the one virtio-9p device, on what can be served now (`list`); `port` carries the
   * page's attachments and grants to the device worker (web/9p-folders.ts `FoldersToDevice`).
   */
  folders?: { list: FolderSpec[]; port: MessagePort };
  /** The guest agent's, over the vsock (web/vsock-device.ts; web/app/agent-link.ts has the page's end). */
  agent?: MessagePort;
  /** systemd's notifications (web/vsock-device.ts `VsockFromDevice`), a `firmware` machine's: the page's end hears READY=1. */
  notify?: MessagePort;
  /**
   * A 3D machine's (the page's default where WebGL2 is; `?gpu=2d` turns it off): the GPU worker's port (web/gpu-worker.ts,
   * which has the screen). The virtio-gpu gets virgl and renders there, with the start's `caps`.
   */
  renderer?: MessagePort;
};

/** Page → worker. One machine per worker: a restart is a new worker (the page's `stop`, then `terminate`). */
export type ToWorker =
  | {
      type: 'start';
      config: MachineConfig;
      ports: MachinePorts;
      /** The screen's canvas (`transferControlToOffscreen`, sized as the machine's framebuffer): the worker draws it (web/display.ts). Not on a 3D machine: the GPU worker has it. */
      screen?: OffscreenCanvas;
      /** The caps a 3D machine gives the guest (web/virgl-caps.ts), with `ports.renderer`. */
      caps?: Uint8Array;
      /** The display's size at the start (the page's screen box, `wantedSize` in web/app/areas/screen-view.ts): the console and the firmware get it with no event. Default: the machine's. */
      size?: { width: number; height: number };
      /** The words of the units the page has the guest run (web/app/guest-words.ts): the page renders them, the worker places them. */
      words: GuestWords;
      /** The machine's disks in slot order (docs/machines.md §4.1: at most `MAX_DISKS`), resolved by the page. */
      disks: StartDisk[];
      /**
       * The OPFS directory of the machine's own files: the firmware's variable store (`flash`) and a suspended machine
       * (`suspend`). A stored machine's `machines/<id>`; a transient one's is its first writable disk's overlay. None:
       * neither is kept.
       */
      home?: string;
      /**
       * Start from this snapshot file (the page's Load snapshot) instead of booting: the machine, its
       * devices and its vCPU count are the header's (below, docs/frontend.md "Snapshots"), the disk's
       * overlay is replaced by the file's blocks. The config's size is then ignored.
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
       * `bases`: the generations of the stored disks it reads (read-only or under an overlay), by disk id
       * (web/app/snapshot-lost.ts `basesOf`), into the header: a restore is refused once one moved.
       */
      about?: {
        name: string;
        shape: Shape;
        shapeHash: string;
        urls: Record<number, string>;
        bases?: Record<string, number>;
      };
      /** What a restore does with each writable disk the snapshot pins (web/snapshot.ts `DiskPlan`); none: replace each. */
      plan?: DiskPlan[];
      /**
       * Count every step (web/vm.ts `BootOptions.count`): the status bar shows an element that needs them (MIPS, the
       * JIT share, the per-vCPU bars: web/app/statusbar.ts `counts`). Without, the machine runs a little faster.
       */
      count: boolean;
    }
  /** The status bar's step-counting elements came or went (`start`'s `count`): the running machine follows (a flush of its JIT's code). */
  | { type: 'count'; on: boolean }
  /**
   * Suspend the running machine: it pauses, its snapshot (without the disk's changes, which stay
   * in the overlay) is written beside the overlay, and it stops: `suspend-done`, then the state `suspended`. On a
   * failure it runs on, with a `snapshot-error`. Progress comes as `snapshot-progress`; each of them echoes `id` (the
   * page's, web/app/run/run.ts `Run.save`).
   */
  | { type: 'suspend'; id: number }
  /**
   * Save a snapshot of the running machine (`running` or `booting`): it pauses, the file is written,
   * it runs on. The bytes go to `handle`'s writable stream (from `showSaveFilePicker`), or, without
   * one, back in `snapshot-chunk` messages, or, with `keep`, to that OPFS file (a kept snapshot: docs/machines.md
   * §5.2). A disk written in place has its blocks in the file only with `whole` (its whole store). `stage`: a file
   * save's staging file in OPFS (web/snapshot-stage.ts; the page holds its lock), written during the pause while the
   * storage has room, then copied into `handle`'s stream or handed back in `snapshot-done`'s `file`. Answered by
   * `snapshot-resumed` (the machine runs again), then `snapshot-done` or `snapshot-error`, each message of it with its
   * `id`.
   */
  | { type: 'snapshot'; id: number; handle?: FileSystemFileHandle; keep?: string; whole?: boolean; stage?: string }
  /** A `snapshot-chunk`'s buffer back (transferred), its bytes copied: save `id`'s next chunks are copied into it. */
  | { type: 'snapshot-spare'; id: number; buffer: ArrayBuffer }
  /**
   * Whether a snapshot or a suspend (`what`) would be refused now by a device (Vulkan in use, a video decoding),
   * asked before the page touches the machine (its USB ports, its input); answered by `snapshot-check`.
   */
  | { type: 'snapshot-check'; id: number; what: 'snapshot' | 'suspend' }
  /** The disks' overlays compacted (after the guest's trim: web/app/areas/trim-actions.ts); answered by `compacted`. */
  | { type: 'compact'; id: number; measure?: boolean }
  /**
   * A question about the running machine's surfaces (web/surface.ts; the disk surface visualizer): a `disk-*` query is
   * answered by the disk's device (`query.disk`: the disk's place among the machine's disks, slot order) from what it
   * has in memory; a `ram-*` query by the RAM map's scanner (web/app/worker-ram.ts); answered by `inspected` with its
   * `id`, `{ kind: 'none' }` without a machine or for a kind nothing answers.
   */
  | { type: 'inspect'; id: number; query: InspectQuery }
  /** Wake the guest if it is in PSCI SYSTEM_SUSPEND (`Status.asleep`): a key or a click reached it. */
  | { type: 'wake' }
  /**
   * The guest said it's up: systemd's READY=1 on its notify socket (web/vsock-device.ts, a `firmware` machine's), or the
   * clipboard agent's HELLO (docs/clipboard.md). A machine still `booting` is `running`, as its `ready` marker would make it.
   */
  | { type: 'up' }
  /** Stop the vCPUs and release the disk overlay; answered by `stopped`. */
  | { type: 'stop' }
  /** Benchmarks (`?displaystats`, bench/gpu/sway-load.ts): start or stop the guest PC sampler over every vCPU; a stop is answered by `profile` with its `id`. */
  | { type: 'profile'; on: boolean; id?: number }
  /** Benchmarks: what the core's heap has touched (web/vm.ts `heapUse`), answered by `heap` with its `id`. */
  | { type: 'heap'; id: number }
  /** Benchmarks: start or stop the vCPU timeline (web/profiler.ts `startTimeline`); a stop is answered by `timeline` with its `id`. */
  | { type: 'timeline'; on: boolean; id?: number };

/**
 * Where a disk's bytes come from: an image by URL (read by ranges) or as a `File` (read in slices), a blank disk of
 * `blank` bytes (zeros), a ramdisk of `ramdisk` bytes (with `swap`, a swap area of that label turned on in the guest:
 * web/app/guest-swap.ts), or a disk stored in the browser (its OPFS directory,
 * `disks/<id>`, and size: web/stored.ts; `made`, the size it was made with once grown: its changes files' base hash,
 * web/changes.ts `baseHash`). A stored disk written in place is a blank source with the store as its overlay.
 */
export type DiskSource =
  | { url: string; chunked?: string }
  | { file: File }
  | { blank: number }
  | { ramdisk: number; swap?: string }
  | { stored: string; size: number; made?: number };

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
  /** What the guest's GET_ID gets (default `waarm64-blk`). */
  serial?: string;
  /**
   * Its size as the guest sees it where that is larger than the source's (a grown overlay: docs/machines.md §4.5);
   * absent: the source's.
   */
  size?: number;
  /** The machine's own image (`MachineSpec.disk`): a snapshot's header names no disk for it (`disk: null`). */
  own?: true;
};

/** A disk for the disk jobs (export, changes in): its source, the overlay of its changes and what that overlay belongs to (default `diskIdentity`'s). */
export type DiskRef = { source: DiskSource; overlay?: string; identity?: string };

/**
 * Where a save's time went, ms (`snapshot-done`, `suspend-done`; the page puts it in `#message`'s `data-snapshot`):
 * web/snapshot.ts `SavePhases`, with the worker's wait for the vCPUs to stop (`pause`) and the output's close (`close`:
 * a picked file's stream or a kept snapshot's file after the resume, not paused; a suspended copy's before the stop),
 * a staged file's copy into the picked file after the resume (`copy`, 0 for none);
 * and, before the pause, the save's pool started (`poolReady`: its start to its last worker ready, 0 without one) and
 * how long the save waited for it once the guest's free memory was handed over (`poolWait`).
 */
export type SaveTimes = SavePhases & {
  pause: number;
  close: number;
  copy: number;
  poolWait: number;
  poolReady: number;
};
/**
 * Where a start from a snapshot's time went, ms (`loaded`; the page puts it in `#message`'s `data-load`): the core
 * fetched and compiled and the machine's parts (`prepare`), web/snapshot.ts `RestorePhases` (the check pass, the state,
 * RAM, the disks' blocks), the rest of the machine's start to `running` (`start`: its workers, the devices' state put
 * back), and from the worker's start to `running` (`total`).
 */
export type LoadPhases = RestorePhases & { prepare: number; start: number; total: number };

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
  /**
   * The machine is restored (a snapshot, a suspended copy): the guest renews its leases once the connections are up; from
   * a template (a snapshot whose header has `template: true`), its agent renews the guest's identity too.
   */
  | { type: 'restored'; template: boolean }
  /** A start from a snapshot or a suspended copy posted `running`: where its time went (for tools). */
  | { type: 'loaded'; phases: LoadPhases }
  /** What a `loading` machine started from a snapshot is doing (it has no download to report). */
  | { type: 'phase'; text: Msg }
  /** A save's progress: the phase and the fraction done of it (0 when unknown). */
  | { type: 'snapshot-progress'; id: number; phase: Msg; fraction: number }
  /** Save `id`'s pause is over: the machine runs again (a staged file's copy may follow before `snapshot-done`). */
  | { type: 'snapshot-resumed'; id: number }
  /**
   * The next bytes of the file, when the save had no `handle` (transferred, in order): the page copies them (into a
   * Blob) and gives the buffer back (`snapshot-spare`), so a file's worth of them never waits for a GC.
   */
  | { type: 'snapshot-chunk'; id: number; data: Uint8Array }
  /** The file is complete: its size, ms the machine was paused (from the pause request to the resume), and the disks it pins. */
  /** `stateMs`: the devices' state, of the pause (the 3D renderer's read-back is in it); `blobBytes`: their binary parts (the 3D contents), before compression. */
  /** `hintMs`, `hinted`: how long the guest took to hand over its free memory before the pause (web/balloon.ts), and its bytes (none: no balloon's hint). */
  | {
      type: 'snapshot-done';
      id: number;
      bytes: number;
      pausedMs: number;
      stateMs: number;
      blobBytes: number;
      pins: SnapshotDisk[];
      hintMs?: number;
      hinted?: number;
      phases: SaveTimes;
      /**
       * A file save's staging (web/snapshot-stage.ts): `staged` (through its staging file), `room` (not: the storage
       * hadn't room for the file's bound) or `refused` (a staging write was refused partway: written again directly);
       * none without one.
       */
      staging?: 'staged' | 'room' | 'refused';
      /** A download's staged file (the page downloads it, then removes it). */
      file?: File;
    }
  /** The save failed (the machine runs on, unless it had ended): the error for the user (`toWire`). */
  | { type: 'snapshot-error'; id: number; error: WireError }
  /** `snapshot-check`'s answer: the error the save would end with (`toWire`), or none. */
  | { type: 'snapshot-check'; id: number; refused?: WireError }
  /** `compact`'s answer: the bytes the overlays' files took before and after (none: no machine running). */
  | { type: 'compacted'; id: number; before?: number; after?: number }
  /** `inspect`'s answer (its arrays transferred). */
  | { type: 'inspected'; id: number; answer: InspectAnswer }
  /** The suspend `id` is written and the machine closed (the state `suspended` follows): the file's size, the pause's ms and where they went. */
  | { type: 'suspend-done'; id: number; bytes: number; pausedMs: number; phases: SaveTimes }
  /** The PC sampler's histogram since `profile` started it: [pc in hex, samples] (any vCPU). */
  | { type: 'profile'; id: number; samples: [string, number][] }
  /** `heap`'s answer (web/vm.ts `heapUse`). */
  | {
      type: 'heap';
      id: number;
      heap: {
        /** Memory 0's size: 4 GiB for a fixed memory of memory 0's largest RAM (web/vm.ts `fixedPages`). */
        memoryBytes: number;
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
  | { type: 'timeline'; id: number; timeline: Timeline }
  | { type: 'stopped' };

/** Once a second while the machine runs. */
export type Status = {
  ncpus: number;
  ramMiB: number;
  /** ms since the VM started running. */
  uptime: number;
  /** Guest instructions retired (all vCPUs): every one only while `counted`. */
  steps: number;
  /**
   * Whether the machine counted every step since the last status (`count`): without, compiled code's steps go
   * uncounted (web/vm.ts `BootOptions.count`), and the status bar's step rates aren't drawn across a change.
   */
  counted: boolean;
  /** Blocks compiled since boot (all vCPUs; a flush doesn't reset it), and how often the code cache was flushed (its byte budget, docs/jit.md "Memory"). */
  jitBlocks: number;
  jitFlushes: number;
  jitCompileMs: number;
  /** Instructions retired in JIT code (the rest were interpreted) and the wasm bytes compiled since boot (all vCPUs). */
  jitSteps: number;
  jitBytes: number;
  irqs: number;
  /** The TLB's misses and flushes, all vCPUs (docs/cpu.md "MMU and TLB"). */
  tlbMisses: number;
  tlbFlushes: number;
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
   * The memory signal's estimate of what the tab holds for the machine now, and its peak since this start, bytes
   * (web/app/memory.ts `Signal`, kept by the worker: the status bar's Tab memory and the page's mark).
   */
  estimateBytes: number;
  peakBytes: number;
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
