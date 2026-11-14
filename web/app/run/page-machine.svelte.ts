// The machine on this page (docs/frontend.md "The page's code"): which it is (a stored machine, `?m=<id>`, or a
// transient one made from the query: the tests' `?machine=`), its disk, its size and graphics, and its run. The
// owner the areas' modules share (web/app/main.ts makes it and hands it to each): what they read and change of the
// machine is here, not in module globals. Its derived parts are in web/app/run/page-disks.ts.
import { MsgError } from '../../i18n.ts';
import { cpuFeatures, credentials, params, query, simpleDisplay } from './knobs.ts';
import { parseDevKnobs } from './dev-knobs.ts';
import type { MachineConfig } from '../protocol.ts';
import type { Run } from './run.ts';
import { asRun, effectiveDisplay, resolveMachine, type RunDisplay } from './config.ts';
import { currentShape } from '../snapshots.ts';
import { settings } from '../settings.ts';
import { DEFAULT_SHARES_PATH } from '../shares-mount.ts';
import type { Store } from '../store.ts';
import { adaptersOf, DEFAULT_MAC, serialOf, type Adapter, type DiskRecord, type MachineRecord } from '../shape.ts';
import { JIT_DEFAULT_MIB, MACHINES, type DiskChoice, type Machine, type MachineName } from '../machine.ts';

/** A stored machine's record and its disks' records, as the page has them (read again as the store changes). */
export class Stored {
  record: MachineRecord;
  disks: Map<string, DiskRecord>;
  constructor(record: MachineRecord, disks: Map<string, DiskRecord>) {
    this.record = $state.raw(record);
    this.disks = $state.raw(disks);
  }
}

const NO_WEBGL2 = 'this browser has no WebGL2';
/** The machine last opened on this page (in this browser): opened again by a page without a query. */
const LAST = 'waarm64.machine';

const hasWebgl2 = () => {
  try {
    return !!new OffscreenCanvas(1, 1).getContext('webgl2');
  } catch {
    return false; // no OffscreenCanvas: no WebGL2 either
  }
};

/** A stored machine and its disks' records; refused (an error the page shows) when one of them is missing. */
export async function loadStored(store: Store, id: string): Promise<Stored> {
  const record = await store.get('machines', id);
  if (!record) throw new MsgError('machine:page-machine.noMachine', { id });
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- filled here, then held raw by `Stored`
  const disks = new Map<string, DiskRecord>();
  for (const a of record.attachments) {
    const d = await store.get('disks', a.disk);
    if (!d) throw new MsgError('machine:page-machine.noDisk', { name: record.name, id: a.disk });
    disks.set(d.id, d);
  }
  return new Stored(record, disks);
}

/** The machine id remembered as this page's, if any. */
export const lastMachine = () => {
  try {
    return localStorage.getItem(LAST) ?? undefined;
  } catch {
    return undefined; // no storage: nothing remembered
  }
};
/** Remembers `id` as the machine this page opens without a query. */
export const rememberMachine = (id: string) => {
  try {
    localStorage.setItem(LAST, id);
  } catch {
    /* not remembered */
  }
};

/** Where the guest finds the machine's shared folders; undefined: the page doesn't mount them. */
export const sharesPath = (m: MachineRecord) =>
  m.sharesMount === false ? undefined : (m.sharesPath ?? DEFAULT_SHARES_PATH);

/** A stored machine's disk `id`'s record (its attachments' disks are all loaded with it). */
export const diskOf = (s: Stored, id: string) => {
  const d = s.disks.get(id);
  if (!d) throw new Error(`disk ${id} not loaded`);
  return d;
};

