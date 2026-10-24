// The status bar's elements (docs/frontend.md "The status bar"): what each can show, the bar a browser starts with, and
// the pieces an element draws from the last second's numbers. web/app/StatusBar.svelte draws the bar, and the
// Preferences' editor (web/app/StatusEditor.svelte) chooses and orders its elements, kept in the settings' `statusBar`.
// DOM-free, for tests/statusbar.test.ts.
import { bytesText } from './bytes.ts';
import type { IconName } from './icons.ts';
import type { Status } from './protocol.ts';
import type { PageState } from './ui.svelte.ts';

/** How an element shows: words (`812 MIPS`), an icon and the bare value (the words in its tooltip), or both. */
export type Look = 'text' | 'icon' | 'both';
/** A per-device element's devices: all of them summed, each in turn, or one, by `index`. */
export type Scope = 'all' | 'each' | 'one';
type Device = 'cpu' | 'net' | 'disk';
export type Group = 'Machine' | 'CPU and JIT' | 'Network' | 'Disks' | 'Graphics' | 'Input and sound' | 'Layout';

type Def = { name: string; group: Group; icon?: IconName; device?: Device; scopes?: Scope[]; look: Look; about: string };
export const KINDS = {
  state: { name: 'Power state', group: 'Machine', look: 'text', about: 'Powered off, booting, running, and what the page is doing' },
  vcpus: { name: 'vCPUs', group: 'Machine', icon: 'cpu', look: 'text', about: 'How many vCPUs the machine has' },
  ram: { name: 'RAM', group: 'Machine', icon: 'memory', look: 'text', about: "The machine's RAM" },
  uptime: { name: 'Uptime', group: 'Machine', icon: 'history', look: 'text', about: 'How long the machine has run' },
  clock: { name: 'Clock', group: 'Machine', icon: 'clock', look: 'text', about: "This computer's time" },
  memory: { name: 'Tab memory', group: 'Machine', icon: 'server-2', look: 'text', about: "What the machine costs its tab, by the emulator's accounting (the memory signal)" },
  mips: { name: 'MIPS', group: 'CPU and JIT', icon: 'gauge', device: 'cpu', scopes: ['all', 'each', 'one'], look: 'text', about: 'Millions of guest instructions run a second' },
  jit: { name: 'JIT share', group: 'CPU and JIT', icon: 'car-turbine', device: 'cpu', scopes: ['all', 'each', 'one'], look: 'text', about: 'The share of the instructions run in compiled code (the rest are interpreted)' },
  irqs: { name: 'IRQ/s', group: 'CPU and JIT', icon: 'bolt', look: 'text', about: 'Interrupts taken a second' },
  blocks: { name: 'Blocks compiled', group: 'CPU and JIT', icon: 'blocks', look: 'text', about: 'Blocks the JIT compiled since boot, and how often its cache was flushed' },
  compile: { name: 'Compile time', group: 'CPU and JIT', icon: 'clock-code', look: 'text', about: 'Time spent compiling since boot (all vCPUs)' },
  jitcache: { name: 'JIT cache', group: 'CPU and JIT', icon: 'cake-roll', look: 'text', about: "The JIT's live code against its cache's budget" },
  netrate: { name: 'Network traffic', group: 'Network', icon: 'network', device: 'net', scopes: ['all', 'each', 'one'], look: 'text', about: 'Bytes a second received and sent by the machine' },
  nettotal: { name: 'Network total', group: 'Network', icon: 'network', device: 'net', scopes: ['all', 'each', 'one'], look: 'text', about: 'Bytes received and sent since the machine started' },
  link: { name: 'Connection', group: 'Network', icon: 'network', device: 'net', scopes: ['each', 'one'], look: 'icon', about: "An adapter's connection: connected, connecting, waiting for a login, or off" },
  diskrate: { name: 'Disk speed', group: 'Disks', icon: 'database', device: 'disk', scopes: ['all', 'each', 'one'], look: 'text', about: 'Bytes a second read (R) and written (W)' },
  disktotal: { name: 'Disk total', group: 'Disks', icon: 'database', device: 'disk', scopes: ['all', 'each', 'one'], look: 'text', about: 'Bytes read (R) and written (W) since the machine started' },
  gpu: { name: 'Renderer', group: 'Graphics', icon: 'device-desktop', look: 'text', about: 'How the screen is drawn: 3D through WebGL2 (virgl), or 2D; amber when the browser renders in software' },
  fps: { name: 'Frame rate', group: 'Graphics', icon: 'keyframes', look: 'text', about: 'Screen updates drawn a second' },
  video: { name: 'Video decode', group: 'Graphics', icon: 'player-play', look: 'text', about: "The guest's video streams decoded by the browser (VA-API over virgl, 3D machines), their codecs and pictures a second" },
  pointer: { name: 'Mouse lock', group: 'Input and sound', icon: 'mouse', look: 'icon', about: 'Whether the screen holds the mouse (green), would take it on a click (grey), or the lock is off (dim)' },
  keyboard: { name: 'Keyboard', group: 'Input and sound', icon: 'keyboard', look: 'icon', about: "Where typing goes: to the machine (green; in full screen with the keyboard lock, the browser's shortcuts too), or nowhere until a click on the screen" },
  mic: { name: 'Microphone', group: 'Input and sound', icon: 'microphone', look: 'icon', about: 'Shown while the machine records from the microphone (or the browser refused it)' },
  spacer: { name: 'Spacer', group: 'Layout', look: 'text', about: 'Takes the free room: what follows goes to the right' },
  divider: { name: 'Divider', group: 'Layout', look: 'text', about: 'A line between elements' },
} satisfies Record<string, Def>;
export type Kind = keyof typeof KINDS;
const def = (k: Kind): Def => KINDS[k];

