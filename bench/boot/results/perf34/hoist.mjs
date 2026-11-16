// PERF loop 34: does TurboFan keep a plain i32.load from shared memory inside a store-free wasm loop?
//   node --no-liftoff --no-wasm-lazy-compilation --print-wasm-code hoist.mjs [atomic]
// (func (param $v i32) (param $acc i32) (result i32)
//   (loop $l  acc += 7;  (br_if $l (i32.lt_u acc (i32.load offset=1444 (local.get $v)))))  acc)
const atomic = process.argv[2] === 'atomic';
const leb = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const load = atomic ? [0xfe, 0x10, 0x02, ...leb(1444)] : [0x28, 0x02, ...leb(1444)];
const body = [0x00, // no locals
  0x03, 0x40, // loop
  0x20, 0x01, 0x41, 0x07, 0x6a, 0x21, 0x01, // acc += 7
  0x20, 0x01, 0x20, 0x00, ...load, 0x49, 0x0d, 0x00, // br_if 0 (acc < word)
  0x0b, 0x20, 0x01, 0x0b];
const sec = (id, c) => [id, ...leb(c.length), ...c];
const bytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
  ...sec(1, [1, 0x60, 2, 0x7f, 0x7f, 1, 0x7f]),
  ...sec(2, [1, 1, 0x6d, 1, 0x6d, 0x02, 0x03, 1, 1]), // import "m" "m" memory shared min 1 max 1
  ...sec(3, [1, 0]),
  ...sec(7, [1, 1, 0x66, 0x00, 0x00]), // export "f"
  ...sec(10, [1, ...leb(body.length), ...body])]);
const mem = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
const { f } = new WebAssembly.Instance(new WebAssembly.Module(bytes), { m: { m: mem } }).exports;
const w = new Int32Array(mem.buffer);
w[1444 / 4] = 1000;
console.log('ran to', f(0, 0));
