// The host-visible window's write-watch in wasm (docs/devices.md "virtio-gpu"): tests/baremetal/watch.c stores to
// chosen window pages in hot loops, phase by phase, and the host's look (web/window.ts) must report exactly those pages
// each time, under the interpreter, the block interpreter and the JIT (whose inline stores reach a watched page's
// write entry only until it is dropped). core/tests/baremetal.rs `window_watch` runs it natively, in parallel mode too.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { bootVm } from '../web/vm.ts';
import { Exit } from '../web/core.ts';
import { Counter } from '../web/counters.ts';
import { Worker } from 'node:worker_threads';
import { WindowWatch } from '../web/window.ts';

const wasm = readFileSync(new URL('../target/wasm32-unknown-unknown/release/waarm64_core.wasm', import.meta.url));
const kernel = readFileSync(new URL('baremetal/watch.bin', import.meta.url));
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, k) => a + k);
// Phase 6 overflows a vCPU's 64 records; phase 7 is wide, pair and vector stores across pages, DC ZVA and the rest.
const PHASES = [[1, 2, 3], [5], [1], [3, 7, 8], [9, 10], range(20, 100), range(110, 121)];
const MAILBOX = 8 << 20; // from the start of RAM (watch.c)

for (const jit of [0, 4, 1] as const) {
  test(`the watch reports exactly the pages written between looks (jit ${jit})`, async () => {
    const vm = await bootVm(wasm, { ramSize: 16 << 20, window: 2 << 20, kernel, kernelOffset: 0, cmdline: '', jit });
    assert.ok(vm.watch, 'a window has a watch');
    assert.equal(vm.watch.pages, 512);
    const mb = new BigUint64Array(vm.memory.buffer, vm.ram + MAILBOX, 2);
    let n = 1;
    let r;
    for (let rounds = 0; rounds < 100_000; rounds++) {
      r = vm.run(100_000);
      if (r.kind !== Exit.BUDGET) break;
      if (mb[0] === BigInt(n)) {
        assert.deepEqual(vm.watch.take(), PHASES[n - 1], `phase ${n}`);
        mb[1] = BigInt(n);
        n++;
      }
    }
    assert.deepEqual([r?.kind, r?.x[1], n], [Exit.PSCI, 0n, PHASES.length + 1]);
    // Under the JIT the stores ran as compiled code: its inline path is what each look must have cut off.
    const jitSteps = Number(new BigUint64Array(vm.memory.buffer, vm.counters, Counter.LEN)[Counter.JIT_STEPS]);
    if (jit === 1) assert.ok(jitSteps > 100_000, `JIT steps ${jitSteps}`);
  });
}

// PERF loop 56: a vCPU in parallel SMP's polled code reaches its run loop's top (where it drops its write entries and
// acks the look) only when its chunk ends, which without `acc` no step count does: the look stores 0 in its stop word.
// Here a worker plays the vCPU, acking only once its stop word is 0, as compiled code at its poll would.
test("the watch's look stops a running vCPU's polled code, not waiting for its chunk to end", async () => {
  // core/src/mem.rs `Watch`: GEN, NCPUS, WORDS, PAGES, ACK[128], RUNNING[128], the bitmap; the stop word past it.
  const sab = new SharedArrayBuffer(8192);
  const w = new Int32Array(sab);
  const [ACK, RUNNING, STOP] = [4, 132, 1024];
  [w[1], w[2], w[3], w[RUNNING], w[STOP]] = [1, 1, 32, 1, 1];
  const vcpu = new Worker(
    `const { workerData: sab } = require('node:worker_threads');
     const w = new Int32Array(sab);
     for (;;) {
       if (Atomics.load(w, ${STOP}) === 0) {
         Atomics.store(w, ${STOP}, 1);
         Atomics.store(w, ${ACK}, Atomics.load(w, 0));
         Atomics.notify(w, ${ACK});
       }
       if (Atomics.load(w, 2000) !== 0) break;
     }`,
    { eval: true, workerData: sab },
  );
  try {
    const watch = new WindowWatch(sab, 0, [STOP * 4]);
    for (let r = 0; r < 5; r++) {
      const t0 = performance.now();
      const pages = watch.take(500);
      const ms = performance.now() - t0;
      assert.ok(ms < 50, `look ${r}: ${ms.toFixed(1)} ms`);
      assert.deepEqual(pages, [], `look ${r}: no page written (not every page, as after a timeout)`);
    }
  } finally {
    Atomics.store(w, 2000, 1);
    await vcpu.terminate();
  }
});