/** One element of the bar. `index`: the device of a `one` element as the page numbers it (vCPUs from 0, as the guest
 * names them; adapters and disks from 1, as the machine's Network and Disks tabs list them). `numbers`: an `each`
 * vCPU element writes its numbers rather than drawing bars. */
export type Item = { kind: Kind; scope?: Scope; index?: number; look?: Look; numbers?: boolean };

/** Today's bar, and the one a browser starts with. */
export const DEFAULT_ITEMS: readonly Item[] = [
  { kind: 'state' }, { kind: 'divider' }, { kind: 'vcpus' }, { kind: 'ram' }, { kind: 'uptime' }, { kind: 'mips' }, { kind: 'jit' }, { kind: 'irqs' },
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
const NOUN = { cpu: 'vCPU', net: 'adapter', disk: 'disk' } as const;

/** An element's name in the editor and its tooltips: `MIPS`, `MIPS, each vCPU`, `MIPS, vCPU 2` (`generic`, the palette's: `MIPS, one vCPU`). */
export function nameOf(i: Item, generic = false) {
  const d = def(i.kind);
  if (!d.device || !i.scope || (i.scope === 'all' && d.scopes![0] === 'all')) return d.name;
  return i.scope === 'each' ? `${d.name}, each ${NOUN[d.device]}` : i.scope === 'one' ? (generic ? `${d.name}, one ${NOUN[d.device]}` : `${d.name}, ${NOUN[d.device]} ${i.index ?? firstIndex(d.device)}`) : d.name;
}
/** The palette's chips: every kind in each of its scopes (a `one` chip adds the first device: its number is set after). */
export function palette(): { group: Group; items: Item[] }[] {
  const groups = new Map<Group, Item[]>();
  for (const kind of Object.keys(KINDS) as Kind[]) {
    const d = def(kind);
    const items = d.scopes ? d.scopes.map((scope): Item => (scope === 'one' ? { kind, scope, index: firstIndex(d.device!) } : { kind, scope })) : [{ kind }];
    groups.set(d.group, [...(groups.get(d.group) ?? []), ...items]);
  }
  return [...groups].map(([group, items]) => ({ group, items }));
}
export const aboutOf = (k: Kind) => def(k).about;
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
};
export type Sample = { status: Status; at: number; metrics: Metrics };

/** A video stream as the GPU worker reports it (web/virgl-video.ts `VideoStream`), with its pictures a second. */
type Stream = { id: number; profile: string; width: number; height: number; hardware: boolean; open: boolean; decoded: number; fps?: number };
/**
 * The screen's last second: a 3D machine's GPU worker `stats` (web/gpu-worker.ts), or a 2D machine's presenter's
 * `screen-stats` (web/gpu-present.ts; `webgl2` or `canvas2d`). `fps`: presents a second; the video's decoded pictures a
 * second, all streams and each. `hardware` is what a decoder asked for: WebCodecs doesn't say what it got (Chromium's
 * `prefer-hardware` fails rather than fall back).
 */
