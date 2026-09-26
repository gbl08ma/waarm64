// Interpreter MIPS baselines: the integer guest (guest.c, M1) and the FP/NEON
// guest (guest-fp.c, M2) on the wasm core, through the ABI a vCPU worker uses. Runs in a browser worker (bench/run.ts
// --page bench/interp/index.html) and in Node (tests/core-wasm.test.ts).
// M4: the integer guest again in a whole VM through vm_run, at EL1 with the MMU off and on (vm-start.S).
// M5: each of them again through the JIT (`jit_*`, `VmConfig.jit`), with the JIT's counters in the params.
import type { Options, Sample } from '../spike/benchmarks.ts';
import { ABI, bootVm, coreImports } from '../../web/vm.ts';

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
  jit_new(threshold: number, batch: number, capacity: number, check: number): number;
  jit_run(v: number, mem: number, n: bigint): bigint;
  jit_stats(v: number): number;
};

/** What the JIT did so far (`jit::Stats`, `vm::Counters`); steps are all steps, jitSteps those in JIT code. */
type JitCounts = { steps: number; jitSteps: number; dispatches: number; blocks: number; modules: number; bytes: number; compileNs: number; inline: number; helpers: number; inlineSteps: number; flagsStored: number; flagsElided: number; condDirect: number; condComputed: number; condMemory: number; regionBlocks: number };

/** jit_new's arguments: threshold, batch, capacity, stale-code check. */
export type JitConfig = [number, number, number, number];
/** The JIT's default policy (`jit::Config::DEFAULT`) and JIT-stress (`jit::Config::STRESS`). */
export const JIT_DEFAULT: JitConfig = [50, 32, 16384, 0];
export const JIT_STRESS: JitConfig = [0, 1, 4, 1];

/**
 * Instantiates the core, loads a guest into RAM placed after the core's state
 * (layout A); with `jit` (jit_new's arguments), runs it through the JIT.
 */
export async function setup(bin = 'guest.bin', jit?: JitConfig) {
  const wasm = await load('../../target/wasm32-unknown-unknown/release/webpc_core.wasm');
  const memory = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
  const imports = coreImports(memory);
  const { instance } = await WebAssembly.instantiate(wasm, imports);
  imports.jit.bind(instance);
  const ex = instance.exports as unknown as Exports;
  if (ex.abi_version() !== ABI) throw new Error(`core ABI ${ex.abi_version()}, expected ${ABI}`);
  const cpu = jit ? ex.jit_new(...jit) : ex.vcpu_new();
  const base = memory.grow(RAM / 65536) * 65536;
  const guest = await load(bin);
  new Uint8Array(memory.buffer, base + LOAD, guest.length).set(guest);
  const mem = ex.mem_new(base, BigInt(RAM));
  const u64 = (addr: number) => new BigUint64Array(memory.buffer, addr, 1);
  u64(cpu + 256)[0] = BigInt(LOAD); // PC
  let steps = 0;
  return {
    memory, cpu, base, ex,
    run: (n: number) => {
      const done = Number(jit ? ex.jit_run(cpu, mem, BigInt(n)) : ex.interp_run(cpu, mem, BigInt(n)));
      steps += done;
      return done;
    },
    pc: () => u64(cpu + 256)[0],
    rounds: () => u64(base + ROUNDS)[0],
    counts: jit ? (): JitCounts => {
      const [blocks, modules, bytes, compileNs, jitSteps, dispatches, , , inline, helpers, inlineSteps, flagsStored, flagsElided, condDirect, condComputed, condMemory, regionBlocks] = [...new BigUint64Array(memory.buffer, ex.jit_stats(cpu), 17)].map(Number);
      return { steps, jitSteps, dispatches, blocks, modules, bytes, compileNs, inline, helpers, inlineSteps, flagsStored, flagsElided, condDirect, condComputed, condMemory, regionBlocks };
    } : undefined,
  };
}

/** guest-vm.bin at EL1 in a whole VM, entered through vm-start.bin (at RAM + 2 MiB, as `bootVm` places a kernel). */
export async function setupVm(mmu: boolean, jit: 0 | 1 | 2 = 0) {
  const [wasm, start, guest] = await Promise.all([load('../../target/wasm32-unknown-unknown/release/webpc_core.wasm'), load('vm-start.bin'), load('guest-vm.bin')]);
  const kernel = new Uint8Array(0x10000 + guest.length);
  kernel.set(start);
  kernel.set(guest, 0x10000);
  const vm = await bootVm(wasm, { ramSize: RAM, kernel, cmdline: '', jit });
  new BigUint64Array(vm.memory.buffer, vm.cpu + 8, 1)[0] = mmu ? 1n : 0n; // x1
  return {
    vm,
    run: (n: number) => vm.run(n).steps,
    pc: vm.pc,
    rounds: () => new BigUint64Array(vm.memory.buffer, vm.ram + 0x28_0000, 1)[0], // guest-vm.bin's ROUNDS
    counts: jit ? (): JitCounts => {
      const s = vm.stats();
      const j = s.jit;
      return { ...j, steps: s.steps, jitSteps: j.steps };
    } : undefined,
  };
}

