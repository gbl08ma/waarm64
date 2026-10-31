// Machines as the unit (docs/machines.md §2, §5.1): what a machine, a disk and an attachment
// are, the slots a machine's devices take, and the shape: a canonical description of what the guest
// sees, whose SHA-256 a snapshot is checked against. DOM-free: the page, the workers and Node's
// tests use it alike. web/app/store.ts keeps these records.

/** The most disks a machine has (docs/machines.md §4.1: room left of the core's 32 transports for devices to come). */
export const MAX_DISKS = 16;
/** The most network adapters a machine has (docs/network-adapters.md §1.1). */
export const MAX_ADAPTERS = 4;
/** The MAC a machine's card had before adapters (and a new machine's first adapter has): such a machine's shape is as it was. */
export const DEFAULT_MAC = '52:54:00:12:34:56';
/** The shape's format: a new one orphans every snapshot made under the old (none is expected soon). */
export const SHAPE_VERSION = 1;

/** Where a base disk's bytes come from (machines.md §4.2). */
export type DiskKind = 'url' | 'file' | 'stored' | 'blank' | 'ramdisk';

/**
 * A base disk's cheap identity (machines.md §3.1): what decides whether an overlay belongs to it and
 * a snapshot was made over it. A URL's path (not its host: the same image moved keeps its changes)
 * and size, with the server's validator where it sent one; a file's name, size and modification
 * time; the id of a disk that exists only in this browser (stored, blank) and its size; a ramdisk's
 * id and size (it starts empty: there's nothing else to tell).
 */
export type DiskIdentity =
  | { kind: 'url'; path: string; bytes: number; etag?: string; lastModified?: string }
  | { kind: 'file'; name: string; bytes: number; modified: number }
  | { kind: 'stored' | 'blank' | 'ramdisk'; id: string; bytes: number };

/** A base disk (IndexedDB `disks`). */
export type DiskRecord = {
  id: string;
  kind: DiskKind;
  /** Its name on the page (a file's, a URL's last part, or the user's). */
  name: string;
  /** What the guest sees, bytes (a qcow2's virtual size; a multiple of 512). */
  size: number;
  /** The image's format where it has one (a stored, blank or ramdisk disk is the block store's own). */
  format?: 'raw' | 'qcow2' | 'iso';
  identity: DiskIdentity;
  /** `url`: the image's URL. */
  url?: string;
  /** `file`: the file's handle, kept so the file needn't be picked again (a read permission is asked for in each session). */
  handle?: FileSystemFileHandle;
  /** The image's SHA-256 (hex) where it was computed (machines.md §3.1: only where one is needed). */
  sha256?: string;
  /** `stored`: the store's generation (its `meta`, as the page last read it): written in place or merged into, it moves (§4.4). */
  generation?: number;
  created: number;
};

/**
 * A disk in a machine's slot list. `readOnly`: the guest can't write it; otherwise it writes into
 * the overlay `overlay` (an id in IndexedDB `overlays`, machines.md §2), or, with `inPlace`, into
 * the disk itself (a stored disk only: §4.4), or, for a ramdisk, into memory.
 */
export type Attachment = { id: string; disk: string; readOnly: boolean; inPlace?: boolean; overlay?: string };

/** The machine's display: a virtio-gpu, 2D or with virgl (3D, rendered with WebGL2): the guest sees different devices. */
export type Display = '2d' | '3d';

/** A folder attached to a machine (web/app/folders.ts): its id, and whether this machine only reads it. */
export type FolderAttachment = { id: string; readOnly: boolean };

