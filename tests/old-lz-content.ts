// What tests/fixtures/old-lz.waarm64snap holds: a small snapshot written by the core's own LZ codec (core/src/lz.rs,
// replaced by lz4_flex in SNAPZ loop 1), so tests/snapshot.test.ts can check that files from before then still load.
// Deterministic: the test makes the same content and compares it with what it reads.
import type { SnapshotHeader } from '../web/snapshot-file.ts';

export const OLD_LZ_HEADER: SnapshotHeader = { format: 1, coreVersion: 3, abi: 67, created: '2026-11-15T00:00:00Z', machine: 'old-lz' };

/** xorshift32 bytes, masked to `mask` (a few bits: compressible but not trivially). */
function noise(n: number, seed: number, mask: number) {
  const out = new Uint8Array(n);
  let s = seed | 1;
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    out[i] = s & mask;
  }
  return out;
}

/** A page of one of five kinds: text, a counting pattern, pointer-like words, a repeated random motif, a run with a random tail. */
function page(kind: number, seed: number) {
  const p = new Uint8Array(4096);
  const v = new DataView(p.buffer);
  if (kind === 0) {
    const words = ['the ', 'quick ', 'brown ', 'fox ', 'jumps ', 'over ', 'lazy ', 'dog\n'];
    const pick = noise(4096, seed, 7);
    let at = 0;
    for (let i = 0; at < 4096; i++) for (const ch of words[pick[i]]) if (at < 4096) p[at++] = ch.charCodeAt(0);
  } else if (kind === 1) for (let i = 0; i < 4096; i++) p[i] = (i / 16 + seed) & 255;
  else if (kind === 2) for (let i = 0; i < 512; i++) v.setBigUint64(i * 8, 0xffff_0000_0000_0000n + BigInt(seed * 4096 + i * 8), true);
  else if (kind === 3) { const m = noise(256, seed, 0xff); for (let i = 0; i < 4096; i++) p[i] = m[i & 255] + (i % 100 === 0 ? 1 : 0); }
  else { p.fill(seed & 255, 0, 4000); p.set(noise(96, seed, 0xff), 4000); }
  return p;
}

/** CORE and DEVS bytes, 2 MiB of RAM with 40 of its 512 pages non-zero, and a few overlay blocks in three runs. */
export function oldLzContent() {
  const core = page(3, 1);
  const devs = new TextEncoder().encode(JSON.stringify({ devices: Array.from({ length: 40 }, (_, i) => ({ i, name: `dev${i}`, regs: [i, i * 2, i * 3] })) }));
  const ram = new Uint8Array(2 << 20);
  for (let k = 0; k < 40; k++) {
    const p = (k * 13 + (k >> 2)) % 512;
    ram.set(page(k % 5, k + 7), p * 4096);
  }
  const disk = [3, 4, 5, 9, 200].map((block, i) => ({ block, data: page((i + 2) % 5, 100 + i) }));
  return { core, devs, ram, disk };
}