export class PageMachine {
  readonly store: Store;
  /** The kind of machine (`uefi` for a stored one). */
  readonly name: MachineName;
  readonly spec: Machine;
  /** The stored machine, if the page's is one. */
  stored = $state.raw<Stored>();
  /** Why the stored machine `?m=` names can't be opened (an error the page shows), if it can't. */
  storedError: unknown;
  /** The root disk the user chose for a transient machine (a file, or `?disk=<url>`), with its own overlay. */
  chosen = $state.raw<DiskChoice>();
  ncpus = $state(1);
  ramMiB = $state(1024);
  /** The RAM's split as the user set it, MiB, memory 0 first (docs/spill-memories.md). */
  ramSplit = $state.raw<number[]>();
  /** The JIT's code cache budget, MiB; 0: the default. */
  jitMiB = $state(0);
  want3d = $state(false);
  /** Why there's no 3D (the browser, the GPU worker), if there's none. */
  no3d = $state<string>();
  readonly webgl2 = hasWebgl2();
  /** It has a virtio-gpu (unless `?display=simple`). */
  readonly hasGpu: boolean;
  /** The run, while there is one. */
  run = $state.raw<Run>();
  /** What follows the stored machine's record besides what reads it reactively (the USB menu's entries). */
  onRecord: () => void = () => undefined;
  /** Files picked in this session for file disks without a usable handle, by disk id. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- nothing shows them
  readonly pickedFiles = new Map<string, File>();

  constructor(store: Store, stored: Stored | undefined, storedError: unknown) {
    this.store = store;
    this.stored = stored;
    this.storedError = storedError;
    this.name = stored ? 'uefi' : ((params.get('machine') ?? 'uefi') as MachineName);
    if (!(this.name in MACHINES)) throw new Error(`no machine ${this.name}`);
    this.spec = MACHINES[this.name];
    this.hasGpu = this.spec.display === 'gpu' && !simpleDisplay;
    this.#initialSize();
    this.choose3d();
    if (stored) rememberMachine(stored.record.id);
  }

  /** The machine as the address, its record, the browser's settings and the defaults say now (web/app/run/config.ts). */
  resolve() {
    const env = {
      gpu: this.spec.display === 'gpu',
      ramMiB: this.spec.ramMiB,
      cores: navigator.hardwareConcurrency || 4,
    };
    return resolveMachine(query(), this.stored?.record, settings(), env);
  }

