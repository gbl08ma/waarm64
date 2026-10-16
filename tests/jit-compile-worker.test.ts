// The JIT's compile worker (web/jit-compile-worker.ts, docs/jit.md "Sharing"): the word it publishes is the
// number up to which every module is compiled, whatever order the vCPUs' modules arrive in.
import assert from 'node:assert/strict';
import { test } from 'node:test';
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
