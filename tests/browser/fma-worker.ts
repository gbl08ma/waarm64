// The FP guest (bench/interp/guest-fp.c: mostly FMA forms) in Chromium through both arms of the JIT's FMA, its modules
// reaching TurboFan: the same `Cpu`, step for step (docs/jit.md "Floating point").
import { JIT_DEFAULT, setup } from '../../bench/interp/suite.ts';
import { fusedFma } from '../../web/fma.ts';

const STEPS = 2_000_000_000, CPU_BYTES = 1168;

async function arm(fma: boolean) {
  const g = await setup('guest-fp.bin', JIT_DEFAULT, 0, fma);
  let steps = 0;
  while (steps < STEPS) {
    const done = g.run(STEPS - steps);
    if (!done) break;
    steps += done;
  }
  return { steps, bytes: g.counts!().bytes, cpu: new Uint8Array(g.memory.buffer, g.cpu, CPU_BYTES).slice() };
}

try {
  const [a, b] = [await arm(true), await arm(false)];
  postMessage({ fused: fusedFma(), same: a.cpu.every((x, i) => x === b.cpu[i]), steps: [a.steps, b.steps], bytes: [a.bytes, b.bytes] });
} catch (e) {
  postMessage({ error: String(e) });
}
