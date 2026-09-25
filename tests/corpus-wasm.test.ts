// The golden corpus on the wasm core in Node (V8), the counterpart of the
// native comparator in core/tests/corpus.rs. Host float behavior is where the
// native and wasm builds could diverge. Needs the wasm build (scripts/ci.sh).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { coreImports } from '../web/vm.ts';
import { CODE, DATA, DATA_SIZE, REGS, initialState, parseFile } from '../tools/corpus/corpus.ts';

const WASM = new URL('../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url);
const DIR = new URL('corpus/', import.meta.url);
const RAM = Number(DATA) + DATA_SIZE;
const BRK_END = 0xd4200000;

type Exports = {
  vcpu_new(): number;
  mem_new(base: number, size: bigint): number;
  interp_run_exit(cpu: number, mem: number, n: bigint, exit: number): bigint;
};

/** Byte offset of each REGS slot in cpu::Cpu (x0..x30, sp, then nzcv, fpcr, fpsr, v0..v31). */
function offset(name: string): number {
  if (name === 'sp') return 248;
  if (name === 'nzcv') return 264;
  if (name === 'fpcr') return 816;
  if (name === 'fpsr') return 824;
  if (name[0] === 'v') return 304 + 16 * Number(name.slice(1));
  return 8 * Number(name.slice(1));
}

test('golden corpus on the wasm core', () => {
  const memory = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
  const mod = new WebAssembly.Module(readFileSync(WASM));
  const ex = new WebAssembly.Instance(mod, coreImports(memory)).exports as unknown as Exports;
  const cpu = ex.vcpu_new();
  const exit = ex.vcpu_new(); // any 16 aligned bytes the core won't touch otherwise
  const base = memory.grow(Math.ceil(RAM / 65536)) * 65536;
  const mem = ex.mem_new(base, BigInt(RAM));
  const bytes = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const M64 = (1n << 64n) - 1n;
  const get = (name: string) =>
    name[0] === 'v'
      ? dv.getBigUint64(cpu + offset(name), true) | (dv.getBigUint64(cpu + offset(name) + 8, true) << 64n)
      : dv.getBigUint64(cpu + offset(name), true);
  const set = (name: string, v: bigint) => {
    dv.setBigUint64(cpu + offset(name), v & M64, true);
    if (name[0] === 'v') dv.setBigUint64(cpu + offset(name) + 8, v >> 64n, true);
  };

  let total = 0;
  const failures: string[] = [];
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.txt')).sort()) {
    for (const t of parseFile(readFileSync(new URL(file, DIR), 'utf8')).tests) {
      total++;
      const init = initialState(t);
      const code = base + Number(CODE);
      bytes.fill(0, code, code + 4096);
      [...t.code, BRK_END].forEach((w, k) => dv.setUint32(code + 4 * k, w, true));
      bytes.set(init.mem, base + Number(DATA));
      REGS.forEach((r, i) => set(r, init.regs[i]));
      dv.setBigUint64(cpu + 256, CODE, true); // PC
      ex.interp_run_exit(cpu, mem, 1000n, exit);

      const [kind, val] = [dv.getBigUint64(exit, true), dv.getBigUint64(exit + 8, true)];
      const pc = dv.getBigUint64(cpu + 256, true);
      const off = pc - CODE;
      const end = off === BigInt(4 * t.code.length);
      const got =
        kind === 6n && end ? 'end'
        : kind === 6n ? `sigtrap pc=+${off} code=1`
        : kind === 1n ? `sigill pc=+${off} code=1`
        : kind === 4n ? `sigbus pc=+${off} code=1 addr=0x${val.toString(16)}`
        : kind === 3n ? `sigsegv pc=+${off} code=1 addr=0x${val.toString(16)}`
        : `exit kind ${kind} (${val}) pc=+${off}`;
      const errs: string[] = [];
      if (got !== t.exit) errs.push(`exit: got ${got}, want ${t.exit}`);
      REGS.forEach((r, i) => {
        const want = t.out?.get(r) ?? init.regs[i];
        const v = get(r);
        if (v !== want) errs.push(`${r}: got 0x${v.toString(16)}, want 0x${want.toString(16)}`);
      });
      const wantMem = init.mem.slice();
      for (const [a, b] of t.mem ?? []) wantMem.set(b, Number(a - DATA));
      const data = bytes.subarray(base + Number(DATA), base + Number(DATA) + DATA_SIZE);
      const k = data.findIndex((b, i) => b !== wantMem[i]);
      if (k >= 0) errs.push(`mem 0x${(DATA + BigInt(k)).toString(16)}: got ${data[k]}, want ${wantMem[k]}`);
      if (errs.length) failures.push(`${t.name}: ${errs.join('; ')}`);
    }
  }
  assert.ok(total > 30_000, `only ${total} corpus tests`);
  assert.deepEqual(failures.slice(0, 20), [], `${failures.length} of ${total} failed`);
});
