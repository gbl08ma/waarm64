// A size as typed (web/app/size-input.ts, ui/SizeField.svelte's): a number and a binary unit to bytes and back, and
// what's wrong with one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bytesText } from '../web/app/bytes.ts';
import { convert, inUnits, sizeProblem, toBytes } from '../web/app/size-input.ts';

const MiB = 2 ** 20;
const GiB = 2 ** 30;
const TiB = 2 ** 40;

test('a size typed, in bytes: rounded up to a whole MiB (or what is asked), none for no number', () => {
  assert.equal(toBytes(64, 'MiB'), 64 * MiB);
  assert.equal(toBytes(1.5, 'GiB'), 1536 * MiB);
  assert.equal(toBytes(2, 'TiB'), 2 * TiB);
  assert.equal(toBytes(0.0001, 'GiB'), MiB, 'up to a whole MiB');
  assert.equal(toBytes(1.0001, 'MiB'), 2 * MiB);
  assert.equal(toBytes(1.5, 'MiB', 512), 1.5 * MiB, 'a sector');
  for (const none of [null, undefined, NaN, 0, -1, Infinity]) assert.equal(toBytes(none, 'GiB'), undefined, String(none));
});

test('a size in bytes, as typed: the largest unit it is a whole number of, else the largest it is one of', () => {
  assert.deepEqual(inUnits(GiB, ['MiB', 'GiB']), { amount: 1, unit: 'GiB' });
  assert.deepEqual(inUnits(1536 * MiB, ['MiB', 'GiB']), { amount: 1536, unit: 'MiB' });
  assert.deepEqual(inUnits(1536 * MiB + 512, ['MiB', 'GiB']), { amount: 1.5, unit: 'GiB' });
  assert.deepEqual(inUnits(256 * MiB, ['MiB', 'GiB']), { amount: 256, unit: 'MiB' });
  assert.deepEqual(inUnits(4 * TiB, ['MiB', 'GiB', 'TiB']), { amount: 4, unit: 'TiB' });
  assert.deepEqual(inUnits(4 * TiB, ['GiB', 'MiB']), { amount: 4096, unit: 'GiB' }, 'in any order');
  assert.deepEqual(inUnits(1000, ['MiB', 'GiB']), { amount: 0.001, unit: 'MiB' }, 'under the smallest');
  // Back to the same bytes.
  for (const b of [MiB, 64 * MiB, GiB, 1536 * MiB, 3 * GiB, 8 * TiB]) {
    const { amount, unit } = inUnits(b, ['MiB', 'GiB', 'TiB']);
    assert.equal(toBytes(amount, unit), b, String(b));
  }
});

test('a unit changed keeps the size, to three decimals', () => {
  assert.equal(convert(1536, 'MiB', 'GiB'), 1.5);
  assert.equal(convert(1.5, 'GiB', 'MiB'), 1536);
  assert.equal(convert(100, 'MiB', 'GiB'), 0.098);
  assert.equal(convert(2, 'TiB', 'GiB'), 2048);
});

test("what's wrong with a size: none, under its least, past its most", () => {
  assert.equal(sizeProblem(undefined, MiB), 'empty');
  assert.equal(sizeProblem(MiB, MiB, GiB), undefined, 'the least is allowed');
  assert.equal(sizeProblem(GiB, MiB, GiB), undefined, 'the most is allowed');
  assert.equal(sizeProblem(MiB, 2 * MiB), 'small');
  assert.equal(sizeProblem(GiB + MiB, MiB, GiB), 'large');
  assert.equal(sizeProblem(8 * TiB), undefined, 'no bounds');
});

test('a size in words reaches TiB (web/app/bytes.ts), as a size may be typed in them', () => {
  assert.equal(bytesText(1023 * GiB), '1023.0 GiB');
  assert.equal(bytesText(8 * TiB), '8.00 TiB');
  assert.equal(bytesText(12 * TiB), '12.0 TiB');
});