/** A machine (IndexedDB `machines`). */
export type MachineRecord = {
  id: string;
  name: string;
  ncpus: number;
  ramMiB: number;
  /**
   * The RAM's split as the user set it, MiB: memory 0 first, then each spill memory (a NUMA node for the guest;
   * docs/spill-memories.md), summing to `ramMiB`. Absent: the automatic one (web/app/machine.ts `ramSplitMiB`).
   */
  ramSplit?: number[];
  /**
   * The JIT's code cache budget, MiB (docs/jit.md "Memory"); absent: the page's default. The guest doesn't see it: it
   * travels with the shape (a snapshot's header, "make a machine like it") but isn't in its hash.
   */
  jitMiB?: number;
  /**
   * The guest's keyboard layout, set by the page at every boot (web/app/keyboard.ts, an id in `KEYBOARD_LAYOUTS`, or
   * `FOLLOW_BROWSER`: the browser's, looked up at every start; a new machine's); absent: the page leaves the guest's own. Not in the shape: only a boot reads it.
   */
  keyboard?: string;
  /**
   * False: the page leaves the guest's network settings alone; absent: it has the guest take each adapter's lease (its
   * MTU, search domain; web/app/guest-net.ts) at every boot. Not in the shape: only a boot reads it.
   */
  netConfig?: false;
  display: Display;
  /**
   * Vulkan through Venus beside 3D (docs/devices.md "Venus"; the module's renderer on the browser's WebGPU): the GPU
   * gets Venus's capset and a host-visible window after the RAM. Only with `display` 3D; absent: off, the shape as it was.
   */
  vulkan?: boolean;
  /**
   * The network adapters (virtio-net), in slot order (docs/network-adapters.md). Absent on machines made before
   * adapters: their `network` says whether they have one, at `DEFAULT_MAC` (`adaptersOf`).
   */
  adapters?: Adapter[];
  /** Before adapters: a network card from the start. Read only through `adaptersOf`. */
  network?: boolean;
  /**
   * A USB controller (an xHCI: 4 USB 2 and 4 USB 3 root ports behind 4 connectors, docs/usb.md "The page"). Absent on
   * machines made before it existed: off, and their shape (and its hash) as it was. New machines have it.
   */
  usb?: boolean;
  /** The USB devices the machine remembers (hot-plugged: not in the shape). */
  usbDevices?: UsbEntry[];
  /**
   * A relative mouse (virtio-input), the pointer while the screen holds the mouse (docs/frontend.md "Mouse lock"). Absent
   * on machines made before it: off (the lock moves the tablet instead), their shape as it was. New machines have it.
   */
  mouse?: boolean;
  /**
   * A touchscreen (virtio-input, multitouch): the page's touches go to it (without one they move the tablet). Absent on
   * machines made before it: off, their shape as it was. New machines have it.
   */
  touch?: boolean;
  /**
   * A clock device (virtio-rtc, web/clock.ts): the browser's clock, for a guest's PTP clock and RTC. Absent on machines
   * made before it: off, their shape as it was. New machines have it.
   */
  clock?: boolean;
  /**
   * Shared folders (docs/shares.md): one virtio-9p device, whatever is attached. Absent on machines made before it: off,
   * their shape as it was. New machines have it.
   */
  shares?: boolean;
  /** False: the page doesn't mount them in the guest; absent: it does, at `sharesPath`. Not in the shape: the guest's disk decides what a path means. */
  sharesMount?: false;
  /** Where the guest finds them; absent: `DEFAULT_SHARES_PATH` (web/app/shares-mount.ts). Not in the shape. */
  sharesPath?: string;
  /** The folders attached, in the root's order (changed while the machine runs: not in the shape). Absent: none. */
  folders?: FolderAttachment[];
  /** In slot order (the guest's vda, vdb…). */
  attachments: Attachment[];
  created: number;
  modified: number;
};

/**
 * A network adapter: its MAC (in the shape: the guest sees it) and the connection it is attached to (an id in the
 * browser's connections, web/app/connections.ts; none: a card with no cable). The connection isn't in the shape.
 */
export type Adapter = { id: string; mac: string; connection?: string };

/** A machine's adapters: its own, or, made before adapters, the card it had. */
export function adaptersOf(m: Pick<MachineRecord, 'adapters' | 'network'>): Adapter[] {
  return m.adapters ?? (m.network ? [{ id: 'f00000000000', mac: DEFAULT_MAC }] : []);
}

/** A new adapter's MAC: QEMU's locally administered prefix and three random bytes, not one of `taken` (nor the default). */
export function newMac(taken: Iterable<string> = [], random: () => number = Math.random): string {
  const used = new Set([...taken, DEFAULT_MAC].map((x) => x.toLowerCase()));
  for (;;) {
    const mac = ['52', '54', '00', ...Array.from({ length: 3 }, () => Math.floor(random() * 256).toString(16).padStart(2, '0'))].join(':');
    if (!used.has(mac)) return mac;
  }
}

/** Whether `s` is a MAC as the page writes them (six lowercase hex pairs) and a unicast one. */
export const isMac = (s: string) => /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(s) && (parseInt(s.slice(0, 2), 16) & 1) === 0;

