// What a start hands the machine worker (web/app/protocol.ts `start`): the run's channels, one per device the machine
// has, and the start message built from the page's machine and the address's knobs, with the ports it transfers.
import type { PageAudio } from '../../audio.ts';
import type { FolderSpec } from '../../9p-folders.ts';
import { guestWords } from '../guest-words.ts';
import type { KeyboardLayout } from '../keyboard.ts';
import type { StartDisk, ToWorker } from '../protocol.ts';
import { credentials, cpuFlags, params, simpleDisplay } from './knobs.ts';
import { sharesPath, type PageMachine } from './page-machine.svelte.ts';

type Start = Extract<ToWorker, { type: 'start' }>;

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

/** A run's channels for what the page's machine has. */
export function channels(m: PageMachine, sound: Channels['sound'], nets: Channels['nets']): Channels {
  const optional = (on: boolean) => (on ? new MessageChannel() : undefined);
  return {
    display: new MessageChannel(),
    keyboard: new MessageChannel(),
    tablet: new MessageChannel(),
    serial: new MessageChannel(),
    sound,
    nets,
    usb: optional(m.has('usb')),
    shares: optional(!!m.stored?.record.shares),
    mouse: optional(m.has('mouse')),
    touch: optional(m.has('touch')),
    agent: optional(m.has('clipboard')),
  };
}

/** What a start adds to the channels: the disks, the 3D renderer, the snapshot and the rest. */
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

/** The devices' ends and the knobs of the start message. */
function devices(m: PageMachine, ch: Channels, w: StartWith) {
  const stored = m.stored?.record;
  const shares = stored && sharesPath(stored);
  return {
    keyboard: ch.keyboard.port2,
    tablet: ch.tablet.port2,
    serial: ch.serial.port2,
    screen: w.screen,
    display: ch.display.port2,
    nets: ch.nets,
    usb: ch.usb?.port2,
    mouse: ch.mouse?.port2,
    touch: ch.touch?.port2,
    folders: ch.shares && w.folders && { list: w.folders, port: ch.shares.port2 },
    sharesPath: ch.shares ? shares : undefined,
    agent: ch.agent?.port2,
    sound: ch.sound,
  };
}

/** The address's knobs the start message carries (development, tests and measurements). */
const knobs = () => ({
  simple: simpleDisplay || undefined,
  displayStats: params.has('displaystats') || undefined,
  ioStats: params.has('iostats') || undefined,
  noDiskCache: params.get('diskcache') === '0' || undefined,
  avProbe: params.has('avprobe') || undefined,
  cpu: cpuFlags(),
  params: params.get('params') ?? undefined,
  credentials,
});

/** The start message, and what it transfers. */
export function startMessage(m: PageMachine, ch: Channels, w: StartWith): [Start, Transferable[]] {
  const stored = m.stored?.record;
  const message: Start = {
    type: 'start',
    query: location.search,
    machine: m.name,
    ncpus: m.ncpus,
    ramMiB: m.ramMiB,
    ramSplit: m.ramSplit,
    jitMiB: m.jitMiB || undefined,
    keyLayout: w.layout?.id,
    netConfig: (params.get('netconfig') ?? (stored?.netConfig === false ? '0' : '1')) !== '0',
    disks: w.disks,
    home: w.home,
    ...devices(m, ch, w),
    size: m.hasGpu ? w.size : undefined,
    ...knobs(),
    guest: guestWords(w.layout),
    clock: stored ? !!stored.clock : params.get('clock') !== '0',
    snapshot: w.snapshot,
    resume: w.resume,
    about: w.about,
    plan: w.plan,
    ...w.three,
    vulkan: w.three && m.wantsVulkan() ? true : undefined,
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
