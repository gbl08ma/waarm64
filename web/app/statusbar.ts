// The status bar's elements (docs/frontend.md "The status bar"): what each can show, the bar a browser starts with, and
// the pieces an element draws from the last second's numbers. web/app/StatusBar.svelte draws the bar, and the
// Preferences' editor (web/app/StatusEditor.svelte) chooses and orders its elements, kept in the settings' `statusBar`.
// DOM-free, for tests/statusbar.test.ts.
import { msg, t, type Msg } from '../i18n.ts';
import { bytesText } from './bytes.ts';
import type { IconName } from './icons.ts';
import type { Status } from './protocol.ts';
import type { PageState } from './areas/power.svelte.ts';

/** How an element shows: words (`812 MIPS`), an icon and the bare value (the words in its tooltip), or both. */
export type Look = 'text' | 'icon' | 'both';
/** A per-device element's devices: all of them summed, each in turn, or one, by `index`. */
export type Scope = 'all' | 'each' | 'one';
type Device = 'cpu' | 'net' | 'disk';
/** The palette's groups (their names: `groupName`). */
export type Group = 'machine' | 'cpu' | 'network' | 'disks' | 'usb' | 'graphics' | 'input' | 'layout';
const GROUP_NAME: Record<Group, string> = {
  machine: 'statusbar:statusbar.group.machine',
  cpu: 'statusbar:statusbar.group.cpu',
  network: 'statusbar:statusbar.group.network',
  disks: 'statusbar:statusbar.group.disks',
  usb: 'statusbar:statusbar.group.usb',
  graphics: 'statusbar:statusbar.group.graphics',
  input: 'statusbar:statusbar.group.input',
  layout: 'statusbar:statusbar.group.layout',
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
    name: 'statusbar:statusbar.kind.state',
    group: 'machine',
    look: 'text',
    about: 'statusbar:statusbar.kind.state.about',
  },
  vcpus: {
    name: 'statusbar:statusbar.kind.vcpus',
    group: 'machine',
    icon: 'cpu',
    look: 'text',
    about: 'statusbar:statusbar.kind.vcpus.about',
  },
  ram: {
    name: 'statusbar:statusbar.kind.ram',
    group: 'machine',
    icon: 'memory',
    look: 'text',
    about: 'statusbar:statusbar.kind.ram.about',
  },
  uptime: {
    name: 'statusbar:statusbar.kind.uptime',
    group: 'machine',
    icon: 'history',
    look: 'text',
    about: 'statusbar:statusbar.kind.uptime.about',
  },
  clock: {
    name: 'statusbar:statusbar.kind.clock',
    group: 'machine',
    icon: 'clock',
    look: 'text',
    about: 'statusbar:statusbar.kind.clock.about',
  },
  memory: {
    name: 'statusbar:statusbar.kind.memory',
    group: 'machine',
    icon: 'server-2',
    look: 'text',
    about: 'statusbar:statusbar.kind.memory.about',
  },
  mips: {
    name: 'statusbar:statusbar.kind.mips',
    group: 'cpu',
    icon: 'gauge',
    device: 'cpu',
    scopes: ['all', 'each', 'one'],
    look: 'text',
    about: 'statusbar:statusbar.kind.mips.about',
  },
  jit: {
    name: 'statusbar:statusbar.kind.jit',
    group: 'cpu',
    icon: 'car-turbine',
    device: 'cpu',
    scopes: ['all', 'each', 'one'],
    look: 'text',
    about: 'statusbar:statusbar.kind.jit.about',
  },
  irqs: {
    name: 'statusbar:statusbar.kind.irqs',
    group: 'cpu',
    icon: 'bolt',
    look: 'text',
    about: 'statusbar:statusbar.kind.irqs.about',
  },
  blocks: {
    name: 'statusbar:statusbar.kind.blocks',
    group: 'cpu',
    icon: 'blocks',
    look: 'text',
    about: 'statusbar:statusbar.kind.blocks.about',
  },
  compile: {
    name: 'statusbar:statusbar.kind.compile',
    group: 'cpu',
    icon: 'clock-code',
    look: 'text',
    about: 'statusbar:statusbar.kind.compile.about',
  },
  jitcache: {
    name: 'statusbar:statusbar.kind.jitcache',
    group: 'cpu',
    icon: 'cake-roll',
    look: 'text',
    about: 'statusbar:statusbar.kind.jitcache.about',
  },
  netrate: {
    name: 'statusbar:statusbar.kind.netrate',
    group: 'network',
    icon: 'network',
    device: 'net',
    scopes: ['all', 'each', 'one'],
    look: 'text',
    about: 'statusbar:statusbar.kind.netrate.about',
  },
  nettotal: {
    name: 'statusbar:statusbar.kind.nettotal',
    group: 'network',
    icon: 'network',
    device: 'net',
    scopes: ['all', 'each', 'one'],
    look: 'text',
    about: 'statusbar:statusbar.kind.nettotal.about',
  },
  link: {
    name: 'statusbar:statusbar.kind.link',
    group: 'network',
    icon: 'network',
    device: 'net',
    scopes: ['each', 'one'],
    look: 'icon',
    about: 'statusbar:statusbar.kind.link.about',
  },
  diskrate: {
    name: 'statusbar:statusbar.kind.diskrate',
    group: 'disks',
    icon: 'database',
    device: 'disk',
    scopes: ['all', 'each', 'one'],
    look: 'text',
    about: 'statusbar:statusbar.kind.diskrate.about',
  },
  disktotal: {
    name: 'statusbar:statusbar.kind.disktotal',
    group: 'disks',
    icon: 'database',
    device: 'disk',
    scopes: ['all', 'each', 'one'],
    look: 'text',
    about: 'statusbar:statusbar.kind.disktotal.about',
  },
  usbrate: {
    name: 'statusbar:statusbar.kind.usbrate',
    group: 'usb',
    icon: 'usb',
    look: 'text',
    about: 'statusbar:statusbar.kind.usbrate.about',
  },
  usbtotal: {
    name: 'statusbar:statusbar.kind.usbtotal',
    group: 'usb',
    icon: 'usb',
    look: 'text',
    about: 'statusbar:statusbar.kind.usbtotal.about',
  },
  gpu: {
    name: 'statusbar:statusbar.kind.gpu',
    group: 'graphics',
    icon: 'device-desktop',
    look: 'text',
    about: 'statusbar:statusbar.kind.gpu.about',
  },
  fps: {
    name: 'statusbar:statusbar.kind.fps',
    group: 'graphics',
    icon: 'keyframes',
    look: 'text',
    about: 'statusbar:statusbar.kind.fps.about',
  },
  video: {
    name: 'statusbar:statusbar.kind.video',
    group: 'graphics',
    icon: 'player-play',
    look: 'text',
    about: 'statusbar:statusbar.kind.video.about',
  },
  vulkan: {
    name: 'statusbar:statusbar.kind.vulkan',
    group: 'graphics',
    icon: 'cube',
    look: 'text',
    about: 'statusbar:statusbar.kind.vulkan.about',
  },
  pointer: {
    name: 'statusbar:statusbar.kind.pointer',
    group: 'input',
    icon: 'mouse',
    look: 'icon',
    about: 'statusbar:statusbar.kind.pointer.about',
  },
  keyboard: {
    name: 'statusbar:statusbar.kind.keyboard',
    group: 'input',
    icon: 'keyboard',
    look: 'icon',
    about: 'statusbar:statusbar.kind.keyboard.about',
  },
  mic: {
    name: 'statusbar:statusbar.kind.mic',
    group: 'input',
    icon: 'microphone',
    look: 'icon',
    about: 'statusbar:statusbar.kind.mic.about',
  },
  spacer: {
    name: 'statusbar:statusbar.kind.spacer',
    group: 'layout',
    look: 'text',
    about: 'statusbar:statusbar.kind.spacer.about',
  },
  divider: {
    name: 'statusbar:statusbar.kind.divider',
    group: 'layout',
    look: 'text',
    about: 'statusbar:statusbar.kind.divider.about',
  },
} satisfies Record<string, Def>;
export type Kind = keyof typeof KINDS;
const def = (k: Kind): Def => KINDS[k];

