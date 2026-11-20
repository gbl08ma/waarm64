// The spill memories' accessor (docs/spill-memories.md): guest RAM past memory 0 lives in
// more shared wasm32 memories, which the core (Rust on wasm32, one memory) can't address. This
// module imports them and exports what the core imports as `ram` (core/src/mem.rs `acc`): aligned
// single-copy-atomic loads, stores and compare-and-swaps by (memory, offset, size). The memory
// index is the core's (1 for the first spill memory); a bad index or size traps.

const I32 = 0x7f;
const I64 = 0x7e;

function leb(v: number): number[] {
  const out = [];
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}

const str = (s: string) => [...leb(s.length), ...new TextEncoder().encode(s)];
const section = (id: number, body: number[]) => [id, ...leb(body.length), ...body];
const vec = (items: number[][]) => [...leb(items.length), ...items.flat()];

/** Atomic opcodes (0xfe prefix) by size 1, 2, 4, 8. */
const LOAD: Record<number, number> = { 1: 0x14, 2: 0x15, 4: 0x16, 8: 0x11 };
const STORE: Record<number, number> = { 1: 0x1b, 2: 0x1c, 4: 0x1d, 8: 0x18 };
const CMPXCHG: Record<number, number> = { 1: 0x4c, 2: 0x4d, 4: 0x4e, 8: 0x49 };

/** The accessor module's bytes for `n` spill memories (imported as `ram.m1`…). */
export function spillModule(n: number): Uint8Array<ArrayBuffer> {
  const types = [
    [0x60, ...vec([[I32], [I32], [I32]]), 1, I64], // load(m, off, size) -> i64
    [0x60, ...vec([[I32], [I32], [I32], [I64]]), 0], // store(m, off, size, val)
    [0x60, ...vec([[I32], [I32], [I32], [I64], [I64]]), 1, I64], // cas(m, off, size, expected, new) -> i64
  ];
  // Shared, limits 0..65536 pages: any shared wasm32 memory matches.
  const imports = Array.from({ length: n }, (_, k) => [
    ...str('ram'),
    ...str(`m${k + 1}`),
    0x02,
    0x03,
    0,
    ...leb(65536),
  ]);
  /** Chained ifs on `local` against `cases`, each case's code, `unreachable` after the last. */
  const select = (local: number, cases: [number, number[]][], bt: number): number[] => {
    if (!cases.length) return [0x00];
    const [[v, code], ...rest] = cases;
    return [0x20, local, 0x41, ...leb(v), 0x46, 0x04, bt, ...code, 0x05, ...select(local, rest, bt), 0x0b];
  };
  // The core's memory m is this module's m - 1 (its only memories are the imported spill ones).
  const memarg = (size: number, m: number) => [Math.log2(size) | 0x40, ...leb(m - 1), 0];
  const body = (bt: number, access: (size: number, m: number) => number[]) => {
    const code = select(
      0,
      Array.from({ length: n }, (_, k) => [
        k + 1,
        select(
          2,
          [8, 4, 2, 1].map((s) => [s, access(s, k + 1)]),
          bt,
        ),
      ]),
      bt,
    );
    const f = [0, ...code, 0x0b]; // no locals
    return [...leb(f.length), ...f];
  };
  const code = [
    body(I64, (s, m) => [0x20, 1, 0xfe, LOAD[s], ...memarg(s, m)]),
    body(0x40, (s, m) => [0x20, 1, 0x20, 3, 0xfe, STORE[s], ...memarg(s, m)]),
    body(I64, (s, m) => [0x20, 1, 0x20, 3, 0x20, 4, 0xfe, CMPXCHG[s], ...memarg(s, m)]),
  ];
  const exports = ['load', 'store', 'cas'].map((name, k) => [...str(name), 0x00, k]);
  return new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    1,
    0,
    0,
    0,
    ...section(1, vec(types)),
    ...section(2, vec(imports)),
    ...section(3, vec([[0], [1], [2]])),
    ...section(7, vec(exports)),
    ...section(10, vec(code)),
  ]);
}

/** The core's `ram` imports over `spill` (memory 1 first); with none, every call traps. */
export function spillImports(spill: WebAssembly.Memory[]): WebAssembly.ModuleImports {
  const ram = Object.fromEntries(spill.map((m, k) => [`m${k + 1}`, m]));
  return new WebAssembly.Instance(new WebAssembly.Module(spillModule(spill.length)), { ram }).exports;
}
