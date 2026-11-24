// One arm of a paired A/B, in a worker that outlives its samples (bench/ab.ts drives the arms' pages in one browser,
// a sample of each per round; docs/benchmarking.md "The paired A/B"). A sample is one deterministic run of a
// workload to power-off under the JIT on this arm's core (`?core=<path from the tree's root>`, compiled once),
// through this tree's own `boot` (bench/boot/suite.ts, which reads the rest of the query: `nocw`, `fma=emul`, …):
// its time, its steps and counters, and the renderers' CPU counters over it (`?proc=<port>`: bench/procstat.ts),
// read here so that an arm from an older tree is measured the same way: around the boot (from the machine made to
// after its close: a little wider than the time's), or for a workload with a window between two of the guest's
// "waarm64: …" lines (its boot and power-off left out). The counters and the memory are every renderer's of the
// browser, the other arms' idle pages too: the driver leaves a pause between samples so that an arm's leftovers
// (its collector, freed code) don't land in the next one's. A full GC before each
// sample (the suite's reason) and after it (an arm's dead modules and memory don't wait beside the next arm's run).
// Workloads: `boot`, Alpine's boot to power-off (the gate `boot_alpine_jit`); `user`, Alpine's userspace phases
// with their boot (`alpine_user_jit`); `node`, Node running images/alpine/node/jitjit.js (V8 writing, patching and
// dropping machine code: a JIT inside the JIT) between its two lines, whose check line every sample must repeat;
// `smp`, the same image on 4 vCPUs in parallel SMP (a worker each and the compile worker, as the page runs a machine;
// realtime, not deterministic) running four copies of jitjit.js at once, each printing the check line. Its samples
// also carry `lat` (`Latency`): what the run did about latency and compiling over the window.
import { compileCore } from '../../web/core.ts';
import { readyQuantile } from '../../web/counters.ts';
import { startTimeline, summarizeTimeline } from '../../web/profiler.ts';
import { DISTROS } from '../../web/test-guests.ts';
import type { Counters, ProcStat } from '../procstat.ts';
import type { bootVm } from '../../web/vm.ts';
import { boot, images } from './suite.ts';

type Vm = Awaited<ReturnType<typeof bootVm>>;

