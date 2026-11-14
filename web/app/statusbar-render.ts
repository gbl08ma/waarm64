// What each status bar element draws now (docs/frontend.md "The status bar"): a renderer per kind, the page's own
// (power, clock, input, links) and the machine's numbers here, the graphics' (web/app/statusbar-graphics.ts) and the
// traffic's (statusbar-traffic.ts) beside. DOM-free, for tests/statusbar.test.ts.
import { t } from '../i18n.ts';
import { bytesText } from './bytes.ts';
import type { IconName } from './icons.ts';
import { iconOf, nameOf, type Item } from './statusbar.ts';
import type { Kind } from './statusbar-kinds.ts';
import { fpsPiece, gpuPiece, videoPiece, vulkanPiece } from './statusbar-graphics.ts';
import type { Metrics } from './statusbar-metrics.ts';
import { count, devices, hms, piece, type Live, type Piece, type Tone } from './statusbar-piece.ts';
import { diskPieces, netPieces, usbPieces } from './statusbar-traffic.ts';
import type { PageState } from './areas/power.svelte.ts';

type Renderer = (i: Item, icon: IconName | undefined, m: Metrics | undefined, live: Live) => Piece[];
/** A renderer of the machine's numbers: nothing until the first status. */
type Numbers = (i: Item, icon: IconName | undefined, m: Metrics, live: Live) => Piece[];
const numbers =
  (f: Numbers): Renderer =>
  (i, icon, m, live) =>
    m ? f(i, icon, m, live) : [];

const STATE_TONE: Partial<Record<PageState, Tone>> = {
  running: 'ok',
  off: 'off',
  idle: 'off',
  crashed: 'bad',
  failed: 'bad',
};
/** A connection's phase (web/app/network.ts) as a `link` element says it, with the adapter's name, and its tone. */
const PHASE_WORD: Record<string, [string, Tone]> = {
  connected: ['statusbar:statusbar-render.link.connected', 'ok'],
  connecting: ['statusbar:statusbar-render.link.connecting', 'busy'],
  login: ['statusbar:statusbar-render.link.login', 'busy'],
  error: ['statusbar:statusbar-render.link.error', 'bad'],
  off: ['statusbar:statusbar-render.link.off', 'off'],
};

/** A clean power-off or reboot under way, as the state says it. */
const SOFT_WORDS = {
  off: 'statusbar:statusbar-render.state.shuttingDown',
  reboot: 'statusbar:statusbar-render.state.restarting',
} as const;

/** The power state, a dot before its words (a running guest's pending power-off or reboot in its place). */
const statePiece: Renderer = (_i, _icon, _m, live) => {
  const soft = live.soft && live.state === 'running' ? t(SOFT_WORDS[live.soft]) : undefined;
  const text = soft ?? live.stateText;
  const title = t('statusbar:statusbar-render.state.title', { state: text });
  return [{ text, short: '', dot: true, tone: soft ? 'busy' : (STATE_TONE[live.state] ?? 'busy'), title }];
};

/** The guest's OS, once its agent named it. */
const osPiece: Renderer = (_i, icon, _m, live) =>
  live.os ? piece(icon, live.os, live.os, t('statusbar:statusbar-render.os.title', { os: live.os })) : [];

