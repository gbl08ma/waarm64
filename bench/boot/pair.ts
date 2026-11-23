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
// dropping machine code: a JIT inside the JIT) between its two lines, whose check line every sample must repeat.
import { compileCore } from '../../web/core.ts';
import { DISTROS } from '../../web/test-guests.ts';
import type { Counters, ProcStat } from '../procstat.ts';
import { boot, images } from './suite.ts';

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
/** `window`: the console lines ("waarm64: <line>") the sample runs between; `check`: a line of the guest's it reports. */
type Workload = { img: () => Promise<Img>; window?: [string, string]; check?: RegExp };
const WORKLOADS: Record<string, Workload> = {
  boot: { img: () => alpine(DISTROS.alpine.disk, true) },
  // The whole run, not its phases alone: between "compress start" and "sqlite end" a pair's ratio spread 0.53%
  // against the run's 0.38% (the same noise over two thirds of the time), which costs what the sharper signal buys.
  user: { img: () => alpine('alpine-user/rootfs-user.ext4', false) },
  node: { img: () => alpine('alpine-node/rootfs-node.ext4', false), window: ['node start', 'node end'], check: /jitjit: [0-9a-f]{8} \d+/ },
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
 * What a sample is: `ms` and `steps` over the run or its window, `proc` the renderers' counters over the same,
 * `footprint` their memory at its end (bytes), `stats` the whole run's counters, `check` the guest's check line.
 */
export type PairSample = { ms: number; steps: number; marks: Record<string, number>; proc?: Counters; footprint?: number; check?: string; stats: Awaited<ReturnType<typeof boot>>['stats'] };

async function sample(workload: string): Promise<PairSample> {
  if (!WORKLOADS[workload]) throw new Error(`no workload ${workload}; one of ${Object.keys(WORKLOADS)}`);
  core ??= get(`../../${q.get('core')}`).then(compileCore);
  const wl = WORKLOADS[workload];
  if (!imgs.has(workload)) imgs.set(workload, wl.img());
  const [module, img] = [await core, await imgs.get(workload)!];
  const delta = (a: ProcStat | undefined, b: ProcStat | undefined) => a && b && (Object.fromEntries(Object.keys(b.renderer).map((k) => [k, b.renderer[k as keyof Counters] - a.renderer[k as keyof Counters]])) as Counters);
  fresh();
  let p0: ProcStat | undefined, p1: ProcStat | undefined, steps0 = 0, steps1 = 0, readMs = 0;
  const r = await boot(module, img, async () => { if (!wl.window) p0 = await procNow(); }, {
    onMark: (m, vm) => {
      if (m === wl.window?.[0]) {
        const t = performance.now();
        p0 = procSync();
        steps0 = vm.stats().steps;
        readMs = performance.now() - t;
      } else if (m === wl.window?.[1]) {
        steps1 = vm.stats().steps;
        p1 = procSync();
      }
    },
  });
  if (!wl.window) p1 = await procNow();
  const check = wl.check && (r.console.match(wl.check)?.[0] ?? `no check line`);
  fresh();
  if (!wl.window) return { ms: r.total, steps: r.stats.steps, marks: r.marks, proc: delta(p0, p1), footprint: p1?.footprint, check, stats: r.stats };
  const ms = r.marks[wl.window[1]] - r.marks[wl.window[0]] - readMs;
  if (!(ms > 0 && steps1 > steps0)) throw new Error(`${workload}: no "${wl.window[0]}" and "${wl.window[1]}" lines:\n${r.console.slice(-2000)}`);
  return { ms, steps: steps1 - steps0, marks: r.marks, proc: delta(p0, p1), footprint: p1?.footprint, check, stats: r.stats };
}

self.onmessage = async (e: MessageEvent<{ id: number; workload: string }>) => {
  try {
    self.postMessage({ id: e.data.id, result: await sample(e.data.workload) });
  } catch (err) {
    self.postMessage({ id: e.data.id, error: String((err as Error).stack ?? err) });
  }
};
