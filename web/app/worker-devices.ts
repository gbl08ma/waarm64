// The machine worker's devices (web/app/worker.ts): a start message's transports in slot order and the device spec
// (web/devices.ts) each one is made from.
import { SEVERAL_ADAPTERS, type DeviceSpec } from '../devices.ts';
import { SHARES_TAG } from './shares-mount.ts';
import type { Machine } from './machine.ts';
import type { StartDisk, ToWorker } from './protocol.ts';
import { slots, type DeviceKind } from './shape.ts';

export type StartMessage = Extract<ToWorker, { type: 'start' }>;
/** A transport of the machine: its kind, and the disk it is for a `blk`, the adapter for a `net`. */
export type Slot = { kind: DeviceKind; disk?: StartDisk; adapter?: number };

/** The machine's transports in slot order (web/app/shape.ts `slots`): the kinds a snapshot's header lists, so a restore makes the same. */
export const layout = (m: StartMessage, machine: Machine): Slot[] =>
  slots({
    nets: machine.network ? m.config.devices.nets : 0,
    display: m.config.display === 'none' ? 'none' : '2d',
    mouse: m.config.devices.mouse,
    touch: m.config.devices.touch,
    clock: m.config.devices.clock,
    shares: m.config.devices.shares,
    vsock: !!machine.firmware,
    attachments: m.disks,
  }).map((s) => ({
    kind: s.kind,
    disk: s.attachment === undefined ? undefined : m.disks[s.attachment],
    adapter: s.adapter,
  }));

/** Vulkan through Venus on a 3D machine (the page's choice, `vulkan`; its renderer is the GPU worker's: docs/devices.md "Venus"). */
export const venusOn = (m: StartMessage) => m.config.vulkan && !!m.ports.renderer;

type Source = StartDisk['source'];
/** Where a disk's bytes come from, as its device takes it. */
function sourceOf(s: Source) {
  if ('url' in s) return { url: new URL(s.url, self.location.href).href, ...(s.chunked ? { chunked: s.chunked } : {}) };
  if ('file' in s) return { file: s.file };
  if ('blank' in s) return { source: 'zero' as const, size: s.blank };
  if ('stored' in s) return { stored: s.stored, size: s.size };
  return { source: 'ram' as const, size: s.ramdisk, swap: s.swap };
}

/**
 * A disk's device: its source, and its overlay (what the guest trims leaves it; a ramdisk gives the memory back), at
 * the size the guest sees (a grown overlay's, past its source's: docs/machines.md §4.5), and then the source's own size
 * (`diskSize`: its surface's disk, web/surface.ts; the device reads and the guest sees by `size` alone).
 */
export function blkSpec(d: StartDisk, stats?: boolean, keep?: boolean): DeviceSpec {
  const s = d.source;
  const from: ReturnType<typeof sourceOf> & { size?: number } = sourceOf(s);
  return {
    type: 'blk',
    ...from,
    ...(d.size !== undefined && d.size > (from.size ?? 0)
      ? { size: d.size, ...(from.size !== undefined ? { diskSize: from.size } : {}) }
      : {}),
    overlay: 'ramdisk' in s ? undefined : d.overlay,
    identity: d.identity,
    serial: d.serial,
    discard: true,
    stats,
    keep,
  };
}

type Maker = (slot: Slot, m: StartMessage, machine: Machine) => DeviceSpec;

const shares: Maker = (_slot, m) => {
  const asHost = m.config.dev.sharesAsync;
  return {
    type: '9p',
    tag: SHARES_TAG,
    folders: (m.ports.folders?.list ?? []).map((f) => (asHost.includes(f.name) ? { ...f, kind: 'host' as const } : f)),
    port: m.ports.folders?.port,
  };
};

const disk: Maker = (slot, m) => {
  if (!slot.disk) throw new Error('a disk slot without its disk'); // shape.ts `slots` gives each its attachment
  return blkSpec(slot.disk, m.config.dev.ioStats || undefined, m.config.dev.noDiskCache ? false : undefined);
};

const gpu: Maker = (_slot, m, machine) => {
  const { virglNull, ...tuning } = m.config.dev.gpu;
  return {
    type: 'gpu',
    width: m.size?.width ?? machine.framebuffer.width,
    height: m.size?.height ?? machine.framebuffer.height,
    canvas: m.ports.renderer ? undefined : m.screen,
    port: m.ports.display,
    stats: m.config.dev.displayStats || undefined,
    probe: m.config.dev.avProbe || undefined,
    keepConsole: true,
    ...tuning,
    virgl: virglNull || !!m.ports.renderer,
    venus: venusOn(m),
    renderer: m.ports.renderer,
    caps: m.caps,
  };
};

const net: Maker = (slot, m) => {
  if (slot.adapter === undefined) throw new Error('a network slot without its adapter'); // as a disk's, above
  const n = m.ports.nets[slot.adapter];
  // Several adapters: frequent renewals, so the default route follows the primary (docs/networking/adapters.md §4).
  return {
    type: 'net',
    mac: n.mac,
    gateway: slot.adapter,
    ...(m.ports.nets.length > 1 ? SEVERAL_ADAPTERS : {}),
    adapter: { ip: n.ip, link: n.link },
  };
};

// Without the page's ring (a page that passed none), the sink plays on its own clock.
// With the page's sound, its volume and mute are the device's controls (the guest's Master).
const sound: Maker = (_slot, m) => ({
  type: 'snd',
  ring: m.ports.sound?.ring,
  mic: m.ports.sound?.mic,
  port: m.ports.sound?.port,
  mixer: m.ports.sound && { level: m.ports.sound.level, muted: m.ports.sound.muted },
  ...m.config.dev.snd,
});

const MAKERS: Record<DeviceKind, Maker> = {
  rng: () => ({ type: 'rng' }),
  clock: () => ({ type: 'clock' }),
  balloon: () => ({ type: 'balloon' }),
  vsock: (_slot, m) => ({ type: 'vsock', port: m.ports.notify, agent: m.ports.agent }),
  '9p': shares,
  blk: disk,
  keyboard: (_slot, m) => ({ type: 'input', kind: 'keyboard', port: m.ports.keyboard }),
  tablet: (_slot, m) => ({ type: 'input', kind: 'tablet', port: m.ports.tablet }),
  mouse: (_slot, m) => ({ type: 'input', kind: 'mouse', port: m.ports.mouse }),
  touch: (_slot, m) => ({ type: 'input', kind: 'touch', port: m.ports.touch }),
  gpu,
  net,
  snd: sound,
};

/** The device in `slot` for this start. */
export const device = (slot: Slot, m: StartMessage, machine: Machine): DeviceSpec =>
  MAKERS[slot.kind](slot, m, machine);
