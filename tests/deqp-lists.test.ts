// The dEQP tests' samples and slices of a pass list (tests/deqp-lists.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { phase, sample } from './deqp-lists.ts';

// A list like dEQP's: groups of different sizes, one shorter than the stride.
const list = [
  ...Array.from({ length: 50 }, (_, i) => `dEQP-GLES3.functional.shaders.loops.case_${i}`),
  ...Array.from({ length: 3 }, (_, i) => `dEQP-GLES3.functional.fbo.blit.case_${i}`),
  ...Array.from({ length: 21 }, (_, i) => `dEQP-GLES3.functional.texture.format.case_${i}`),
];
const group = (c: string) => c.split('.').slice(1, 4).join('.');

test('a sample takes every group, in the list\'s order, the same for a seed', () => {
  const s = sample(list, 8, 1234);
  assert.deepEqual(new Set(s.map(group)), new Set(list.map(group)));
  assert.deepEqual(s, list.filter((c) => s.includes(c)), 'in the list\'s order');
  assert.deepEqual(sample(list, 8, 1234), s);
  assert.ok(s.length >= 9 && s.length <= 12, `${s.length} cases`);
});

test('samples of different seeds cover the list', () => {
  const seen = new Set<string>();
  for (let seed = 0; seed < 64; seed++) for (const c of sample(list, 8, seed)) seen.add(c);
  assert.equal(seen.size, list.length);
});

test('the slices of a list are the list, cut at whole rounds', () => {
  const parts = [1, 2, 3].map((n) => phase(list, n, 3, 8));
  assert.deepEqual(parts.flat(), list);
  for (const p of parts.slice(0, -1)) assert.equal(p.length % 8, 0);
});