/**
 * A USB device a machine remembers (docs/usb.md "The page"): who it is (WebUSB's or WebHID's grant persists per origin,
 * so the page finds it again by this), the connector it goes on (fixed, so the guest's by-path names stay), and whether
 * it is attached when the machine starts (and when it is plugged in while the machine runs). `index`: among identical
 * devices without a serial number, which one in `getDevices()` order.
 */
export type UsbEntry = {
  id: string;
  api: 'usb' | 'hid';
  vendorId: number;
  productId: number;
  serialNumber?: string;
  productName?: string;
  index?: number;
  /** 0–3. */
  connector: number;
  atStart: boolean;
};
/** The root connectors a machine's controller has (each a USB 2 and a USB 3 port). */
export const USB_CONNECTORS = 4;
/** The last is the built-in keyboard's (web/usb-keyboard.ts, docs/usb.md "The keyboard"); the others are the remembered devices'. */
export const KEYBOARD_CONNECTOR = USB_CONNECTORS - 1;
export const USER_CONNECTORS = KEYBOARD_CONNECTOR;

/** The device kinds a machine's transports have, in slot order (`slots`). */
export type DeviceKind = 'rng' | 'keyboard' | 'tablet' | 'net' | 'gpu' | 'snd' | 'mouse' | 'touch' | 'clock' | '9p' | 'blk';
/** The vCPUs' optional features (`BootOptions.rng`, `e0pd`, `sha3`). */
export type CpuFeature = 'rng' | 'e0pd' | 'sha3';
export const CPU_FEATURES: CpuFeature[] = ['rng', 'e0pd', 'sha3'];
/**
 * The features the shape's hash leaves out: the ones that came after shapes did, so that the snapshots and suspended
 * machines kept before them keep their hash. A restore runs with the snapshot's own features (its header's `cpu`),
 * whatever the machine's are now, so the hash needn't tell them apart.
 */
const UNHASHED_CPU: CpuFeature[] = ['sha3'];
const hashedCpu = (cpu: CpuFeature[]) => cpu.filter((f) => !UNHASHED_CPU.includes(f));

/**
 * The machine's transports in slot order: the other devices first, in a fixed order, then the disks
 * (machines.md §4.1), so that a device kind added later is appended after them only on machines
 * that have it. The network adapters are where the one card was (network-adapters.md §4). `attachment` is the disk's
 * index in the machine's list, `adapter` the adapter's.
 */
export function slots(m: { nets: number; display?: Display | 'none'; mouse?: boolean; touch?: boolean; clock?: boolean; shares?: boolean; attachments: unknown[] }): { kind: DeviceKind; attachment?: number; adapter?: number }[] {
  return [
    { kind: 'rng' }, { kind: 'keyboard' }, { kind: 'tablet' },
    ...Array.from({ length: m.nets }, (_, i) => ({ kind: 'net' as const, adapter: i })),
    ...(m.display === 'none' ? [] : [{ kind: 'gpu' as const }]),
    { kind: 'snd' },
    ...(m.mouse ? [{ kind: 'mouse' as const }] : []),
    ...(m.touch ? [{ kind: 'touch' as const }] : []),
    ...(m.clock ? [{ kind: 'clock' as const }] : []),
    ...(m.shares ? [{ kind: '9p' as const }] : []),
    ...m.attachments.map((_, i) => ({ kind: 'blk' as const, attachment: i })),
  ];
}

/** The serial a disk's guest sees (virtio-blk GET_ID, at most 20 bytes; Linux's /dev/disk/by-id/virtio-<serial>): the attachment's, so it survives a reorder. */
export const serialOf = (attachment: string) => `webpc-${attachment}`.slice(0, 20);

/** One disk of a shape: what the guest sees of it. */
export type ShapeDisk = { slot: number; size: number; readOnly: boolean; serial: string; identity: DiskIdentity };

/** What the guest sees of a machine (machines.md §5.1): a snapshot made on one shape restores only on the same shape. */
export type Shape = {
  version: number;
  ncpus: number;
  ramMiB: number;
  /** The user's split of the RAM (`MachineRecord.ramSplit`): only when set (left out otherwise, so shapes made before it hash as they did). */
  split?: number[];
  display: Display | 'none';
  cpu: CpuFeature[];
  devices: DeviceKind[];
  disks: ShapeDisk[];
  /** The USB controller: only when there is one (left out otherwise, so shapes made before it hash as they did). */
  usb?: true;
  /** Vulkan (Venus) beside 3D: only when on (left out otherwise, so shapes made before it hash as they did). */
  vulkan?: true;
  /** The adapters' MACs, in order: left out for none, or one at `DEFAULT_MAC` (so shapes made before adapters hash as they did). */
  macs?: string[];
  /**
   * The machine's JIT budget, MiB, only when set (`MachineRecord.jitMiB`). Not in the hash (`hashed`): the guest
   * doesn't see it and a state restores under any budget, so changing it orphans no snapshot.
   */
  jitMiB?: number;
};

