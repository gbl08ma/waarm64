// The RAM map's pure parts in Node: a pass over guest RAM (web/ram-scan.ts: pages with data, changed and cleared since
// the pass before, a surface's cells, a range page by page, RAM in several parts at their guest addresses), its looks
// and words (web/app/ram-look.ts) and its pacing (web/app/ram-source.ts). The window itself is
// tests/page-ram.test.ts's (Chromium).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paOf, RAM_PAGE, RamScan } from '../web/ram-scan.ts';
import { RANGE, UNIT, type Surface } from '../web/surface.ts';
import { paText, ramCellWords, ramDetailCounts, ramDetailLook, ramDetailWords, ramLegend, ramLookOf, ramWholeWords } from '../web/app/ram-look.ts';
import { ramDelay, RAM_POLL_MS } from '../web/app/ram-source.ts';
import { CORE, RIM, STEPS } from '../web/app/ui/block-grid.ts';

const MiB = 2 ** 20;
const per = RANGE / UNIT; // pages in a range
const RAM_BASE = 0x4000_0000;

/** RAM of `size` bytes on a shared buffer, `pad` bytes into it (as memory 0's RAM is), and its words. */
function ram(size: number, pad = 64 * 1024) {
  const buffer = new SharedArrayBuffer(pad + size);
  return { part: { buffer, offset: pad, size, pa: RAM_BASE }, words: new Int32Array(buffer, pad, size / 4) };
}
const at = (page: number, word = 0) => (page * UNIT) / 4 + word;
const sum = (a: Uint32Array) => a.reduce((n, k) => n + k, 0);

test('a pass: pages with data counted per cell; the first pass tells no change, the next one changed and cleared pages', () => {
  const { part, words } = ram(16 * MiB);
  // Page 0 at its first word, page 5 at its last, a whole range (range 2) full.
  words[at(0)] = 1;
  words[at(5, 1023)] = -1;
  for (let p = 2 * per; p < 3 * per; p++) words[at(p, 7)] = p;
  const s = new RamScan([part]);
  assert.equal(s.size, 16 * MiB);
  s.pass();
  let surface = s.surface(4);
  assert.equal(surface.cellBytes, RANGE);
  assert.deepEqual([...surface.layers[0].held], [2, 0, per, 0]);
  assert.equal(surface.layers.length, 1, 'no change layer after the first pass');

  // A word changed in page 0, page 5 cleared, a page of range 3 written; range 2 as it was.
  words[at(0, 100)] = 42;
  words[at(5, 1023)] = 0;
  words[at(3 * per + 1)] = 9;
  s.pass();
  surface = s.surface(4);
  const [data, changed] = surface.layers;
  assert.equal(changed.id, 'changed');
  assert.deepEqual([...data.held], [1, 0, per, 1]);
  assert.deepEqual([...changed.held], [1, 0, 0, 1], 'a page written from zeros changed too');
  assert.deepEqual([...changed.zero], [1, 0, 0, 0]);
  // Two words that swap places change the fingerprint too.
  [words[at(2 * per, 7)], words[at(2 * per, 8)]] = [0, words[at(2 * per, 7)]];
  s.pass();
  assert.deepEqual([...s.surface(4).layers[1].held], [0, 0, 1, 0]);
  // Nothing written: nothing changed.
  s.pass();
  assert.equal(sum(s.surface(4).layers[1].held) + sum(s.surface(4).layers[1].zero), 0);
});

test('a surface of fewer cells than ranges: cells of 4 MiB times a power of two; a range page by page', () => {
  const { part, words } = ram(40 * MiB); // 10 ranges
  words[at(9 * per + 3)] = 1;
  const s = new RamScan([part]);
  s.pass();
  const surface = s.surface(4); // 10 ranges in 4 cells: 4 ranges a cell, 3 cells
  assert.equal(surface.cellBytes, 4 * RANGE);
  assert.deepEqual([...surface.layers[0].held], [0, 0, 1]);
  const d = s.range(9);
  assert.ok(d);
  assert.equal(d.blocks[3], RAM_PAGE.data);
  assert.equal(ramDetailCounts(d).data, 1);
  assert.equal(s.range(10), undefined, 'past RAM');
  assert.equal(s.range(-1), undefined);
});

test('RAM in parts (memory 0 and a spill memory): one map, each part at its guest address', () => {
  const a = ram(8 * MiB);
  const b = new SharedArrayBuffer(12 * MiB);
  const bw = new Int32Array(b);
  bw[(4 * MiB) / 4] = 5; // spill's first page (the part starts 4 MiB in)
  const SPILL_PA = 2 ** 32;
  const s = new RamScan([a.part, { buffer: b, offset: 4 * MiB, size: 8 * MiB, pa: SPILL_PA }]);
  assert.equal(s.size, 16 * MiB);
  assert.deepEqual(s.layout, [
    { off: 0, pa: RAM_BASE, size: 8 * MiB },
    { off: 8 * MiB, pa: SPILL_PA, size: 8 * MiB },
  ]);
  s.pass();
  assert.deepEqual([...s.surface(4).layers[0].held], [0, 0, 1, 0]);
  assert.equal(paOf(s.layout, 8 * MiB), SPILL_PA);
  assert.equal(paOf(s.layout, 8 * MiB - 1), RAM_BASE + 8 * MiB - 1);
  assert.throws(() => new RamScan([{ buffer: b, offset: 2, size: UNIT, pa: 0 }]), /whole pages/);
});

