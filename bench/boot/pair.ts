// One arm of a paired A/B, in a worker that outlives its samples (bench/ab.ts drives the arms' pages in one browser,
// a sample of each per round; docs/benchmarking.md "The paired A/B"). A sample is one deterministic run of a
// workload to power-off under the JIT on this arm's core (`?core=<path from the tree's root>`, compiled once),
// through this tree's own `boot` (bench/boot/suite.ts, which reads the rest of the query: `nocw`, `fma=emul`, …):
// its time, its steps and counters, and the renderers' CPU counters over it (`?proc=<port>`: bench/procstat.ts),
// read here around the boot so that an arm from an older tree is measured the same way. A full GC before each
// sample (the suite's reason) and after it (an arm's dead modules and memory don't wait beside the next arm's run).
// Workloads: `user`, Alpine's userspace phases (the gate `alpine_user_jit`); `boot`, Alpine's boot (`boot_alpine_jit`).
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
const WORKLOADS: Record<string, () => Promise<Img>> = {
  user: () => alpine('alpine-user/rootfs-user.ext4', false),
  boot: () => alpine(DISTROS.alpine.disk, true),
};

let core: Promise<WebAssembly.Module> | undefined;
const imgs = new Map<string, Promise<Img>>();

/** What a sample is: `proc` the renderers' counters over the run, `footprint` their memory at its end (bytes). */
export type PairSample = { ms: number; steps: number; marks: Record<string, number>; proc?: Counters; footprint?: number; stats: Awaited<ReturnType<typeof boot>>['stats'] };

async function sample(workload: string): Promise<PairSample> {
  if (!WORKLOADS[workload]) throw new Error(`no workload ${workload}; one of ${Object.keys(WORKLOADS)}`);
  core ??= get(`../../${q.get('core')}`).then(compileCore);
  if (!imgs.has(workload)) imgs.set(workload, WORKLOADS[workload]());
  const [module, img] = [await core, await imgs.get(workload)!];
  fresh();
  let p0: ProcStat | undefined;
  const r = await boot(module, img, async () => { p0 = await procNow(); });
  const p1 = await procNow();
  const proc = p0 && p1 && (Object.fromEntries(Object.keys(p1.renderer).map((k) => [k, p1.renderer[k as keyof Counters] - p0!.renderer[k as keyof Counters]])) as Counters);
  fresh();
  return { ms: r.total, steps: r.stats.steps, marks: r.marks, proc, footprint: p1?.footprint, stats: r.stats };
}

self.onmessage = async (e: MessageEvent<{ id: number; workload: string }>) => {
  try {
    self.postMessage({ id: e.data.id, result: await sample(e.data.workload) });
  } catch (err) {
    self.postMessage({ id: e.data.id, error: String((err as Error).stack ?? err) });
  }
};
