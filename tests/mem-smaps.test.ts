// The memory sampler's reading of /proc/<pid>/smaps (bench/mem/probe.ts): resident bytes, not reservations, by class,
// with transparent huge pages counted apart.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSmaps, smapsClass, smapsTotals } from '../bench/mem/probe.ts';

const entry = (from: number, to: number, perm: string, name: string, rssKb: number, thpKb = 0) =>
  [`${from.toString(16)}-${to.toString(16)} ${perm} 00000000 00:00 0  ${name}`, `Size: ${(to - from) / 1024} kB`, `Rss: ${rssKb} kB`, `Pss: ${rssKb} kB`, `AnonHugePages: ${thpKb} kB`, 'VmFlags: rd wr mr mw me ac'].join('\n');
const GiB = 2 ** 30;
const SMAPS = [
  // V8's wasm code space: 128 MiB reserved, 6 MiB resident, 2 MiB of it a huge page.
  entry(0x10000000, 0x18000000, 'rwxp', '[anon:v8]', 6144, 2048),
  entry(0x18000000, 0x19000000, '---p', '[anon:v8]', 0),
  // A wasm memory: a 10 GiB reservation, 1 GiB touched.
  entry(0x100000000, 0x100000000 + 10 * GiB, 'rw-p', '[anon:v8-sandbox]', 1048576),
  entry(0x400000000, 0x400100000, 'rw-p', '[anon:partition_alloc]', 512),
  entry(0x500000000, 0x500200000, 'r-xp', '/usr/lib64/chromium/chromium', 1024),
  entry(0x600000000, 0x640000000, 'rw-s', '/memfd:shared (deleted)', 2048),
].join('\n');

test('smaps: Rss and AnonHugePages per mapping, its size from the range', () => {
  const m = parseSmaps(SMAPS);
  assert.equal(m.length, 6);
  assert.deepEqual(m[0], { perm: 'rwxp', name: '[anon:v8]', size: 128 * 2 ** 20, rss: 6 * 2 ** 20, thp: 2 * 2 ** 20 });
  assert.deepEqual(m.map(smapsClass), ['code', 'other', 'wasm-mem', 'anon', 'exec-lib', 'shared']);
});

test('smaps: the classes sum resident bytes, the reservations apart', () => {
  const { cls, total } = smapsTotals(parseSmaps(SMAPS));
  assert.deepEqual(cls.code, { rss: 6 * 2 ** 20, size: 128 * 2 ** 20, thp: 2 * 2 ** 20, n: 1 });
  assert.equal(cls['wasm-mem'].rss, GiB);
  assert.equal(cls['wasm-mem'].size, 10 * GiB);
  assert.equal(cls.other.rss, 0);
  assert.equal(cls.other.size, 16 * 2 ** 20);
  assert.equal(total.rss, (6144 + 1048576 + 512 + 1024 + 2048) * 1024);
  assert.equal(total.n, 6);
});
