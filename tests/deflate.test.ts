// qcow2's raw deflate through the core's miniz_oxide (web/deflate.ts; docs/abi.md "SNAPZ: qcow2's clusters through
// miniz_oxide"), with Node's zlib as the oracle: QEMU's window (4 KiB) reads what it writes, what zlib writes it
// reads, and what doesn't unpack to a cluster's size exactly (corrupt, truncated, past its bound) is refused.
import assert from 'node:assert/strict';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import { threadDeflate } from '../web/deflate.ts';
import { CLUSTER, LEVEL } from '../web/qcow2-write.ts';

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) & 0xff;
const words = ['usr/', 'lib/', 'share/', 'bin/', 'doc ', 'the ', 'kernel\n'];
const cluster = (kind: number, n = CLUSTER) => {
  const b = new Uint8Array(n);
  if (kind === 0) return b;
  if (kind === 1) return crypto.getRandomValues(b);
  const t = new TextEncoder().encode(Array.from({ length: n }, () => words[rnd() % words.length]).join(''));
  return t.subarray(0, n);
};
const same = (a: Uint8Array | undefined, b: Uint8Array) => !!a && Buffer.compare(a, b) === 0;

test('a 4 KiB cluster deflated by the core reads back in zlib with QEMU\'s 4 KiB window, and in the core with junk after it', async () => {
  const z = await threadDeflate();
  for (let k = 0; k < 60; k++) {
    const c = cluster(k % 3 === 1 ? 2 : k % 3 === 2 ? 0 : 2);
    const p = z.deflate(c, LEVEL, CLUSTER - 1);
    assert.ok(p && p.length < CLUSTER, `cluster ${k} shrinks`);
    assert.ok(same(new Uint8Array(inflateRawSync(p, { windowBits: 12 })), c), `zlib (window 12) reads cluster ${k}`);
    const junk = new Uint8Array(p.length + 511).map(() => rnd());
    junk.set(p);
    assert.ok(same(z.inflate(junk, CLUSTER), c), `the core reads cluster ${k} with a sector's junk after it`);
  }
  // Random bytes don't shrink: stored as they are.
  assert.ok(z.deflate(cluster(1), LEVEL, CLUSTER - 1) === undefined, 'random bytes shrank');
});

test('the core inflates what zlib deflates (QEMU\'s 64 KiB clusters, written at its window of 4 KiB)', async () => {
  const z = await threadDeflate();
  for (const level of [1, 6, 9]) {
    const c = cluster(2, 65536);
    const p = new Uint8Array(deflateRawSync(c, { level, windowBits: 12 }));
    assert.ok(same(z.inflate(p, 65536), c), `level ${level}`);
  }
});

test('a stream that is corrupt, truncated, short of its size or past it is refused, never thrown', async () => {
  const z = await threadDeflate();
  const c = cluster(2, 65536);
  const p = new Uint8Array(deflateRawSync(c));
  // Past its bound: the cluster's size is smaller than what the stream holds.
  assert.ok(z.inflate(p, 65535) === undefined, 'inflated past 65535');
  assert.ok(z.inflate(p, 4096) === undefined, 'inflated past 4096');
  // Short of it: a cluster unpacks to exactly its size.
  assert.ok(z.inflate(p, 65537) === undefined, '65536 bytes taken for a cluster of 65537');
  // Truncated.
  for (const cut of [0, 1, 7, p.length >> 1, p.length - 1]) assert.ok(z.inflate(p.subarray(0, cut), 65536) === undefined, `cut at ${cut}`);
  // Bits flipped: refused, or (raw deflate has no checksum: a flipped literal still parses) exactly the size.
  let refused = 0;
  for (let k = 0; k < 400; k++) {
    const m = p.slice();
    m[((rnd() << 8) | rnd()) % m.length] ^= 1 << (k % 8);
    const out = z.inflate(m, 65536);
    if (!out) refused++;
    else assert.ok(out.length === 65536, `${out.length} bytes`);
  }
  assert.ok(refused > 100, `${refused} of 400 damaged streams refused`);
  // Garbage.
  for (let k = 0; k < 200; k++) assert.doesNotThrow(() => z.inflate(cluster(1, 1 + k * 7), 65536));
});

test('a thread\'s codec that failed to start (no memory for it, once) starts at the next call', async () => {
  // A module of its own (a fresh `threadDeflate`, none made yet), its first instance's memory refused.
  const { threadDeflate: fresh } = await import(`../web/deflate.ts?first-fails=${Date.now()}`) as typeof import('../web/deflate.ts');
  const Memory = WebAssembly.Memory;
  let refused = 0;
  WebAssembly.Memory = function (this: unknown, d: WebAssembly.MemoryDescriptor) {
    if (!refused++) throw new RangeError('WebAssembly.Memory(): could not allocate memory');
    return new Memory(d);
  } as unknown as typeof WebAssembly.Memory;
  try {
    await assert.rejects(fresh(), RangeError, 'the first start fails');
  } finally {
    WebAssembly.Memory = Memory;
  }
  const z = await fresh();
  const c = cluster(2);
  assert.ok(same(z.inflate(z.deflate(c, LEVEL)!, CLUSTER), c), 'the codec made at the next call works');
});
