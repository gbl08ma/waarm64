// What the page's machine runs with (docs/frontend.md "Query parameters"): its size, devices and display, resolved
// from the address, the record, the browser's settings and what this browser can do. Pure (no `location`, no storage): tests/config.test.ts runs it
// in Node.
import { keyboardSetting } from '../keyboard.ts';
import { CPU_SLIDER, defaultCpus, RAM_SLIDER, ramSplitError, type SliderRange } from '../machine.ts';
import type { Settings } from '../settings.ts';
import type { Display, MachineRecord } from '../shape.ts';

/** A machine's display as it runs: none without a virtio-gpu, 3D or 2D with one; Vulkan (Venus) only beside 3D. */
export type RunDisplay = { display: Display | 'none'; vulkan: boolean };

/**
 * The display a machine runs with on this page. `gpu`: its kind has a virtio-gpu (`MachineSpec.display`); `simple`:
 * the address's `?display=simple` (none, the simple framebuffer). 3D where it's asked for (the address's `asked` over
 * the record's over the Preferences' `setting`, 3D by default) and not refused (no WebGL2, or `refused`: the GPU worker
 * failed), else 2D. `vulkan`: Vulkan asked for (the record's, `?gpu=vulkan`).
 */
export function effectiveDisplay(o: {
  gpu: boolean;
  simple: boolean;
  asked?: Display;
  record?: Display;
  setting?: Display;
  webgl2: boolean;
  refused?: boolean;
  vulkan: boolean;
}): RunDisplay {
  if (!o.gpu || o.simple) return { display: 'none', vulkan: false };
  const three = wants3d(o) && o.webgl2 && !o.refused;
  return { display: three ? '3d' : '2d', vulkan: three && o.vulkan };
}

/** Whether 3D is asked for (before what the browser can do): the address's, else the record's, else the Preferences'. */
export const wants3d = (o: { gpu: boolean; simple: boolean; asked?: Display; record?: Display; setting?: Display }) =>
  o.gpu && !o.simple && (o.asked ?? o.record ?? o.setting ?? '3d') === '3d';

/** A size kept in the settings, if its slider stops at it (0: none). */
const kept = (n: number | undefined, r: SliderRange) =>
  n && ((n >= r.min && n <= r.max && Number.isInteger((n - r.min) / r.step)) || r.stands?.some(([, v]) => v === n))
    ? n
    : 0;

/** The devices a machine may have or not, and the guest's network settings (`MachineRecord`'s switches). */
export type DeviceSwitches = {
  usb: boolean;
  mouse: boolean;
  touch: boolean;
  agent: boolean;
  clipboard: boolean;
  clock: boolean;
  shares: boolean;
  netConfig: boolean;
};

/** What the page's machine is resolved to at its start (before what this browser can do: `effectiveDisplay`). */
export type Resolved = {
  ncpus: number;
  ramMiB: number;
  /** The RAM's split, MiB, memory 0 first; none: the automatic one. */
  ramSplit?: number[];
  /** The JIT's code cache budget, MiB; 0: the default. */
  jitMiB: number;
  devices: DeviceSwitches;
  /** 3D asked for (`wants3d`), and Vulkan beside it. */
  three: boolean;
  vulkan: boolean;
  /** The guest's keyboard layout setting (web/app/keyboard.ts `keyboardSetting`). */
  keyboard?: string;
};

/**
 * The page's machine as the address, a stored machine's record (none: a transient machine), the browser's settings
 * and the defaults say (docs/frontend.md "Query parameters").
 */
export function resolveMachine(
  q: URLSearchParams,
  record: MachineRecord | undefined,
  s: Settings,
  env: { gpu: boolean; ramMiB: number; cores: number },
): Resolved {
  const gpu = (q.get('gpu') ?? '').split(',');
  const asked = gpu.includes('2d') || gpu.includes('virgl-null') ? '2d' : gpu.includes('virgl') ? '3d' : undefined;
  const simple = q.get('display') === 'simple';
  return {
    ...resolveSize(q, record, s, env),
    devices: resolveDevices(q, record),
    three: wants3d({ gpu: env.gpu, simple, asked, record: record?.display, setting: s.gpu }),
    vulkan: gpu.includes('vulkan') || !!record?.vulkan,
    keyboard: keyboardSetting(q.get('keyboard'), record, q.has('machine')),
  };
}

