// Minimal WebAssembly binary encoder for the M0 spike. Just enough to emit
// modules shaped like the planned JIT output; the real emitter will live in
// the Rust core.

export const I32 = 0x7f, I64 = 0x7e, F64 = 0x7c, V128 = 0x7b, FUNCREF = 0x70;

export function uleb(v: number | bigint): number[] {
  let n = BigInt(v);
  const out: number[] = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n !== 0n) b |= 0x80;
    out.push(b);
  } while (n !== 0n);
  return out;
}

export function sleb(v: number | bigint): number[] {
  let n = BigInt(v);
  const out: number[] = [];
  for (;;) {
    const b = Number(n & 0x7fn);
    n >>= 7n;
    const done = (n === 0n && (b & 0x40) === 0) || (n === -1n && (b & 0x40) !== 0);
    out.push(done ? b : b | 0x80);
    if (done) return out;
  }
}

const str = (s: string) => {
  const b = [...new TextEncoder().encode(s)];
  return [...uleb(b.length), ...b];
};
const vec = (items: number[][]) => [...uleb(items.length), ...items.flat()];

/** memarg; `mem` > 0 uses the multi-memory encoding. */
const memarg = (align: number, offset: number | bigint, mem: number) =>
  mem ? [align | 0x40, ...uleb(mem), ...uleb(offset)] : [align, ...uleb(offset)];

// Instruction helpers. Each returns the encoded bytes.
export const op = {
  unreachable: [0x00], nop: [0x01],
  block: (t = 0x40) => [0x02, t], loop: (t = 0x40) => [0x03, t], if: (t = 0x40) => [0x04, t],
  else: [0x05], end: [0x0b], br: (d: number) => [0x0c, ...uleb(d)], brIf: (d: number) => [0x0d, ...uleb(d)],
  return: [0x0f], call: (f: number) => [0x10, ...uleb(f)],
  callIndirect: (type: number, table = 0) => [0x11, ...uleb(type), ...uleb(table)],
  drop: [0x1a], select: [0x1b],
  localGet: (i: number) => [0x20, ...uleb(i)], localSet: (i: number) => [0x21, ...uleb(i)],
  localTee: (i: number) => [0x22, ...uleb(i)],
  i32Load: (off: number | bigint = 0, mem = 0) => [0x28, ...memarg(2, off, mem)],
  i64Load: (off: number | bigint = 0, mem = 0) => [0x29, ...memarg(3, off, mem)],
  i32Store: (off: number | bigint = 0, mem = 0) => [0x36, ...memarg(2, off, mem)],
  i64Store: (off: number | bigint = 0, mem = 0) => [0x37, ...memarg(3, off, mem)],
  i32Const: (v: number) => [0x41, ...sleb(v)], i64Const: (v: number | bigint) => [0x42, ...sleb(v)],
  i32Eqz: [0x45], i32Eq: [0x46], i32Ne: [0x47], i32LtU: [0x49], i32GeU: [0x4f],
  i64Eqz: [0x50], i64Eq: [0x51], i64Ne: [0x52], i64LtU: [0x54],
  i32Add: [0x6a], i32Sub: [0x6b], i32Mul: [0x6c], i32And: [0x71], i32Or: [0x72], i32Xor: [0x73],
  i32Shl: [0x74], i32ShrU: [0x76],
  i64Add: [0x7c], i64Sub: [0x7d], i64Mul: [0x7e], i64And: [0x83], i64Or: [0x84], i64Xor: [0x85],
  i64Shl: [0x86], i64ShrU: [0x88], i64Rotl: [0x89],
  i32WrapI64: [0xa7], i64ExtendI32U: [0xad],
  v128Load: (off = 0) => [0xfd, ...uleb(0), ...memarg(4, off, 0)],
  v128Store: (off = 0) => [0xfd, ...uleb(11), ...memarg(4, off, 0)],
  i32x4Add: [0xfd, ...uleb(174)],
};

export type Limits = { min: number; max?: number; shared?: boolean; memory64?: boolean };
const limits = ({ min, max, shared, memory64 }: Limits) => {
  const flags = (max !== undefined ? 1 : 0) | (shared ? 2 : 0) | (memory64 ? 4 : 0);
  return [flags, ...uleb(min), ...(max !== undefined ? uleb(max) : [])];
};

type Func = { type: number; locals: number[]; body: number[] };

export class ModuleBuilder {
  private types: number[][] = [];
  private imports: number[][] = [];
  private funcs: Func[] = [];
  private tables: number[][] = [];
  private memories: number[][] = [];
  private exports: number[][] = [];
  private elems: number[][] = [];
  private importedFuncs = 0;

  type(params: number[], results: number[]): number {
    const t = [0x60, ...uleb(params.length), ...params, ...uleb(results.length), ...results];
    const key = t.join();
    const i = this.types.findIndex((x) => x.join() === key);
    return i >= 0 ? i : this.types.push(t) - 1;
  }

  /** Imports must be declared before any defined function. */
  importFunc(mod: string, name: string, type: number): number {
    this.imports.push([...str(mod), ...str(name), 0x00, ...uleb(type)]);
    return this.importedFuncs++;
  }
  importTable(mod: string, name: string, lim: Limits) {
    this.imports.push([...str(mod), ...str(name), 0x01, FUNCREF, ...limits(lim)]);
  }
  importMemory(mod: string, name: string, lim: Limits) {
    this.imports.push([...str(mod), ...str(name), 0x02, ...limits(lim)]);
  }

  func(type: number, locals: number[], body: number[]): number {
    this.funcs.push({ type, locals, body });
    return this.importedFuncs + this.funcs.length - 1;
  }
  table(lim: Limits) { this.tables.push([FUNCREF, ...limits(lim)]); }
  memory(lim: Limits) { this.memories.push(limits(lim)); }
  exportFunc(name: string, f: number) { this.exports.push([...str(name), 0x00, ...uleb(f)]); }
  exportTable(name: string, t: number) { this.exports.push([...str(name), 0x01, ...uleb(t)]); }
  exportMemory(name: string, m: number) { this.exports.push([...str(name), 0x02, ...uleb(m)]); }
  /** Active element segment into table 0 at `offset`. */
  elem(offset: number, funcs: number[]) {
    this.elems.push([0x00, ...op.i32Const(offset), ...op.end, ...vec(funcs.map((f) => uleb(f)))]);
  }

  bytes(): Uint8Array<ArrayBuffer> {
    const section = (id: number, items: number[][]) => {
      if (!items.length) return [];
      const body = vec(items);
      return [id, ...uleb(body.length), ...body];
    };
    const code = this.funcs.map(({ locals, body }) => {
      const decl = vec(locals.map((t) => [1, t]));
      const b = [...decl, ...body, ...op.end];
      return [...uleb(b.length), ...b];
    });
    return new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      ...section(1, this.types),
      ...section(2, this.imports),
      ...section(3, this.funcs.map((f) => uleb(f.type))),
      ...section(4, this.tables),
      ...section(5, this.memories),
      ...section(7, this.exports),
      ...section(9, this.elems),
      ...section(10, code),
    ]);
  }
}