export type Graphics = {
  mode: '3d' | 'webgl2' | 'canvas2d';
  renderer?: string;
  vendor?: string;
  software?: boolean;
  presents: number;
  fps?: number;
  video?: { enabled: boolean; decoded: number; fps?: number; decoderErrors: number; streams: Stream[] };
};
type GpuReport = { renderer?: string; vendor?: string; software?: boolean; presents: number; video?: { enabled: boolean; decoded: number; decoderErrors: number; streams: Omit<Stream, 'fps'>[] } };
/** A report received at `at` (ms), after `prev` (the same run's last). */
export function graphics(mode: Graphics['mode'], m: GpuReport, at: number, prev?: { g: Graphics; at: number }): Graphics {
  const dt = prev && prev.g.mode === mode ? (at - prev.at) / 1000 : 0;
  const rate = (now: number, then: number | undefined) => (then !== undefined && dt > 0 && now >= then ? (now - then) / dt : undefined);
  const v = m.video;
  return {
    mode, renderer: m.renderer, vendor: m.vendor, software: m.software, presents: m.presents, fps: rate(m.presents, prev?.g.presents),
    video: v && {
      enabled: v.enabled, decoded: v.decoded, decoderErrors: v.decoderErrors, fps: rate(v.decoded, prev?.g.video?.decoded),
      streams: v.streams.map((st) => ({ ...st, fps: rate(st.decoded, prev?.g.video?.streams.find((o) => o.id === st.id)?.decoded) })),
    },
  };
}

/** `s`, received at `at` (ms, monotonic), after `prev` (the run's previous one). */
export function metrics(s: Status, at: number, prev?: Sample, tabBytes?: number): Metrics {
  const p = prev?.status;
  const dt = prev ? (at - prev.at) / 1000 : 0;
  const rate = (now: number, then: number | undefined) => (then !== undefined && dt > 0 ? Math.max(0, now - then) / dt : undefined);
  const share = (jit: number, all: number, jit0?: number, all0?: number) => (jit0 !== undefined && all0 !== undefined && all > all0 ? ((jit - jit0) / (all - all0)) * 100 : undefined);
  const cpus = s.cpus && p?.cpus?.length === s.cpus.length
    ? s.cpus.map((c, i) => ({ mips: (rate(c.steps, p.cpus![i].steps) ?? 0) / 1e6, jit: share(c.jitSteps, c.steps, p.cpus![i].jitSteps, p.cpus![i].steps) }))
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
    disks: s.disks?.map((d, i) => ({ ...d, readRate: rate(d.read, p?.disks?.[i]?.read), writeRate: rate(d.written, p?.disks?.[i]?.written) })),
    nets: s.nets?.map((n, i) => ({ ...n, rxRate: rate(n.rx, p?.nets?.[i]?.rx), txRate: rate(n.tx, p?.nets?.[i]?.tx) })),
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
  nets: { name: string; phase: string; text: string }[];
  /** The screen's last second (none yet, or no screen). */
  gpu?: Graphics;
};

/** A colour the bar has words for. */
export type Tone = 'ok' | 'busy' | 'off' | 'bad' | 'dim';
/**
 * What an element draws: its words (`text`), or with an icon its short value (`short`, the words in `title`), a dot
 * before them (the power state), a tone, bars (each from 0 to 1, per vCPU), or parts with icons of their own.
 */
export type Piece = { text: string; short?: string; icon?: IconName; tone?: Tone; dot?: boolean; bars?: number[]; title: string; label?: string; parts?: Part[] };
/** A value drawn with an icon of its own (received, sent): `label` (words only) and `parts` stand for `text` and `short` then. */
export type Part = { icon: IconName; text: string };

