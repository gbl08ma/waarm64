// A module of `n` exported functions (i32)->i32, each a long chain of arithmetic; `nonce` adds a custom section.
export function gen(n, nonce) {
  const leb = (v) => { const o = []; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; o.push(b); } while (v); return o; };
  const sleb = (v) => { const o = []; for (;;) { const b = v & 0x7f; v >>= 7; if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) { o.push(b); return o; } o.push(b | 0x80); } };
  const enc = (s) => (typeof Buffer !== 'undefined' ? [...Buffer.from(s)] : [...new TextEncoder().encode(s)]);
  const sec = (id, body) => [id, ...leb(body.length), ...body];
  const vec = (items) => [...leb(items.length), ...items.flat()];
  const type = sec(1, vec([[0x60, 1, 0x7f, 1, 0x7f]]));
  const func = sec(3, vec(Array.from({ length: n }, () => [0])));
  const exp = sec(7, vec(Array.from({ length: n }, (_, i) => { const nm = enc('f' + i); return [...leb(nm.length), ...nm, 0, ...leb(i)]; })));
  const bodies = Array.from({ length: n }, (_, i) => {
    const code = [];
    for (let k = 0; k < 150; k++) code.push(0x20, 0, 0x41, ...sleb((i * 7 + k) & 0xfff), 0x6a, 0x41, ...sleb(k + 3), 0x6c, 0x21, 0);
    code.push(0x20, 0, 0x0b);
    const body = [0, ...code];
    return [...leb(body.length), ...body];
  });
  const codeSec = sec(10, vec(bodies));
  const custom = nonce === undefined ? [] : sec(0, [4, ...enc('nnce'), ...enc(String(nonce))]);
  return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...type, ...func, ...exp, ...codeSec, ...custom]);
}
