// M1 interpreter MIPS baseline: the integer guest (guest.c) on the wasm core,
// through the ABI a vCPU worker uses. Runs in a browser worker (bench/run.ts
// --page bench/interp/index.html) and in Node (tests/core-wasm.test.ts).
import type { Options, Sample } from '../spike/benchmarks.ts';

const RAM = 16 << 20;
const LOAD = 0x10000; // guest.ld
const ROUNDS = 0x80000; // guest.c

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
  vcpu_new(): number;
  mem_new(base: number, size: bigint): number;
  interp_run(cpu: number, mem: number, n: bigint): bigint;
};

/** Instantiates the core, loads the guest into RAM placed after the core's state (layout A). */
export async function setup() {
  const wasm = await load('../../target/wasm32-unknown-unknown/release/webpc_core.wasm');
  const memory = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
  const { instance } = await WebAssembly.instantiate(wasm, { env: { memory } });
  const ex = instance.exports as unknown as Exports;
  if (ex.abi_version() !== 1) throw new Error(`core ABI ${ex.abi_version()}, expected 1`);
  const cpu = ex.vcpu_new();
  const base = memory.grow(RAM / 65536) * 65536;
  const guest = await load('guest.bin');
  new Uint8Array(memory.buffer, base + LOAD, guest.length).set(guest);
  const mem = ex.mem_new(base, BigInt(RAM));
  const u64 = (addr: number) => new BigUint64Array(memory.buffer, addr, 1);
  u64(cpu + 256)[0] = BigInt(LOAD); // PC
  return {
    run: (n: number) => Number(ex.interp_run(cpu, mem, BigInt(n))),
    pc: () => u64(cpu + 256)[0],
    rounds: () => u64(base + ROUNDS)[0],
  };
}

async function interpMips(o: Options): Promise<Sample[]> {
  const g = await setup();
  const chunk = o.quick ? 2_000_000 : 20_000_000;
  const mips = (n: number) => {
    const t = performance.now();
    const done = g.run(n);
    const dt = performance.now() - t;
    if (done !== n) throw new Error(`guest stopped after ${done} instructions at pc 0x${g.pc().toString(16)}`);
    return n / dt / 1000;
  };
  // Cold: the first instructions after instantiation, while V8 still runs Liftoff code.
  const cold = [mips(2_000_000)];
  for (let i = 0; i < 3; i++) mips(chunk);
  const warm = Array.from({ length: o.quick ? 5 : 15 }, () => mips(chunk));
  o.log?.(`interp: ${warm.map((x) => x.toFixed(1)).join(' ')} MIPS, ${g.rounds()} guest rounds`);
  if (g.rounds() === 0n) throw new Error('guest made no progress');
  const params = { guest: 'bench/interp/guest.c', chunk };
  return [
    { name: 'interp_mips_cold', unit: 'MIPS', params: { ...params, chunk: 2_000_000 }, samples: cold },
    { name: 'interp_mips', unit: 'MIPS', params, samples: warm },
  ];
}

export const suite = { interp_mips: interpMips };
export const runAll = interpMips;