const count = (n: number) => Math.round(n).toLocaleString('en');
const size = (n: number) => (n < 1024 ? `${Math.round(n)} B` : bytesText(n));
const perSec = (n: number | undefined) => (n === undefined ? '…' : `${size(n)}/s`);
const hms = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const STATE_TONE: Partial<Record<PageState, Tone>> = { running: 'ok', off: 'off', idle: 'off', crashed: 'bad', failed: 'bad' };
const PHASE_WORD: Record<string, [string, Tone]> = { connected: ['connected', 'ok'], connecting: ['connecting', 'busy'], login: ['log in', 'busy'], error: ['failed', 'bad'], off: ['off', 'off'] };

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
  const one = (text: string, short: string, title: string, extra: Partial<Piece> = {}): Piece[] => [{ text, short, icon: d.icon, title, ...extra }];
  switch (i.kind) {
    case 'state':
      return [{ text: live.stateText, short: '', dot: true, tone: STATE_TONE[live.state] ?? 'busy', title: `The machine: ${live.stateText}` }];
    case 'clock': {
      const t = new Date(live.now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return one(t, t, `This computer's time: ${t}`);
    }
    case 'pointer': {
      const [text, tone, title] = live.mouseLocked ? ['Mouse held', 'ok', 'The screen holds the mouse (Esc lets go)'] as const
        : live.mouseLock ? ['Mouse lock on', 'dim', 'A click on the screen takes the mouse'] as const
        : ['Mouse lock off', 'off', 'The mouse lock is off (the toolbar turns it on)'] as const;
      return one(text, '', title, { tone });
    }
    case 'keyboard':
      return live.keyboardLocked ? one('Keys locked', '', "Full screen with the keyboard lock: keys and the browser's shortcuts go to the machine (hold Esc to leave)", { tone: 'ok' })
        : live.keysFocused ? one('Typing to the machine', '', 'Keys go to the machine (the browser keeps its shortcuts; full screen locks them too)', { tone: 'ok' })
        : one('Click to type', '', 'Keys go elsewhere: a click on the screen sends them to the machine', { tone: 'off' });
    case 'mic':
      return live.mic === 'on' ? one('Recording', '', 'The machine records from the microphone', { tone: 'bad' })
        : live.mic === 'denied' ? one('Mic refused', '', 'The machine records, but the browser refused the microphone: it gets silence', { tone: 'dim' }) : [];
    case 'link': {
      return (devices(i, live.nets) ?? []).map(({ v }) => {
        const [word, tone] = PHASE_WORD[v.phase] ?? [v.phase, 'busy'];
        return { text: `${v.name} ${word}`, short: '', icon: d.icon, tone, title: `${v.name}: ${v.text}` };
      });
    }
    case 'spacer': case 'divider':
      return [{ text: '', title: d.name }];
    case 'gpu': {
      const g = live.gpu;
      if (!g) return [];
      const by = g.renderer ? `\n${g.renderer}${g.vendor ? ` (${g.vendor})` : ''}` : '';
      if (g.mode === 'canvas2d') return one('2D canvas', '2D', 'The screen is 2D, drawn on a canvas (this browser has no hardware WebGL2)', { tone: 'off' });
      const what = g.mode === '3d' ? '3D' : '2D';
      return g.software
        ? one(`${what} software`, what, `The screen is ${what} through WebGL2, which this browser renders in software: slow${by}`, { tone: 'busy' })
        : one(`${what} WebGL2`, what, `The screen is ${what}${g.mode === '3d' ? ' (virgl)' : ''}, drawn through WebGL2 on the GPU${by}`, { tone: g.mode === '3d' ? 'ok' : undefined });
    }
    case 'fps': {
      const f = live.gpu?.fps;
      return f === undefined ? [] : one(`${f.toFixed(0)} fps`, f.toFixed(0), `${f.toFixed(0)} screen updates drawn a second`);
    }
    case 'video': {
      const v = live.gpu?.video;
      if (!v?.enabled) return [];
      const open = v.streams.filter((st) => st.open);
      if (!v.streams.length) return one('video idle', '', 'Video decode: no stream (the guest decodes none through VA-API now)', { tone: 'off' });
      const hw = open.length > 0 && open.every((st) => st.hardware);
      const names = [...new Set(v.streams.map((st) => st.profile))].join(', ');
      const f = v.fps === undefined ? '' : ` ${v.fps.toFixed(0)} fps`;
      const title = v.streams.map((st) => `${st.profile} ${st.width}×${st.height}: ${st.hardware ? 'hardware' : 'software'}${st.open ? '' : ', no decoder now'}${st.fps === undefined ? '' : `, ${st.fps.toFixed(0)} pictures a second`}`).join('\n');
      return one(`${names} ${hw ? 'hw' : 'sw'}${f}`, `${v.streams.length}${f}`, `Video decode (hardware is what the decoder asked for: the browser doesn't say what it got)\n${title}${v.decoderErrors ? `\n${v.decoderErrors} decoder errors` : ''}`, { tone: hw ? 'ok' : undefined });
    }
  }
  if (!m) return [];
  switch (i.kind) {
    case 'vcpus': return one(`${m.ncpus} vCPU${m.ncpus > 1 ? 's' : ''}`, `${m.ncpus}`, `${m.ncpus} vCPU${m.ncpus > 1 ? 's' : ''}`);
    case 'ram': return one(`${m.ramMiB} MiB`, `${m.ramMiB} MiB`, `RAM: ${m.ramMiB} MiB`);
    case 'uptime': return one(`up ${hms(m.uptimeMs)}`, hms(m.uptimeMs), `Up ${hms(m.uptimeMs)}`);
    case 'memory': return m.tabBytes === undefined ? [] : one(`tab ${bytesText(m.tabBytes)}`, bytesText(m.tabBytes), `The tab: about ${bytesText(m.tabBytes)} by the emulator's accounting`);
    case 'irqs': return m.irqs === undefined ? [] : one(`${count(m.irqs)} IRQ/s`, count(m.irqs), `${count(m.irqs)} interrupts a second`);
    case 'blocks': {
      const f = m.flushes ? ` (cache flushed ${m.flushes}×)` : '';
      return one(`${count(m.blocks)} blocks compiled${f}`, `${count(m.blocks)}${m.flushes ? ` (${m.flushes}×)` : ''}`, `JIT: ${count(m.blocks)} blocks compiled${f}`);
    }
    case 'compile': {
      const s = `${(m.compileMs / 1000).toFixed(1)} s`;
      return one(`${s} compiling`, s, `JIT: ${s} compiling since boot`);
    }
    case 'jitcache': {
      const t = `${bytesText(m.jitLive)} of ${bytesText(m.jitBudget)}`;
      return one(`JIT ${t}`, t, `The JIT's cache: ${t} in use`);
    }
    case 'mips': case 'jit': return cpuPieces(i, m, d.icon);
    case 'netrate': case 'nettotal': {
      const total = i.kind === 'nettotal';
      const show = (rx: number | undefined, tx: number | undefined) => (total ? `received ${size(rx!)}, sent ${size(tx!)}` : `received ${perSec(rx)}, sent ${perSec(tx)}`);
      const what = total ? 'since the start' : 'a second';
      const arrows = (rx: number | undefined, tx: number | undefined): Part[] => [{ icon: 'arrow-down', text: total ? size(rx!) : perSec(rx) }, { icon: 'arrow-up', text: total ? size(tx!) : perSec(tx) }];
      const ds = devices(i, m.nets);
      if (!ds) {
        if (!m.nets?.length) return [];
        const sum = (f: (n: NonNullable<Metrics['nets']>[number]) => number | undefined) => m.nets!.reduce<number | undefined>((a, n) => (a === undefined || f(n) === undefined ? undefined : a + f(n)!), 0);
        const [rx, tx] = total ? [sum((n) => n.rx), sum((n) => n.tx)] : [sum((n) => n.rxRate), sum((n) => n.txRate)];
        const v = show(rx, tx);
        return one(`net ${v}`, v, `The network, every adapter: received and sent ${what}`, { label: 'net', parts: arrows(rx, tx) });
      }
      return ds.map(({ at, v }) => {
        const name = live.nets[at]?.name ?? `Adapter ${at + 1}`;
        const [rx, tx] = total ? [v.rx, v.tx] : [v.rxRate, v.txRate];
        const s = show(rx, tx);
        return { text: `${name} ${s}`, short: s, icon: d.icon, title: `${name}: received and sent ${what}`, label: name, parts: arrows(rx, tx) };
      });
    }
    case 'diskrate': case 'disktotal': {
      const total = i.kind === 'disktotal';
      const show = (r: number | undefined, w: number | undefined) => (total ? `R ${size(r!)} W ${size(w!)}` : `R ${perSec(r)} W ${perSec(w)}`);
      const what = total ? 'since the start' : 'a second';
      const ds = devices(i, m.disks);
      if (!ds) {
        if (!m.disks?.length) return [];
        const sum = (f: (n: NonNullable<Metrics['disks']>[number]) => number | undefined) => m.disks!.reduce<number | undefined>((a, n) => (a === undefined || f(n) === undefined ? undefined : a + f(n)!), 0);
        const v = total ? show(sum((n) => n.read), sum((n) => n.written)) : show(sum((n) => n.readRate), sum((n) => n.writeRate));
        return one(`disk ${v}`, v, `The disks, all of them: read (R) and written (W) ${what}`);
      }
      return ds.map(({ at, v }) => {
        const name = live.disks[at] ?? `Disk ${at + 1}`;
        const s = total ? show(v.read, v.written) : show(v.readRate, v.writeRate);
        return { text: `${name} ${s}`, short: s, icon: d.icon, title: `${name}: read (R) and written (W) ${what}` };
      });
    }
  }
  return [];
}

