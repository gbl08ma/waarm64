// Interpreter MIPS baselines: the integer guest (guest.c, M1) and the FP/NEON
// guest (guest-fp.c, M2) on the wasm core, through the ABI a vCPU worker uses. Runs in a browser worker (bench/run.ts
// --page bench/interp/index.html) and in Node (tests/core-wasm.test.ts).
// M4: the integer guest again in a whole VM through vm_run, at EL1 with the MMU off and on (vm-start.S).
import type { Options, Sample } from '../spike/benchmarks.ts';
import { bootVm } from '../../web/vm.ts';

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

/** Instantiates the core, loads a guest into RAM placed after the core's state (layout A). */
export async function setup(bin = 'guest.bin') {
  const wasm = await load('../../target/wasm32-unknown-unknown/release/webpc_core.wasm');
  const memory = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
  const { instance } = await WebAssembly.instantiate(wasm, { env: { memory } });
  const ex = instance.exports as unknown as Exports;
  if (ex.abi_version() !== 5) throw new Error(`core ABI ${ex.abi_version()}, expected 5`);
  const cpu = ex.vcpu_new();
  const base = memory.grow(RAM / 65536) * 65536;
  const guest = await load(bin);
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

/** guest-vm.bin at EL1 in a whole VM, entered through vm-start.bin (at RAM + 2 MiB, as `bootVm` places a kernel). */
export async function setupVm(mmu: boolean) {
  const [wasm, start, guest] = await Promise.all([load('../../target/wasm32-unknown-unknown/release/webpc_core.wasm'), load('vm-start.bin'), load('guest-vm.bin')]);
  const kernel = new Uint8Array(0x10000 + guest.length);
  kernel.set(start);
  kernel.set(guest, 0x10000);
  const vm = await bootVm(wasm, { ramSize: RAM, kernel, cmdline: '' });
  new BigUint64Array(vm.memory.buffer, vm.cpu + 8, 1)[0] = mmu ? 1n : 0n; // x1
  return {
    run: (n: number) => vm.run(n).steps,
    pc: vm.pc,
    rounds: () => new BigUint64Array(vm.memory.buffer, vm.ram + 0x28_0000, 1)[0], // guest-vm.bin's ROUNDS
  };
}

type Guest = { run(n: number): number; pc(): bigint; rounds(): bigint };

/** Cold and warm MIPS for one guest; sample names are `<name>_cold` and `<name>`. */
async function mipsOf(o: Options, name: string, guest: string, g: Guest): Promise<Sample[]> {
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
  o.log?.(`${name}: ${warm.map((x) => x.toFixed(1)).join(' ')} MIPS, ${g.rounds()} guest rounds`);
  if (g.rounds() === 0n) throw new Error('guest made no progress');
  const params = { guest, chunk };
  return [
    { name: `${name}_cold`, unit: 'MIPS', params: { ...params, chunk: 2_000_000 }, samples: cold },
    { name, unit: 'MIPS', params, samples: warm },
  ];
}

const interpMips = async (o: Options) => mipsOf(o, 'interp_mips', 'bench/interp/guest.c', await setup('guest.bin'));
const interpFpMips = async (o: Options) => mipsOf(o, 'interp_fp_mips', 'bench/interp/guest-fp.c', await setup('guest-fp.bin'));
const vmFlatMips = async (o: Options) => mipsOf(o, 'vm_flat_mips', 'bench/interp/guest.c EL1 MMU off', await setupVm(false));
const vmMmuMips = async (o: Options) => mipsOf(o, 'vm_mmu_mips', 'bench/interp/guest.c EL1 MMU on', await setupVm(true));

export const suite = { interp_mips: interpMips, interp_fp_mips: interpFpMips, vm_flat_mips: vmFlatMips, vm_mmu_mips: vmMmuMips };
export const runAll = async (o: Options) => [...(await interpMips(o)), ...(await interpFpMips(o)), ...(await vmFlatMips(o)), ...(await vmMmuMips(o))];
