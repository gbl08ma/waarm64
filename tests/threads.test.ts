// Many core instances on one shared memory in Node's worker_threads (M7 loop 1,
// docs/abi.md "Many core instances on one memory"; tests/threads-run.ts has the
// check, tests/browser.test.ts runs it in Chromium). Needs the wasm build.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
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
