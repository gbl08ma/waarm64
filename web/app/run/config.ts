// What the page's machine runs with (docs/frontend.md "Query parameters"): its size, devices and display, resolved
// from the address, the record, the browser's settings and what this browser can do. Pure (no `location`, no storage): tests/config.test.ts runs it
// in Node.
import { keyboardSetting } from '../keyboard.ts';
import { defaultCpus, RAM_CHOICES, ramSplitError } from '../machine.ts';
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

/** The vCPU counts the Machine menu offers. */
export const CPU_CHOICES = [1, 2, 3, 4, 6, 8];

/** A size kept in the settings, if it is one of the choices (0: none). */
const kept = (n: number | undefined, choices: number[]) => (n && choices.includes(n) ? n : 0);

/** The devices a machine may have or not, and the guest's network settings (`MachineRecord`'s switches). */
export type DeviceSwitches = {
  usb: boolean;
  mouse: boolean;
  touch: boolean;
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
  const ncpus = first(asked('ncpus'), record?.ncpus, kept(s.ncpus, CPU_CHOICES), defaultCpus(env.cores));
  const ramMiB = first(asked('ram'), record?.ramMiB, kept(s.ramMiB, RAM_CHOICES), env.ramMiB);
  const jitMiB = first(Math.max(0, Math.round(asked('jitmb'))), record ? record.jitMiB : s.jitMiB);
  // `?split=3071,1024` (its sum is the RAM, over `?ram=`), else a stored machine's own.
  const split = q.get('split')?.split(',').map(Number);
  const ramSplit = split && !ramSplitError(split) ? split : q.has('ram') ? undefined : record?.ramSplit;
  return { ncpus, ramMiB: ramSplit ? ramSplit.reduce((a, b) => a + b, 0) : ramMiB, ramSplit, jitMiB };
}

/** The devices: a stored machine's record's; a transient machine's by the address (`?usb=1`, …, `?clock=0`). */
function resolveDevices(q: URLSearchParams, record: MachineRecord | undefined): DeviceSwitches {
  const flag = (k: 'usb' | 'mouse' | 'touch' | 'clipboard') => (record ? !!record[k] : q.get(k) === '1');
  return {
    usb: flag('usb'),
    mouse: flag('mouse'),
    touch: flag('touch'),
    clipboard: flag('clipboard'),
    clock: record ? !!record.clock : q.get('clock') !== '0',
    shares: !!record?.shares,
    netConfig: (q.get('netconfig') ?? (record?.netConfig === false ? '0' : '1')) !== '0',
  };
}
