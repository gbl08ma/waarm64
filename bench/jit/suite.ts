// M5 step 1: the JIT's plumbing cost on the wasm core (core/src/jit, web/vm.ts
// jitHost). Install: the core emits a one-block module and the host compiles,
// instantiates and puts it into the core's table. Call: the core calls blocks
// through its table from one call site (a block is one i64 add on a register).
// `node bench/run.ts --page bench/jit/index.html`.
import type { Options, Sample } from '../spike/benchmarks.ts';
import { ABI, coreImports } from '../../web/vm.ts';

type Exports = {
  abi_version(): number;
  vcpu_new(): number;
  jit_add_install(reg: number, imm: bigint, slot: number): number;
  jit_call(cpu: number, idx: number, k: number, n: number): number;
};

async function setup() {
  const url = new URL('../../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url);
  const wasm = url.protocol === 'file:' ? await (await import('node:fs/promises')).readFile(url) : await (await fetch(url)).arrayBuffer();
  const memory = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
  const imports = coreImports(memory);
  const { instance } = await WebAssembly.instantiate(wasm, imports);
  imports.jit.bind(instance);
  const ex = instance.exports as unknown as Exports;
  if (ex.abi_version() !== ABI) throw new Error(`core ABI ${ex.abi_version()}, expected ${ABI}`);
  return { ex, cpu: ex.vcpu_new() };
}

/** µs per install (emit, compile, instantiate, table.set) and per first call (V8 compiles lazily). */
async function install(o: Options): Promise<Sample[]> {
  const { ex, cpu } = await setup();
  const per = 100;
  const inst: number[] = [], first: number[] = [];
  for (let r = 0; r < (o.quick ? 5 : 20); r++) {
    const idx: number[] = [];
    let t = performance.now();
    for (let k = 0; k < per; k++) idx.push(ex.jit_add_install(k % 31, BigInt(r * per + k), k));
    inst.push(((performance.now() - t) * 1000) / per);
    t = performance.now();
    for (const i of idx) ex.jit_call(cpu, i, 1, 1);
    first.push(((performance.now() - t) * 1000) / per);
  }
  o.log?.(`install ${inst.map((x) => x.toFixed(1)).join(' ')} µs; first call ${first.map((x) => x.toFixed(1)).join(' ')} µs`);
  return [
    { name: 'jit_install', unit: 'µs', params: { per }, samples: inst },
    { name: 'jit_first_call', unit: 'µs', params: { per }, samples: first },
  ];
}

/** ns per call through the core's table from one call site, over `k` distinct blocks. */
async function calls(o: Options, k: number): Promise<Sample[]> {
  const { ex, cpu } = await setup();
  const first = ex.jit_add_install(0, 1n, 0);
  for (let i = 1; i < k; i++) ex.jit_add_install(i, 1n, i);
  const n = o.quick ? 2_000_000 : 10_000_000;
  const ns = () => {
    const t = performance.now();
    if (ex.jit_call(cpu, first, k, n) !== n) throw new Error('a block returned the wrong status');
    return ((performance.now() - t) * 1e6) / n;
  };
  for (let i = 0; i < 3; i++) ns();
  const s = Array.from({ length: o.quick ? 5 : 15 }, ns);
  o.log?.(`call over ${k}: ${s.map((x) => x.toFixed(2)).join(' ')} ns`);
  return [{ name: `jit_call_${k}`, unit: 'ns', params: { blocks: k, n }, samples: s }];
}

export const suite = { install, call_1: (o: Options) => calls(o, 1), call_16: (o: Options) => calls(o, 16) };
export const runAll = async (o: Options) => [...(await install(o)), ...(await calls(o, 1)), ...(await calls(o, 16))];
