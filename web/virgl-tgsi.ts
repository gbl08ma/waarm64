// TGSI (Gallium's shader text, what Mesa's virgl driver sends) to GLSL ES 3.00 for WebGL2 (docs/plans/graphics.md §1,
// §20). The parser reads the text tgsi_dump writes (Mesa's tgsi_dump.c, tgsi_strings.c); the generator follows
// virglrenderer's vrend_shader.c (MIT, THIRD_PARTY.md) in its conventions — registers as untyped 32-bit vec4s held in
// floats, constants as bits, varyings named by semantic — with WebGL2's limits: no texture swizzle or BGRA (the
// sampler and render-target swizzles of the key are applied in the shader), no 1D or rectangle textures (2D
// stand-ins), no noperspective, clip distances only through an extension (not used), no geometry, tessellation or
// compute stages. A vertex and a fragment shader are generated as a pair: their varyings must match in name, type and
// interpolation, which only the pair knows.

export type Stage = 'VERT' | 'FRAG' | 'GEOM' | 'TESS_CTRL' | 'TESS_EVAL' | 'COMP';
export type RegFile = 'NULL' | 'CONST' | 'IN' | 'OUT' | 'TEMP' | 'SAMP' | 'ADDR' | 'IMM' | 'PRED' | 'SV' | 'IMAGE' | 'SVIEW' | 'BUFFER' | 'MEMORY' | 'HWATOMIC';

export type Indirect = { file: RegFile; index: number; comp: number };
export type Operand = {
  file: RegFile;
  index: number;
  /** A second dimension (CONST[1][4]: dim 1, index 4). */
  dim?: number;
  ind?: Indirect;
  dimInd?: Indirect;
  arrayId?: number;
  /** Source: the components read, x=0..w=3. */
  swizzle: number[];
  neg: boolean;
  abs: boolean;
  /** Destination: the components written (bits x=1, y=2, z=4, w=8). */
  mask: number;
};
export type Instr = { op: string; sat: boolean; dst: Operand[]; src: Operand[]; tex?: string; offsets: Operand[]; label?: number };
export type Decl = {
  file: RegFile; first: number; last: number; dim?: number; mask: number;
  semantic?: string; semIndex: number; interp?: string; loc?: string; arrayId?: number;
  /** SVIEW: the texture target and the return type. */
  target?: string; ret?: string;
  invariant?: boolean;
};
export type Imm = { type: string; bits: number[] };
export type Tgsi = { stage: Stage; props: Map<string, string>; decls: Decl[]; imms: Imm[]; instrs: Instr[] };

export class TgsiError extends Error {}

const FILES = new Set<RegFile>(['NULL', 'CONST', 'IN', 'OUT', 'TEMP', 'SAMP', 'ADDR', 'IMM', 'PRED', 'SV', 'IMAGE', 'SVIEW', 'BUFFER', 'MEMORY', 'HWATOMIC']);
const COMP = 'xyzw';

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const bitsOf = (f: number) => { f32[0] = f; return u32[0]; };
const floatOf = (b: number) => { u32[0] = b; return f32[0]; };

/** Parses TGSI text as tgsi_dump writes it (with or without TGSI_DUMP_FLOAT_AS_HEX). */
export function parseTgsi(text: string): Tgsi {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (!lines.length) throw new TgsiError('empty shader');
  const stage = lines[0] as Stage;
  if (!['VERT', 'FRAG', 'GEOM', 'TESS_CTRL', 'TESS_EVAL', 'COMP'].includes(stage)) throw new TgsiError(`unknown processor ${lines[0]}`);
  const t: Tgsi = { stage, props: new Map(), decls: [], imms: [], instrs: [] };
  for (const line of lines.slice(1)) {
    if (line.startsWith('PROPERTY ')) {
      const [, name, value = ''] = /^PROPERTY (\S+)\s*(.*)$/.exec(line) ?? [];
      if (name) t.props.set(name, value);
    } else if (line.startsWith('DCL ')) t.decls.push(parseDecl(line.slice(4)));
    else if (line.startsWith('IMM')) t.imms.push(parseImm(line));
    else {
      const m = /^\d+:\s*(.*)$/.exec(line);
      if (!m) throw new TgsiError(`can't read: ${line}`);
      t.instrs.push(parseInstr(m[1]));
    }
  }
  return t;
}

function parseImm(line: string): Imm {
  const m = /^IMM\[\d+\]\s+(\w+)\s*\{(.*)\}$/.exec(line);
  if (!m) throw new TgsiError(`bad immediate: ${line}`);
  const type = m[1];
  const bits = m[2].split(',').map((s) => s.trim()).map((s) => {
    if (/^0x[0-9a-f]+$/i.test(s)) return Number(BigInt(s) & 0xffffffffn);
    if (type === 'FLT32') return bitsOf(Number(s));
    const n = Number(s);
    if (!Number.isFinite(n)) throw new TgsiError(`bad immediate value ${s}`);
    return n >>> 0;
  });
  if (type === 'FLT64' || type === 'UINT64' || type === 'INT64') throw new TgsiError(`64-bit immediates aren't supported`);
  return { type, bits };
}

/** A small cursor over an operand or declaration string. */
class Cursor {
  at = 0;
  readonly s: string;
  constructor(s: string) { this.s = s; }
  peek() { return this.s[this.at]; }
  eat(c: string) {
    if (this.s.startsWith(c, this.at)) { this.at += c.length; return true; }
    return false;
  }
  expect(c: string) { if (!this.eat(c)) throw new TgsiError(`expected '${c}' at ${this.at} in ${this.s}`); }
  word() {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.s.slice(this.at));
    if (!m) throw new TgsiError(`expected a name at ${this.at} in ${this.s}`);
    this.at += m[0].length;
    return m[0];
  }
  int() {
    const m = /^[-+]?\d+/.exec(this.s.slice(this.at));
    if (!m) throw new TgsiError(`expected a number at ${this.at} in ${this.s}`);
    this.at += m[0].length;
    return Number(m[0]);
  }
  ws() { while (this.s[this.at] === ' ') this.at++; }
  done() { return this.at >= this.s.length; }
}

/** `[...]`: a number, or `FILE[n].c` with an optional `+k`/`-k`. */
function parseIndex(c: Cursor): { index: number; ind?: Indirect } {
  c.expect('[');
  let r: { index: number; ind?: Indirect };
  if (/[A-Z]/.test(c.peek())) {
    const file = c.word() as RegFile;
    c.expect('[');
    const i = c.int();
    c.expect(']');
    c.expect('.');
    const comp = COMP.indexOf(c.s[c.at++]);
    let index = 0;
    if (c.peek() === '+' || c.peek() === '-') index = c.int();
    r = { index, ind: { file, index: i, comp } };
  } else r = { index: c.int() };
  c.expect(']');
  return r;
}

function parseOperand(s: string, dst: boolean): Operand {
  const c = new Cursor(s.trim());
  const op: Operand = { file: 'NULL', index: 0, swizzle: [0, 1, 2, 3], neg: false, abs: false, mask: 15 };
  if (c.eat('-')) op.neg = true;
  if (c.eat('|')) op.abs = true;
  const file = c.word() as RegFile;
  if (!FILES.has(file)) throw new TgsiError(`unknown register file ${file}`);
  op.file = file;
  const first = parseIndex(c);
  if (c.eat('(')) { op.arrayId = c.int(); c.expect(')'); }
  if (c.peek() === '[') {
    // Two dimensions: the first was the dimension.
    op.dim = first.index;
    op.dimInd = first.ind;
    const second = parseIndex(c);
    op.index = second.index;
    op.ind = second.ind;
    if (c.eat('(')) { op.arrayId = c.int(); c.expect(')'); }
  } else {
    op.index = first.index;
    op.ind = first.ind;
  }
  if (c.eat('.')) {
    const m = /^[xyzw]+/.exec(c.s.slice(c.at))![0];
    c.at += m.length;
    if (dst) op.mask = [...m].reduce((k, ch) => k | (1 << COMP.indexOf(ch)), 0);
    else {
      const sw = [...m].map((ch) => COMP.indexOf(ch));
      while (sw.length < 4) sw.push(sw[sw.length - 1]);
      op.swizzle = sw;
    }
  }
  if (op.abs) c.expect('|');
  if (!c.done()) throw new TgsiError(`trailing text in operand ${s}`);
  return op;
}

