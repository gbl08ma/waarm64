// The page's memory signal (web/app/memory.ts; docs/jit.md "The page's memory signal"): the estimate's parts, a flushed
// epoch counted until V8 can have collected it, and the mark a running machine leaves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALIVE_STALE_MS, clearAlive, DEAD_MS, estimate, JIT_CODE_PER_BYTE, JIT_META_PER_BYTE, JIT_PER_MODULE, lastCrash, markAlive, Signal, type HostUse } from '../web/app/memory.ts';

const MiB = 2 ** 20;
const use = (o: Partial<HostUse> = {}): HostUse => ({ ramBytes: 2048 * MiB, heapLive: 100 * MiB, heapPeak: 200 * MiB, jitLiveBytes: 100 * MiB, jitModules: 1000, jitBudget: 320 * MiB, jitEpochs: 0, jitLimit: 0, ...o });

test('the estimate: RAM whole, the heap at its high-water mark, the JIT at V8\'s factors, the rest of the tab', () => {
  const { bytes, parts } = estimate(use(), 4);
  assert.equal(parts.ram, 2048 * MiB);
  assert.equal(parts.heap, 200 * MiB);
  assert.equal(parts.jit, 100 * MiB * (JIT_CODE_PER_BYTE + JIT_META_PER_BYTE) + 1000 * JIT_PER_MODULE);
  assert.equal(bytes, parts.ram + parts.heap + parts.jit + parts.base);
  assert.ok(estimate(use(), 8).bytes > bytes, 'more vCPUs, more');
});

test('a flushed epoch counts until V8 can have collected it; the peak stays', () => {
  const s = new Signal();
  const before = s.update(use({ jitLiveBytes: 300 * MiB, jitModules: 9000 }), 4, 0);
  const after = s.update(use({ jitLiveBytes: 0, jitModules: 0, jitEpochs: 1 }), 4, 1000);
  assert.equal(after, before, 'right after the flush: the old code is still there');
  const later = s.update(use({ jitLiveBytes: 0, jitModules: 0, jitEpochs: 1 }), 4, 1000 + DEAD_MS);
  assert.equal(later, estimate(use({ jitLiveBytes: 0, jitModules: 0 }), 4).bytes);
  assert.equal(s.peak, before);
});

test('a running machine\'s mark: renewed, cleared at a clean stop, and found stale after its tab went away', () => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  const a = { name: 'M', ramMiB: 2048, ncpus: 4, jitMiB: 320, gib: 4.5, peakGiB: 5, t: 1_000_000 };
  markAlive('m1', a);
  assert.equal(lastCrash('m1', a.t + 1000), undefined, 'a tab renews it');
  assert.deepEqual(lastCrash('m1', a.t + ALIVE_STALE_MS + 1), a);
  clearAlive('m1');
  assert.equal(lastCrash('m1', a.t + ALIVE_STALE_MS + 1), undefined);
  // Storage that throws: no mark, no error.
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
  markAlive('m1', a);
  clearAlive('m1');
  assert.equal(lastCrash('m1'), undefined);
  delete (globalThis as { localStorage?: unknown }).localStorage;
});