  /** The size: the address's, else the stored machine's, else the one chosen last in this browser, else the defaults. */
  #initialSize() {
    this.takeSize();
  }

  /** The size as `resolve` says now (a stored machine's record changed, or another opened): the address's over it. */
  takeSize() {
    const r = this.resolve();
    [this.ncpus, this.ramMiB, this.ramSplit, this.jitMiB] = [r.ncpus, r.ramMiB, r.ramSplit, r.jitMiB];
  }

  /** The budget the machine runs with, MiB. */
  jitBudget() {
    return this.jitMiB || JIT_DEFAULT_MIB;
  }

  /**
   * 3D: a machine with a virtio-gpu gets virgl, rendered by a GPU worker that owns the screen as WebGL2
   * (web/gpu-worker.ts; docs/frontend.md "A 3D machine"). The default since G3; the Machine menu's Graphics turns it
   * off (`2d`, kept in this browser), and the query is over it (`gpuAsked`). Off where this browser has no WebGL2.
   */
  wants3d() {
    return this.resolve().three;
  }
  /** 3D as the machine wants it now, and why it can't have it. */
  choose3d() {
    this.want3d = this.wants3d();
    this.no3d = this.want3d && !this.webgl2 ? NO_WEBGL2 : undefined;
  }
  /** Vulkan through Venus beside 3D (docs/devices.md "Venus"): a stored machine's setting, or `?gpu=vulkan`. */
  wantsVulkan() {
    return this.resolve().vulkan;
  }
  /**
   * The display the machine runs with now (`effectiveDisplay`, as `choose3d` chose): a call, not a constant, as the
   * GPU worker's `failed` turns 3D off (`no3d`) for the next start.
   */
  display(): RunDisplay {
    return effectiveDisplay({
      gpu: this.hasGpu,
      simple: false,
      asked: this.want3d ? '3d' : '2d',
      webgl2: this.webgl2,
      refused: !!this.no3d,
      vulkan: this.wantsVulkan(),
    });
  }

  /** Reads the stored machine's record again, if `id` (by default its own) is it. */
  async rereadRecord(id = this.stored?.record.id) {
    const s = this.stored;
    if (s && id === s.record.id) s.record = (await this.store.get('machines', id)) ?? s.record;
  }

  /** The page's machine as the network and the memory signal know it: a stored machine's id, or the transient one. */
  netKey() {
    return this.stored?.record.id ?? 'transient';
  }
  /** The page's machine's adapters: a stored machine's, or a transient one's card (its connection kept in the settings). */
  adapters(): Adapter[] {
    if (!this.spec.network) return [];
    if (this.stored) return adaptersOf(this.stored.record);
    const id = settings().transientNet;
    return [{ id: 'transient', mac: DEFAULT_MAC, ...(id ? { connection: id } : {}) }];
  }
  /** Whether `id` (undefined: the transient machine) is the page's. */
  isCurrent(id: string | undefined) {
    return this.stored ? this.stored.record.id === id : id === undefined;
  }

  /** A device of its (web/app/run/config.ts `resolveMachine`): USB, a mouse, a touchscreen, the clipboard, shared folders. */
  has(device: 'usb' | 'mouse' | 'touch' | 'clipboard' | 'shares') {
    return this.resolve().devices[device];
  }

  /**
   * The machine's configuration for a start with `nets` network adapters (web/app/protocol.ts `MachineConfig`): its size
   * as the page has it now (the address's, the Machine menu's, a stored machine's settings), its devices, display and
   * guest settings by `resolve` and `display`, the address's CPU features and development knobs. The keyboard layout is
   * filled in by the start once it is resolved (`guest.keyLayout`).
   */
  config(nets: number): MachineConfig {
    const stored = this.stored?.record;
    const resolved = this.resolve().devices;
    const { display, vulkan } = this.display();
    return {
      machine: this.name,
      ncpus: this.ncpus,
      ram: { mib: this.ramMiB, split: this.ramSplit },
      jitMiB: this.jitMiB || undefined,
      cpu: cpuFeatures(),
      display,
      vulkan,
      devices: {
        nets,
        mouse: resolved.mouse,
        touch: resolved.touch,
        clock: resolved.clock,
        shares: resolved.shares,
        agent: resolved.agent,
        clipboard: resolved.agent && resolved.clipboard,
        usb: resolved.usb,
      },
      guest: {
        netConfig: resolved.netConfig,
        sharesPath: resolved.shares && stored ? sharesPath(stored) : undefined,
        params: params.get('params') ?? undefined,
        credentials,
      },
      dev: parseDevKnobs(params),
    };
  }

  /**
   * A stored machine as its snapshots describe it (protocol.ts `about`): its shape as `config` runs it (by default the
   * next start's: its size, devices and display as resolved, so a snapshot taken under the address's `?mouse=1` or
   * `?ncpus=` says so) and its URL disks' URLs by slot.
   */
  async about(config = this.config(0)) {
    const s = this.stored;
    if (!s) return undefined;
    const d = config.devices;
    const record = asRun(s.record, {
      ncpus: config.ncpus,
      ramMiB: config.ram.mib,
      ramSplit: config.ram.split,
      jitMiB: config.jitMiB ?? 0,
      devices: { ...d, netConfig: config.guest.netConfig },
    });
    const { shape, hash } = await currentShape(record, (id) => s.disks.get(id), {
      display: config.display,
      cpu: config.cpu,
      vulkan: config.vulkan,
    });
    const urls: Record<number, string> = {};
    for (const x of shape.disks) {
      const a = s.record.attachments.find((y) => serialOf(y.id) === x.serial);
      const rec = a && s.disks.get(a.disk);
      if (rec?.kind === 'url' && rec.url) urls[x.slot] = rec.url;
    }
    return { name: s.record.name, shape, shapeHash: hash, urls };
  }

  /** The ramdisks' size, MiB: host memory the machine may take beside its RAM. */
  ramdiskMiB() {
    const s = this.stored;
    if (!s) return 0;
    return s.record.attachments.reduce((n, a) => {
      const d = diskOf(s, a.disk);
      return n + (d.kind === 'ramdisk' ? d.size / 2 ** 20 : 0);
    }, 0);
  }
}