type Guest = { run(n: number): number; pc(): bigint; rounds(): bigint; counts?: () => JitCounts };

/** The JIT's counters over a window (between two `counts()`). */
function jitParams(a: JitCounts, b: JitCounts) {
  const steps = b.steps - a.steps, jit = b.jitSteps - a.jitSteps, d = b.dispatches - a.dispatches;
  return {
    dispatchesPerInsn: +(d / steps).toFixed(4), avgBlock: +(jit / d).toFixed(2), interpretedPct: +((100 * (steps - jit)) / steps).toFixed(3),
    blocks: b.blocks - a.blocks, modules: b.modules - a.modules, bytes: b.bytes - a.bytes, compileMs: +((b.compileNs - a.compileNs) / 1e6).toFixed(2),
    // Inline share of the instructions compiled (static, so far) and of those run in JIT code (dynamic, this window).
    inlinePct: +((100 * b.inline) / (b.inline + b.helpers)).toFixed(2), inlineStepsPct: +((100 * (b.inlineSteps - a.inlineSteps)) / jit).toFixed(2),
    // Static, so far: lazy flag setters whose NZCV is never stored; conditions by where they come from.
    flagsElided: b.flagsElided, flagsStored: b.flagsStored, condDirect: b.condDirect, condComputed: b.condComputed, condMemory: b.condMemory,
    // Blocks per region (static, so far; step 8).
    blocksPerRegion: +(b.regionBlocks / b.blocks).toFixed(2),
  };
}

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
  const zero: JitCounts = { steps: 0, jitSteps: 0, dispatches: 0, blocks: 0, modules: 0, bytes: 0, compileNs: 0, inline: 0, helpers: 0, inlineSteps: 0, flagsStored: 0, flagsElided: 0, condDirect: 0, condComputed: 0, condMemory: 0, regionBlocks: 0 };
  const cold = [mips(2_000_000)];
  const c1 = g.counts?.();
  for (let i = 0; i < 3; i++) mips(chunk);
  const c2 = g.counts?.();
  const warm = Array.from({ length: o.quick ? 5 : 15 }, () => mips(chunk));
  const c3 = g.counts?.();
  const jc = c1 && c2 && c3 ? { cold: jitParams(zero, c1), warm: jitParams(c2, c3) } : undefined;
  o.log?.(`${name}: ${warm.map((x) => x.toFixed(1)).join(' ')} MIPS, ${g.rounds()} guest rounds${jc ? ` ${JSON.stringify(jc)}` : ''}`);
  if (g.rounds() === 0n) throw new Error('guest made no progress');
  const params = { guest, chunk };
  return [
    { name: `${name}_cold`, unit: 'MIPS', params: { ...params, chunk: 2_000_000, ...(jc && { jit: jc.cold }) }, samples: cold },
    { name, unit: 'MIPS', params: { ...params, ...(jc && { jit: jc.warm }) }, samples: warm },
  ];
}

const interpMips = async (o: Options) => mipsOf(o, 'interp_mips', 'bench/interp/guest.c', await setup('guest.bin'));
const interpFpMips = async (o: Options) => mipsOf(o, 'interp_fp_mips', 'bench/interp/guest-fp.c', await setup('guest-fp.bin'));
const vmFlatMips = async (o: Options) => mipsOf(o, 'vm_flat_mips', 'bench/interp/guest.c EL1 MMU off', await setupVm(false));
const vmMmuMips = async (o: Options) => mipsOf(o, 'vm_mmu_mips', 'bench/interp/guest.c EL1 MMU on', await setupVm(true));
const jitMips = async (o: Options) => mipsOf(o, 'jit_mips', 'bench/interp/guest.c', await setup('guest.bin', JIT_DEFAULT));
const jitFpMips = async (o: Options) => mipsOf(o, 'jit_fp_mips', 'bench/interp/guest-fp.c', await setup('guest-fp.bin', JIT_DEFAULT));
const vmJitFlatMips = async (o: Options) => mipsOf(o, 'vm_jit_flat_mips', 'bench/interp/guest.c EL1 MMU off', await setupVm(false, 1));
const vmJitMmuMips = async (o: Options) => mipsOf(o, 'vm_jit_mmu_mips', 'bench/interp/guest.c EL1 MMU on', await setupVm(true, 1));

export const suite = {
  interp_mips: interpMips, interp_fp_mips: interpFpMips, vm_flat_mips: vmFlatMips, vm_mmu_mips: vmMmuMips,
  jit_mips: jitMips, jit_fp_mips: jitFpMips, vm_jit_flat_mips: vmJitFlatMips, vm_jit_mmu_mips: vmJitMmuMips,
};
export const runAll = async (o: Options) => {
  const out = [];
  for (const b of Object.values(suite)) out.push(...(await b(o)));
  return out;
};