/** The part of a shape its hash covers: what the guest sees (all but `jitMiB` and `UNHASHED_CPU`). */
const hashed = (s: Shape): Shape => ({ ...s, jitMiB: undefined, cpu: hashedCpu(s.cpu) });

/**
 * A machine's shape, from its record and its disks' (by id). `cpu`: the vCPUs' features (all,
 * unless the page turned one off for development). `display`: what the machine runs with when it
 * differs from its record's (a 3D machine on a browser without WebGL2 runs 2D; `none`: the page's
 * `?display=simple`).
 */
export function shapeOf(m: MachineRecord, disks: (id: string) => DiskRecord | undefined, opts: { cpu?: CpuFeature[]; display?: Display | 'none'; vulkan?: boolean } = {}): Shape {
  const display = opts.display ?? m.display;
  // Vulkan needs 3D (`vulkan`: what the machine runs with when the page asks for it beside its record's).
  const vulkan = display === '3d' && (opts.vulkan ?? !!m.vulkan);
  const macs = adaptersOf(m).map((a) => a.mac.toLowerCase());
  const list = slots({ nets: macs.length, display, mouse: m.mouse, touch: m.touch, clock: m.clock, shares: m.shares, attachments: m.attachments });
  return {
    version: SHAPE_VERSION,
    ncpus: m.ncpus,
    ramMiB: m.ramMiB,
    ...(m.ramSplit ? { split: m.ramSplit } : {}),
    display,
    cpu: CPU_FEATURES.filter((f) => (opts.cpu ?? CPU_FEATURES).includes(f)),
    devices: list.map((s) => s.kind),
    disks: list.flatMap((s, slot) => {
      if (s.attachment === undefined) return [];
      const a = m.attachments[s.attachment];
      const d = disks(a.disk);
      if (!d) throw new Error(`machine ${m.name} has a disk that isn't in this browser (${a.disk})`);
      return [{ slot, size: d.size, readOnly: a.readOnly, serial: serialOf(a.id), identity: d.identity }];
    }),
    ...(m.usb ? { usb: true as const } : {}),
    ...(vulkan ? { vulkan: true as const } : {}),
    ...(macs.length > 1 || (macs.length === 1 && macs[0] !== DEFAULT_MAC) ? { macs } : {}),
    ...(m.jitMiB ? { jitMiB: m.jitMiB } : {}),
  };
}

/** A shape's adapters' MACs (`macs`, or the one card before adapters). */
export const macsOf = (s: Shape) => s.macs ?? (s.devices.includes('net') ? [DEFAULT_MAC] : []);