/** MIPS and the JIT's share: the machine's, each vCPU's (bars or numbers) or one vCPU's. */
function cpuPieces(i: Item, m: Metrics, icon?: IconName): Piece[] {
  const mips = i.kind === 'mips';
  const val = (c: { mips: number; jit?: number }) => (mips ? c.mips : c.jit);
  const word = (v: number | undefined) => (v === undefined ? '…' : mips ? v.toFixed(0) : `${v.toFixed(1)}%`);
  const unit = mips ? ' MIPS' : ' in JIT';
  if (i.scope === 'all' || !i.scope) {
    const v = mips ? m.mips : m.jit;
    return v === undefined ? [] : [{ text: `${word(v)}${unit}`, short: word(v), icon, title: mips ? `${word(v)} million instructions a second` : `${word(v)} of the instructions run in compiled code` }];
  }
  if (!m.cpus) return [];
  const title = m.cpus.map((c, n) => `vCPU ${n}: ${word(val(c))}${unit}`).join('\n');
  if (i.scope === 'one') {
    const n = i.index ?? 0;
    const c = m.cpus[n];
    return c ? [{ text: `vCPU ${n} ${word(val(c))}${unit}`, short: word(val(c)), icon, title: `vCPU ${n}: ${word(val(c))}${unit}` }] : [];
  }
  if (i.numbers) {
    const s = m.cpus.map((c) => word(val(c))).join(' ');
    return [{ text: `${s}${unit}`, short: s, icon, title }];
  }
  const top = mips ? Math.max(m.cpuPeak, 1) : 100;
  return [{ text: mips ? 'MIPS' : 'JIT', short: '', icon, bars: m.cpus.map((c) => Math.min(1, (val(c) ?? 0) / top)), title }];
}

