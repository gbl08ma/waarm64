// The status bar's kinds of element (docs/frontend.md "The status bar"): each one's name, palette group, icon, devices
// and default look, a table the model (web/app/statusbar.ts) and the renderers read.
import { t } from '../i18n.ts';
import type { IconName } from './icons.ts';

/** How an element shows: words (`812 MIPS`), an icon and the bare value (the words in its tooltip), or both. */
export type Look = 'text' | 'icon' | 'both';
/** A per-device element's devices: all of them summed, each in turn, or one, by `index`. */
export type Scope = 'all' | 'each' | 'one';
export type Device = 'cpu' | 'net' | 'disk';
/** The palette's groups (their names: `groupName`). */
export type Group = 'machine' | 'cpu' | 'network' | 'disks' | 'usb' | 'graphics' | 'input' | 'layout';
const GROUP_NAME: Record<Group, string> = {
  machine: 'statusbar:statusbar-kinds.group.machine',
  cpu: 'statusbar:statusbar-kinds.group.cpu',
  network: 'statusbar:statusbar-kinds.group.network',
  disks: 'statusbar:statusbar-kinds.group.disks',
  usb: 'statusbar:statusbar-kinds.group.usb',
  graphics: 'statusbar:statusbar-kinds.group.graphics',
  input: 'statusbar:statusbar-kinds.group.input',
  layout: 'statusbar:statusbar-kinds.group.layout',
};
/** A palette group's name, in the Preferences' editor. */
export const groupName = (g: Group) => t(GROUP_NAME[g]);

