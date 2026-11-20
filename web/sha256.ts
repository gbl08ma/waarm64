// SHA-256 (FIPS 180-4) without blocking or awaiting: what a synchronous reader checks content against where
// `crypto.subtle` (a Promise) can't be awaited, a chunked image's pieces and its manifest's id read by a device worker's
// synchronous XHRs (web/chunked.ts). ~100 MiB/s in V8 (2 MiB, ~20 ms); the platform's digest where a caller can wait.

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

/** Hash state `h` advanced by the 64-byte blocks of `b` from `at` to `end` (`w`: the schedule's scratch). */
function blocks(h: Int32Array, w: Int32Array, b: Uint8Array, at: number, end: number) {
  let h0 = h[0],
    h1 = h[1],
    h2 = h[2],
    h3 = h[3],
    h4 = h[4],
    h5 = h[5],
    h6 = h[6],
    h7 = h[7];
  for (; at < end; at += 64) {
    for (let i = 0, j = at; i < 16; i++, j += 4) w[i] = (b[j] << 24) | (b[j + 1] << 16) | (b[j + 2] << 8) | b[j + 3];
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15],
        y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0,
      c1 = h1,
      c2 = h2,
      d = h3,
      e = h4,
      f = h5,
      g = h6,
      k = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (k + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & c1) ^ (a & c2) ^ (c1 & c2))) | 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c2;
      c2 = c1;
      c1 = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + c1) | 0;
    h2 = (h2 + c2) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + k) | 0;
  }
  h[0] = h0;
  h[1] = h1;
  h[2] = h2;
  h[3] = h3;
  h[4] = h4;
  h[5] = h5;
  h[6] = h6;
  h[7] = h7;
}

/** The SHA-256 of `data` (a string as UTF-8), as lowercase hex. */
export function sha256Hex(data: Uint8Array | string): string {
  const msg = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const h = new Int32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Int32Array(64);
  // The message's whole blocks are read in place; the last one or two (the padding, the length) from a copy.
  const whole = msg.length - (msg.length % 64);
  const tail = new Uint8Array(msg.length % 64 < 56 ? 64 : 128);
  tail.set(msg.subarray(whole));
  tail[msg.length - whole] = 0x80;
  const tv = new DataView(tail.buffer);
  tv.setUint32(tail.length - 8, Math.floor(msg.length / 0x20000000));
  tv.setUint32(tail.length - 4, (msg.length * 8) >>> 0);
  blocks(h, w, msg, 0, whole);
  blocks(h, w, tail, 0, tail.length);
  return [...h].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}