/** One element of the bar. `index`: the device of a `one` element as the page numbers it (vCPUs from 0, as the guest
 * names them; adapters and disks from 1, as the machine's Network and Disks tabs list them). `numbers`: an `each`
 * vCPU element writes its numbers rather than drawing bars. */
export type Item = { kind: Kind; scope?: Scope; index?: number; look?: Look; numbers?: boolean };

/** Today's bar, and the one a browser starts with. */
export const DEFAULT_ITEMS: readonly Item[] = [
  { kind: 'state' },
  { kind: 'divider' },
  { kind: 'vcpus' },
  { kind: 'ram' },
  { kind: 'uptime' },
  { kind: 'mips' },
  { kind: 'jit' },
  { kind: 'irqs' },
];

const LOOKS: Look[] = ['text', 'icon', 'both'];
/** The kept list as the page uses it: unknown kinds and fields dropped (another version's), each field checked. */
export function normalize(kept: unknown): Item[] {
  if (!Array.isArray(kept)) return DEFAULT_ITEMS.map((i) => ({ ...i }));
  const out: Item[] = [];
  for (const k of kept as Partial<Item>[]) {
    if (!k || typeof k !== 'object' || typeof k.kind !== 'string' || !Object.hasOwn(KINDS, k.kind)) continue;
    const d = def(k.kind);
    const item: Item = { kind: k.kind };
    if (d.scopes) item.scope = d.scopes.includes(k.scope!) ? k.scope : d.scopes[0];
    if (item.scope === 'one') item.index = Number.isInteger(k.index) && k.index! >= 0 ? k.index : firstIndex(d.device!);
    if (k.look && LOOKS.includes(k.look) && k.look !== d.look && hasLooks(k.kind)) item.look = k.look;
    if (k.numbers === true && d.device === 'cpu' && item.scope === 'each') item.numbers = true;
    out.push(item);
  }
  return out;
}
/** The first device's number: vCPU 0, adapter or disk 1. */
export const firstIndex = (d: Device) => (d === 'cpu' ? 0 : 1);
/** Whether the element's look can be chosen (the layout's elements have none). */
export const hasLooks = (k: Kind) => k !== 'spacer' && k !== 'divider';
export const lookOf = (i: Item): Look => i.look ?? def(i.kind).look;
/** What the device of a kind is called, for the editor. */
export const deviceOf = (k: Kind) => def(k).device;
export const scopesOf = (k: Kind) => def(k).scopes;
/** The names of a per-device element: `{{name}}` is the kind's, `{{index}}` the device's number. */
const SCOPED = {
  each: {
    cpu: 'statusbar:statusbar.name.each.cpu',
    net: 'statusbar:statusbar.name.each.net',
    disk: 'statusbar:statusbar.name.each.disk',
  },
  any: {
    cpu: 'statusbar:statusbar.name.any.cpu',
    net: 'statusbar:statusbar.name.any.net',
    disk: 'statusbar:statusbar.name.any.disk',
  },
  one: {
    cpu: 'statusbar:statusbar.name.one.cpu',
    net: 'statusbar:statusbar.name.one.net',
    disk: 'statusbar:statusbar.name.one.disk',
  },
} as const;

