// Many core instances on one shared memory in Node's worker_threads (M7 loop 1,
// docs/abi.md "Many core instances on one memory"; tests/threads-run.ts has the
// check, tests/browser.test.ts runs it in Chromium). Needs the wasm build.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { clockOffset } from '../web/vm.ts';
import { threadsRun, type Spawn } from './threads-run.ts';
import type { Result } from './threads-worker.ts';

const WASM = readFileSync(new URL('../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url));
const GUEST = readFileSync(new URL('../bench/interp/guest.bin', import.meta.url));
const N = 30_000_000;

const spawn: Spawn = () => {
  const w = new Worker(new URL('./threads-worker.ts', import.meta.url));
  return {
    run: (job) => new Promise<Result>((resolve, reject) => {
      w.once('message', (m: Result & { error?: string }) => (m.error ? reject(new Error(m.error)) : resolve(m)));
      w.once('error', reject);
      w.postMessage(job);
    }),
    close: () => void w.terminate(),
  };
};

test('three core instances run guests concurrently on one memory, interpreter and JIT', async () => {
  const r = await threadsRun(WASM, GUEST, spawn, N);
  assert.equal(r.reference, N);
  for (const c of r.checks) {
    console.log(`# ${c.what}: ${c.done} steps in ${c.ms.toFixed(0)} ms`);
    assert.deepEqual({ done: c.done, tls: c.tls, registers: c.registers, ram: c.ram }, { done: N, tls: 1, registers: true, ram: true }, c.what);
  }
});

// A vCPU worker's clock is the VM creator's, measured by round trips (web/vm.ts
// `clockOffset`; M7 loop 8: Chromium's per-context timeOrigin had drifted
// seconds apart). Here the other side's clock runs 2 s ahead of this thread's
// and answers after a varying delay, split unevenly around its reading: the
// estimate lands within the shortest round trip's half, whatever the delays.
// That half is the bound, taken from the round trips as they ran (plus 0.1 ms
// for the awaits around them), not from the delays asked for: a loaded host
// that preempts the spin of the 0.2 ms round makes the 1 ms round the fastest,
// 0.25 ms off and right (a fixed 0.2 ms bound failed so under scripts/ci.sh,
// 2026-10-18). Picking any round but the fastest, or averaging, is 0.5 ms off
// or more. The second case preempts the fastest round on purpose.
test('clockOffset finds another clock through its fastest round trip', async () => {
  const skew = 2000;
  const spin = (ms: number) => { for (const t = performance.now(); performance.now() - t < ms;); };
  for (const preempt of [0, 5]) {
    const delays = [3, 1, 0.2, 4, 2];
    let i = 0;
    let fastest = Infinity;
    const ask = async () => {
      const d = delays[i++ % delays.length];
      const t0 = performance.now();
      spin(d / 4);
      const t = performance.timeOrigin + performance.now() + skew;
      spin((3 * d) / 4 + (d === 0.2 ? preempt : 0));
      fastest = Math.min(fastest, performance.now() - t0);
      return t;
    };
    const clock = await clockOffset(ask, 10);
    const err = clock - (performance.timeOrigin + skew);
    assert.ok(Math.abs(err) < fastest / 2 + 0.1, `off by ${err} ms, the fastest round trip ${fastest.toFixed(3)} ms (preempted ${preempt} ms)`);
    if (preempt) assert.ok(fastest >= 1, 'the preempted round was the fastest');
  }
});
