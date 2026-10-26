// A paired A/B of core builds in one process, for a host whose speed drifts (a cloud runner, where
// bench/interp/ab.sh's rounds spread past a few percent): every arm's guests live side by side and
// run alternately, a chunk each in a shuffled order every iteration, so a slowdown hits all arms
// alike. A sample is one iteration's MIPS of an arm over the first arm's, in percent. The guests are
// the block interpreter's small ones (`VmConfig.jit` 4 / `jit_new` never compiling): `dec_mips`'s at
// two placements, `vm_dec_flat_mips`' and `vm_dec_mmu_mips`'.
//   node bench/interp/paired.ts <iterations> <name>=<core.wasm>...        (Node)
//   node bench/run.ts --page bench/interp/paired.html --query='arms=<name>=<core.wasm>,...&iters=<n>'   (Chromium)
// Core paths are relative to the repo's root. `node bench/interp/paired.ts --summary <json>...` sums
// up runs (Node's OUT=<json>, or bench/run.ts's --out), pooled.
import type { Options, Sample } from '../spike/benchmarks.ts';
import { ABI, bootVm, coreImports } from '../../web/vm.ts';
import { JIT_INTERP } from './suite.ts';

const RAM = 16 << 20;
const LOAD = 0x10000; // guest.ld
const CHUNK = 20_000_000;