/** An element's name in the editor and its tooltips: `MIPS`, `MIPS, each vCPU`, `MIPS, vCPU 2` (`generic`, the palette's: `MIPS, one vCPU`). */
export function nameOf(i: Item, generic = false) {
  const d = def(i.kind);
  const name = msg(d.name);
  if (!d.device || !i.scope || (i.scope === 'all' && d.scopes![0] === 'all')) return t(d.name);
  if (i.scope === 'each') return t(SCOPED.each[d.device], { name });
  if (i.scope === 'one')
    return generic
      ? t(SCOPED.any[d.device], { name })
      : t(SCOPED.one[d.device], { name, index: i.index ?? firstIndex(d.device) });
  return t(d.name);
}
/** The palette's chips: every kind in each of its scopes (a `one` chip adds the first device: its number is set after). */
export function palette(): { group: Group; items: Item[] }[] {
  const groups = new Map<Group, Item[]>();
  for (const kind of Object.keys(KINDS) as Kind[]) {
    const d = def(kind);
    const items = d.scopes
      ? d.scopes.map((scope): Item =>
          scope === 'one' ? { kind, scope, index: firstIndex(d.device!) } : { kind, scope },
        )
      : [{ kind }];
    groups.set(d.group, [...(groups.get(d.group) ?? []), ...items]);
  }
  return [...groups].map(([group, items]) => ({ group, items }));
}
export const aboutOf = (k: Kind) => t(def(k).about);
export const iconOf = (k: Kind) => def(k).icon;

/** One second's numbers, from two statuses in a row (rates need both: until then they're undefined). */
export type Metrics = {
  ncpus: number;
  ramMiB: number;
  uptimeMs: number;
  mips?: number;
  /** Percent of the instructions run in JIT code. */
  jit?: number;
  /** Each vCPU's, when each vCPU counts its own (a worker per vCPU); `jit` undefined in a second it ran nothing. */
  cpus?: { mips: number; jit?: number }[];
  /** The highest vCPU's MIPS seen in this run: the bars' full height. */
  cpuPeak: number;
  irqs?: number;
  blocks: number;
  flushes: number;
  compileMs: number;
  jitLive: number;
  jitBudget: number;
  /** The tab's memory by the emulator's accounting (web/app/memory.ts). */
  tabBytes?: number;
  /** Per disk and adapter, in the machine's order: totals, and their rates a second. */
  disks?: { read: number; written: number; readRate?: number; writeRate?: number }[];
  nets?: { rx: number; tx: number; rxRate?: number; txRate?: number }[];
  /** A machine with a USB controller: its devices' bytes in (to the guest) and out, all together, and their rates a second. */
  usb?: { in: number; out: number; inRate?: number; outRate?: number };
};
export type Sample = { status: Status; at: number; metrics: Metrics };

/** A video stream as the GPU worker reports it (web/virgl-video.ts `VideoStream`), with its pictures a second. */
type Stream = {
  id: number;
  profile: string;
  width: number;
  height: number;
  hardware: boolean;
  open: boolean;
  decoded: number;
  fps?: number;
};
/**
 * The screen's last second: a 3D machine's GPU worker `stats` (web/gpu-worker.ts), or a 2D machine's presenter's
 * `screen-stats` (web/gpu-present.ts; `webgl2` or `canvas2d`), or a machine without virtio-gpu's simple framebuffer
 * (`framebuffer`: its machine worker's `screen-stats`, web/app/worker.ts). `fps`: presents a second; the video's decoded pictures a
 * second, all streams and each. `hardware` is what a decoder asked for: WebCodecs doesn't say what it got (Chromium's
 * `prefer-hardware` fails rather than fall back).
 */
export type Graphics = {
  mode: '3d' | 'webgl2' | 'canvas2d' | 'framebuffer';
  renderer?: string;
  vendor?: string;
  software?: boolean;
  presents: number;
  fps?: number;
  video?: { enabled: boolean; decoded: number; fps?: number; decoderErrors: number; streams: Stream[] };
  /** A Vulkan machine's Venus (web/gpu-worker.ts `VulkanReport`), its submits and draws a second. */
  vulkan?: Vulkan;
};
type Vulkan = {
  contexts: number;
  submits: number;
  draws: number;
  device: boolean;
  adapter?: string;
  software?: boolean;
  submitRate?: number;
  drawRate?: number;
};
type GpuReport = {
  renderer?: string;
  vendor?: string;
  software?: boolean;
  presents: number;
  video?: { enabled: boolean; decoded: number; decoderErrors: number; streams: Omit<Stream, 'fps'>[] };
  vulkan?: Omit<Vulkan, 'submitRate' | 'drawRate'>;
};
/** A report received at `at` (ms), after `prev` (the same run's last). */
export function graphics(
  mode: Graphics['mode'],
  m: GpuReport,
  at: number,
  prev?: { g: Graphics; at: number },
): Graphics {
  const dt = prev && prev.g.mode === mode ? (at - prev.at) / 1000 : 0;
  const rate = (now: number, then: number | undefined) =>
    then !== undefined && dt > 0 && now >= then ? (now - then) / dt : undefined;
  const v = m.video;
  return {
    mode,
    renderer: m.renderer,
    vendor: m.vendor,
    software: m.software,
    presents: m.presents,
    fps: rate(m.presents, prev?.g.presents),
    video: v && {
      enabled: v.enabled,
      decoded: v.decoded,
      decoderErrors: v.decoderErrors,
      fps: rate(v.decoded, prev?.g.video?.decoded),
      streams: v.streams.map((st) => ({
        ...st,
        fps: rate(st.decoded, prev?.g.video?.streams.find((o) => o.id === st.id)?.decoded),
      })),
    },
    vulkan: m.vulkan && {
      ...m.vulkan,
      submitRate: rate(m.vulkan.submits, prev?.g.vulkan?.submits),
      drawRate: rate(m.vulkan.draws, prev?.g.vulkan?.draws),
    },
  };
}

