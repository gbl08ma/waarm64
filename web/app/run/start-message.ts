// What a start hands the machine worker (web/app/protocol.ts `start`): the machine's configuration, resolved once per
// start (`machineConfig`: web/app/run/config.ts's rules over the page's machine), the run's channels, one per device
// the configuration has, and the start message with the ports it transfers.
import type { PageAudio } from '../../audio.ts';
import type { FolderSpec } from '../../9p-folders.ts';
import { guestWords } from '../guest-words.ts';
import type { KeyboardLayout } from '../keyboard.ts';
import type { MachineConfig, MachinePorts, StartDisk, ToWorker } from '../protocol.ts';
import { credentials, cpuFeatures, params } from './knobs.ts';
import { sharesPath, type PageMachine } from './page-machine.svelte.ts';
import { parseDevKnobs } from './dev-knobs.ts';

type Start = Extract<ToWorker, { type: 'start' }>;

/**
 * The page's machine's configuration for a start with `nets` network adapters: its size as the page has it now (the
 * Machine menu's, a stored machine's settings), its devices, display and guest settings by `PageMachine.resolve` and
 * `display`, the address's CPU features and development knobs. The layout is filled in once resolved (`keyLayout`).
 */
export function machineConfig(m: PageMachine, nets: number): MachineConfig {
  const stored = m.stored?.record;
  const resolved = m.resolve().devices;
  const { display, vulkan } = m.display();
  return {
    machine: m.name,
    ncpus: m.ncpus,
    ram: { mib: m.ramMiB, split: m.ramSplit },
    jitMiB: m.jitMiB || undefined,
    cpu: cpuFeatures(),
    display,
    vulkan,
    devices: {
      nets,
      mouse: resolved.mouse,
      touch: resolved.touch,
      clock: resolved.clock,
      shares: resolved.shares,
      clipboard: resolved.clipboard,
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

/** A run's channels: the page keeps `port1` of each, the worker gets `port2`. */
export type Channels = {
  display: MessageChannel;
  keyboard: MessageChannel;
  tablet: MessageChannel;
  serial: MessageChannel;
  sound: ReturnType<PageAudio['attach']>;
  /** The machine's network adapters' ends of the IP ports (web/app/net-live.ts: the clients of their connections). */
  nets: { mac: string; ip: MessagePort }[];
  /** A USB controller's port its devices are attached over (docs/usb.md "The page"). */
  usb?: MessageChannel;
  /** Shared folders' port: what's attached while it runs goes over it (docs/shares.md). */
  shares?: MessageChannel;
  /** A relative mouse (the pointer while the screen holds the mouse) and a touchscreen. */
  mouse?: MessageChannel;
  touch?: MessageChannel;
  /** Clipboard sharing's port to the guest's agent (docs/plans/clipboard.md). */
  agent?: MessageChannel;
};

/** A run's channels for what the configuration has. */
export function channels(c: MachineConfig, sound: Channels['sound'], nets: Channels['nets']): Channels {
  const optional = (on: boolean) => (on ? new MessageChannel() : undefined);
  return {
    display: new MessageChannel(),
    keyboard: new MessageChannel(),
    tablet: new MessageChannel(),
    serial: new MessageChannel(),
    sound,
    nets,
    usb: optional(c.devices.usb),
    shares: optional(c.devices.shares),
    mouse: optional(c.devices.mouse),
    touch: optional(c.devices.touch),
    agent: optional(c.devices.clipboard),
  };
}

/** What a start adds to the configuration and the channels: the disks, the 3D renderer, the snapshot and the rest. */
export type StartWith = {
  disks: StartDisk[];
  home?: string;
  screen?: OffscreenCanvas;
  size?: { width: number; height: number };
  layout?: KeyboardLayout;
  folders?: FolderSpec[];
  three?: { renderer: MessagePort; caps: Uint8Array };
  snapshot?: File;
  resume: boolean;
  about?: Start['about'];
  plan?: Start['plan'];
};

/** The devices' ends of the channels. */
function ports(ch: Channels, w: StartWith): MachinePorts {
  return {
    keyboard: ch.keyboard.port2,
    tablet: ch.tablet.port2,
    serial: ch.serial.port2,
    display: ch.display.port2,
    nets: ch.nets,
    usb: ch.usb?.port2,
    mouse: ch.mouse?.port2,
    touch: ch.touch?.port2,
    folders: ch.shares && w.folders && { list: w.folders, port: ch.shares.port2 },
    agent: ch.agent?.port2,
    sound: ch.sound,
    renderer: w.three?.renderer,
  };
}

/** The start message, and what it transfers. */
export function startMessage(
  m: PageMachine,
  config: MachineConfig,
  ch: Channels,
  w: StartWith,
): [Start, Transferable[]] {
  const message: Start = {
    type: 'start',
    config: { ...config, guest: { ...config.guest, keyLayout: w.layout?.id } },
    ports: ports(ch, w),
    screen: w.screen,
    caps: w.three?.caps,
    size: m.hasGpu ? w.size : undefined,
    words: guestWords(w.layout),
    disks: w.disks,
    home: w.home,
    snapshot: w.snapshot,
    resume: w.resume,
    about: w.about,
    plan: w.plan,
  };
  const ends = [ch.usb, ch.shares, ch.mouse, ch.touch, ch.agent].flatMap((c) => (c ? [c.port2] : []));
  const transfer: Transferable[] = [
    ch.keyboard.port2,
    ch.tablet.port2,
    ch.serial.port2,
    ch.display.port2,
    ch.sound.port,
    ...(w.screen ? [w.screen] : []),
    ...(w.three ? [w.three.renderer] : []),
    ...ch.nets.map((n) => n.ip),
    ...ends,
  ];
  return [message, transfer];
}