/** The size: the address's, else the stored machine's, else the one chosen last in this browser, else the defaults. */
function resolveSize(
  q: URLSearchParams,
  record: MachineRecord | undefined,
  s: Settings,
  env: { ramMiB: number; cores: number },
) {
  /** The address's number for `k`; 0 (absent, not a number): unset. */
  const asked = (k: string) => Number(q.get(k)) || 0;
  const first = (...n: (number | undefined)[]) => n.find((x) => !!x) ?? 0;
  const ncpus = first(asked('ncpus'), record?.ncpus, kept(s.ncpus, CPU_SLIDER), defaultCpus(env.cores));
  const ramMiB = first(asked('ram'), record?.ramMiB, kept(s.ramMiB, RAM_SLIDER), env.ramMiB);
  const jitMiB = first(Math.max(0, Math.round(asked('jitmb'))), record ? record.jitMiB : s.jitMiB);
  // `?split=3071,1024` (its sum is the RAM, over `?ram=`), else a stored machine's own.
  const split = q.get('split')?.split(',').map(Number);
  const ramSplit = split && !ramSplitError(split) ? split : q.has('ram') ? undefined : record?.ramSplit;
  return { ncpus, ramMiB: ramSplit ? ramSplit.reduce((a, b) => a + b, 0) : ramMiB, ramSplit, jitMiB };
}

/**
 * The address's switches, one per device (or setting) a machine may have: `=1` turns it on, `=0` off, over a stored
 * machine's record and a transient machine's default. A switch to another machine on the page drops them with the
 * size's (web/app/areas/disk-actions.ts `switchMachine`): they were the address's for the machine it opened.
 */
export const SWITCHES = {
  usb: 'usb',
  mouse: 'mouse',
  touch: 'touch',
  agent: 'agent',
  clipboard: 'clipboard',
  clock: 'clock',
  netConfig: 'netconfig',
} as const;
/** The address's keys a switch to another machine drops: the size's and the switches. */
export const MACHINE_PARAMS = ['ncpus', 'ram', 'split', 'jitmb', ...Object.values(SWITCHES)];

/**
 * The address a machine resolves over: the page's own machine, the whole address; another one (the Home page's
 * choice), without the size's and the switches' keys, as `switchMachine` drops them before it runs here.
 */
export function addressFor(q: URLSearchParams, own: boolean) {
  if (own) return q;
  const other = new URLSearchParams(q);
  for (const k of MACHINE_PARAMS) other.delete(k);
  return other;
}

/**
 * The devices: each the address's (`?usb=1`, `?mouse=0`, …), else a stored machine's record's, else the default (off,
 * but the clock and the guest's network settings on; a stored machine's clock off unless its record says, as the
 * records from before it have none). Shared folders are the record's only.
 */
function resolveDevices(q: URLSearchParams, record: MachineRecord | undefined): DeviceSwitches {
  const asked = (k: keyof typeof SWITCHES) => {
    const v = q.get(SWITCHES[k]);
    return v === '1' ? true : v === '0' ? false : undefined;
  };
  const flag = (k: 'usb' | 'mouse' | 'touch' | 'clipboard') => asked(k) ?? !!record?.[k];
  return {
    usb: flag('usb'),
    mouse: flag('mouse'),
    touch: flag('touch'),
    // The guest agent: on unless the record or the address says not. The clipboard goes through it.
    agent: asked('agent') ?? record?.agent !== false,
    clipboard: flag('clipboard'),
    clock: asked('clock') ?? (record ? !!record.clock : true),
    shares: !!record?.shares,
    netConfig: asked('netConfig') ?? record?.netConfig !== false,
  };
}

/**
 * A stored machine's record as a start runs it: its size and devices as they were resolved (`Resolved`, or the page's
 * machine's), the rest its own. Its shape is the one the run's snapshots and suspends carry (docs/machines.md §5.1).
 */
export function asRun(
  r: MachineRecord,
  x: Pick<Resolved, 'ncpus' | 'ramMiB' | 'ramSplit' | 'jitMiB' | 'devices'>,
): MachineRecord {
  const d = x.devices;
  return {
    ...r,
    ncpus: x.ncpus,
    ramMiB: x.ramMiB,
    ramSplit: x.ramSplit,
    jitMiB: x.jitMiB || undefined,
    usb: d.usb,
    mouse: d.mouse,
    touch: d.touch,
    agent: d.agent ? undefined : false,
    clipboard: d.clipboard,
    clock: d.clock,
    shares: d.shares,
    netConfig: d.netConfig ? undefined : false,
  };
}