/** `s`, received at `at` (ms, monotonic), after `prev` (the run's previous one). */
export function metrics(s: Status, at: number, prev?: Sample, tabBytes?: number): Metrics {
  const p = prev?.status;
  const dt = prev ? (at - prev.at) / 1000 : 0;
  const rate = (now: number, then: number | undefined) =>
    then !== undefined && dt > 0 ? Math.max(0, now - then) / dt : undefined;
  const share = (jit: number, all: number, jit0?: number, all0?: number) =>
    jit0 !== undefined && all0 !== undefined && all > all0 ? ((jit - jit0) / (all - all0)) * 100 : undefined;
  const cpus =
    s.cpus && p?.cpus?.length === s.cpus.length
      ? s.cpus.map((c, i) => ({
          mips: (rate(c.steps, p.cpus![i].steps) ?? 0) / 1e6,
          jit: share(c.jitSteps, c.steps, p.cpus![i].jitSteps, p.cpus![i].steps),
        }))
      : undefined;
  const mips = rate(s.steps, p?.steps);
  return {
    ncpus: s.ncpus,
    ramMiB: s.ramMiB,
    uptimeMs: s.uptime,
    mips: mips === undefined ? undefined : mips / 1e6,
    jit: share(s.jitSteps, s.steps, p?.jitSteps, p?.steps),
    cpus,
    cpuPeak: Math.max(prev?.metrics.cpuPeak ?? 0, ...(cpus ?? []).map((c) => c.mips)),
    irqs: rate(s.irqs, p?.irqs),
    blocks: s.jitBlocks,
    flushes: s.jitFlushes,
    compileMs: s.jitCompileMs,
    jitLive: s.memory.jitLiveBytes,
    jitBudget: s.memory.jitBudget,
    tabBytes,
    disks: s.disks?.map((d, i) => ({
      ...d,
      readRate: rate(d.read, p?.disks?.[i]?.read),
      writeRate: rate(d.written, p?.disks?.[i]?.written),
    })),
    nets: s.nets?.map((n, i) => ({ ...n, rxRate: rate(n.rx, p?.nets?.[i]?.rx), txRate: rate(n.tx, p?.nets?.[i]?.tx) })),
    usb: s.usb && { ...s.usb, inRate: rate(s.usb.in, p?.usb?.in), outRate: rate(s.usb.out, p?.usb?.out) },
  };
}

/** What the page knows besides the statuses. */
export type Live = {
  state: PageState;
  stateText: string;
  /** This computer's time, ms since the epoch. */
  now: number;
  mouseLock: boolean;
  mouseLocked: boolean;
  keyboardLocked: boolean;
  /** The screen or the terminal has the focus, in a focused window: keys go to the machine (no "Click to type"). */
  keysFocused: boolean;
  /** The microphone (web/audio.ts `micState`). */
  mic: string;
  /** The machine's disks' and adapters' names, in its order; an adapter's connection phase (web/app/network.ts) and words. */
  disks: string[];
  /** `details`: lines under its words in the tooltip (why a connection failed; a room's active connections). */
  nets: { name: string; phase: string; text: string; details?: string[] }[];
  /** The screen's last second (none yet, or no screen). */
  gpu?: Graphics;
};

/** A colour the bar has words for. */
export type Tone = 'ok' | 'busy' | 'off' | 'bad' | 'dim';
/**
 * What an element draws: its words (`text`), or with an icon its short value (`short`, the words in `title`), a dot
 * before them (the power state), a tone, bars (each from 0 to 1, per vCPU), or parts with icons of their own.
 */
export type Piece = {
  text: string;
  short?: string;
  icon?: IconName;
  tone?: Tone;
  dot?: boolean;
  bars?: number[];
  title: string;
  label?: string;
  parts?: Part[];
};
/** A value drawn with an icon of its own (received, sent): `label` (words only) and `parts` stand for `text` and `short` then. */
export type Part = { icon: IconName; text: string };

const count = (n: number) => Math.round(n).toLocaleString('en');
const size = (n: number) => (n < 1024 ? `${Math.round(n)} B` : bytesText(n)); // i18n-ignore: a size and its unit
const perSec = (n: number | undefined) => (n === undefined ? '…' : `${size(n)}/s`); // i18n-ignore: a rate's unit
const hms = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const STATE_TONE: Partial<Record<PageState, Tone>> = {
  running: 'ok',
  off: 'off',
  idle: 'off',
  crashed: 'bad',
  failed: 'bad',
};
/** A connection's phase (web/app/network.ts) as a `link` element says it, with the adapter's name, and its tone. */
const PHASE_WORD: Record<string, [string, Tone]> = {
  connected: ['statusbar:statusbar.link.connected', 'ok'],
  connecting: ['statusbar:statusbar.link.connecting', 'busy'],
  login: ['statusbar:statusbar.link.login', 'busy'],
  error: ['statusbar:statusbar.link.error', 'bad'],
  off: ['statusbar:statusbar.link.off', 'off'],
};
/** An adapter's name, by its number from 1 (as the machine's Network tab lists them). */
export const adapterName = (n: number) => t('statusbar:statusbar.adapter', { number: n });

