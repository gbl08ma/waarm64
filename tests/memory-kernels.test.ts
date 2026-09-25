// M0.5 memory kernels: every layout/strategy must compute the same thing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VARIANTS, instantiate, seedFor, view } from '../bench/spike/memory/cost.ts';
import { hostOf, type Kernel } from '../bench/spike/memory/kernels.ts';

test('all memory layouts agree on a pointer chase (loads and stores)', () => {
  const ws = 1 << 20;
  for (const mixed of [false, true]) {
    const got = VARIANTS.map((v) => {
      const k = { ...v, pattern: 'chase', mixed } as Kernel;
      const seed = seedFor(k, ws);
      const [m, off] = hostOf(k, seed + 16n); // the first iteration's store (mixed only)
      view(m)[off / 8] = 0n;
      return [instantiate(k)(20_000, seed, BigInt(ws - 64)), view(m)[off / 8]];
    });
    assert.ok(got[0][0] !== 0n && (!mixed || got[0][1] !== 0n));
    for (const [i, s] of got.entries()) assert.deepEqual(s, got[0], `${JSON.stringify(VARIANTS[i])} mixed=${mixed}`);
  }
});
