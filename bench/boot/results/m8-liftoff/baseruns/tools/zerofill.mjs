// zerofill.ts [child n type]: Liftoff's prologue for a function (i32) -> i32 with n locals of a type (0x7e i64,
// 0x7f i32, 0x7b v128) that it sets and reads once; prints the code size and whether it zero-fills.
import { spawnSync } from 'node:child_process';
const mod = (n, ty) => {
  const body = [1, n, ty]; // locals
  for (let i = 0; i < n; i++) {
    if (ty === 0x7b) body.push(0xfd, 12, ...new Array(16).fill(i & 0xff), 0x21, i + 1);
    else body.push(ty === 0x7e ? 0x42 : 0x41, i & 0x3f, 0x21, i + 1);
  }
  body.push(0x20, 0, 0x0b);
  const code = [1, body.length, ...body];
  return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 6, 1, 0x60, 1, 0x7f, 1, 0x7f, 3, 2, 1, 0, 7, 5, 1, 1, 102, 0, 0, 10, code.length, ...code]);
};
if (process.argv[2] === 'child') {
  new WebAssembly.Module(mod(Number(process.argv[3]), Number(process.argv[4])));
} else {
  for (const ty of [0x7e, 0x7f]) for (const n of [4, 6, 8, 10, 11, 12, 13, 16, 20, 30]) {
    const r = spawnSync(process.execPath, ['--liftoff-only', '--no-wasm-lazy-compilation', '--print-wasm-code', process.argv[1], 'child', String(n), String(ty)], { encoding: 'utf8' });
    const out = r.stdout.split("\nname: ").at(-1);
    const size = out.match(/Instructions \(size = (\d+)\)/)?.[1];
    const loop = /cbnz/.test(out);
    const wzr = (out.match(/wzr|xzr/g) ?? []).length;
    console.log(`type ${ty.toString(16)} n=${n}: ${size} bytes, loop ${loop}, zero stores ${wzr}`);
  }
}