/**
 * The devices a per-device element shows: all (`undefined`: summed), each, or the one numbered `index`; none when the
 * machine hasn't it (the element disappears).
 */
function devices<T>(i: Item, list: T[] | undefined): { at: number; v: T }[] | undefined {
  if (!list) return [];
  if (i.scope === 'all') return undefined;
  const all = list.map((v, at) => ({ at, v }));
  if (i.scope === 'each') return all;
  const at = (i.index ?? firstIndex(def(i.kind).device!)) - firstIndex(def(i.kind).device!);
  return all.filter((d) => d.at === at);
}

/** What item `i` draws now: nothing, one piece, or one per device (an `each` element). */
export function render(i: Item, m: Metrics | undefined, live: Live): Piece[] {
  const d = def(i.kind);
  const one = (text: string, short: string, title: string, extra: Partial<Piece> = {}): Piece[] => [
    { text, short, icon: d.icon, title, ...extra },
  ];
  switch (i.kind) {
    case 'state':
      return [
        {
          text: live.stateText,
          short: '',
          dot: true,
          tone: STATE_TONE[live.state] ?? 'busy',
          title: t('statusbar:statusbar.state.title', { state: live.stateText }),
        },
      ];
    case 'clock': {
      const time = new Date(live.now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return one(time, time, t('statusbar:statusbar.clock.title', { time }));
    }
    case 'pointer': {
      const [text, tone, title] = live.mouseLocked
        ? ([t('statusbar:statusbar.pointer.held'), 'ok', t('statusbar:statusbar.pointer.held.title')] as const)
        : live.mouseLock
          ? ([t('statusbar:statusbar.pointer.on'), 'dim', t('statusbar:statusbar.pointer.on.title')] as const)
          : ([t('statusbar:statusbar.pointer.off'), 'off', t('statusbar:statusbar.pointer.off.title')] as const);
      return one(text, '', title, { tone });
    }
    case 'keyboard':
      return live.keyboardLocked
        ? one(t('statusbar:statusbar.keyboard.locked'), '', t('statusbar:statusbar.keyboard.locked.title'), {
            tone: 'ok',
          })
        : live.keysFocused
          ? one(t('statusbar:statusbar.keyboard.typing'), '', t('statusbar:statusbar.keyboard.typing.title'), {
              tone: 'ok',
            })
          : one(t('statusbar:statusbar.keyboard.click'), '', t('statusbar:statusbar.keyboard.click.title'), {
              tone: 'off',
            });
    case 'mic':
      return live.mic === 'on'
        ? one(t('statusbar:statusbar.mic.on'), '', t('statusbar:statusbar.mic.on.title'), { tone: 'bad' })
        : live.mic === 'denied'
          ? one(t('statusbar:statusbar.mic.denied'), '', t('statusbar:statusbar.mic.denied.title'), { tone: 'dim' })
          : [];
    case 'link': {
      return (devices(i, live.nets) ?? []).map(({ v }) => {
        const [key, tone] = PHASE_WORD[v.phase] ?? ['', 'busy'];
        const text = key
          ? t(key, { name: v.name })
          : t('statusbar:statusbar.link.other', { name: v.name, phase: v.phase });
        return {
          text,
          short: '',
          icon: d.icon,
          tone,
          title: t('statusbar:statusbar.link.title', { name: v.name, text: [v.text, ...(v.details ?? [])].join('\n') }),
        };
      });
    }
    case 'spacer':
    case 'divider':
      return [{ text: '', title: t(d.name) }];
    case 'gpu': {
      const g = live.gpu;
      if (!g) return [];
      // The renderer, on a line of its own under the title.
      const by = g.renderer
        ? g.vendor
          ? t('statusbar:statusbar.gpu.renderer.vendor', { renderer: g.renderer, vendor: g.vendor })
          : t('statusbar:statusbar.gpu.renderer', { renderer: g.renderer })
        : '';
      const titled = (title: string) => (by ? `${title}\n${by}` : title);
      if (g.mode === 'framebuffer')
        return one(
          t('statusbar:statusbar.gpu.framebuffer'),
          t('statusbar:statusbar.gpu.2d'),
          t('statusbar:statusbar.gpu.framebuffer.title'),
        );
      if (g.mode === 'canvas2d')
        return one(
          t('statusbar:statusbar.gpu.canvas'),
          t('statusbar:statusbar.gpu.2d'),
          t('statusbar:statusbar.gpu.canvas.title'),
          { tone: 'off' },
        );
      const is3d = g.mode === '3d';
      const what = is3d ? t('statusbar:statusbar.gpu.3d') : t('statusbar:statusbar.gpu.2d');
      return g.software
        ? one(
            is3d ? t('statusbar:statusbar.gpu.software.3d') : t('statusbar:statusbar.gpu.software.2d'),
            what,
            titled(
              is3d ? t('statusbar:statusbar.gpu.software.3d.title') : t('statusbar:statusbar.gpu.software.2d.title'),
            ),
            { tone: 'busy' },
          )
        : one(
            is3d ? t('statusbar:statusbar.gpu.webgl2.3d') : t('statusbar:statusbar.gpu.webgl2.2d'),
            what,
            titled(is3d ? t('statusbar:statusbar.gpu.webgl2.3d.title') : t('statusbar:statusbar.gpu.webgl2.2d.title')),
            { tone: is3d ? 'ok' : undefined },
          );
    }
    case 'fps': {
      const f = live.gpu?.fps;
      return f === undefined
        ? []
        : one(
            t('statusbar:statusbar.fps', { fps: f.toFixed(0) }),
            f.toFixed(0),
            t('statusbar:statusbar.fps.title', { fps: f.toFixed(0) }),
          );
    }
    case 'video': {
      const v = live.gpu?.video;
      if (!v?.enabled) return [];
      const open = v.streams.filter((st) => st.open);
      if (!v.streams.length)
        return one(t('statusbar:statusbar.video.idle'), '', t('statusbar:statusbar.video.idle.title'), { tone: 'off' });
      const hw = open.length > 0 && open.every((st) => st.hardware);
      const codecs = [...new Set(v.streams.map((st) => st.profile))].join(', ');
      const fps = v.fps?.toFixed(0);
      const text = hw
        ? fps === undefined
          ? t('statusbar:statusbar.video.hw', { codecs })
          : t('statusbar:statusbar.video.hw.fps', { codecs, fps })
        : fps === undefined
          ? t('statusbar:statusbar.video.sw', { codecs })
          : t('statusbar:statusbar.video.sw.fps', { codecs, fps });
      const short =
        fps === undefined
          ? `${v.streams.length}`
          : t('statusbar:statusbar.video.short', { streams: v.streams.length, fps });
      // A line per stream: its codec, its size, and what's known of its decoder.
      const lines = v.streams.map((st) => {
        const facts: Msg[] = [
          msg(st.hardware ? 'statusbar:statusbar.video.stream.hardware' : 'statusbar:statusbar.video.stream.software'),
        ];
        if (!st.open) facts.push(msg('statusbar:statusbar.video.stream.closed'));
        if (st.fps !== undefined) facts.push(msg('statusbar:statusbar.video.stream.fps', { fps: st.fps.toFixed(0) }));
        return t('statusbar:statusbar.video.stream', {
          profile: st.profile,
          width: st.width,
          height: st.height,
          facts,
        });
      });
      const title = [
        t('statusbar:statusbar.video.title'),
        ...lines,
        ...(v.decoderErrors ? [t('statusbar:statusbar.video.errors', { errors: v.decoderErrors })] : []),
      ].join('\n');
      return one(text, short, title, { tone: hw ? 'ok' : undefined });
    }
    case 'vulkan': {
      const k = live.gpu?.vulkan;
      if (!k) return [];
      const on = k.adapter
        ? t(k.software ? 'statusbar:statusbar.vulkan.adapter.software' : 'statusbar:statusbar.vulkan.adapter', {
            adapter: k.adapter,
          })
        : '';
      const titled = (first: string, ...more: string[]) => [first, ...more, ...(on ? [on] : [])].join('\n');
      if (!k.device)
        return one(t('statusbar:statusbar.vulkan.none'), '', t('statusbar:statusbar.vulkan.none.title'), {
          tone: 'bad',
        });
      if (!k.contexts)
        return one(t('statusbar:statusbar.vulkan.idle'), '', titled(t('statusbar:statusbar.vulkan.idle.title')), {
          tone: 'off',
        });
      const submits = k.submitRate?.toFixed(0),
        draws = k.drawRate?.toFixed(0);
      const text =
        submits === undefined
          ? t('statusbar:statusbar.vulkan.programs', { count: k.contexts })
          : t('statusbar:statusbar.vulkan.programs.rate', { count: k.contexts, submits });
      const lines = [
        t('statusbar:statusbar.vulkan.title', { count: k.contexts }),
        ...(submits === undefined ? [] : [t('statusbar:statusbar.vulkan.rates', { submits, draws: draws ?? '0' })]),
      ];
      return one(
        text,
        submits === undefined ? `${k.contexts}` : t('statusbar:statusbar.vulkan.short', { count: k.contexts, submits }),
        titled(lines[0], ...lines.slice(1)),
        { tone: k.software ? 'busy' : (k.submitRate ?? 0) > 0 ? 'ok' : undefined },
      );
    }
  }
  if (!m) return [];
  switch (i.kind) {
    case 'vcpus':
      return one(
        t('statusbar:statusbar.vcpus', { count: m.ncpus }),
        `${m.ncpus}`,
        t('statusbar:statusbar.vcpus', { count: m.ncpus }),
      );
    case 'ram':
      return one(`${m.ramMiB} MiB`, `${m.ramMiB} MiB`, t('statusbar:statusbar.ram.title', { mib: m.ramMiB })); // i18n-ignore: a size and its unit
    case 'uptime':
      return one(
        t('statusbar:statusbar.uptime', { time: hms(m.uptimeMs) }),
        hms(m.uptimeMs),
        t('statusbar:statusbar.uptime.title', { time: hms(m.uptimeMs) }),
      );
    case 'memory':
      return m.tabBytes === undefined
        ? []
        : one(
            t('statusbar:statusbar.memory', { size: bytesText(m.tabBytes) }),
            bytesText(m.tabBytes),
            t('statusbar:statusbar.memory.title', { size: bytesText(m.tabBytes) }),
          );
    case 'irqs':
      return m.irqs === undefined
        ? []
        : one(
            t('statusbar:statusbar.irqs', { irqs: count(m.irqs) }),
            count(m.irqs),
            t('statusbar:statusbar.irqs.title', { irqs: count(m.irqs) }),
          );
    case 'blocks': {
      const blocks = count(m.blocks),
        flushes = m.flushes;
      return flushes
        ? one(
            t('statusbar:statusbar.blocks.flushed', { blocks, flushes }),
            t('statusbar:statusbar.blocks.flushed.short', { blocks, flushes }),
            t('statusbar:statusbar.blocks.flushed.title', { blocks, flushes }),
          )
        : one(t('statusbar:statusbar.blocks', { blocks }), blocks, t('statusbar:statusbar.blocks.title', { blocks }));
    }
    case 'compile': {
      const time = `${(m.compileMs / 1000).toFixed(1)} s`; // i18n-ignore: a time and its unit
      return one(t('statusbar:statusbar.compile', { time }), time, t('statusbar:statusbar.compile.title', { time }));
    }
    case 'jitcache': {
      const cache = t('statusbar:statusbar.jitcache.use', {
        live: bytesText(m.jitLive),
        budget: bytesText(m.jitBudget),
      });
      return one(
        t('statusbar:statusbar.jitcache', { cache }),
        cache,
        t('statusbar:statusbar.jitcache.title', { cache }),
      );
    }
    case 'mips':
    case 'jit':
      return cpuPieces(i, m, d.icon);
    case 'netrate':
    case 'nettotal': {
      const total = i.kind === 'nettotal';
      const show = (rx: number | undefined, tx: number | undefined) =>
        t(
          'statusbar:statusbar.net.traffic',
          total ? { rx: size(rx!), tx: size(tx!) } : { rx: perSec(rx), tx: perSec(tx) },
        );
      const arrows = (rx: number | undefined, tx: number | undefined): Part[] => [
        { icon: 'arrow-down', text: total ? size(rx!) : perSec(rx) },
        { icon: 'arrow-up', text: total ? size(tx!) : perSec(tx) },
      ];
      const ds = devices(i, m.nets);
      if (!ds) {
        if (!m.nets?.length) return [];
        const sum = (f: (n: NonNullable<Metrics['nets']>[number]) => number | undefined) =>
          m.nets!.reduce<number | undefined>(
            (a, n) => (a === undefined || f(n) === undefined ? undefined : a + f(n)!),
            0,
          );
        const [rx, tx] = total ? [sum((n) => n.rx), sum((n) => n.tx)] : [sum((n) => n.rxRate), sum((n) => n.txRate)];
        const traffic = show(rx, tx);
        return one(
          t('statusbar:statusbar.net.all', { traffic }),
          traffic,
          total ? t('statusbar:statusbar.net.all.total.title') : t('statusbar:statusbar.net.all.rate.title'),
          { label: t('statusbar:statusbar.net.all.label'), parts: arrows(rx, tx) },
        );
      }
      return ds.map(({ at, v }) => {
        const name = live.nets[at]?.name ?? adapterName(at + 1);
        const [rx, tx] = total ? [v.rx, v.tx] : [v.rxRate, v.txRate];
        const traffic = show(rx, tx);
        return {
          text: t('statusbar:statusbar.net.one', { name, traffic }),
          short: traffic,
          icon: d.icon,
          title: total
            ? t('statusbar:statusbar.net.one.total.title', { name })
            : t('statusbar:statusbar.net.one.rate.title', { name }),
          label: name,
          parts: arrows(rx, tx),
        };
      });
    }
    case 'diskrate':
    case 'disktotal': {
      const total = i.kind === 'disktotal';
      const show = (r: number | undefined, w: number | undefined) =>
        t(
          'statusbar:statusbar.disk.traffic',
          total ? { read: size(r!), written: size(w!) } : { read: perSec(r), written: perSec(w) },
        );
      const ds = devices(i, m.disks);
      if (!ds) {
        if (!m.disks?.length) return [];
        const sum = (f: (n: NonNullable<Metrics['disks']>[number]) => number | undefined) =>
          m.disks!.reduce<number | undefined>(
            (a, n) => (a === undefined || f(n) === undefined ? undefined : a + f(n)!),
            0,
          );
        const traffic = total
          ? show(
              sum((n) => n.read),
              sum((n) => n.written),
            )
          : show(
              sum((n) => n.readRate),
              sum((n) => n.writeRate),
            );
        return one(
          t('statusbar:statusbar.disk.all', { traffic }),
          traffic,
          total ? t('statusbar:statusbar.disk.all.total.title') : t('statusbar:statusbar.disk.all.rate.title'),
        );
      }
      return ds.map(({ at, v }) => {
        const name = live.disks[at] ?? t('statusbar:statusbar.disk.name', { number: at + 1 });
        const traffic = total ? show(v.read, v.written) : show(v.readRate, v.writeRate);
        return {
          text: t('statusbar:statusbar.disk.one', { name, traffic }),
          short: traffic,
          icon: d.icon,
          title: total
            ? t('statusbar:statusbar.disk.one.total.title', { name })
            : t('statusbar:statusbar.disk.one.rate.title', { name }),
        };
      });
    }
    case 'usbrate':
    case 'usbtotal': {
      const u = m.usb;
      if (!u) return [];
      const total = i.kind === 'usbtotal';
      const [into, out] = total ? [size(u.in), size(u.out)] : [perSec(u.inRate), perSec(u.outRate)];
      const traffic = t('statusbar:statusbar.usb.traffic', { in: into, out });
      return one(
        t('statusbar:statusbar.usb', { traffic }),
        traffic,
        total ? t('statusbar:statusbar.usb.total.title') : t('statusbar:statusbar.usb.rate.title'),
        {
          label: t('statusbar:statusbar.usb.label'),
          parts: [
            { icon: 'arrow-down', text: into },
            { icon: 'arrow-up', text: out },
          ],
        },
      );
    }
  }
  return [];
}

/** MIPS and the JIT's share: the machine's, each vCPU's (bars or numbers) or one vCPU's. */
function cpuPieces(i: Item, m: Metrics, icon?: IconName): Piece[] {
  const mips = i.kind === 'mips';
  const val = (c: { mips: number; jit?: number }) => (mips ? c.mips : c.jit);
  const word = (v: number | undefined) => (v === undefined ? '…' : mips ? v.toFixed(0) : `${v.toFixed(1)}%`);
  /** A value (or values) with its unit: `812 MIPS`, `98.7% in JIT`. */
  const unit = (value: string) =>
    mips ? t('statusbar:statusbar.cpu.mips', { value }) : t('statusbar:statusbar.cpu.jit', { value });
  if (i.scope === 'all' || !i.scope) {
    const v = mips ? m.mips : m.jit;
    return v === undefined
      ? []
      : [
          {
            text: unit(word(v)),
            short: word(v),
            icon,
            title: mips
              ? t('statusbar:statusbar.cpu.mips.title', { value: word(v) })
              : t('statusbar:statusbar.cpu.jit.title', { value: word(v) }),
          },
        ];
  }
  if (!m.cpus) return [];
  const title = m.cpus
    .map((c, n) => t('statusbar:statusbar.cpu.line', { vcpu: n, value: unit(word(val(c))) }))
    .join('\n');
  if (i.scope === 'one') {
    const n = i.index ?? 0;
    const c = m.cpus[n];
    return c
      ? [
          {
            text: t('statusbar:statusbar.cpu.one', { vcpu: n, value: unit(word(val(c))) }),
            short: word(val(c)),
            icon,
            title: t('statusbar:statusbar.cpu.line', { vcpu: n, value: unit(word(val(c))) }),
          },
        ]
      : [];
  }
  if (i.numbers) {
    const s = m.cpus.map((c) => word(val(c))).join(' ');
    return [{ text: unit(s), short: s, icon, title }];
  }
  const top = mips ? Math.max(m.cpuPeak, 1) : 100;
  return [
    {
      text: mips ? t('statusbar:statusbar.cpu.bars.mips') : t('statusbar:statusbar.cpu.bars.jit'),
      short: '',
      icon,
      bars: m.cpus.map((c) => Math.min(1, (val(c) ?? 0) / top)),
      title,
    },
  ];
}

/** Whether a kept list shows anything (none: the bar goes away). */
export const shows = (items: readonly Item[]) => items.some((i) => i.kind !== 'spacer' && i.kind !== 'divider');

/** What the Preferences' preview draws while no machine runs: a made-up machine with 4 vCPUs, 2 disks, 2 adapters and a USB controller. */
export const SAMPLE: { metrics: Metrics; disks: string[]; nets: Live['nets']; gpu: Graphics } = {
  metrics: {
    ncpus: 4,
    ramMiB: 4096,
    uptimeMs: 754_000,
    mips: 812,
    jit: 98.7,
    irqs: 2140,
    blocks: 48_213,
    flushes: 0,
    compileMs: 9300,
    cpus: [
      { mips: 310, jit: 99.1 },
      { mips: 254, jit: 98.8 },
      { mips: 172, jit: 97.9 },
      { mips: 76, jit: 96.2 },
    ],
    cpuPeak: 400,
    jitLive: 61 * 2 ** 20,
    jitBudget: 320 * 2 ** 20,
    tabBytes: 6.2 * 2 ** 30,
    disks: [
      { read: 812 * 2 ** 20, written: 96 * 2 ** 20, readRate: 3.1 * 2 ** 20, writeRate: 48 * 2 ** 10 },
      { read: 4 * 2 ** 20, written: 0, readRate: 0, writeRate: 0 },
    ],
    nets: [
      { rx: 210 * 2 ** 20, tx: 12 * 2 ** 20, rxRate: 1.4 * 2 ** 20, txRate: 31 * 2 ** 10 },
      { rx: 2 * 2 ** 20, tx: 1 * 2 ** 20, rxRate: 512, txRate: 300 },
    ],
    usb: { in: 38 * 2 ** 20, out: 2 * 2 ** 20, inRate: 640 * 2 ** 10, outRate: 12 * 2 ** 10 },
  },
  disks: ['debian.qcow2', 'data.img'], // i18n-ignore: file names
  nets: [
    { name: adapterName(1), phase: 'connected', text: t('statusbar:statusbar.sample.net1') },
    { name: adapterName(2), phase: 'off', text: t('statusbar:statusbar.sample.net2') },
  ],
  gpu: {
    mode: '3d',
    renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4)',
    software: false,
    presents: 0,
    fps: 60,
    video: {
      enabled: true,
      decoded: 0,
      fps: 30,
      decoderErrors: 0,
      streams: [
        { id: 1, profile: 'H.264 High', width: 1920, height: 1088, hardware: true, open: true, decoded: 0, fps: 30 },
      ],
    },
    vulkan: {
      contexts: 2,
      submits: 0,
      draws: 0,
      device: true,
      adapter: 'apple metal-3',
      software: false,
      submitRate: 60,
      drawRate: 840,
    },
  },
};