const q = new URLSearchParams(self.name);
const get = async (rel: string) => {
  const r = await fetch(new URL(rel, import.meta.url));
  if (!r.ok) throw new Error(`${rel}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};
const abs = (rel: string) => new URL(rel, import.meta.url).href;
const procNow = async (): Promise<ProcStat | undefined> => (q.has('proc') ? ((await (await fetch(`http://127.0.0.1:${q.get('proc')}/`)).json()) as ProcStat) : undefined);
const fresh = () => (globalThis as { gc?: () => void }).gc?.();

type Img = Parameters<typeof boot>[1];
const alpine = async (disk: string, test: boolean): Promise<Img> => {
  const a = DISTROS.alpine;
  const [base, initrd, kernel] = await Promise.all([images(), get(`../../target/images/${a.initrd}`), get(`../../target/images/${a.kernel}`)]);
  return { kernel, initrd, disk: abs(`../../target/images/${disk}`), cmdline: a.cmdline, ramSize: 1 << 30, test, jit: 1, wasm: base.wasm } as Img;
};
/**
 * `window`: the console lines ("waarm64: <line>") the sample runs between; `check`: a line of the guest's it reports
 * (`checks` of them: all must be there, and the same); `ncpus`: parallel SMP on that many vCPUs; `cmdline`: added to
 * the kernel's.
 */
type Workload = { img: () => Promise<Img>; window?: [string, string]; check?: RegExp; checks?: number; ncpus?: number; cmdline?: string };
const WORKLOADS: Record<string, Workload> = {
  boot: { img: () => alpine(DISTROS.alpine.disk, true) },
  // The whole run, not its phases alone: between "compress start" and "sqlite end" a pair's ratio spread 0.53%
  // against the run's 0.38% (the same noise over two thirds of the time), which costs what the sharper signal buys.
  user: { img: () => alpine('alpine-user/rootfs-user.ext4', false) },
  node: { img: () => alpine('alpine-node/rootfs-node.ext4', false), window: ['node start', 'node end'], check: /jitjit: [0-9a-f]{8} \d+/ },
  smp: { img: () => alpine('alpine-node/rootfs-node.ext4', false), window: ['node start', 'node end'], check: /jitjit: [0-9a-f]{8} \d+/g, checks: Number(q.get('par') ?? 4), ncpus: 4, cmdline: `waarm64.par=${q.get('par') ?? 4} waarm64.jj=${q.get('jj') ?? 50}` },
};
/** The counters now, the vCPU waiting for them: at a console line, mid-run (its time is taken off the sample's). */
const procSync = (): ProcStat | undefined => {
  if (!q.has('proc')) return undefined;
  const x = new XMLHttpRequest();
  x.open('GET', `http://127.0.0.1:${q.get('proc')}/`, false);
  x.send();
  return JSON.parse(x.responseText) as ProcStat;
};

let core: Promise<WebAssembly.Module> | undefined;
const imgs = new Map<string, Promise<Img>>();

/**
 * A parallel workload's window, for latency under JIT churn (all summed over the vCPUs): the share of steps run
 * compiled and in the block interpreter (%); modules a table compiled itself after waiting for the compile worker
 * over a second (`overdue`), and times a compiled module hadn't reached a vCPU when its table wanted it (`parks`);
 * the compile worker's modules, its busy ms, and the delay from a module's emission to the ready word reaching it
 * (ms: mean, and the upper bounds of the buckets that hold the median, the 99th percentile and the longest, 2048 for
 * 1024 and over:
 * web/counters.ts `readyQuantile`; `readyMaxMs` is the whole run's, the boot's too); from the vCPU timeline (5 ms
 * rows: web/profiler.ts `summarizeTimeline`), the longest run of rows in which a vCPU inside one `vm_run_cpu` call
 * retired nothing (`stallMaxMs`, the longest over the vCPUs: a compile, V8's GC, a lock or a wait on the host, the
 * guest's clock running on) and such rows' ms a second summed over the vCPUs (`stallMsPerS`), and ms a second out of
 * the core (idle, or the host's: `outMsPerS`).
 */
export type Latency = { compiledPct: number; interpPct: number; overdue: number; parks: number; modules: number; workerBusyMs: number; ready: number; readyMeanMs: number; readyP50Ms: number; readyP99Ms: number; readyTopMs: number; readyMaxMs: number; stallMaxMs: number; stallMsPerS: number; outMsPerS: number };
/**
 * What a sample is: `ms` and `steps` over the run or its window, `proc` the renderers' counters over the same,
 * `footprint` their memory at its end (bytes), `stats` the whole run's counters, `check` the guest's check line,
 * `lat` a parallel workload's latency counters over the window.
 */
export type PairSample = { ms: number; steps: number; marks: Record<string, number>; proc?: Counters; footprint?: number; check?: string; lat?: Latency; stats: Awaited<ReturnType<typeof boot>>['stats'] };


async function sample(workload: string): Promise<PairSample> {
  if (!WORKLOADS[workload]) throw new Error(`no workload ${workload}; one of ${Object.keys(WORKLOADS)}`);
  core ??= get(`../../${q.get('core')}`).then(compileCore);
  const wl = WORKLOADS[workload];
  if (!imgs.has(workload)) imgs.set(workload, wl.img());
  const [module, img] = [await core, await imgs.get(workload)!];
  const delta = (a: ProcStat | undefined, b: ProcStat | undefined) => a && b && (Object.fromEntries(Object.keys(b.renderer).map((k) => [k, b.renderer[k as keyof Counters] - a.renderer[k as keyof Counters]])) as Counters);
  fresh();
  type At = { stats: ReturnType<Vm['stats']>; cw: ReturnType<NonNullable<Vm['compileStats']>> };
  let p0: ProcStat | undefined, p1: ProcStat | undefined, steps0 = 0, steps1 = 0, readMs = 0;
  let at0: At | undefined, at1: At | undefined, timeline: ReturnType<typeof startTimeline> | undefined, rows: Promise<Parameters<typeof summarizeTimeline>[0]> | undefined;
  // (An older tree's VM has no compile worker counters.)
  const here = (vm: Vm): At => ({ stats: vm.stats(), cw: vm.compileStats?.() });
  const cmdline = wl.cmdline && `${img.cmdline} ${wl.cmdline}`;
  const r = await boot(module, img, async () => { if (!wl.window) p0 = await procNow(); }, {
    cmdline, ncpus: wl.ncpus, parallel: wl.ncpus ? true : undefined,
    onMark: (m, vm) => {
      if (m === wl.window?.[0]) {
        const t = performance.now();
        p0 = procSync();
        steps0 = vm.stats().steps;
        if (wl.ncpus) {
          at0 = here(vm);
          // The timeline's worker starts in the window's first milliseconds (its rows begin when it has).
          if (vm.liveBlock) timeline = startTimeline(vm.memory, vm.counterBlocks, vm.liveBlock, 5);
        }
        readMs = performance.now() - t;
      } else if (m === wl.window?.[1]) {
        steps1 = vm.stats().steps;
        p1 = procSync();
        if (wl.ncpus) {
          at1 = here(vm);
          rows = timeline?.then((stop) => stop());
        }
      }
    },
  });
  if (!wl.window) p1 = await procNow();
  const found = wl.check ? [...r.console.matchAll(new RegExp(wl.check.source, 'g'))].map((x) => x[0]) : [];
  // Each copy's line, the same: `<n>× <line>`; lines that differ are each there, and fail the run as a different check.
  const check = wl.check && (!found.length ? 'no check line' : wl.checks ? `${found.length}× ${[...new Set(found)].sort().join(' | ')}` : found[0]);
  fresh();
  if (!wl.window) return { ms: r.total, steps: r.stats.steps, marks: r.marks, proc: delta(p0, p1), footprint: p1?.footprint, check, stats: r.stats };
  const ms = r.marks[wl.window[1]] - r.marks[wl.window[0]] - readMs;
  if (!(ms > 0 && steps1 > steps0)) throw new Error(`${workload}: no "${wl.window[0]}" and "${wl.window[1]}" lines:\n${r.console.slice(-2000)}`);
  const lat = at0 && at1 ? latency(at0, at1, rows && summarizeTimeline(await rows)) : undefined;
  return { ms, steps: steps1 - steps0, marks: r.marks, proc: delta(p0, p1), footprint: p1?.footprint, check, lat, stats: r.stats };
}

/** A window's `Latency`, from the counters at its two ends and its timeline's summary. */
function latency(a: { stats: PairSample['stats']; cw?: { compiled: number; busyMs: number; ready: number; readySumMs: number; readyMaxMs: number; readyHist: number[] } }, b: typeof a, tl?: ReturnType<typeof summarizeTimeline>): Latency {
  const d = (f: (s: PairSample['stats']) => number) => f(b.stats) - f(a.stats);
  const steps = d((s) => s.steps);
  const hist = b.cw ? b.cw.readyHist.map((n, k) => n - a.cw!.readyHist[k]) : [];
  const ready = b.cw ? b.cw.ready - a.cw!.ready : 0;
  const top = hist.findLastIndex((n) => n > 0);
  return {
    compiledPct: (100 * d((s) => s.jit.steps)) / steps,
    interpPct: (100 * d((s) => s.jit.decSteps)) / steps,
    overdue: d((s) => s.jit.overdue),
    parks: d((s) => s.jit.parks),
    modules: b.cw ? b.cw.compiled - a.cw!.compiled : NaN,
    workerBusyMs: b.cw ? b.cw.busyMs - a.cw!.busyMs : NaN,
    ready,
    readyMeanMs: ready ? (b.cw!.readySumMs - a.cw!.readySumMs) / ready : NaN,
    readyP50Ms: b.cw ? readyQuantile(hist, 0.5) : NaN,
    readyP99Ms: b.cw ? readyQuantile(hist, 0.99) : NaN,
    readyTopMs: top < 0 ? 0 : 2 ** top,
    readyMaxMs: b.cw?.readyMaxMs ?? NaN,
    stallMaxMs: tl ? Math.max(...tl.cpus.map((c) => c.worstStall.ms)) : NaN,
    stallMsPerS: tl ? tl.cpus.reduce((t, c) => t + c.stallMs, 0) : NaN,
    outMsPerS: tl ? tl.cpus.reduce((t, c) => t + c.outMs, 0) : NaN,
  };
}

self.onmessage = async (e: MessageEvent<{ id: number; workload: string }>) => {
  try {
    self.postMessage({ id: e.data.id, result: await sample(e.data.workload) });
  } catch (err) {
    self.postMessage({ id: e.data.id, error: String((err as Error).stack ?? err) });
  }
};