const clockPiece: Renderer = (_i, icon, _m, live) => {
  const time = new Date(live.now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return piece(icon, time, time, t('statusbar:statusbar-render.clock.title', { time }));
};

/** Mouse lock: holding the pointer, on, or off. */
const pointerPiece: Renderer = (_i, icon, _m, live) => {
  if (live.mouseLocked)
    return piece(
      icon,
      t('statusbar:statusbar-render.pointer.held'),
      '',
      t('statusbar:statusbar-render.pointer.held.title'),
      { tone: 'ok' },
    );
  if (live.mouseLock)
    return piece(
      icon,
      t('statusbar:statusbar-render.pointer.on'),
      '',
      t('statusbar:statusbar-render.pointer.on.title'),
      {
        tone: 'dim',
      },
    );
  return piece(
    icon,
    t('statusbar:statusbar-render.pointer.off'),
    '',
    t('statusbar:statusbar-render.pointer.off.title'),
    {
      tone: 'off',
    },
  );
};

/** Where keys go: the keyboard locked, typing into the machine, or a click needed first. */
const keyboardPiece: Renderer = (_i, icon, _m, live) => {
  if (live.keyboardLocked)
    return piece(
      icon,
      t('statusbar:statusbar-render.keyboard.locked'),
      '',
      t('statusbar:statusbar-render.keyboard.locked.title'),
      { tone: 'ok' },
    );
  if (live.keysFocused)
    return piece(
      icon,
      t('statusbar:statusbar-render.keyboard.typing'),
      '',
      t('statusbar:statusbar-render.keyboard.typing.title'),
      { tone: 'ok' },
    );
  return piece(
    icon,
    t('statusbar:statusbar-render.keyboard.click'),
    '',
    t('statusbar:statusbar-render.keyboard.click.title'),
    { tone: 'off' },
  );
};

/** The microphone, while it's on or refused. */
const micPiece: Renderer = (_i, icon, _m, live) => {
  if (live.mic === 'on')
    return piece(icon, t('statusbar:statusbar-render.mic.on'), '', t('statusbar:statusbar-render.mic.on.title'), {
      tone: 'bad',
    });
  if (live.mic === 'denied')
    return piece(
      icon,
      t('statusbar:statusbar-render.mic.denied'),
      '',
      t('statusbar:statusbar-render.mic.denied.title'),
      {
        tone: 'dim',
      },
    );
  return [];
};

/** Each adapter's connection, its phase's words and tone. */
const linkPieces: Renderer = (i, icon, _m, live) =>
  (devices(i, live.nets) ?? []).map(({ v }) => {
    const [key, tone] = PHASE_WORD[v.phase] ?? ['', 'busy'];
    const text = key
      ? t(key, { name: v.name })
      : t('statusbar:statusbar-render.link.other', { name: v.name, phase: v.phase });
    return {
      text,
      short: '',
      icon,
      tone,
      title: t('statusbar:statusbar-render.link.title', {
        name: v.name,
        text: [v.text, ...(v.details ?? [])].join('\n'),
      }),
    };
  });

/** A spacer or a divider: no words, its name as the editor's tooltip. */
const layoutPiece: Renderer = (i) => [{ text: '', title: nameOf(i) }];

const vcpusPiece: Numbers = (_i, icon, m) =>
  piece(
    icon,
    t('statusbar:statusbar-render.vcpus', { count: m.ncpus }),
    `${m.ncpus}`,
    t('statusbar:statusbar-render.vcpus', { count: m.ncpus }),
  );

const ramPiece: Numbers = (_i, icon, m) =>
  piece(icon, `${m.ramMiB} MiB`, `${m.ramMiB} MiB`, t('statusbar:statusbar-render.ram.title', { mib: m.ramMiB })); // i18n-ignore: a size and its unit

const uptimePiece: Numbers = (_i, icon, m) => {
  const time = hms(m.uptimeMs);
  return piece(
    icon,
    t('statusbar:statusbar-render.uptime', { time }),
    time,
    t('statusbar:statusbar-render.uptime.title', { time }),
  );
};

/** The tab's memory, once counted. */
const memoryPiece: Numbers = (_i, icon, m) => {
  if (m.tabBytes === undefined) return [];
  const size = bytesText(m.tabBytes);
  return piece(
    icon,
    t('statusbar:statusbar-render.memory', { size }),
    size,
    t('statusbar:statusbar-render.memory.title', { size }),
  );
};

const irqsPiece: Numbers = (_i, icon, m) => {
  if (m.irqs === undefined) return [];
  const irqs = count(m.irqs);
  return piece(
    icon,
    t('statusbar:statusbar-render.irqs', { irqs }),
    irqs,
    t('statusbar:statusbar-render.irqs.title', { irqs }),
  );
};

/** The JIT's blocks, and its flushes once there are some. */
const blocksPiece: Numbers = (_i, icon, m) => {
  const blocks = count(m.blocks),
    flushes = m.flushes;
  return flushes
    ? piece(
        icon,
        t('statusbar:statusbar-render.blocks.flushed', { blocks, flushes }),
        t('statusbar:statusbar-render.blocks.flushed.short', { blocks, flushes }),
        t('statusbar:statusbar-render.blocks.flushed.title', { blocks, flushes }),
      )
    : piece(
        icon,
        t('statusbar:statusbar-render.blocks', { blocks }),
        blocks,
        t('statusbar:statusbar-render.blocks.title', { blocks }),
      );
};

const compilePiece: Numbers = (_i, icon, m) => {
  const time = `${(m.compileMs / 1000).toFixed(1)} s`; // i18n-ignore: a time and its unit
  return piece(
    icon,
    t('statusbar:statusbar-render.compile', { time }),
    time,
    t('statusbar:statusbar-render.compile.title', { time }),
  );
};

const jitcachePiece: Numbers = (_i, icon, m) => {
  const cache = t('statusbar:statusbar-render.jitcache.use', {
    live: bytesText(m.jitLive),
    budget: bytesText(m.jitBudget),
  });
  return piece(
    icon,
    t('statusbar:statusbar-render.jitcache', { cache }),
    cache,
    t('statusbar:statusbar-render.jitcache.title', { cache }),
  );
};

type Cpu = { mips: number; jit?: number };
/** MIPS or the JIT's share, as an element of either kind words it. */
function cpuWords(mips: boolean) {
  const val = (c: Cpu) => (mips ? c.mips : c.jit);
  const word = (v: number | undefined) => {
    if (v === undefined) return '…';
    return mips ? v.toFixed(0) : `${v.toFixed(1)}%`;
  };
  /** A value (or values) with its unit: `812 MIPS`, `98.7% in JIT`. */
  const unit = (value: string) =>
    mips ? t('statusbar:statusbar-render.cpu.mips', { value }) : t('statusbar:statusbar-render.cpu.jit', { value });
  return { val, word, unit, say: (c: Cpu) => unit(word(val(c))) };
}

/** The machine's MIPS or JIT share, all vCPUs together. */
const allCpusPiece: Numbers = (i, icon, m) => {
  const mips = i.kind === 'mips';
  const { word, unit } = cpuWords(mips);
  const v = mips ? m.mips : m.jit;
  if (v === undefined) return [];
  return piece(
    icon,
    unit(word(v)),
    word(v),
    mips
      ? t('statusbar:statusbar-render.cpu.mips.title', { value: word(v) })
      : t('statusbar:statusbar-render.cpu.jit.title', { value: word(v) }),
  );
};

/** One vCPU's, or each vCPU's (bars, or numbers). */
function eachCpuPieces(i: Item, icon: IconName | undefined, cpus: Cpu[], cpuPeak: number): Piece[] {
  const mips = i.kind === 'mips';
  const { val, word, unit, say } = cpuWords(mips);
  if (i.scope === 'one') {
    const vcpu = i.index ?? 0;
    const c = cpus.at(vcpu);
    if (!c) return [];
    return piece(
      icon,
      t('statusbar:statusbar-render.cpu.one', { vcpu, value: say(c) }),
      word(val(c)),
      t('statusbar:statusbar-render.cpu.line', { vcpu, value: say(c) }),
    );
  }
  const title = cpus.map((c, vcpu) => t('statusbar:statusbar-render.cpu.line', { vcpu, value: say(c) })).join('\n');
  if (i.numbers) {
    const s = cpus.map((c) => word(val(c))).join(' ');
    return [{ text: unit(s), short: s, icon, title }];
  }
  const top = mips ? Math.max(cpuPeak, 1) : 100;
  const text = mips ? t('statusbar:statusbar-render.cpu.bars.mips') : t('statusbar:statusbar-render.cpu.bars.jit');
  return [{ text, short: '', icon, bars: cpus.map((c) => Math.min(1, (val(c) ?? 0) / top)), title }];
}

/** MIPS and the JIT's share: the machine's, each vCPU's (bars or numbers) or one vCPU's. */
const cpuPieces: Numbers = (i, icon, m, live) => {
  if (i.scope === 'all' || !i.scope) return allCpusPiece(i, icon, m, live);
  return m.cpus ? eachCpuPieces(i, icon, m.cpus, m.cpuPeak) : [];
};

const RENDERERS: Record<Kind, Renderer> = {
  state: statePiece,
  clock: clockPiece,
  os: osPiece,
  pointer: pointerPiece,
  keyboard: keyboardPiece,
  mic: micPiece,
  link: linkPieces,
  spacer: layoutPiece,
  divider: layoutPiece,
  gpu: (_i, icon, _m, live) => gpuPiece(icon, live),
  fps: (_i, icon, _m, live) => fpsPiece(icon, live),
  video: (_i, icon, _m, live) => videoPiece(icon, live),
  vulkan: (_i, icon, _m, live) => vulkanPiece(icon, live),
  vcpus: numbers(vcpusPiece),
  ram: numbers(ramPiece),
  uptime: numbers(uptimePiece),
  memory: numbers(memoryPiece),
  irqs: numbers(irqsPiece),
  blocks: numbers(blocksPiece),
  compile: numbers(compilePiece),
  jitcache: numbers(jitcachePiece),
  mips: numbers(cpuPieces),
  jit: numbers(cpuPieces),
  netrate: numbers(netPieces),
  nettotal: numbers(netPieces),
  diskrate: numbers(diskPieces),
  disktotal: numbers(diskPieces),
  usbrate: numbers(usbPieces),
  usbtotal: numbers(usbPieces),
};

/** What item `i` draws now: nothing, one piece, or one per device (an `each` element). */
export const render = (i: Item, m: Metrics | undefined, live: Live): Piece[] =>
  RENDERERS[i.kind](i, iconOf(i.kind), m, live);
