// The per-vCPU liveness block (web/liveness.ts): the writer's bookkeeping against a fake clock,
// and a real parallel run (bare-metal smp.bin, 4 vCPUs, JIT) whose workers fill it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { livenessWriter, newLiveness, readLiveness } from '../web/liveness.ts';
import { runToPowerOff, type Vm } from '../web/vm.ts';

test('a chunk, its host work and a stall in progress', () => {
  let t = 1000;
  const block = newLiveness(2);
  const w0 = livenessWriter(block, 0, () => t);
  w0.enter();
  t += 30;
  w0.leave();
  t += 5;
  w0.handled();
  w0.enter();
  t += 12;
  w0.leave();
  t += 2;
  w0.handled();
  w0.enter(); // stuck inside the third chunk
  t += 2500;
  const [a, b] = readLiveness(block, () => t);
  assert.deepEqual([a.chunks, a.maxRunMs, a.maxRunAt, a.maxHostMs, a.maxHostAt, a.runningMs], [2, 30, 1030, 5, 1030, 2500]);
  assert.equal(a.sinceReturnMs, 2500 + 2);
  assert.deepEqual([b.chunks, b.runningMs, b.sinceReturnMs, b.maxRunMs], [0, 0, 0, 0]); // vCPU 1 never ran
});

test('parallel: every vCPU worker reports its chunks', async () => {
  let vm: Vm | undefined;
  const wasm = readFileSync(new URL('../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url));
  const kernel = readFileSync(new URL('baremetal/smp.bin', import.meta.url));
  await runToPowerOff(wasm, { ramSize: 16 << 20, kernel, kernelOffset: 0, cmdline: '', ncpus: 4, parallel: true, realtime: true, idleLimitMs: 30_000, jit: 1 }, 1e12, (v) => { vm = v; });
  const live = vm!.liveness();
  assert.equal(live.length, 4);
  for (const l of live) {
    assert.ok(l.chunks > 0, `vCPU ${l.cpu} ran no chunk`);
    assert.ok(l.maxRunMs > 0 && l.maxRunMs < 10_000, `vCPU ${l.cpu}'s longest chunk: ${l.maxRunMs} ms`);
  }
});
