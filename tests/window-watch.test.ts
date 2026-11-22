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
