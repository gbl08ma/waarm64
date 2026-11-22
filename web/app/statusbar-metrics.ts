// The status bar's numbers (docs/frontend.md "The status bar"): one second of a machine's, from two statuses in a row.
// DOM-free, for tests/statusbar.test.ts.
import type { Status } from './protocol.ts';

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
  /** The TLB's misses and flushes a second, all vCPUs. */
  tlbMisses?: number;
  tlbFlushes?: number;
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

type Rate = (now: number, then: number | undefined) => number | undefined;
/** The share of `all`'s steps since `all0` that ran in JIT code (`jit` since `jit0`), in percent. */
const share = (jit: number, all: number, jit0?: number, all0?: number) =>
  jit0 !== undefined && all0 !== undefined && all > all0 ? ((jit - jit0) / (all - all0)) * 100 : undefined;

/** Each vCPU's MIPS and JIT share, when both statuses count them alike. */
function cpusOf(s: Status, p: Status | undefined, rate: Rate) {
  const prevCpus = p?.cpus;
  if (!s.cpus || prevCpus?.length !== s.cpus.length) return undefined;
  return s.cpus.map((c, i) => ({
    mips: (rate(c.steps, prevCpus[i].steps) ?? 0) / 1e6,
    jit: share(c.jitSteps, c.steps, prevCpus[i].jitSteps, prevCpus[i].steps),
  }));
}

/** The disks', adapters' and USB's totals and their rates. */
function trafficOf(s: Status, p: Status | undefined, rate: Rate): Pick<Metrics, 'disks' | 'nets' | 'usb'> {
  return {
    disks: s.disks?.map((d, i) => ({
      ...d,
      readRate: rate(d.read, p?.disks?.[i]?.read),
      writeRate: rate(d.written, p?.disks?.[i]?.written),
    })),
    nets: s.nets?.map((n, i) => ({ ...n, rxRate: rate(n.rx, p?.nets?.[i]?.rx), txRate: rate(n.tx, p?.nets?.[i]?.tx) })),
    usb: s.usb && { ...s.usb, inRate: rate(s.usb.in, p?.usb?.in), outRate: rate(s.usb.out, p?.usb?.out) },
  };
}

/**
 * The steps' rates, only between two statuses that counted every step (a machine that turned counting on or off
 * between them counted part of the second): MIPS, the JIT share, each vCPU's, the bars' full height.
 */
function stepsOf(s: Status, prev: Sample | undefined, rate: Rate): Pick<Metrics, 'mips' | 'jit' | 'cpus' | 'cpuPeak'> {
  const q = s.counted && prev?.status.counted ? prev.status : undefined;
  const cpus = cpusOf(s, q, rate);
  const mips = rate(s.steps, q?.steps);
  return {
    mips: mips === undefined ? undefined : mips / 1e6,
    jit: share(s.jitSteps, s.steps, q?.jitSteps, q?.steps),
    cpus,
    cpuPeak: Math.max(prev?.metrics.cpuPeak ?? 0, ...(cpus ?? []).map((c) => c.mips)),
  };
}

/** `s`, received at `at` (ms, monotonic), after `prev` (the run's previous one). */
export function metrics(s: Status, at: number, prev?: Sample, tabBytes?: number): Metrics {
  const p = prev?.status;
  const dt = prev ? (at - prev.at) / 1000 : 0;
  const rate: Rate = (now, then) => (then !== undefined && dt > 0 ? Math.max(0, now - then) / dt : undefined);
  return {
    ncpus: s.ncpus,
    ramMiB: s.ramMiB,
    uptimeMs: s.uptime,
    ...stepsOf(s, prev, rate),
    irqs: rate(s.irqs, p?.irqs),
    tlbMisses: rate(s.tlbMisses, p?.tlbMisses),
    tlbFlushes: rate(s.tlbFlushes, p?.tlbFlushes),
    blocks: s.jitBlocks,
    flushes: s.jitFlushes,
    compileMs: s.jitCompileMs,
    jitLive: s.memory.jitLiveBytes,
    jitBudget: s.memory.jitBudget,
    tabBytes,
    ...trafficOf(s, p, rate),
  };
}
