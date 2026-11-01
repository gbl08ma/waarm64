// Does this host's relaxed-SIMD `madd` fuse? (docs/jit.md "Floating point", FMA.) A relaxed `madd` is either a·b + c
// rounded once or rounded twice, by the spec's rule a choice fixed for the environment; V8 lowers it the same way in
// Liftoff and TurboFan (`fmla` on arm64; on x86-64 one macro, FMA3's `vfmadd` where the CPU has it, else mul + add).
// So one probe of each op says what the JIT's modules will do, in any tier. The operands come in as parameters, so
// that nothing can fold them. No relaxed-SIMD, or a `madd` that doesn't fuse: false, and the JIT keeps its emulation.

/** `madd`, `nmadd` of f32x4 and of f64x2 (the 0xfd prefix's opcodes). */
const OPS = [[0x105, 0x106], [0x107, 0x108]];

const leb = (n: number) => (n < 128 ? [n] : [(n & 127) | 128, n >> 7]);

/** The module of (a, b, c) => lane 0 of `op`(splat a, splat b, splat c), lanes single or double. */
function moduleOf(op: number, d: boolean): Uint8Array<ArrayBuffer> {
  const [t, splat, extract] = d ? [0x7c, 0x14, 0x21] : [0x7d, 0x13, 0x1f];
  const code = [0x20, 0, 0xfd, splat, 0x20, 1, 0xfd, splat, 0x20, 2, 0xfd, splat, 0xfd, ...leb(op), 0xfd, extract, 0, 0x0b];
  const section = (id: number, b: number[]) => [id, b.length, ...b];
  return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...section(1, [1, 0x60, 3, t, t, t, 1, t]), ...section(3, [1, 0]), ...section(7, [1, 1, 0x66, 0, 0]),
    ...section(10, [1, code.length + 1, 0, ...code])]);
}

/** (1 + e)(1 + e) - 1 with e = 2^-27 (2^-13 in singles): 2e + e² fused; 2e rounded twice, e² lost. */
function fuses(op: number, d: boolean, negated: boolean): boolean {
  const bytes = moduleOf(op, d);
  if (!WebAssembly.validate(bytes)) return false;
  const f = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.f as (a: number, b: number, c: number) => number;
  const e = d ? 2 ** -27 : 2 ** -13;
  return f(negated ? -(1 + e) : 1 + e, 1 + e, -1) === 2 * e + e * e;
}

let fused: boolean | undefined;

/** The host's relaxed `madd` and `nmadd` fuse, in singles and in doubles. Probed once. */
export function fusedFma(): boolean {
  return fused ??= OPS.every((ops, d) => ops.every((op, negated) => fuses(op, d === 1, negated === 1)));
}
