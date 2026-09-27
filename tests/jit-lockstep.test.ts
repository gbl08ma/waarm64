// JIT vs interpreter lockstep (PLAN.md §4 item 4): the same guest on an
// interpreter-only core and on a JIT core (two instances, two memories),
// comparing the registers (`cpu::Cpu`) and a RAM checksum after every chunk.
// CI-sized; `WEBPC_LOCKSTEP_STEPS=300000000 node --test tests/jit-lockstep.test.ts`
// runs every guest that long (stress runs a tenth of it: it compiles on most dispatches).
// Needs the wasm build (scripts/ci.sh).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JIT_DEFAULT, JIT_STRESS, setup, setupVm } from '../bench/interp/suite.ts';

const STEPS = Number(process.env.WEBPC_LOCKSTEP_STEPS ?? 20_000_000);
const RAM = 16 << 20; // bench/interp/suite.ts
const CPU_BYTES = 1072; // size_of::<cpu::Cpu>()

type Side = { run(n: number): number; memory: WebAssembly.Memory; cpu: number; ram: number };

/** FNV-1a over 32-bit words of guest RAM. */
function checksum(m: WebAssembly.Memory, ram: number) {
  const w = new Uint32Array(m.buffer, ram, RAM / 4);
  let h = 0x811c9dc5;
  for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w[i], 0x01000193);
  return h >>> 0;
}

function lockstep(a: Side, b: Side, steps: number, chunk: number) {
  for (let done = 0; done < steps; done += chunk) {
    const [ka, kb] = [a.run(chunk), b.run(chunk)];
    const ca = new Uint8Array(a.memory.buffer, a.cpu, CPU_BYTES), cb = new Uint8Array(b.memory.buffer, b.cpu, CPU_BYTES);
    const k = ca.findIndex((x, i) => x !== cb[i]);
    assert.ok(ka === kb && k < 0, `after ${done} + ${ka}/${kb} steps: Cpu byte ${k} differs`);
    assert.equal(checksum(b.memory, b.ram), checksum(a.memory, a.ram), `after ${done + ka} steps: RAM differs`);
  }
}

for (const [bin, what] of [['guest.bin', 'integer'], ['guest-fp.bin', 'FP/NEON']]) {
  for (const [mode, jit, steps] of [['JIT', JIT_DEFAULT, STEPS], ['JIT-stress', JIT_STRESS, STEPS / 10]] as const) {
    test(`lockstep: ${what} guest, user mode, ${mode}`, async () => {
      const [a, b] = [await setup(bin), await setup(bin, jit)];
      lockstep({ ...a, ram: a.base }, { ...b, ram: b.base }, steps, 100_000);
      const c = b.counts!();
      assert.ok(c.jitSteps > (mode === 'JIT' ? steps / 2 : 0), `${c.jitSteps} of ${steps} steps in JIT code`);
    });
  }
}

for (const mmu of [false, true]) {
  for (const [mode, jit, steps] of [['JIT', 1, STEPS], ['JIT-stress', 2, STEPS / 10]] as const) {
    test(`lockstep: integer guest at EL1, MMU ${mmu ? 'on' : 'off'}, ${mode}`, async () => {
      const [a, b] = [await setupVm(mmu), await setupVm(mmu, jit)];
      lockstep({ ...a.vm, ...a }, { ...b.vm, ...b }, steps, 100_000);
      const s = b.vm.stats();
      assert.ok(s.jit.steps > (mode === 'JIT' ? steps / 2 : 0), `${s.jit.steps} of ${steps} steps in JIT code`);
      if (mode === 'JIT-stress') assert.ok(s.jit.flushes > 0, 'the stress cache never flushed');
    });
  }
}