/** Whether a kept list shows anything (none: the bar goes away). */
export const shows = (items: readonly Item[]) => items.some((i) => i.kind !== 'spacer' && i.kind !== 'divider');

/** What the Preferences' preview draws while no machine runs: a made-up machine with 4 vCPUs, 2 disks and 2 adapters. */
export const SAMPLE: { metrics: Metrics; disks: string[]; nets: Live['nets']; gpu: Graphics } = {
  metrics: {
    ncpus: 4, ramMiB: 4096, uptimeMs: 754_000, mips: 812, jit: 98.7, irqs: 2140, blocks: 48_213, flushes: 0, compileMs: 9300,
    cpus: [{ mips: 310, jit: 99.1 }, { mips: 254, jit: 98.8 }, { mips: 172, jit: 97.9 }, { mips: 76, jit: 96.2 }], cpuPeak: 400,
    jitLive: 61 * 2 ** 20, jitBudget: 320 * 2 ** 20, tabBytes: 6.2 * 2 ** 30,
    disks: [{ read: 812 * 2 ** 20, written: 96 * 2 ** 20, readRate: 3.1 * 2 ** 20, writeRate: 48 * 2 ** 10 }, { read: 4 * 2 ** 20, written: 0, readRate: 0, writeRate: 0 }],
    nets: [{ rx: 210 * 2 ** 20, tx: 12 * 2 ** 20, rxRate: 1.4 * 2 ** 20, txRate: 31 * 2 ** 10 }, { rx: 2 * 2 ** 20, tx: 1 * 2 ** 20, rxRate: 512, txRate: 300 }],
  },
  disks: ['debian.qcow2', 'data.img'],
  nets: [{ name: 'Adapter 1', phase: 'connected', text: 'home tailnet: Connected' }, { name: 'Adapter 2', phase: 'off', text: 'no connection: Not connected' }],
  gpu: {
    mode: '3d', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4)', software: false, presents: 0, fps: 60,
    video: { enabled: true, decoded: 0, fps: 30, decoderErrors: 0, streams: [{ id: 1, profile: 'H.264 High', width: 1920, height: 1088, hardware: true, open: true, decoded: 0, fps: 30 }] },
  },
};