/** `v` as JSON with every object's keys sorted and undefined members left out: the same value, the same text. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** The shape's SHA-256 (hex) of its canonical JSON. */
export async function shapeHash(s: Shape): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(hashed(s))));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** What differs between two shapes, in words for the snapshots view (an orphaned snapshot's reason): empty when they're the same. */
export function shapeDiff(was: Shape, now: Shape): string[] {
  const out: string[] = [];
  if (was.version !== now.version) return ['it was made by another version of this page'];
  if (was.ncpus !== now.ncpus) out.push(`processors: ${was.ncpus} then, ${now.ncpus} now`);
  if (was.ramMiB !== now.ramMiB) out.push(`memory: ${was.ramMiB} MiB then, ${now.ramMiB} MiB now`);
  else if (canonical(was.split ?? []) !== canonical(now.split ?? [])) {
    const split = (s?: number[]) => (s ? `${s.join(' + ')} MiB` : 'automatic');
    out.push(`memory's split: ${split(was.split)} then, ${split(now.split)} now`);
  }
  if (was.display !== now.display) out.push(`display: ${was.display} then, ${now.display} now`);
  if (!!was.vulkan !== !!now.vulkan) out.push(was.vulkan ? 'it had Vulkan' : 'it had no Vulkan');
  if (canonical(hashedCpu(was.cpu)) !== canonical(hashedCpu(now.cpu))) out.push(`processor features: ${was.cpu.join(', ') || 'none'} then, ${now.cpu.join(', ') || 'none'} now`);
  const [macsWas, macsNow] = [macsOf(was), macsOf(now)];
  if (macsWas.length !== macsNow.length) out.push(`network adapters: ${macsWas.length} then, ${macsNow.length} now`);
  else for (let i = 0; i < macsWas.length; i++) if (macsWas[i] !== macsNow[i]) out.push(`network adapter ${i + 1}: MAC ${macsWas[i]} then, ${macsNow[i]} now`);
  if (!!was.usb !== !!now.usb) out.push(was.usb ? 'it had a USB controller' : 'it had no USB controller');
  for (const [k, name] of [['mouse', 'a relative mouse'], ['touch', 'a touchscreen'], ['clock', 'a clock device'], ['9p', 'a shared folders device']] as const) {
    if (was.devices.includes(k) !== now.devices.includes(k)) out.push(was.devices.includes(k) ? `it had ${name}` : `it had no ${name.replace(/^an? /, '')}`);
  }
  if (was.disks.length !== now.disks.length) out.push(`disks: ${was.disks.length} then, ${now.disks.length} now`);
  for (let i = 0; i < Math.min(was.disks.length, now.disks.length); i++) {
    const [a, b] = [was.disks[i], now.disks[i]];
    const what = `disk ${i + 1}`;
    if (canonical(a.identity) !== canonical(b.identity)) out.push(`${what}: another disk (${describeIdentity(a.identity)} then, ${describeIdentity(b.identity)} now)`);
    else if (a.size !== b.size) out.push(`${what}: ${a.size} bytes then, ${b.size} now`);
    if (a.readOnly !== b.readOnly) out.push(`${what}: ${a.readOnly ? 'read-only' : 'writable'} then, ${b.readOnly ? 'read-only' : 'writable'} now`);
    if (a.serial !== b.serial) out.push(`${what}: attached anew (its serial changed)`);
  }
  if (!out.length && canonical(hashed(was)) !== canonical(hashed(now))) out.push('its devices are in another order');
  return out;
}

/** A disk identity in words. */
export function describeIdentity(d: DiskIdentity): string {
  switch (d.kind) {
    case 'url': return d.path.split('/').pop() || d.path;
    case 'file': return `the file ${d.name}`;
    case 'stored': return 'a disk stored in this browser';
    case 'blank': return 'a blank disk';
    case 'ramdisk': return 'a ramdisk';
  }
}

/** A new record id: 12 hex digits (48 random bits). Records' files are named by it (machines.md §2). */
export function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
/** Whether `s` is an id `newId` makes: the store's sweep touches only such files (a transient machine's are named otherwise). */
export const isId = (s: string) => /^[0-9a-f]{12}$/.test(s);

const ADJECTIVES = ['Amber', 'Brisk', 'Calm', 'Clever', 'Cobalt', 'Dusky', 'Eager', 'Fern', 'Gentle', 'Hazel', 'Ivory', 'Jade', 'Keen', 'Lucid', 'Mellow', 'Nimble', 'Olive', 'Plucky', 'Quiet', 'Rusty', 'Sable', 'Tidy', 'Umber', 'Vivid', 'Wry', 'Zesty'];
const NOUNS = ['Heron', 'Otter', 'Lynx', 'Wren', 'Badger', 'Falcon', 'Marten', 'Puffin', 'Stoat', 'Ibis', 'Koala', 'Gecko', 'Raven', 'Bison', 'Crane', 'Dingo', 'Egret', 'Ferret', 'Lemur', 'Newt', 'Osprey', 'Panda', 'Quail', 'Tapir', 'Vole', 'Yak'];

/** A machine's generated name (machines.md §1: named by default), not one of `taken`. */
export function generateName(taken: Iterable<string>, random: () => number = Math.random): string {
  const used = new Set(taken);
  for (let i = 0; i < 50; i++) {
    const name = `${ADJECTIVES[Math.floor(random() * ADJECTIVES.length)]} ${NOUNS[Math.floor(random() * NOUNS.length)]}`;
    if (!used.has(name)) return name;
  }
  return uniqueName('Machine', used);
}

/** `name`, or `name (2)`, `name (3)`… : the first that isn't in `taken` (an imported machine's name, a copy's). */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(name)) return name;
  const stem = name.replace(/ \(\d+\)$/, '');
  for (let k = 2; ; k++) if (!used.has(`${stem} (${k})`)) return `${stem} (${k})`;
}