/** A kind: `name` and `about` are the keys of its name and of what it shows. */
type Def = {
  name: string;
  group: Group;
  icon?: IconName;
  device?: Device;
  scopes?: Scope[];
  look: Look;
  about: string;
};
export const KINDS = {
  state: {
    name: 'statusbar:statusbar-kinds.kind.state',
    group: 'machine',
    look: 'text',
    about: 'statusbar:statusbar-kinds.kind.state.about',
  },
  os: {
    name: 'statusbar:statusbar-kinds.kind.os',
    group: 'machine',
    icon: 'app-window',
    look: 'text',
    about: 'statusbar:statusbar-kinds.kind.os.about',
  },
  vcpus: {
    name: 'statusbar:statusbar-kinds.kind.vcpus',
    group: 'machine',
    icon: 'cpu',
    look: 'text',
    about: 'statusbar:statusbar-kinds.kind.vcpus.about',
  },
  ram: {
    name: 'statusbar:statusbar-kinds.kind.ram',
    group: 'machine',
    icon: 'memory',
    look: 'text',
    about: 'statusbar:statusbar-kinds.kind.ram.about',
  },
  uptime: {
    name: 'statusbar:statusbar-kinds.kind.uptime',
    group: 'machine',
    icon: 'history',
    look: 'text',
    about: 'statusbar:statusbar-kinds.kind.uptime.about',
  },
  clock: {
    name: 'statusbar:statusbar-kinds.kind.clock',
    group: 'machine',
    icon: 'clock',
    look: 'text',
    about: 'statusbar:statusbar-kinds.kind.clock.about',
  },
  memory: {
    name: 'statusbar:statusbar-kinds.kind.memory',
    group: 'machine',
    icon: 'server-2',
    look: 'text',
    about: 'statusbar:statusbar-kinds.kind.memory.about',
  },
  mips: {
    name: 'statusbar:statusbar-kinds.kind.mips',
    group: 'cpu',
    icon: 'gauge',
    device: 'cpu',
    scopes: ['all', 'each', 'one'],
    look: 'text',
    about: 'statusbar:statusbar-kinds.kind.mips.about',
  },
  jit: {
    name: 'statusbar:statusbar-kinds.kind.jit',
    group: 'cpu',
    icon: 'car-turbine',
    device: 'cpu',
    scopes: ['all', 'each', 'one'],
    look: 'text',
    about: 'statusbar:statusbar-kinds.kind.jit.about',
  },
  irqs: {
    name: 'statusbar:statusbar-kinds.kind.irqs',
    group: 'cpu',
    icon: 'bolt',
    look: 'text',
    about: 'statusbar:statusbar-kinds.kind.irqs.about',
  },
  blocks: {
    name: 'statusbar:statusbar-kinds.kind.blocks',
    group: 'cpu',
    icon: 'blocks',
    look: 'text',
    about: 'statusbar:statusbar-kinds.kind.blocks.about',
  },
  compile: {
    name: 'statusbar:statusbar-kinds.kind.compile',
    group: 'cpu',
    icon: 'clock-code',
    look: 'text',
    about: 'statusbar:statusbar-kinds.kind.compile.about',
  },
  jitcache: {
    name: 'statusbar:statusbar-kinds.kind.jitcache',
    group: 'cpu',
    icon: 'cake-roll',
    look: 'text',
    about: 'statusbar:statusbar-kinds.kind.jitcache.about',
  },
  netrate: {
    name: 'statusbar:statusbar-kinds.kind.netrate',
    group: 'network',
    icon: 'network',
    device: 'net',
    scopes: ['all', 'each', 'one'],
    look: 'text',
    about: 'statusbar:statusbar-kinds.kind.netrate.about',
  },
  nettotal: {
    name: 'statusbar:statusbar-kinds.kind.nettotal',
    group: 'network',
    icon: 'network',
    device: 'net',
    scopes: ['all', 'each', 'one'],
    look: 'text',
    about: 'statusbar:statusbar-kinds.kind.nettotal.about',
  },
  link: {
    name: 'statusbar:statusbar-kinds.kind.link',
    group: 'network',
    icon: 'network',
    device: 'net',
    scopes: ['each', 'one'],
    look: 'icon',
    about: 'statusbar:statusbar-kinds.kind.link.about',
  },
  diskrate: {
    name: 'statusbar:statusbar-kinds.kind.diskrate',
    group: 'disks',
    icon: 'database',
    device: 'disk',
    scopes: ['all', 'each', 'one'],
    look: 'text',
    about: 'statusbar:statusbar-kinds.kind.diskrate.about',
  },
  disktotal: {
    name: 'statusbar:statusbar-kinds.kind.disktotal',
    group: 'disks',
    icon: 'database',
    device: 'disk',
    scopes: ['all', 'each', 'one'],
    look: 'text',
    about: 'statusbar:statusbar-kinds.kind.disktotal.about',
  },
  usbrate: {
    name: 'statusbar:statusbar-kinds.kind.usbrate',
    group: 'usb',
    icon: 'usb',
    look: 'text',
    about: 'statusbar:statusbar-kinds.kind.usbrate.about',
  },
  usbtotal: {
    name: 'statusbar:statusbar-kinds.kind.usbtotal',
    group: 'usb',
    icon: 'usb',
    look: 'text',
    about: 'statusbar:statusbar-kinds.kind.usbtotal.about',
  },
  gpu: {
    name: 'statusbar:statusbar-kinds.kind.gpu',
    group: 'graphics',
    icon: 'device-desktop',
    look: 'text',
    about: 'statusbar:statusbar-kinds.kind.gpu.about',
  },
  fps: {
    name: 'statusbar:statusbar-kinds.kind.fps',
    group: 'graphics',
    icon: 'keyframes',
    look: 'text',
    about: 'statusbar:statusbar-kinds.kind.fps.about',
  },
  video: {
    name: 'statusbar:statusbar-kinds.kind.video',
    group: 'graphics',
    icon: 'player-play',
    look: 'text',
    about: 'statusbar:statusbar-kinds.kind.video.about',
  },
  vulkan: {
    name: 'statusbar:statusbar-kinds.kind.vulkan',
    group: 'graphics',
    icon: 'cube',
    look: 'text',
    about: 'statusbar:statusbar-kinds.kind.vulkan.about',
  },
  pointer: {
    name: 'statusbar:statusbar-kinds.kind.pointer',
    group: 'input',
    icon: 'mouse',
    look: 'icon',
    about: 'statusbar:statusbar-kinds.kind.pointer.about',
  },
  keyboard: {
    name: 'statusbar:statusbar-kinds.kind.keyboard',
    group: 'input',
    icon: 'keyboard',
    look: 'icon',
    about: 'statusbar:statusbar-kinds.kind.keyboard.about',
  },
  mic: {
    name: 'statusbar:statusbar-kinds.kind.mic',
    group: 'input',
    icon: 'microphone',
    look: 'icon',
    about: 'statusbar:statusbar-kinds.kind.mic.about',
  },
  spacer: {
    name: 'statusbar:statusbar-kinds.kind.spacer',
    group: 'layout',
    look: 'text',
    about: 'statusbar:statusbar-kinds.kind.spacer.about',
  },
  divider: {
    name: 'statusbar:statusbar-kinds.kind.divider',
    group: 'layout',
    look: 'text',
    about: 'statusbar:statusbar-kinds.kind.divider.about',
  },
} satisfies Record<string, Def>;
export type Kind = keyof typeof KINDS;
export const def = (k: Kind): Def => KINDS[k];
