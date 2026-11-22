// What a start hands the machine worker (web/app/protocol.ts `start`): the machine's configuration, resolved once per
// start (`PageMachine.config`: web/app/run/config.ts's rules over the page's machine), the run's channels, one per
// device the configuration has, and the start message with the ports it transfers.
import type { PageAudio } from '../../audio.ts';
import type { FolderSpec } from '../../9p-folders.ts';
import { guestWords } from '../guest-words.ts';
import type { KeyboardLayout } from '../keyboard.ts';
import type { MachineConfig, MachinePorts, StartDisk, ToWorker } from '../protocol.ts';
import { MACHINES, type Machine } from '../machine.ts';
import type { PageMachine } from './page-machine.svelte.ts';

type Start = Extract<ToWorker, { type: 'start' }>;

/** A run's channels: the page keeps `port1` of each, the worker gets `port2`. */
export type Channels = {
  display: MessageChannel;
  keyboard: MessageChannel;
  tablet: MessageChannel;
  serial: MessageChannel;
  sound: ReturnType<PageAudio['attach']>;
  /** The machine's network adapters' ends of the IP ports (web/app/net-live.ts: the clients of their connections). */
  nets: { mac: string; ip: MessagePort; link?: MessagePort }[];
  /** The page's ends of the cards' links. */
  netLinks: MessagePort[];
  /** A USB controller's port its devices are attached over (docs/usb.md "The page"). */
  usb?: MessageChannel;
  /** Shared folders' port: what's attached while it runs goes over it (docs/shares.md). */
  shares?: MessageChannel;
  /** A relative mouse (the pointer while the screen holds the mouse) and a touchscreen. */
  mouse?: MessageChannel;
  touch?: MessageChannel;
  /** The guest agent's end (web/app/agent-link.ts), a `firmware` machine's with the agent on (over its vsock). */
  agent?: MessageChannel;
  /** The agent shares the clipboard (the page's HELLO says so). */
  clipboard: boolean;
  /** The agent's device end is the page's tests' (web/app/run/dev-knobs.ts `agentStub`), not the worker's. */
  agentStub: boolean;
  /** systemd's notifications, a firmware machine's (web/vsock-device.ts): the page hears READY=1. */
  notify?: MessageChannel;
};

/** What a run's guest agent takes of its channels (web/app/areas/agent-actions.ts). */
export type AgentChannels = Pick<Channels, 'agent' | 'clipboard' | 'agentStub'>;

/** A run's channels for what the configuration has. */
export function channels(
  c: MachineConfig,
  sound: Channels['sound'],
  ips: { mac: string; ip: MessagePort }[],
): Channels {
  const optional = (on: boolean) => (on ? new MessageChannel() : undefined);
  // Each card's link of the page's to its device (a flap: web/app/areas/lease-actions.ts).
  const links = ips.map(() => new MessageChannel());
  const nets = ips.map((n, i) => ({ ...n, link: links[i].port2 }));
  return {
    netLinks: links.map((l) => l.port1),
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
    agent: optional(c.dev.agentStub || (c.devices.agent && !!(MACHINES[c.machine] as Machine).firmware)),
    agentStub: c.dev.agentStub,
    clipboard: c.devices.clipboard,
    notify: optional(!!(MACHINES[c.machine] as Machine).firmware),
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
    agent: ch.agentStub ? undefined : ch.agent?.port2,
    notify: ch.notify?.port2,
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
  const ends = [ch.usb, ch.shares, ch.mouse, ch.touch, ch.agentStub ? undefined : ch.agent, ch.notify].flatMap((c) =>
    c ? [c.port2] : [],
  );
  const transfer: Transferable[] = [
    ch.keyboard.port2,
    ch.tablet.port2,
    ch.serial.port2,
    ch.display.port2,
    ch.sound.port,
    ...(w.screen ? [w.screen] : []),
    ...(w.three ? [w.three.renderer] : []),
    ...ch.nets.flatMap((n) => (n.link ? [n.ip, n.link] : [n.ip])),
    ...ends,
  ];
  return [message, transfer];
}