async function load(rel: string): Promise<Uint8Array<ArrayBuffer>> {
  const url = new URL(rel, import.meta.url);
  if (url.protocol === 'file:') {
    const { readFile } = await import('node:fs/promises');
    return new Uint8Array(await readFile(url));
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

type Exports = {
  abi_version(): number;
  jit_new(threshold: number, batch: number, capacity: number, check: number, regionAfter: number): number;
  mem_new(base: number, size: bigint): number;
  jit_run(v: number, mem: number, n: bigint): bigint;
};
type Run = (n: number) => number;

/** 0..n-1 in a random order (Fisher-Yates). */
function shuffled(n: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** guest.bin in user mode, `pad` bytes into its first page (bench/interp/suite.ts `setup`). */
async function user(wasm: Uint8Array<ArrayBuffer>, pad: number): Promise<Run> {
  const memory = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
  const imports = coreImports(memory);
  const { instance } = await WebAssembly.instantiate(wasm, imports);
  imports.jit.bind(instance);
  const ex = instance.exports as unknown as Exports;
  if (ex.abi_version() !== ABI) throw new Error(`core ABI ${ex.abi_version()}, expected ${ABI}`);
  const cpu = ex.jit_new(...JIT_INTERP);
  const base = memory.grow(RAM / 65536 + 1) * 65536 + pad;
  const guest = await load('guest.bin');
  new Uint8Array(memory.buffer, base + LOAD, guest.length).set(guest);
  const mem = ex.mem_new(base, BigInt(RAM));
  new BigUint64Array(memory.buffer, cpu + 256, 1)[0] = BigInt(LOAD); // PC
  return (n) => Number(ex.jit_run(cpu, mem, BigInt(n)));
}

/** guest-vm.bin at EL1 in a whole VM (bench/interp/suite.ts `setupVm`). */
async function vm(wasm: Uint8Array<ArrayBuffer>, mmu: boolean): Promise<Run> {
  const [start, guest] = await Promise.all([load('vm-start.bin'), load('guest-vm.bin')]);
  const kernel = new Uint8Array(0x10000 + guest.length);
  kernel.set(start);
  kernel.set(guest, 0x10000);
  const v = await bootVm(wasm, { ramSize: RAM, kernel, cmdline: '', jit: 4 });
  new BigUint64Array(v.memory.buffer, v.cpu + 8, 1)[0] = mmu ? 1n : 0n; // x1
  return (n) => v.run(n).steps;
}

const GUESTS: [string, (w: Uint8Array<ArrayBuffer>) => Promise<Run>][] = [
  ['dec_pad0', (w) => user(w, 0)],
  ['dec_pad29696', (w) => user(w, 29696)],
  ['vm_dec_flat', (w) => vm(w, false)],
  ['vm_dec_mmu', (w) => vm(w, true)],
];

/** Runs the arms (`[name, core path from the repo's root]`, the first the base) `iters` times. */
export async function paired(arms: [string, string][], iters: number, log = (_: string) => {}): Promise<Sample[]> {
  const wasms = await Promise.all(arms.map(([, p]) => load(`../../${p}`)));
  const mips = (r: Run) => {
    const t = performance.now();
    const s = r(CHUNK);
    return s / ((performance.now() - t) * 1000);
  };
  const out: Sample[] = [];
  for (const [guest, make] of GUESTS) {
    // Made one at a time in a shuffled order: where an instance lands moves it by a few percent (an
    // A/A pair up to ~3.6% in one process), so which arm is made first must not be fixed either.
    const runs: Run[] = [];
    for (const i of shuffled(arms.length)) runs[i] = await make(wasms[i]);
    for (const r of runs) for (let i = 0; i < 5; i++) mips(r); // warm-up
    const rows: number[][] = [];
    for (let it = 0; it < iters; it++) {
      const m: number[] = [];
      for (const i of shuffled(arms.length)) m[i] = mips(runs[i]);
      rows.push(m);
    }
    log(`${guest}: ${iters} iterations`);
    for (let i = 0; i < arms.length; i++) {
      out.push({
        name: `${guest}_${arms[i][0]}`, unit: '%',
        params: { guest, arm: arms[i][0], core: arms[i][1], base: arms[0][0], chunk: CHUNK, mips: rows.map((m) => +m[i].toFixed(2)) },
        samples: rows.map((m) => (i === 0 ? 0 : (100 * m[i]) / m[0] - 100)),
      });
    }
  }
  return out;
}

/** For bench/run.ts: the arms and iterations from the page's query (bench/spike/page.ts passes it as the worker's name). */
const fromQuery = (o: Options) => {
  const q = new URLSearchParams(self.name);
  const arms = (q.get('arms') ?? '').split(',').filter(Boolean).map((a) => a.split('=') as [string, string]);
  if (arms.length < 2) throw new Error('paired: ?arms=<name>=<core.wasm>,<name>=<core.wasm>...');
  return paired(arms, +(q.get('iters') ?? 50), o.log);
};
export const suite = { paired: fromQuery };
export const runAll = fromQuery;

/** Each arm against the base: the median of the paired samples, a bootstrap 95% interval of it, how often it won. */
export function summary(samples: Sample[][]): string[] {
  const by = new Map<string, number[]>();
  for (const s of samples.flat()) by.set(s.name, [...(by.get(s.name) ?? []), ...s.samples]);
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
  const lines: string[] = [];
  for (const [name, xs] of by) {
    if (xs.every((x) => x === 0)) continue; // the base against itself
    const boot = Array.from({ length: 2000 }, () => med(Array.from(xs, () => xs[Math.floor(Math.random() * xs.length)]))).sort((a, b) => a - b);
    const wins = xs.filter((x) => x > 0).length;
    lines.push(`${name.padEnd(24)} ${med(xs) >= 0 ? '+' : ''}${med(xs).toFixed(2)}% [${boot[50].toFixed(2)}, ${boot[1949].toFixed(2)}] wins ${wins}/${xs.length}`);
  }
  return lines;
}

if (typeof process !== 'undefined' && process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const [first, ...rest] = process.argv.slice(2);
  if (first === '--summary') {
    for (const l of summary(rest.map((f) => JSON.parse(readFileSync(f, 'utf8')).results as Sample[]))) console.log(l);
  } else {
    const res = await paired(rest.map((a) => a.split('=') as [string, string]), +first, console.error);
    if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify({ host: process.version, results: res }) + '\n');
    for (const l of summary([res])) console.log(l);
  }
}