test('looks: data in steps, changes as cores, cleared only as a hollow core; the legend has changes only from the second look', () => {
  const size = 4 * RANGE;
  const s: Surface = {
    size,
    cellBytes: RANGE,
    unitBytes: UNIT,
    layers: [
      { id: 'ram', size, known: 'counted', held: Uint32Array.from([0, 1, per, per / 2]), zero: new Uint32Array(4) },
      { id: 'changed', size, known: 'counted', held: Uint32Array.from([0, 0, per, 0]), zero: Uint32Array.from([3, 0, 0, 0]) },
    ],
  };
  const l = ramLookOf(s);
  assert.deepEqual([...l.rim], [RIM.empty, RIM.step(1), RIM.step(STEPS), RIM.step(2)]);
  assert.deepEqual([...l.core], [CORE.hollow, CORE.none, CORE.step(STEPS), CORE.none]);
  assert.deepEqual(ramLegend(false).map((e) => e.key.split('.').pop()), ['zero', 'some', 'full']);
  assert.deepEqual(ramLegend(true).map((e) => e.key.split('.').pop()), ['zero', 'some', 'full', 'changed', 'cleared']);
});

test('words: guest addresses in hex, a cell\'s pages and changes, the whole RAM, a range', () => {
  assert.equal(paText(RAM_BASE), '0x4000_0000');
  assert.equal(paText(2 ** 32 + 0x40_0000), '0x1_0040_0000');
  const size = 2 * RANGE;
  const layout = [{ off: 0, pa: RAM_BASE, size }];
  const first: Surface = {
    size,
    cellBytes: RANGE,
    unitBytes: UNIT,
    layers: [{ id: 'ram', size, known: 'counted', held: Uint32Array.from([10, 0]), zero: new Uint32Array(2) }],
  };
  const keys = (m: { key: string }[]) => m.map((x) => x.key.replace('machine:ram-look.', ''));
  const cell = ramCellWords(first, layout, 1);
  assert.deepEqual(keys(cell), ['at', 'zero']);
  assert.deepEqual(cell[0].params, { from: '0x4040_0000', to: '0x4080_0000' });
  assert.deepEqual(keys(ramWholeWords(first)), ['whole', 'firstLook', 'hint']);
  assert.deepEqual(ramWholeWords(first)[0].params, { size: 10 * UNIT, total: size });
  const second: Surface = {
    ...first,
    layers: [...first.layers, { id: 'changed', size, known: 'counted', held: Uint32Array.from([2, 0]), zero: Uint32Array.from([1, 0]) }],
  };
  assert.deepEqual(keys(ramCellWords(second, layout, 0)), ['at', 'data', 'changed', 'cleared']);
  assert.deepEqual(keys(ramCellWords(second, layout, 1)), ['at', 'zero', 'unchanged']);
  assert.deepEqual(keys(ramWholeWords(second)), ['whole', 'wholeChanged', 'hint']);

  const blocks = new Uint8Array(per);
  blocks.set([RAM_PAGE.data, RAM_PAGE.changed, RAM_PAGE.gone]);
  blocks.fill(RAM_PAGE.past, per - 4);
  const d = { range: 1, blocks, runs: {} };
  assert.deepEqual(ramDetailCounts(d), { zero: per - 7, data: 2, changed: 1, cleared: 1, past: 4 });
  const look = ramDetailLook(d);
  assert.deepEqual([look.rim[0], look.rim[1], look.rim[2], look.rim[per - 1]], [RIM.step(STEPS), RIM.step(STEPS), RIM.empty, RIM.absent]);
  assert.deepEqual([look.core[0], look.core[1], look.core[2]], [CORE.none, CORE.step(STEPS), CORE.hollow]);
  const w = ramDetailWords(d, layout, size, true);
  assert.deepEqual(keys(w), ['at', 'data', 'changed', 'cleared']);
  assert.deepEqual(w[1].params, { data: 2, count: per - 4 });
  assert.deepEqual(keys(ramDetailWords(d, layout, size, false)), ['at', 'data']);
});

test('pacing: at most once a second, and a pass takes under an eighth of the time', () => {
  assert.equal(ramDelay(), RAM_POLL_MS);
  assert.equal(ramDelay(50), RAM_POLL_MS);
  assert.equal(ramDelay(500), 4000);
});

test('a pass over 1 GiB of RAM, a quarter of it written: its time (logged, not judged)', () => {
  const { part, words } = ram(1024 * MiB);
  for (let i = 0; i < words.length / 4; i += 512) words[i] = i | 1;
  const s = new RamScan([part]);
  const times = [s.pass(), s.pass(), s.pass()];
  assert.equal(sum(s.surface(256).layers[0].held), 256 * MiB / UNIT);
  console.log(`# a pass over 1 GiB (256 MiB written): ${times.map((t) => t.toFixed(0)).join(', ')} ms`);
});
