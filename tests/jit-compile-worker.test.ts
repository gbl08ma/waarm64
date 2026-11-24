// The JIT's compile worker (web/jit-compile-worker.ts, docs/jit.md "Sharing"): the word it publishes is the
// number up to which every module is compiled, whatever order the vCPUs' modules arrive in.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompileStat, compileStats, readyBucket, readyQuantile } from '../web/counters.ts';
import { compiler } from '../web/jit-compile-worker.ts';

const EMPTY = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]).buffer;

test('compile worker: the ready word counts the modules compiled without a gap', () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const ready = new Uint32Array(memory.buffer, 64, 1);
  const c = compiler(memory);
  const job = (seq: number, bytes = EMPTY.slice(0)) => c.job({ seq, epoch: 0, ready: 64, bytes });
  job(2);
  assert.equal(ready[0], 0, 'module 1 isn\'t compiled yet');
  job(1);
  assert.equal(ready[0], 2);
  job(4);
  job(3, new Uint8Array([1, 2, 3]).buffer); // not wasm: compiled (failed) all the same, the table reports it
  assert.equal(ready[0], 4);
  assert.deepEqual(c.stats(), { compiled: 4, failed: 1, ms: c.stats().ms, kept: 4 });
  c.job({ seq: 5, epoch: 1, ready: 64, bytes: EMPTY.slice(0) }); // a flush: the old epoch's modules are let go
  assert.equal(ready[0], 5);
  assert.equal(c.stats().kept, 1);
});

test('compile worker: each compiled module goes to every vCPU before the ready word counts it', () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const ready = new Uint32Array(memory.buffer, 64, 1);
  const got: { port: number; seq: number; module: boolean; ready: number }[] = [];
  const ports = [0, 1].map((port) => ({ postMessage: (m: { seq: number; module?: WebAssembly.Module }) => got.push({ port, seq: m.seq, module: m.module instanceof WebAssembly.Module, ready: ready[0] }) }));
  const c = compiler(memory, ports);
  c.job({ seq: 1, epoch: 0, ready: 64, bytes: EMPTY.slice(0) });
  c.job({ seq: 2, epoch: 0, ready: 64, bytes: new Uint8Array([1, 2, 3]).buffer }); // not wasm: no module, the table compiles it
  assert.deepEqual(got, [
    { port: 0, seq: 1, module: true, ready: 0 }, { port: 1, seq: 1, module: true, ready: 0 },
    { port: 0, seq: 2, module: false, ready: 1 }, { port: 1, seq: 2, module: false, ready: 1 },
  ]);
  assert.equal(ready[0], 2);
});

// PERF loop 56 (docs/host-code.md: no allocation per event on hot paths): the view of the core's memory that the
// ready word is stored through is made once, and again only after the memory grew.
test('compile worker: no view of the memory made per module', () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
  const ready = new Uint32Array(memory.buffer, 64, 1);
  const c = compiler(memory, []);
  const Real = globalThis.Uint32Array;
  let made = 0;
  globalThis.Uint32Array = new Proxy(Real, {
    construct(t, args) {
      made++;
      return Reflect.construct(t, args);
    },
  });
  try {
    for (let seq = 1; seq <= 20; seq++) c.job({ seq, epoch: 0, ready: 64, bytes: EMPTY.slice(0) });
    assert.ok(made <= 1, `${made} views for 20 modules`);
    assert.equal(ready[0], 20);
    // Grown: a word past the old size is reached through a new view.
    memory.grow(1);
    c.job({ seq: 21, epoch: 0, ready: 65536 + 64, bytes: EMPTY.slice(0) });
    assert.equal(new Real(memory.buffer)[(65536 + 64) / 4], 21);
  } finally {
    globalThis.Uint32Array = Real;
  }
});

// The counters the paired A/B's `smp` workload prints (web/counters.ts `CompileStat`): a module's delay runs from its
// emission to the ready word reaching it, so a module compiled before an earlier one waits for that one too.
test('compile worker: the delay buckets, and the bound of a quantile', () => {
  assert.deepEqual([0, 0.99, 1, 1.5, 2, 3.9, 4, 600, 1023, 1024, 1e6].map(readyBucket), [0, 0, 1, 1, 2, 2, 3, 10, 10, 11, 11]);
  // 90 under 1 ms, 9 in [4, 8), one at 1024 ms or more.
  const hist = [90, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0, 1];
  assert.equal(readyQuantile(hist, 0.5), 1);
  assert.equal(readyQuantile(hist, 0.9), 1);
  assert.equal(readyQuantile(hist, 0.95), 8);
  assert.equal(readyQuantile(hist, 0.99), 8);
  assert.equal(readyQuantile(hist, 1), 2048);
  assert.equal(readyQuantile(new Array(12).fill(0), 0.5), 0);
});

test('compile worker: the delay from emission to ready, and the time busy', () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const block = new Float64Array(CompileStat.LEN);
  const c = compiler(memory, [], block);
  const ago = (ms: number) => performance.timeOrigin + performance.now() - ms;
  c.job({ seq: 2, epoch: 0, ready: 64, bytes: EMPTY.slice(0), t: ago(50) });
  assert.equal(block[CompileStat.READY], 0, 'module 2 is compiled, not ready: module 1 isn\'t');
  assert.equal(block[CompileStat.COMPILED], 1);
  c.job({ seq: 1, epoch: 0, ready: 64, bytes: EMPTY.slice(0), t: ago(200) });
  const s = compileStats(block);
  assert.equal(s.ready, 2);
  assert.ok(s.readyMaxMs >= 200 && s.readyMaxMs < 10_000, `${s.readyMaxMs}`);
  assert.ok(s.readySumMs >= 250 && s.readySumMs <= 2 * s.readyMaxMs, `${s.readySumMs}`);
  // 50 ms and more (under 10 s): [32, 64) or above; 200 ms: [128, 256) or above, the two in different buckets.
  const at = s.readyHist.flatMap((n, k) => Array(n).fill(k));
  assert.equal(at.length, 2);
  assert.ok(at[0] >= readyBucket(50) && at[1] >= readyBucket(200) && at[0] < at[1], `${s.readyHist}`);
  c.job({ seq: 3, epoch: 0, ready: 64, bytes: EMPTY.slice(0) }); // no emission time: compiled, not timed
  assert.equal(compileStats(block).ready, 2);
  assert.equal(compileStats(block).compiled, 3);
  assert.ok(s.busyMs > 0 && s.busyMs < 10_000);
});
