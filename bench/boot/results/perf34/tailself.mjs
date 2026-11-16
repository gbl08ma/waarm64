// PERF loop 34: does TurboFan keep a plain i32.load fresh across a self tail call (return_call to itself)?
// node --no-liftoff --no-wasm-lazy-compilation --print-wasm-code tailself.mjs
// (func $f (param $v i32) (param $acc i32) (result i32)
//   (if (i32.lt_u acc (i32.load offset=1444 v)) (then (return_call $f v (acc + 7)))) acc)
const leb = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const body = [0x00,
  0x20, 0x01, 0x20, 0x00, 0x28, 0x02, ...leb(1444), 0x49, 0x04, 0x40, // if (acc < word)
  0x20, 0x00, 0x20, 0x01, 0x41, 0x07, 0x6a, 0x12, 0x00, // return_call 0 (v, acc + 7)
  0x0b, 0x20, 0x01, 0x0b];
const sec = (id, c) => [id, ...leb(c.length), ...c];
const bytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
  ...sec(1, [1, 0x60, 2, 0x7f, 0x7f, 1, 0x7f]),
  ...sec(2, [1, 1, 0x6d, 1, 0x6d, 0x02, 0x03, 1, 1]),
  ...sec(3, [1, 0]),
  ...sec(7, [1, 1, 0x66, 0x00, 0x00]),
  ...sec(10, [1, ...leb(body.length), ...body])]);
const mem = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
const { f } = new WebAssembly.Instance(new WebAssembly.Module(bytes), { m: { m: mem } }).exports;
new Int32Array(mem.buffer)[1444 / 4] = 1000000;
for (let i = 0; i < 2000; i++) f(0, 0); // warm: tier-up and inlining feedback
console.log('ran to', f(0, 0));
