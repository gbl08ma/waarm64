// web/display.ts's scan for the rows that changed (the drawing itself is in tests/browser.test.ts).
import assert from 'node:assert/strict';
import test from 'node:test';
import { changedRows } from '../web/display.ts';

test('changedRows finds the first and last changed rows', () => {
  assert.deepEqual(changedRows(10, () => false), [0, 0]);
  assert.deepEqual(changedRows(10, (y) => y === 3 || y === 7), [3, 8]);
  assert.deepEqual(changedRows(10, (y) => y === 9), [9, 10]);
});

test('changedRows ends when the guest changes a row back between the two scans', () => {
  // Row 4 differs when the scan from the top reads it, and no longer when the scan from the bottom would.
  let reads = 0;
  // (The scan once ran on past row 0 for good: the check makes that a failure, not a hang.)
  const changed = (y: number) => {
    assert.ok(y >= 0, `row ${y} scanned`);
    return y === 4 && reads++ === 0;
  };
  assert.deepEqual(changedRows(10, changed), [4, 5]);
});