const TEX_TARGETS = new Set(['BUFFER', '1D', '2D', '3D', 'CUBE', 'RECT', 'SHADOW1D', 'SHADOW2D', 'SHADOWRECT', '1D_ARRAY', '2D_ARRAY', 'SHADOW1D_ARRAY', 'SHADOW2D_ARRAY', 'SHADOWCUBE', '2D_MSAA', '2D_ARRAY_MSAA', 'CUBE_ARRAY', 'SHADOWCUBE_ARRAY', 'UNKNOWN']);

/** How many destinations an opcode has (0 or 1 for everything we take). */
const NO_DST = new Set(['IF', 'UIF', 'ELSE', 'ENDIF', 'BGNLOOP', 'ENDLOOP', 'BRK', 'CONT', 'END', 'RET', 'KILL', 'KILL_IF', 'NOP', 'SWITCH', 'CASE', 'DEFAULT', 'ENDSWITCH', 'EMIT', 'ENDPRIM', 'BARRIER', 'MEMBAR', 'BGNSUB', 'ENDSUB', 'CAL', 'FENCE']);

function parseInstr(s: string): Instr {
  let label: number | undefined;
  const lm = /\s:(\d+)$/.exec(s);
  if (lm) {
    label = Number(lm[1]);
    s = s.slice(0, lm.index);
  }
  const sp = s.indexOf(' ');
  let op = sp < 0 ? s : s.slice(0, sp);
  const rest = sp < 0 ? '' : s.slice(sp + 1);
  let sat = false;
  if (op.endsWith('_SAT')) { sat = true; op = op.slice(0, -4); }
  if (op.endsWith('_PRECISE')) op = op.slice(0, -8);
  const parts = rest.length ? rest.split(',').map((p) => p.trim()) : [];
  const ins: Instr = { op, sat, dst: [], src: [], offsets: [], label };
  let k = 0;
  if (!NO_DST.has(op) && parts.length) ins.dst.push(parseOperand(parts[k++], true));
  for (; k < parts.length; k++) {
    const p = parts[k];
    if (TEX_TARGETS.has(p)) ins.tex = p;
    else if (ins.tex) ins.offsets.push(parseOperand(p, false));
    else if (/^[A-Z_0-9]+$/.test(p) && !/\[/.test(p)) continue; // memory qualifiers and formats (images, buffers): unsupported anyway
    else ins.src.push(parseOperand(p, false));
  }
  return ins;
}

function parseDecl(s: string): Decl {
  const parts = s.split(',').map((p) => p.trim());
  const c = new Cursor(parts[0]);
  const file = c.word() as RegFile;
  if (!FILES.has(file)) throw new TgsiError(`unknown register file ${file}`);
  const d: Decl = { file, first: 0, last: 0, mask: 15, semIndex: 0 };
  // CONST[1][0..3]: the dimension first; IN[][0..3] (arrays of vertices) aren't for our stages.
  const ranges: string[] = [];
  while (c.peek() === '[') {
    const end = c.s.indexOf(']', c.at);
    ranges.push(c.s.slice(c.at + 1, end));
    c.at = end + 1;
  }
  const range = ranges[ranges.length - 1] ?? '0';
  if (ranges.length > 1) d.dim = Number(ranges[0]) || 0;
  const [a, b] = range.split('..');
  d.first = Number(a);
  d.last = b === undefined ? d.first : Number(b);
  if (c.eat('.')) d.mask = [...c.s.slice(c.at)].reduce((k, ch) => k | (1 << COMP.indexOf(ch)), 0);
  for (const p of parts.slice(1)) {
    const am = /^ARRAY\((\d+)\)$/.exec(p);
    const sm = /^([A-Z_]+)(?:\[(\d+)\])?$/.exec(p);
    if (am) d.arrayId = Number(am[1]);
    else if (p === 'LOCAL') continue;
    else if (p === 'INVARIANT') d.invariant = true;
    else if (d.file === 'SVIEW') {
      if (!d.target) d.target = p;
      else d.ret ??= p;
    } else if (['CONSTANT', 'LINEAR', 'PERSPECTIVE', 'COLOR'].includes(p) && d.semantic !== undefined) d.interp = p;
    else if (['CENTER', 'CENTROID', 'SAMPLE'].includes(p)) d.loc = p;
    else if (sm && d.semantic === undefined) { d.semantic = sm[1]; d.semIndex = Number(sm[2] ?? 0); }
    else if (sm && d.semantic !== undefined) d.interp = sm[1];
  }
  return d;
}

// ---------------------------------------------------------------------------------------------------------------
// The generator.

/** A sampler as the draw binds it: what it returns and how its channels come out (format ∘ view swizzle). */
export type SamplerKey = {
  /** 'f' float (and normalized), 'i' signed, 'u' unsigned integer. */
  type: 'f' | 'i' | 'u';
  /** R, G, B, A of the result: a component of the GL texel (0–3), 4 for 0, 5 for 1. */
  swizzle: number[];
  /** The GL target the texture is (`2D` also stands for 1D and rectangle; `RECT` scales coordinates). */
  gl: '2D' | '3D' | 'CUBE' | '2D_ARRAY';
  /** The texture was created as a rectangle or 1D: coordinates in texels (RECT) or 1D (y is 0.5). */
  rect?: boolean;
  oneD?: boolean;
};

/** A color buffer as the draw has it. */
export type ColorKey = {
  type: 'f' | 'i' | 'u';
  /** For each stored component, the logical channel written (-1: none: an X component gets 1). */
  write: number[];
};

export type ProgramKey = {
  /** Per vertex attribute: float, signed or unsigned integer (the vertex element's format). */
  attribs: ('f' | 'i' | 'u')[];
  samplers: { vs: (SamplerKey | undefined)[]; fs: (SamplerKey | undefined)[] };
  cbufs: (ColorKey | undefined)[];
  /** Gallium's PIPE_FUNC (0 never … 7 always) for the alpha test, if on. */
  alphaFunc?: number;
  flatshade?: boolean;
  twoSide?: boolean;
  clampColor?: boolean;
  stipple?: boolean;
  /** The draw is of points: the vertex shader must write gl_PointSize (the rasterizer's, if it doesn't). */
  points?: boolean;
  pointSizePerVertex?: boolean;
  /** Point sprite coordinates replace these GENERIC/TEXCOORD inputs (bits by index). */
  spriteCoordEnable?: number;
  spriteUpperLeft?: boolean;
  /**
   * Stream output: the vertex shader's components captured, in capture order (output register, first component,
   * count), interleaved into one buffer as bits (the renderer scatters them to their targets).
   */
  so?: { reg: number; start: number; comps: number }[];
};

/** What a program's uniforms and attributes are, for the renderer to bind. */
export type ProgramLayout = {
  vs: string; fs: string;
  /** Attribute locations used (IN index = location). */
  attribs: number[];
  /** Constant buffer 0's size in vec4s, per stage (uniform `vc0`/`fc0`), and the UBOs (index → vec4s) per stage. */
  consts: { vs: number; fs: number };
  ubos: { vs: Map<number, number>; fs: Map<number, number> };
  /** Sampler units used, per stage. */
  samplers: { vs: number[]; fs: number[] };
  /** The varyings transform feedback captures (`key.so`), for `transformFeedbackVaryings` before the link. */
  tf?: { varyings: string[]; separate: boolean };
};

/** The uniform block binding of a stage's constant buffer `k` (k ≥ 1). */
export const uboBinding = (stage: 'vs' | 'fs', k: number) => (stage === 'vs' ? 0 : 12) + k - 1;
/** The texture unit of a stage's sampler `n`. */
export const samplerUnit = (stage: 'vs' | 'fs', n: number, fsBase: number) => (stage === 'vs' ? fsBase + n : n);

type Ty = 'f' | 'i' | 'u';
const VEC: Record<Ty, string> = { f: 'vec4', i: 'ivec4', u: 'uvec4' };
const SCALAR: Record<Ty, string> = { f: 'float', i: 'int', u: 'uint' };

/** `e` (a 4-vector of type `from`) as type `to`, its bits kept. */
function cast(e: string, from: Ty, to: Ty) {
  if (from === to) return e;
  if (from === 'f') return `${to === 'i' ? 'floatBitsToInt' : 'floatBitsToUint'}(${e})`;
  if (to === 'f') return `${from === 'i' ? 'intBitsToFloat' : 'uintBitsToFloat'}(${e})`;
  return `${VEC[to]}(${e})`;
}

function floatLiteral(bits: number) {
  const f = floatOf(bits);
  // Not a normal float (an integer's bits, most often): kept as bits, so they survive into an integer cast.
  if (!Number.isFinite(f) || (f !== 0 && Math.abs(f) < 1.1754943508222875e-38)) return `uintBitsToFloat(${bits >>> 0}u)`;
  if (Object.is(f, -0)) return '-0.0';
  let s = String(f);
  for (let p = 1; p <= 9; p++) {
    const t = f.toPrecision(p);
    if (Math.fround(Number(t)) === f) { s = t; break; }
  }
  s = String(Number(s)); // drop trailing zeros
  if (Math.fround(Number(s)) !== f) s = f.toPrecision(9);
  if (!/[.e]/.test(s)) s += '.0';
  if (/e/.test(s) && !/\./.test(s.split('e')[0])) s = s.replace('e', '.0e');
  return s;
}

const SEMANTIC_VARYING = new Set(['GENERIC', 'COLOR', 'BCOLOR', 'FOG', 'TEXCOORD', 'CLIPVERTEX']);

type Varying = { name: string; semantic: string; index: number; interp: string; centroid: boolean };

/** The varyings a fragment shader reads (by name) with their interpolation. */
function fsVaryings(fs: Tgsi, key: ProgramKey): Map<string, Varying> {
  const m = new Map<string, Varying>();
  for (const d of fs.decls) {
    if (d.file !== 'IN' || !d.semantic || !SEMANTIC_VARYING.has(d.semantic)) continue;
    for (let k = d.first; k <= d.last; k++) {
      const index = d.semIndex + (k - d.first);
      if (isSprite(d.semantic, index, key)) continue;
      let interp = d.interp ?? 'PERSPECTIVE';
      if (interp === 'COLOR') interp = key.flatshade ? 'CONSTANT' : 'PERSPECTIVE';
      const v: Varying = { name: `v_${d.semantic}${index}`, semantic: d.semantic, index, interp, centroid: d.loc === 'CENTROID' };
      m.set(v.name, v);
      if (d.semantic === 'COLOR' && key.twoSide) m.set(`v_BCOLOR${index}`, { ...v, name: `v_BCOLOR${index}`, semantic: 'BCOLOR' });
    }
  }
  return m;
}

const isSprite = (semantic: string, index: number, key: ProgramKey) =>
  !!key.points && !!key.spriteCoordEnable && (semantic === 'GENERIC' || semantic === 'TEXCOORD') && index < 32 && ((key.spriteCoordEnable >>> index) & 1) === 1;

const qualifier = (v: Varying) => `${v.interp === 'CONSTANT' ? 'flat ' : 'smooth '}${v.centroid ? 'centroid ' : ''}`;

/** Generates the program for a vertex and a fragment shader under `key`. */
export function generate(vs: Tgsi, fs: Tgsi, key: ProgramKey): ProgramLayout {
  if (vs.stage !== 'VERT' || fs.stage !== 'FRAG') throw new TgsiError(`a program is a vertex and a fragment shader, not ${vs.stage} and ${fs.stage}`);
  const varyings = fsVaryings(fs, key);
  const v = new Gen(vs, 'vs', key, varyings);
  const f = new Gen(fs, 'fs', key, varyings);
  const vsText = v.emit();
  const fsText = f.emit();
  return {
    vs: vsText, fs: fsText,
    attribs: v.attribs,
    consts: { vs: v.const0, fs: f.const0 },
    ubos: { vs: v.ubos, fs: f.ubos },
    samplers: { vs: v.samplerList, fs: f.samplerList },
    ...(key.so?.length ? { tf: { varyings: key.so.map((_, k) => `tf_${k}`), separate: false } } : {}),
  };
}

/** The uniforms every program has (the renderer sets them by name): see `Gen.emit`. */
export const SYS_UNIFORMS = ['u_adjy', 'u_fbh', 'u_alpharef', 'u_psize', 'u_stipple'] as const;

class Gen {
  readonly out: string[] = [];
  readonly head: string[] = [];
  readonly attribs: number[] = [];
  readonly ubos = new Map<number, number>();
  const0 = 0;
  samplerList: number[] = [];
  private depth = 1;
  private temps = new Set<number>();
  private arrays = new Map<number, { first: number; last: number }>();
  private inputs = new Map<number, Decl>();
  private outputs = new Map<number, Decl>();
  private svs = new Map<number, Decl>();
  private sviews = new Map<number, Decl>();
  private samps = new Set<number>();
  private immIndirect = false;
  private helpers = new Set<string>();
  private colorWrites = new Set<number>();
  private writesAllCbufs: boolean;
  private needSys = new Set<string>();
  private loops = 0;
  private switchDepth: boolean[] = [];

  readonly t: Tgsi;
  readonly stage: 'vs' | 'fs';
  readonly key: ProgramKey;
  readonly varyings: Map<string, Varying>;

  constructor(t: Tgsi, stage: 'vs' | 'fs', key: ProgramKey, varyings: Map<string, Varying>) {
    [this.t, this.stage, this.key, this.varyings] = [t, stage, key, varyings];
    this.writesAllCbufs = t.props.get('FS_COLOR0_WRITES_ALL_CBUFS') === '1';
    for (const d of t.decls) {
      for (let k = d.first; k <= d.last; k++) {
        if (d.file === 'TEMP') this.temps.add(k);
        else if (d.file === 'IN') this.inputs.set(k, { ...d, semIndex: d.semIndex + (k - d.first) });
        else if (d.file === 'OUT') this.outputs.set(k, { ...d, semIndex: d.semIndex + (k - d.first) });
        else if (d.file === 'SV') this.svs.set(k, d);
        else if (d.file === 'SVIEW') this.sviews.set(k, d);
        else if (d.file === 'SAMP') this.samps.add(k);
      }
      if (d.file === 'TEMP' && d.arrayId) this.arrays.set(d.arrayId, { first: d.first, last: d.last });
      if (d.file === 'CONST') {
        const dim = d.dim ?? 0;
        if (dim === 0) this.const0 = Math.max(this.const0, d.last + 1);
        else this.ubos.set(dim, Math.max(this.ubos.get(dim) ?? 0, d.last + 1));
      }
      if (['IMAGE', 'BUFFER', 'MEMORY', 'HWATOMIC'].includes(d.file)) throw new TgsiError(`${d.file} declarations aren't supported (GLES 3.0)`);
    }
    // TGSI may read a TEMP outside its declarations (a range declared as an array but indexed directly).
    for (const a of this.arrays.values()) for (let k = a.first; k <= a.last; k++) this.temps.delete(k);
  }

  private line(s: string) { this.out.push('  '.repeat(this.depth) + s); }

  private sys(name: string) { this.needSys.add(name); return name; }

  // --- registers -------------------------------------------------------------------------------------------------

  /** The storage type of a register file (what a read yields before casting). */
  private storage(op: Operand): Ty {
    switch (op.file) {
      case 'TEMP': return 'f';
      case 'CONST': return 'u';
      case 'ADDR': return 'i';
      case 'IN': return this.stage === 'vs' ? this.key.attribs[op.index] ?? 'f' : this.fsInputType(op.index);
      case 'OUT': return this.stage === 'fs' ? this.fsOutType(op.index) : 'f';
      case 'SV': return this.svType(op.index);
      default: return 'f';
    }
  }

  private fsInputType(i: number): Ty {
    const d = this.inputs.get(i);
    if (d?.semantic === 'FACE') return 'f';
    return 'f';
  }

  private fsOutType(i: number): Ty {
    const d = this.outputs.get(i);
    if (d?.semantic === 'COLOR') return 'f'; // the logical color is a float vec4 of bits; the epilogue writes the typed output
    return 'f';
  }

  private svType(i: number): Ty {
    const s = this.svs.get(i)?.semantic;
    return s === 'INSTANCEID' || s === 'VERTEXID' || s === 'VERTEXID_NOBASE' || s === 'BASEVERTEX' || s === 'BASEINSTANCE' || s === 'DRAWID' || s === 'SAMPLEMASK' || s === 'SAMPLEID' ? 'i' : 'f';
  }

  private indexExpr(base: number, ind?: Indirect) {
    if (!ind) return String(base);
    const a = this.regName({ file: ind.file, index: ind.index, swizzle: [0, 1, 2, 3], neg: false, abs: false, mask: 15 });
    const scalar = ind.file === 'ADDR' ? `${a}.${COMP[ind.comp]}` : `int(${cast(a, this.storage({ file: ind.file } as Operand), 'i')}.${COMP[ind.comp]})`;
    return base ? `${scalar} + ${base}` : scalar;
  }

  /** The register as an lvalue or a 4-vector of its storage type. */
  private regName(op: Operand): string {
    switch (op.file) {
      case 'TEMP': {
        if (op.arrayId && this.arrays.has(op.arrayId)) {
          const a = this.arrays.get(op.arrayId)!;
          return `ta${op.arrayId}[${this.indexExpr(op.index - a.first, op.ind)}]`;
        }
        if (op.ind) {
          // Indirect TEMP without an array: TGSI allows it over all temps; the arrays cover what Mesa sends.
          const a = [...this.arrays.entries()].find(([, r]) => op.index >= r.first && op.index <= r.last);
          if (a) return `ta${a[0]}[${this.indexExpr(op.index - a[1].first, op.ind)}]`;
          throw new TgsiError('indirect TEMP outside a declared array');
        }
        const a = [...this.arrays.entries()].find(([, r]) => op.index >= r.first && op.index <= r.last);
        if (a) return `ta${a[0]}[${op.index - a[1].first}]`;
        this.temps.add(op.index);
        return `t${op.index}`;
      }
      case 'ADDR': return `a${op.index}`;
      case 'CONST': {
        const dim = op.dim ?? 0;
        if (op.dimInd) throw new TgsiError('indirect constant buffer selection is not supported');
        if (dim === 0) {
          if (!op.ind) this.const0 = Math.max(this.const0, op.index + 1);
          return `${this.stage[0]}c0[${this.indexExpr(op.index, op.ind)}]`;
        }
        if (!op.ind) this.ubos.set(dim, Math.max(this.ubos.get(dim) ?? 0, op.index + 1));
        return `${this.stage[0]}cb${dim}[${this.indexExpr(op.index, op.ind)}]`;
      }
      case 'IN': {
        if (op.ind) throw new TgsiError('indirect inputs are not supported');
        return this.stage === 'vs' ? `a_${op.index}` : this.fsInput(op.index);
      }
      case 'OUT': {
        if (op.ind) throw new TgsiError('indirect outputs are not supported');
        return this.stage === 'vs' ? this.vsOutput(op.index) : this.fsOutput(op.index);
      }
      case 'SV': return this.svExpr(op.index);
      case 'IMM': {
        if (!op.ind) throw new TgsiError('a direct immediate is a literal');
        this.immIndirect = true;
        return `imm[${this.indexExpr(op.index, op.ind)}]`;
      }
      default: throw new TgsiError(`${op.file} can't be read here`);
    }
  }

  /**
   * gl_FragCoord as Gallium means it. Our framebuffers' rows are stored as the guest's (row 0 first), which is
   * Gallium's upper-left origin and GL's own coordinates; a shader asking for a lower-left origin gets y flipped.
   */
  private fragCoord() {
    const lower = this.t.props.get('FS_COORD_ORIGIN') === 'LOWER_LEFT';
    const integer = this.t.props.get('FS_COORD_PIXEL_CENTER') === 'INTEGER';
    const y = lower ? `${this.sys('u_fbh')} - gl_FragCoord.y` : 'gl_FragCoord.y';
    const o = integer ? ' - 0.5' : '';
    return `vec4(gl_FragCoord.x${o}, ${y}${o}, gl_FragCoord.z, gl_FragCoord.w)`;
  }

  private fsInput(i: number): string {
    const d = this.inputs.get(i);
    if (!d?.semantic) return `in_${i}`;
    switch (d.semantic) {
      case 'POSITION': return this.fragCoord();
      case 'FACE': return 'vec4(gl_FrontFacing ? 1.0 : -1.0, 0.0, 0.0, 1.0)';
      case 'PCOORD': this.sys('u_adjy'); return 'vec4(gl_PointCoord.x, mix(1.0 - gl_PointCoord.y, gl_PointCoord.y, clamp(u_adjy, 0.0, 1.0)), 0.0, 1.0)';
      case 'PRIM_ID': return 'vec4(0.0)';
      default: {
        if (isSprite(d.semantic, d.semIndex, this.key)) {
          const y = this.key.spriteUpperLeft ? 'gl_PointCoord.y' : '1.0 - gl_PointCoord.y';
          return `vec4(gl_PointCoord.x, ${y}, 0.0, 1.0)`;
        }
        const name = `v_${d.semantic}${d.semIndex}`;
        if (!this.varyings.has(name)) return 'vec4(0.0)';
        if (d.semantic === 'COLOR' && this.key.twoSide) return `(gl_FrontFacing ? ${name} : v_BCOLOR${d.semIndex})`;
        return name;
      }
    }
  }

  private vsOutput(i: number): string {
    const d = this.outputs.get(i);
    if (!d?.semantic) return `o_${i}`;
    if (d.semantic === 'POSITION') return 'gl_Position';
    if (d.semantic === 'PSIZE') return 'o_psize';
    if (d.semantic === 'CLIPDIST' || d.semantic === 'EDGEFLAG' || d.semantic === 'VIEWPORT_INDEX' || d.semantic === 'LAYER' || d.semantic === 'CULLDIST') return `o_${i}`;
    const name = `v_${d.semantic}${d.semIndex}`;
    return this.varyings.has(name) ? name : `o_${i}`;
  }

  private fsOutput(i: number): string {
    const d = this.outputs.get(i);
    if (d?.semantic === 'COLOR') {
      this.colorWrites.add(d.semIndex);
      return `col${d.semIndex}`;
    }
    if (d?.semantic === 'POSITION') return 'o_depth';
    return `o_${i}`;
  }

  private svExpr(i: number): string {
    const s = this.svs.get(i)?.semantic;
    switch (s) {
      case 'INSTANCEID': return 'ivec4(gl_InstanceID, 0, 0, 1)';
      case 'VERTEXID': case 'VERTEXID_NOBASE': return 'ivec4(gl_VertexID, 0, 0, 1)';
      case 'BASEVERTEX': case 'BASEINSTANCE': case 'DRAWID': return 'ivec4(0, 0, 0, 1)';
      case 'FACE': return 'vec4(gl_FrontFacing ? 1.0 : -1.0, 0.0, 0.0, 1.0)';
      case 'POSITION': return this.fragCoord();
      default: throw new TgsiError(`system value ${s} isn't supported`);
    }
  }

  /** A source operand as a 4-vector of type `ty` (swizzled, cast, with its modifiers). */
  private src(op: Operand, ty: Ty): string {
    let e: string;
    if (op.file === 'IMM' && !op.ind) {
      const imm = this.t.imms[op.index];
      if (!imm) throw new TgsiError(`IMM[${op.index}] isn't declared`);
      const comps = op.swizzle.map((k) => imm.bits[k] ?? 0);
      e = ty === 'f' ? `vec4(${comps.map(floatLiteral).join(', ')})` : ty === 'u' ? `uvec4(${comps.map((b) => `${b >>> 0}u`).join(', ')})` : `ivec4(${comps.map((b) => String(b | 0)).join(', ')})`;
    } else {
      const sw = op.swizzle.join('') === '0123' ? '' : '.' + op.swizzle.map((k) => COMP[k]).join('');
      e = cast(`${this.regName(op)}${sw}`, this.storage(op), ty);
    }
    if (op.abs) e = ty === 'u' ? e : `abs(${e})`;
    if (op.neg) e = ty === 'u' ? `uvec4(-ivec4(${e}))` : `(-${e})`;
    return e;
  }

  /** Writes a 4-vector `e` of type `ty` to the destination (its mask; saturated if asked). */
  private dst(ins: Instr, e: string, ty: Ty) {
    const d = ins.dst[0];
    if (!d || d.file === 'NULL') return;
    if (ins.sat && ty === 'f') e = `clamp(${e}, 0.0, 1.0)`;
    const st = this.storage(d);
    e = cast(e, ty, st);
    const lhs = this.regName(d);
    const mask = d.mask & 15;
    if (mask === 0) return;
    if (mask === 15) {
      this.line(`${lhs} = ${e};`);
      return;
    }
    const comps = [0, 1, 2, 3].filter((k) => mask & (1 << k)).map((k) => COMP[k]).join('');
    const n = comps.length;
    const t = n === 1 ? SCALAR[st] : `${st === 'f' ? '' : st}vec${n}`;
    this.line(`${lhs}.${comps} = ${t}((${e}).${comps});`);
  }

  // --- instructions ----------------------------------------------------------------------------------------------

  private helper(name: string, code: string) {
    if (!this.helpers.has(name)) {
      this.helpers.add(name);
      this.head.push(code);
    }
  }

  private emitInstr(ins: Instr) {
    const s = (k: number, ty: Ty = 'f') => this.src(ins.src[k], ty);
    const x = (k: number, ty: Ty = 'f') => `${this.src(ins.src[k], ty)}.x`;
    const f = (e: string) => this.dst(ins, e, 'f');
    const i = (e: string) => this.dst(ins, e, 'i');
    const u = (e: string) => this.dst(ins, e, 'u');
    const rep = (e: string) => `vec4(${e})`;
    const bmask = (e: string) => `uvec4(-ivec4(${e}))`; // a bvec4 as TGSI's booleans: ~0 or 0
    switch (ins.op) {
      case 'NOP': return;
      case 'MOV': {
        const d = ins.dst[0];
        const sop = ins.src[0];
        if (ins.sat || sop.neg || sop.abs) return f(s(0));
        // A bit copy: in the source's own type, so integers keep their bits.
        const ty: Ty = sop.file === 'IMM' && !sop.ind ? (d ? this.storage(d) : 'f') : this.storage(sop);
        return this.dst(ins, s(0, ty), ty);
      }
      case 'ADD': return f(`${s(0)} + ${s(1)}`);
      case 'SUB': return f(`${s(0)} - ${s(1)}`);
      case 'MUL': return f(`${s(0)} * ${s(1)}`);
      case 'DIV': return f(`${s(0)} / ${s(1)}`);
      case 'MAD': case 'FMA': return f(`${s(0)} * ${s(1)} + ${s(2)}`);
      case 'MIN': return f(`min(${s(0)}, ${s(1)})`);
      case 'MAX': return f(`max(${s(0)}, ${s(1)})`);
      case 'LRP': return f(`mix(${s(2)}, ${s(1)}, ${s(0)})`);
      case 'DP2': return f(rep(`dot(${s(0)}.xy, ${s(1)}.xy)`));
      case 'DP3': return f(rep(`dot(${s(0)}.xyz, ${s(1)}.xyz)`));
      case 'DP4': return f(rep(`dot(${s(0)}, ${s(1)})`));
      case 'DPH': return f(rep(`dot(vec4(${s(0)}.xyz, 1.0), ${s(1)})`));
      case 'RCP': return f(rep(`1.0 / ${x(0)}`));
      case 'RSQ': return f(rep(`inversesqrt(${x(0)})`));
      case 'SQRT': return f(rep(`sqrt(${x(0)})`));
      case 'EX2': return f(rep(`exp2(${x(0)})`));
      case 'LG2': return f(rep(`log2(${x(0)})`));
      case 'POW': return f(rep(`pow(${x(0)}, ${x(1)})`));
      case 'SIN': return f(rep(`sin(${x(0)})`));
      case 'COS': return f(rep(`cos(${x(0)})`));
      case 'FRC': return f(`fract(${s(0)})`);
      case 'FLR': return f(`floor(${s(0)})`);
      case 'CEIL': return f(`ceil(${s(0)})`);
      case 'ROUND': return f(`roundEven(${s(0)})`);
      case 'TRUNC': return f(`trunc(${s(0)})`);
      case 'ABS': return f(`abs(${s(0)})`);
      case 'SSG': return f(`sign(${s(0)})`);
      case 'DDX': case 'DDX_FINE': return f(`dFdx(${s(0)})`);
      case 'DDY': case 'DDY_FINE': return f(`dFdy(${s(0)})`);
      case 'XPD': return f(`vec4(cross(${s(0)}.xyz, ${s(1)}.xyz), 1.0)`);
      case 'DST': return f(`vec4(1.0, ${s(0)}.y * ${s(1)}.y, ${s(0)}.z, ${s(1)}.w)`);
      case 'LIT': {
        this.helper('lit', 'vec4 lit(vec4 s) { float d = max(s.x, 0.0); float sp = s.x > 0.0 ? exp2(clamp(s.w, -128.0, 128.0) * log2(max(s.y, 0.0))) : 0.0; return vec4(1.0, d, sp, 1.0); }');
        return f(`lit(${s(0)})`);
      }
      case 'EXP': return f(`vec4(exp2(floor(${x(0)})), fract(${x(0)}), exp2(${x(0)}), 1.0)`);
      case 'LOG': return f(`vec4(floor(log2(abs(${x(0)}))), abs(${x(0)}) / exp2(floor(log2(abs(${x(0)})))), log2(abs(${x(0)})), 1.0)`);
      case 'CMP': return f(this.select(`lessThan(${s(0)}, vec4(0.0))`, s(1), s(2), 'f'));
      case 'SLT': return f(`vec4(lessThan(${s(0)}, ${s(1)}))`);
      case 'SGE': return f(`vec4(greaterThanEqual(${s(0)}, ${s(1)}))`);
      case 'SGT': return f(`vec4(greaterThan(${s(0)}, ${s(1)}))`);
      case 'SLE': return f(`vec4(lessThanEqual(${s(0)}, ${s(1)}))`);
      case 'SEQ': return f(`vec4(equal(${s(0)}, ${s(1)}))`);
      case 'SNE': return f(`vec4(notEqual(${s(0)}, ${s(1)}))`);
      case 'FSLT': return u(bmask(`lessThan(${s(0)}, ${s(1)})`));
      case 'FSGE': return u(bmask(`greaterThanEqual(${s(0)}, ${s(1)})`));
      case 'FSEQ': return u(bmask(`equal(${s(0)}, ${s(1)})`));
      case 'FSNE': return u(bmask(`notEqual(${s(0)}, ${s(1)})`));
      case 'ISLT': return u(bmask(`lessThan(${s(0, 'i')}, ${s(1, 'i')})`));
      case 'ISGE': return u(bmask(`greaterThanEqual(${s(0, 'i')}, ${s(1, 'i')})`));
      case 'USLT': return u(bmask(`lessThan(${s(0, 'u')}, ${s(1, 'u')})`));
      case 'USGE': return u(bmask(`greaterThanEqual(${s(0, 'u')}, ${s(1, 'u')})`));
      case 'USEQ': return u(bmask(`equal(${s(0, 'u')}, ${s(1, 'u')})`));
      case 'USNE': return u(bmask(`notEqual(${s(0, 'u')}, ${s(1, 'u')})`));
      case 'I2F': return f(`vec4(${s(0, 'i')})`);
      case 'U2F': return f(`vec4(${s(0, 'u')})`);
      case 'F2I': return i(`ivec4(${s(0)})`);
      case 'F2U': return u(`uvec4(${s(0)})`);
      case 'INEG': return i(`-${s(0, 'i')}`);
      case 'IABS': return i(`abs(${s(0, 'i')})`);
      case 'ISSG': return i(`sign(${s(0, 'i')})`);
      case 'UADD': return u(`${s(0, 'u')} + ${s(1, 'u')}`);
      case 'UMUL': return u(`${s(0, 'u')} * ${s(1, 'u')}`);
      case 'UMAD': return u(`${s(0, 'u')} * ${s(1, 'u')} + ${s(2, 'u')}`);
      case 'IMAX': return i(`max(${s(0, 'i')}, ${s(1, 'i')})`);
      case 'IMIN': return i(`min(${s(0, 'i')}, ${s(1, 'i')})`);
      case 'UMAX': return u(`max(${s(0, 'u')}, ${s(1, 'u')})`);
      case 'UMIN': return u(`min(${s(0, 'u')}, ${s(1, 'u')})`);
      case 'IDIV': {
        this.helper('idiv', 'ivec4 idiv(ivec4 a, ivec4 b) { ivec4 r; for (int k = 0; k < 4; k++) r[k] = b[k] == 0 ? -1 : a[k] / b[k]; return r; }');
        return i(`idiv(${s(0, 'i')}, ${s(1, 'i')})`);
      }
      case 'UDIV': {
        this.helper('udiv', 'uvec4 udiv(uvec4 a, uvec4 b) { uvec4 r; for (int k = 0; k < 4; k++) r[k] = b[k] == 0u ? 0xffffffffu : a[k] / b[k]; return r; }');
        return u(`udiv(${s(0, 'u')}, ${s(1, 'u')})`);
      }
      case 'MOD': {
        this.helper('imod', 'ivec4 imod(ivec4 a, ivec4 b) { ivec4 r; for (int k = 0; k < 4; k++) r[k] = b[k] == 0 ? -1 : a[k] - b[k] * (a[k] / b[k]); return r; }');
        return i(`imod(${s(0, 'i')}, ${s(1, 'i')})`);
      }
      case 'UMOD': {
        this.helper('umod', 'uvec4 umod(uvec4 a, uvec4 b) { uvec4 r; for (int k = 0; k < 4; k++) r[k] = b[k] == 0u ? 0xffffffffu : a[k] % b[k]; return r; }');
        return u(`umod(${s(0, 'u')}, ${s(1, 'u')})`);
      }
      case 'SHL': return u(`${s(0, 'u')} << (${s(1, 'u')} & uvec4(31u))`);
      case 'ISHR': return i(`${s(0, 'i')} >> ivec4(${s(1, 'u')} & uvec4(31u))`);
      case 'USHR': return u(`${s(0, 'u')} >> (${s(1, 'u')} & uvec4(31u))`);
      case 'AND': return u(`${s(0, 'u')} & ${s(1, 'u')}`);
      case 'OR': return u(`${s(0, 'u')} | ${s(1, 'u')}`);
      case 'XOR': return u(`${s(0, 'u')} ^ ${s(1, 'u')}`);
      case 'NOT': return u(`~${s(0, 'u')}`);
      case 'UCMP': {
        // A bit select: in the destination's storage type.
        const ty = this.storage(ins.dst[0]);
        return this.dst(ins, this.select(`notEqual(${s(0, 'u')}, uvec4(0u))`, s(1, ty), s(2, ty), ty), ty);
      }
      case 'ARL': return i(`ivec4(floor(${s(0)}))`);
      case 'UARL': return i(`ivec4(${s(0, 'u')})`);
      case 'IMUL_HI': {
        this.helper('imulhi', 'ivec4 imulhi(ivec4 a, ivec4 b) { ivec4 hi, lo; imulExtended(a, b, hi, lo); return hi; }');
        throw new TgsiError('IMUL_HI needs GLSL ES 3.10');
      }
      case 'UP2H': return f(`vec4(unpackHalf2x16(${x(0, 'u')}), unpackHalf2x16(${x(0, 'u')}))`);
      case 'PK2H': return u(`uvec4(packHalf2x16(${s(0)}.xy))`);
      case 'UP2US': return f(`vec4(unpackUnorm2x16(${x(0, 'u')}), unpackUnorm2x16(${x(0, 'u')}))`);
      case 'PK2US': return u(`uvec4(packUnorm2x16(${s(0)}.xy))`);
      case 'UBFE': case 'IBFE': {
        const sg = ins.op === 'IBFE';
        const t = sg ? 'i' : 'u';
        this.helper(ins.op, sg
          ? 'ivec4 ibfe(ivec4 v, ivec4 o, ivec4 b) { ivec4 r; for (int k = 0; k < 4; k++) { int bits = b[k] & 31; r[k] = bits == 0 ? 0 : (v[k] << (32 - (o[k] & 31) - bits)) >> (32 - bits); if (b[k] >= 32) r[k] = v[k]; } return r; }'
          : 'uvec4 ubfe(uvec4 v, ivec4 o, ivec4 b) { uvec4 r; for (int k = 0; k < 4; k++) { int bits = b[k] & 31; r[k] = bits == 0 ? 0u : (v[k] >> uint(o[k] & 31)) & ((1u << uint(bits)) - 1u); if (b[k] >= 32) r[k] = v[k]; } return r; }');
        return this.dst(ins, `${sg ? 'ibfe' : 'ubfe'}(${s(0, t)}, ${s(1, 'i')}, ${s(2, 'i')})`, t);
      }
      case 'BFI': {
        this.helper('bfi', 'uvec4 bfi(uvec4 base, uvec4 ins, ivec4 o, ivec4 b) { uvec4 r; for (int k = 0; k < 4; k++) { uint m = b[k] >= 32 ? 0xffffffffu : ((1u << uint(b[k])) - 1u) << uint(o[k] & 31); r[k] = (base[k] & ~m) | ((ins[k] << uint(o[k] & 31)) & m); } return r; }');
        return u(`bfi(${s(0, 'u')}, ${s(1, 'u')}, ${s(2, 'i')}, ${s(3, 'i')})`);
      }
      case 'POPC': {
        this.helper('popc', 'ivec4 popc(uvec4 v) { ivec4 r = ivec4(0); for (int k = 0; k < 4; k++) for (int b = 0; b < 32; b++) r[k] += int((v[k] >> uint(b)) & 1u); return r; }');
        return i(`popc(${s(0, 'u')})`);
      }
      case 'LSB': {
        this.helper('lsb', 'ivec4 lsb(uvec4 v) { ivec4 r = ivec4(-1); for (int k = 0; k < 4; k++) for (int b = 31; b >= 0; b--) if (((v[k] >> uint(b)) & 1u) != 0u) r[k] = b; return r; }');
        return i(`lsb(${s(0, 'u')})`);
      }
      case 'UMSB': case 'IMSB': {
        this.helper('umsb', 'ivec4 umsb(uvec4 v) { ivec4 r = ivec4(-1); for (int k = 0; k < 4; k++) for (int b = 0; b < 32; b++) if (((v[k] >> uint(b)) & 1u) != 0u) r[k] = b; return r; }');
        if (ins.op === 'UMSB') return i(`umsb(${s(0, 'u')})`);
        return i(`umsb(uvec4(${this.select(`lessThan(${s(0, 'i')}, ivec4(0))`, `~${s(0, 'i')}`, s(0, 'i'), 'i')}))`);
      }
      case 'BREV': {
        this.helper('brev', 'uvec4 brev(uvec4 v) { uvec4 r = uvec4(0u); for (int k = 0; k < 4; k++) for (int b = 0; b < 32; b++) r[k] |= ((v[k] >> uint(b)) & 1u) << uint(31 - b); return r; }');
        return u(`brev(${s(0, 'u')})`);
      }
      case 'KILL': this.line('discard;'); return;
      case 'KILL_IF': this.line(`if (any(lessThan(${s(0)}, vec4(0.0)))) discard;`); return;
      case 'IF': this.line(`if (${x(0)} != 0.0) {`); this.depth++; return;
      case 'UIF': this.line(`if (${x(0, 'u')} != 0u) {`); this.depth++; return;
      case 'ELSE': this.depth--; this.line('} else {'); this.depth++; return;
      case 'ENDIF': this.depth--; this.line('}'); return;
      case 'BGNLOOP': this.loops++; this.switchDepth.push(false); this.line('while (true) {'); this.depth++; return;
      case 'ENDLOOP': this.loops--; this.switchDepth.pop(); this.depth--; this.line('}'); return;
      case 'BRK': this.line('break;'); return;
      case 'CONT': this.line('continue;'); return;
      case 'SWITCH': this.switchDepth.push(true); this.line(`switch (${x(0, 'i')}) {`); this.depth++; return;
      case 'CASE': this.line(`case ${(this.t.imms[ins.src[0].index]?.bits[ins.src[0].swizzle[0]] ?? 0) | 0}:`); return;
      case 'DEFAULT': this.line('default:'); return;
      case 'ENDSWITCH': this.switchDepth.pop(); this.depth--; this.line('}'); return;
      case 'RET': this.line('return;'); return;
      case 'END': return;
      case 'TEX': case 'TXP': case 'TXB': case 'TXL': case 'TXD': case 'TXF': case 'TXF_LZ': case 'TEX_LZ': case 'TXQ': case 'TEX2': case 'TXB2': case 'TXL2':
        return this.texture(ins);
      default:
        throw new TgsiError(`opcode ${ins.op} isn't supported`);
    }
  }

  /** Per component: `c` (a bvec4) ? a : b. */
  private select(c: string, a: string, b: string, ty: Ty) {
    if (ty === 'f') return `mix(${b}, ${a}, ${c})`;
    this.helper(`sel${ty}`, `${VEC[ty]} sel${ty}(bvec4 c, ${VEC[ty]} a, ${VEC[ty]} b) { return ${VEC[ty]}(c.x ? a.x : b.x, c.y ? a.y : b.y, c.z ? a.z : b.z, c.w ? a.w : b.w); }`);
    return `sel${ty}(${c}, ${a}, ${b})`;
  }

  private samplerName(n: number) { return `${this.stage[0]}s${n}`; }

  private texture(ins: Instr) {
    const target = ins.tex ?? '2D';
    const unit = ins.op === 'TXQ' ? ins.src[1] : ins.op === 'TXD' ? ins.src[3] : ['TXB2', 'TXL2', 'TEX2'].includes(ins.op) ? ins.src[2] : ins.src[1];
    if (!unit || (unit.file !== 'SAMP' && unit.file !== 'SVIEW')) throw new TgsiError(`${ins.op} without a sampler`);
    const n = unit.index;
    const k = (this.stage === 'vs' ? this.key.samplers.vs : this.key.samplers.fs)[n];
    const shadow = target.startsWith('SHADOW');
    const viewRet = this.sviews.get(n)?.ret;
    const sty: Ty = k?.type ?? (viewRet === 'SINT' ? 'i' : viewRet === 'UINT' ? 'u' : 'f');
    const gl = k?.gl ?? (target.includes('CUBE') ? 'CUBE' : target === '3D' ? '3D' : target.includes('ARRAY') ? '2D_ARRAY' : '2D');
    if (['2D_MSAA', '2D_ARRAY_MSAA', 'CUBE_ARRAY', 'SHADOWCUBE_ARRAY', 'BUFFER'].includes(target)) throw new TgsiError(`texture target ${target} isn't supported (GLES 3.0)`);
    const samplerType = `${sty === 'f' ? '' : sty === 'i' ? 'i' : 'u'}sampler${gl === '2D_ARRAY' ? '2DArray' : gl === 'CUBE' ? 'Cube' : gl}${shadow ? 'Shadow' : ''}`;
    const name = this.samplerName(n);
    this.declareSampler(n, samplerType);
    const c = this.src(ins.src[0], ins.op === 'TXF' || ins.op === 'TXF_LZ' ? 'i' : 'f');
    const oneD = k?.oneD || target === '1D' || target === 'SHADOW1D' || target === '1D_ARRAY' || target === 'SHADOW1D_ARRAY';
    const rect = k?.rect || target === 'RECT' || target === 'SHADOWRECT';
    // The coordinate (and the shadow reference) in the GL target's shape.
    let coord: string, ref = '';
    const cv = `${c}`;
    const rectScale = rect && ins.op !== 'TXF' ? ` / vec2(textureSize(${name}, 0))` : '';
    switch (target) {
      case '1D': coord = `vec2(${cv}.x, 0.5)`; break;
      case 'SHADOW1D': coord = `vec2(${cv}.x, 0.5)`; ref = `${cv}.z`; break;
      case '1D_ARRAY': coord = `vec3(${cv}.x, 0.5, ${cv}.y)`; break;
      case 'SHADOW1D_ARRAY': coord = `vec3(${cv}.x, 0.5, ${cv}.y)`; ref = `${cv}.z`; break;
      case '2D': case 'RECT': coord = `${cv}.xy${rectScale}`; break;
      case 'SHADOW2D': case 'SHADOWRECT': coord = `${cv}.xy${rectScale}`; ref = `${cv}.z`; break;
      case '2D_ARRAY': case '3D': case 'CUBE': coord = `${cv}.xyz`; break;
      case 'SHADOW2D_ARRAY': case 'SHADOWCUBE': coord = `${cv}.xyz`; ref = `${cv}.w`; break;
      default: coord = `${cv}.xy`;
    }
    void oneD;
    const dims = gl === '2D' ? 2 : 3;
    let call: string;
    const offs = ins.offsets[0] ? this.offsetLiteral(ins.offsets[0], gl === '3D' ? 3 : 2) : '';
    const off = (fn: string) => (offs ? `${fn}Offset` : fn);
    const withRef = (cc: string) => (ref ? `vec${dims + 1}(${cc}, ${ref})` : cc);
    switch (ins.op) {
      case 'TEX': case 'TEX2': call = `${off('texture')}(${name}, ${withRef(coord)}${offs ? `, ${offs}` : ''})`; break;
      case 'TEX_LZ': call = `${off('textureLod')}(${name}, ${withRef(coord)}, 0.0${offs ? `, ${offs}` : ''})`; break;
      case 'TXP': {
        // Projective: divide by w ourselves (textureProj doesn't take arrays, cubes or our 1D stand-ins).
        const p = `(${c} / ${c}.w)`;
        const cc = target === '1D' || target === 'SHADOW1D' ? `vec2(${p}.x, 0.5)` : dims === 2 ? `${p}.xy${rectScale}` : `${p}.xyz`;
        call = `${off('texture')}(${name}, ${ref ? `vec${dims + 1}(${cc}, ${p}.z)` : cc}${offs ? `, ${offs}` : ''})`;
        break;
      }
      case 'TXB': case 'TXB2': {
        const bias = ins.op === 'TXB2' ? `${this.src(ins.src[1], 'f')}.x` : `${cv}.w`;
        call = `${off('texture')}(${name}, ${withRef(coord)}${offs ? `, ${offs}` : ''}, ${bias})`;
        break;
      }
      case 'TXL': case 'TXL2': {
        const lod = ins.op === 'TXL2' ? `${this.src(ins.src[1], 'f')}.x` : `${cv}.w`;
        call = `${off('textureLod')}(${name}, ${withRef(coord)}, ${lod}${offs ? `, ${offs}` : ''})`;
        break;
      }
      case 'TXD': {
        const sz = gl === '2D' ? 'xy' : 'xyz';
        call = `${off('textureGrad')}(${name}, ${withRef(coord)}, ${this.src(ins.src[1], 'f')}.${sz}, ${this.src(ins.src[2], 'f')}.${sz}${offs ? `, ${offs}` : ''})`;
        break;
      }
      case 'TXF': case 'TXF_LZ': {
        const ic = target === '1D' ? `ivec2(${c}.x, 0)` : target === '1D_ARRAY' ? `ivec3(${c}.x, 0, ${c}.y)` : dims === 2 ? `${c}.xy` : `${c}.xyz`;
        const lod = ins.op === 'TXF_LZ' || rect ? '0' : `${c}.w`;
        call = `${offs ? 'texelFetchOffset' : 'texelFetch'}(${name}, ${ic}, ${lod}${offs ? `, ${offs}` : ''})`;
        break;
      }
      case 'TXQ': {
        const lod = `${this.src(ins.src[0], 'i')}.x`;
        const size = `textureSize(${name}, ${lod})`;
        const v = target === '1D' ? `ivec4(${size}.x, 0, 0, 0)` : dims === 2 || target === '1D_ARRAY' ? `ivec4(${size}.xy, 0, 0)` : `ivec4(${size}, 0)`;
        return this.dst(ins, v, 'i');
      }
      default: throw new TgsiError(`texture opcode ${ins.op}`);
    }
    // The sampled value as a 4-vector, then the key's swizzle (the format's and the view's).
    const val = shadow ? `vec4(${call}, 0.0, 0.0, 1.0)` : call;
    const sw = k?.swizzle ?? [0, 1, 2, 3];
    const vt = shadow ? 'f' : sty;
    const one = vt === 'f' ? '1.0' : vt === 'i' ? '1' : '1u', zero = vt === 'f' ? '0.0' : vt === 'i' ? '0' : '0u';
    let e = val;
    if (sw.join('') !== '0123') {
      const tmp = `tx${this.texTmp++}`;
      this.line(`${VEC[vt]} ${tmp} = ${val};`);
      e = `${VEC[vt]}(${sw.map((q) => (q === 4 ? zero : q === 5 ? one : `${tmp}.${COMP[q]}`)).join(', ')})`;
    }
    this.dst(ins, e, vt);
  }
  private texTmp = 0;

  private offsetLiteral(op: Operand, n: number) {
    if (op.file !== 'IMM') throw new TgsiError('texel offsets must be immediates');
    const imm = this.t.imms[op.index];
    const v = op.swizzle.slice(0, n).map((k) => (imm.bits[k] ?? 0) | 0);
    return `ivec${n}(${v.join(', ')})`;
  }

  private declared = new Map<number, string>();
  private declareSampler(n: number, type: string) {
    const prev = this.declared.get(n);
    if (prev && prev !== type) throw new TgsiError(`sampler ${n} used as ${prev} and ${type}`);
    this.declared.set(n, type);
  }

  // --- the whole shader ------------------------------------------------------------------------------------------

  emit(): string {
    const body: string[] = [];
    // The instructions first: they tell which registers and samplers are used.
    this.depth = 1;
    for (const ins of this.t.instrs) this.emitInstr(ins);
    body.push(...this.out);
    const h: string[] = ['#version 300 es', 'precision highp float;', 'precision highp int;'];
    for (const p of ['sampler3D', 'sampler2DArray', 'sampler2DShadow', 'samplerCubeShadow', 'sampler2DArrayShadow', 'isampler2D', 'isampler3D', 'isamplerCube', 'isampler2DArray', 'usampler2D', 'usampler3D', 'usamplerCube', 'usampler2DArray']) h.push(`precision highp ${p};`);
    const st = this.stage[0];
    // System values (the renderer sets them by name: SYS_UNIFORMS).
    if (this.stage === 'vs') this.needSys.add('u_adjy');
    if (this.stage === 'vs' && this.key.points && !this.writesPointSize()) this.needSys.add('u_psize');
    if (this.stage === 'fs' && this.key.alphaFunc !== undefined && this.key.alphaFunc !== 7) this.needSys.add('u_alpharef');
    if (this.stage === 'fs' && this.key.stipple) { this.needSys.add('u_stipple'); this.needSys.add('u_fbh'); }
    for (const u of this.needSys) h.push(u === 'u_stipple' ? 'uniform uint u_stipple[32];' : `uniform float ${u};`);
    // Constants: buffer 0 as a uniform array of bits, the others as uniform blocks.
    if (this.const0 > 0) h.push(`uniform uvec4 ${st}c0[${this.const0}];`);
    for (const [k, n] of [...this.ubos].sort((a, b) => a[0] - b[0])) h.push(`layout(std140) uniform ${st.toUpperCase()}B${k} { uvec4 ${st}cb${k}[${n}]; };`);
    for (const [n, type] of [...this.declared].sort((a, b) => a[0] - b[0])) h.push(`uniform highp ${type} ${this.samplerName(n)};`);
    this.samplerList = [...this.declared.keys()].sort((a, b) => a - b);
    if (this.immIndirect) h.push(`const uvec4 imm[${this.t.imms.length}] = uvec4[${this.t.imms.length}](${this.t.imms.map((m) => `uvec4(${[0, 1, 2, 3].map((k) => `${(m.bits[k] ?? 0) >>> 0}u`).join(', ')})`).join(', ')});`);
    // Inputs and outputs.
    const epilogue: string[] = [];
    if (this.stage === 'vs') {
      for (const [k] of [...this.inputs].sort((a, b) => a[0] - b[0])) {
        const ty = this.key.attribs[k] ?? 'f';
        h.push(`layout(location = ${k}) in ${VEC[ty]} a_${k};`);
        this.attribs.push(k);
      }
      const written = new Set<string>();
      for (const [k, d] of [...this.outputs].sort((a, b) => a[0] - b[0])) {
        const name = this.vsOutput(k);
        // The point size is declared below, once (with GL's default).
        if (name === 'gl_Position' || name === 'o_psize') continue;
        if (name.startsWith('v_')) {
          const vy = this.varyings.get(name)!;
          h.push(`${qualifier(vy)}out vec4 ${name};`);
          written.add(name);
        } else h.push(`vec4 ${name} = vec4(0.0);`);
        void d;
      }
      // Varyings the fragment shader reads and this one doesn't write: zero.
      for (const vy of this.varyings.values()) {
        if (written.has(vy.name)) continue;
        h.push(`${qualifier(vy)}out vec4 ${vy.name};`);
        epilogue.push(`${vy.name} = ${vy.semantic === 'COLOR' || vy.semantic === 'BCOLOR' ? 'vec4(0.0, 0.0, 0.0, 1.0)' : 'vec4(0.0, 0.0, 0.0, 1.0)'};`);
        // A varying written in the epilogue must not overwrite one written in the body: only unwritten ones get here.
      }
      if (this.key.points) epilogue.push(this.writesPointSize() ? 'gl_PointSize = o_psize.x;' : 'gl_PointSize = u_psize;');
      if (this.writesPointSize() && !this.key.points) epilogue.push('// point size unused');
      if (this.writesPointSize()) h.push('vec4 o_psize = vec4(1.0);');
      // Stream output: the components captured, as the shader wrote them (before the position is flipped).
      (this.key.so ?? []).forEach((o, k) => {
        // As bits: an integer's survive (a float captured would canonicalize a NaN's pattern).
        h.push(`flat out highp ${o.comps === 1 ? 'uint' : `uvec${o.comps}`} tf_${k};`);
        epilogue.push(`tf_${k} = floatBitsToUint(${this.vsOutput(o.reg)}.${'xyzw'.slice(o.start, o.start + o.comps)});`);
      });
      epilogue.push('gl_Position.y *= u_adjy;');
    } else {
      for (const vy of this.varyings.values()) h.push(`${qualifier(vy)}in vec4 ${vy.name};`);
      for (const [k, d] of [...this.inputs].sort((a, b) => a[0] - b[0])) {
        if (!d.semantic) h.push(`vec4 in_${k} = vec4(0.0);`);
      }
      // Color outputs: the logical colors (col<n>, float bits) go out through each buffer's swizzle and type.
      const cbufs = this.key.cbufs;
      const colors = new Set<number>([...this.outputs.values()].filter((d) => d.semantic === 'COLOR').map((d) => d.semIndex));
      for (const n of colors) h.push(`vec4 col${n} = vec4(0.0);`);
      const sources = cbufs.map((_, k) => (this.writesAllCbufs ? (colors.has(0) ? 0 : -1) : colors.has(k) ? k : -1));
      if (this.key.alphaFunc !== undefined && this.key.alphaFunc !== 7 && colors.has(0)) {
        const op = ['', '<', '==', '<=', '>', '!=', '>='][this.key.alphaFunc];
        epilogue.push(this.key.alphaFunc === 0 ? 'discard;' : `if (!(col0.w ${op} u_alpharef)) discard;`);
      }
      if (this.key.stipple) epilogue.push('if (((u_stipple[int(mod(u_fbh - gl_FragCoord.y, 32.0))] >> uint(31 - int(mod(gl_FragCoord.x, 32.0)))) & 1u) == 0u) discard;');
      cbufs.forEach((cb, k) => {
        if (!cb) return;
        const ty = cb.type;
        h.push(`layout(location = ${k}) out ${VEC[ty]} o${k};`);
        const src = sources[k];
        if (src < 0) {
          epilogue.push(`o${k} = ${VEC[ty]}(0);`);
          return;
        }
        let c = `col${src}`;
        if (this.key.clampColor && ty === 'f') c = `clamp(${c}, 0.0, 1.0)`;
        const comps = cb.write.map((q) => (q < 0 ? (ty === 'f' ? '1.0' : ty === 'i' ? '1' : '1u') : `${cast(c, 'f', ty)}.${COMP[q]}`));
        while (comps.length < 4) comps.push(ty === 'f' ? '0.0' : ty === 'i' ? '0' : '0u');
        epilogue.push(`o${k} = ${VEC[ty]}(${comps.join(', ')});`);
      });
      const depth = [...this.outputs.values()].some((d) => d.semantic === 'POSITION');
      if (depth) {
        h.push('vec4 o_depth = vec4(0.0);');
        epilogue.push('gl_FragDepth = o_depth.z;');
      }
      for (const [k, d] of this.outputs) if (d.semantic !== 'COLOR' && d.semantic !== 'POSITION') h.push(`vec4 o_${k} = vec4(0.0);`);
    }
    // Registers.
    for (const k of [...this.temps].sort((a, b) => a - b)) h.push(`vec4 t${k} = vec4(0.0);`);
    for (const [id, r] of this.arrays) h.push(`vec4 ta${id}[${r.last - r.first + 1}];`);
    for (const d of this.t.decls) if (d.file === 'ADDR') for (let k = d.first; k <= d.last; k++) h.push(`ivec4 a${k} = ivec4(0);`);
    h.push(...this.head);
    return [...h, 'void body() {', ...body, '}', 'void main() {', '  body();', ...epilogue.map((l) => `  ${l}`), '}', ''].join('\n');
  }

  private writesPointSize() {
    return this.stage === 'vs' && [...this.outputs.values()].some((d) => d.semantic === 'PSIZE');
  }
}
