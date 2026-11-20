// The agent's frame reader (web/agent-frame.ts `FrameReader`) on a stream cut at random: every frame whole and in
// order whatever the pieces, frames that complete within a piece and across many, a reader reused after each.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFrame, FrameReader, MAX_PAYLOAD } from '../web/agent-frame.ts';

test('frames come out whole and in order from a stream cut anywhere', () => {
  let seed = 1;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) >>> 0) % n);
  const sent: Uint8Array[] = [];
  for (let k = 0; k < 200; k++) {
    const len = [0, 1, 7, 4096, MAX_PAYLOAD][rand(5)];
    const p = new Uint8Array(len);
    for (let i = 0; i < len; i++) p[i] = (k * 31 + i) & 0xff;
    sent.push(p);
  }
  const stream = new Uint8Array(sent.reduce((n, p) => n + 5 + p.length, 0));
  let at = 0;
  sent.forEach((p, k) => {
    const f = encodeFrame(k & 0x7f, p);
    stream.set(f, at);
    at += f.length;
  });
  for (const piece of [1, 13, 4096, 70_000, 1 << 20]) {
    const r = new FrameReader();
    const got = [];
    for (let k = 0; k < stream.length; ) {
      const n = 1 + rand(piece);
      got.push(...r.push(stream.subarray(k, k + n)));
      k += n;
    }
    assert.equal(got.length, sent.length, `pieces up to ${piece}`);
    got.forEach((f, k) => {
      assert.equal(f.type, k & 0x7f);
      assert.equal(Buffer.compare(f.payload, sent[k]), 0, `frame ${k}, pieces up to ${piece}`);
    });
    assert.equal(r.pending, 0);
  }
});
