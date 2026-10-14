// The virgl renderer on WebGL2 (docs/plans/graphics.md §1, §20; docs/devices.md "virgl"): Mesa's virgl command
// stream (virglrenderer's virgl_protocol.h) decoded and run on one WebGL2 context. The decoder and the state model
// follow virglrenderer's vrend_decode.c and vrend_renderer.c (MIT, THIRD_PARTY.md): contexts with sub-contexts that
// own the objects (shaders, blend, depth-stencil-alpha and rasterizer states, vertex elements, sampler views and
// states, surfaces, queries), resources shared by the contexts they're attached to, and the GL state set from the
// sub-context at each draw (one WebGL2 context serves every guest context, so nothing is assumed bound across
// draws). Resources are guest-backed: uploads read the guest's pages (a staging buffer's for COPY_TRANSFER3D, the
// resource's own for TRANSFER3D), read-backs write them, before the submit's fence signals.
//
// WebGL2 is below what virglrenderer assumes of GLES 3.0 in places, and this is where it's made up for: a buffer
// can't be both an index buffer and anything else (buffers keep a CPU copy, and an element buffer is made from it
// when drawn with); vertex buffers with a zero stride (a constant attribute) are read from the copy; no BGRA, no
// texture swizzle, no 1D or rectangle textures (web/virgl-formats.ts, web/virgl-tgsi.ts); no base vertex (indices
// rebased on the CPU); no border colors (edge clamp); one blend state for all color buffers.
import { E } from './gl-enums.ts';
import { FORMATS, GL, VERTEX_FORMATS, boxBytes, type Format, SW_0, SW_1 } from './virgl-formats.ts';
import { generate, parseTgsi, samplerUnit, uboBinding, type ProgramKey, type ProgramLayout, type SamplerKey, type Tgsi } from './virgl-tgsi.ts';
import { VideoContext, type DecodedPicture, type DecoderFactory, type VideoStats } from './virgl-video.ts';

/** A resource's guest pages: offsets into guest RAM and lengths. */
export type Backing = { off: number; len: number }[];

export type ResourceDesc = {
  id: number; target: number; format: number; bind: number; width: number; height: number;
  depth: number; arraySize: number; lastLevel: number; samples: number; flags: number;
};

export type Box = { x: number; y: number; z: number; w: number; h: number; d: number };

/** What a renderer does with the device's commands (the device worker calls these through `VirglHost`). */
export type RendererStats = { submits: number; commands: number; draws: number; errors: number; programs: number; uploads: number; uploadBytes: number; readbacks: number; readbackBytes: number; compileMs: number };

type Res = ResourceDesc & {
  fmt?: Format;
  backing: Backing | null;
  /** A buffer: its GL buffer (ARRAY_BUFFER and the like), its CPU copy, and an element-array twin made on demand. */
  buf?: WebGLBuffer; shadow?: Uint8Array; ibuf?: WebGLBuffer; idirty?: boolean;
  /** Whether ranges of an index buffer hold the type's largest index (`holdsMax`), by offset, count and size. */
  imax?: Map<string, boolean>;
  /** A texture (or a renderbuffer, multisampled or stencil-only). */
  tex?: WebGLTexture; glTarget?: number; rb?: WebGLRenderbuffer;
  /** A multisampled resource sampled: its resolved texture, made again at each draw that samples it. */
  msResolved?: Res;
  /** A format WebGL can't render to (so no framebuffer reads it): its uploaded texels by level, for copies from it. */
  texels?: Map<number, Uint8Array>;
  /** Contexts holding it (unref'd by the guest while attached somewhere: the GL objects live until the last goes). */
  refs: Set<number>;
  dead?: boolean;
};

type Blend = { independent: boolean; logicop: boolean; alphaToCoverage: boolean; rt: { enable: boolean; rgbFunc: number; rgbSrc: number; rgbDst: number; aFunc: number; aSrc: number; aDst: number; mask: number }[] };
type Dsa = { depth: { enabled: boolean; write: boolean; func: number }; alpha: { enabled: boolean; func: number; ref: number }; stencil: { enabled: boolean; func: number; fail: number; zpass: number; zfail: number; valueMask: number; writeMask: number }[] };
type Rasterizer = {
  flatshade: boolean; depthClip: boolean; discard: boolean; lightTwoSide: boolean; spriteUpperLeft: boolean; pointQuad: boolean;
  cullFace: number; scissor: boolean; frontCcw: boolean; clampFragmentColor: boolean; offsetTri: boolean; stipple: boolean;
  pointSizePerVertex: boolean; multisample: boolean; pointSize: number; spriteCoordEnable: number; lineWidth: number;
  offsetUnits: number; offsetScale: number;
};
type Shader = { serial: number; type: number; tgsi?: Tgsi; error?: string; text: string; expected: number; so?: { strides: number[]; outputs: { reg: number; start: number; comps: number; buffer: number; offset: number }[] } };
type VertexElements = { offset: number; divisor: number; vb: number; format: number }[];
type SamplerView = { res: number; format: number; target: number; first: number; last: number; firstLevel: number; lastLevel: number; swizzle: number[] };
type SamplerState = { wrap: number[]; minImg: number; minMip: number; magImg: number; compare: boolean; compareFunc: number; maxAniso: number; lodBias: number; minLod: number; maxLod: number; sampler?: WebGLSampler };
type Surface = { res: number; format: number; level: number; firstLayer: number; lastLayer: number };
type Query = { type: number; index: number; res: number; offset: number; q?: WebGLQuery; target?: number; pending?: boolean; result: number };
/** A stream output target: a buffer's range, and the bytes written into it since it was last bound without append. */
type SoTarget = { res: number; offset: number; size: number; filled: number };
type SoOutput = NonNullable<Shader['so']>['outputs'][number];
/**
 * How a draw's stream output goes to WebGL2: every output captured interleaved, as bits, into one scratch buffer
 * (`total` words a vertex, in `outputs`' order), then scattered into its target at its offset (`targets`: each buffer
 * index used, its stride in words). GLES 3.0's own layouts (one buffer packed, or one output a buffer, a few words
 * each) can't express Gallium's (several outputs a buffer, several buffers, gaps).
 */
type SoPlan = { outputs: SoOutput[]; total: number; targets: { buffer: number; t: SoTarget; r: Res; stride: number }[] };
type Obj =
  | { kind: 'blend'; v: Blend } | { kind: 'dsa'; v: Dsa } | { kind: 'rs'; v: Rasterizer } | { kind: 'shader'; v: Shader }
  | { kind: 've'; v: VertexElements } | { kind: 'view'; v: SamplerView } | { kind: 'sampler'; v: SamplerState }
  | { kind: 'surface'; v: Surface } | { kind: 'query'; v: Query } | { kind: 'so'; v: SoTarget };

type Stage = 'vs' | 'fs';
type Sub = {
  id: number;
  objects: Map<number, Obj>;
  shaders: { vs?: Shader; fs?: Shader };
  blend?: Blend; dsa?: Dsa; rs?: Rasterizer; ve?: VertexElements;
  vbs: { stride: number; offset: number; res: number }[];
  ib: { res: number; size: number; offset: number } | null;
  consts: Record<Stage, Uint32Array>;
  ubos: Record<Stage, Map<number, { res: number; offset: number; length: number }>>;
  views: Record<Stage, (SamplerView | undefined)[]>;
  samplers: Record<Stage, (SamplerState | undefined)[]>;
  fb: { cbufs: (Surface | undefined)[]; zs?: Surface };
  viewport: { scale: number[]; translate: number[] };
  scissor: { minx: number; miny: number; maxx: number; maxy: number };
  stencilRef: [number, number];
  blendColor: number[];
  stipple: Uint32Array;
  sampleMask: number;
  so: { targets: (SoTarget | undefined)[]; tf?: WebGLTransformFeedback; seen: Set<string> };
  vao?: WebGLVertexArrayObject;
  /** A long shader arriving in pieces (VIRGL_OBJ_SHADER_OFFSET_CONT), by stage. */
  longShader: Map<number, { handle: number; shader: Shader }>;
};
type Ctx = { id: number; subs: Map<number, Sub>; sub: Sub; attached: Set<number>; video?: VideoContext };

type Program = { prog: WebGLProgram; layout: ProgramLayout; loc: Map<string, WebGLUniformLocation | null> };

const PIPE_BUFFER = 0, PIPE_TEXTURE_1D = 1, PIPE_TEXTURE_2D = 2, PIPE_TEXTURE_3D = 3, PIPE_TEXTURE_CUBE = 4, PIPE_TEXTURE_RECT = 5;
const PIPE_TEXTURE_1D_ARRAY = 6, PIPE_TEXTURE_2D_ARRAY = 7;
const BIND_STAGING = 1 << 19, BIND_INDEX = 1 << 5;
const SHADER_VERTEX = 0, SHADER_FRAGMENT = 1;
/** Texture units: the fragment shader's samplers from 0, the vertex shader's from here. */
const VS_UNIT_BASE = 16;

const BLEND_FACTOR: Record<number, number> = {
  0x1: E.ONE, 0x2: E.SRC_COLOR, 0x3: E.SRC_ALPHA, 0x4: E.DST_ALPHA, 0x5: E.DST_COLOR, 0x6: E.SRC_ALPHA_SATURATE,
  0x7: E.CONSTANT_COLOR, 0x8: E.CONSTANT_ALPHA, 0x11: E.ZERO, 0x12: E.ONE_MINUS_SRC_COLOR, 0x13: E.ONE_MINUS_SRC_ALPHA,
  0x14: E.ONE_MINUS_DST_ALPHA, 0x15: E.ONE_MINUS_DST_COLOR, 0x17: E.ONE_MINUS_CONSTANT_COLOR, 0x18: E.ONE_MINUS_CONSTANT_ALPHA,
};
const BLEND_FUNC = [E.FUNC_ADD, E.FUNC_SUBTRACT, E.FUNC_REVERSE_SUBTRACT, E.MIN, E.MAX];
const COMPARE = [E.NEVER, E.LESS, E.EQUAL, E.LEQUAL, E.GREATER, E.NOTEQUAL, E.GEQUAL, E.ALWAYS];
/** A blend's source RGB factor to fold into the shader (`ProgramKey.blendSrc`): when it and the destination's mix constant color and constant alpha. */
function foldedBlend(blend?: Blend): number | undefined {
  const rt = blend?.rt[0];
  if (!rt?.enable) return undefined;
  const kind = (g: number) => (g === 7 || g === 0x17 ? 'color' : g === 8 || g === 0x18 ? 'alpha' : undefined);
  const s = kind(rt.rgbSrc), d = kind(rt.rgbDst);
  return s && d && s !== d ? rt.rgbSrc : undefined;
}

/** Query types as virgl numbers them (VIRGL_QUERY_*: not Gallium's PIPE_QUERY_*, whose PRIMITIVES_GENERATED is 6). */
const Q_OCCLUSION_COUNTER = 0, Q_OCCLUSION_PREDICATE = 1, Q_GENERATED = 5, Q_EMITTED = 6, Q_OCCLUSION_CONSERVATIVE = 11;
const STENCIL_OP = [E.KEEP, E.ZERO, E.REPLACE, E.INCR, E.DECR, E.INCR_WRAP, E.DECR_WRAP, E.INVERT];
const WRAP = [E.REPEAT, E.CLAMP_TO_EDGE, E.CLAMP_TO_EDGE, E.CLAMP_TO_EDGE, E.MIRRORED_REPEAT, E.MIRRORED_REPEAT, E.MIRRORED_REPEAT, E.MIRRORED_REPEAT];
const PRIM = [E.POINTS, E.LINES, E.LINE_LOOP, E.LINE_STRIP, E.TRIANGLES, E.TRIANGLE_STRIP, E.TRIANGLE_FAN];
/** The primitives `n` vertices make, per Gallium primitive (PRIM's order). */
const primitives = (mode: number, n: number) => [n, n >> 1, n >= 2 ? n : 0, Math.max(0, n - 1), Math.floor(n / 3), Math.max(0, n - 2), Math.max(0, n - 2)][mode] ?? 0;

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const uif = (b: number) => { u32[0] = b; return f32[0]; };

/** The typed-array view WebGL wants for pixel data of a GL type. */
function viewFor(type: number, bytes: Uint8Array): ArrayBufferView | null {
  const size = type === E.UNSIGNED_BYTE || type === E.BYTE ? 1 : [E.UNSIGNED_SHORT, E.SHORT, E.HALF_FLOAT, 0x8363, 0x8033, 0x8034].includes(type) ? 2 : 4;
  if (bytes.byteOffset % size) bytes = bytes.slice();
  const buf = bytes.buffer, off = bytes.byteOffset, n = Math.floor(bytes.byteLength / size);
  switch (type) {
    case E.UNSIGNED_BYTE: return bytes;
    case E.BYTE: return new Int8Array(buf, off, n);
    case E.SHORT: return new Int16Array(buf, off, n);
    case E.INT: return new Int32Array(buf, off, n);
    case E.FLOAT: return new Float32Array(buf, off, n);
    case 0x8dad: return null; // FLOAT_32_UNSIGNED_INT_24_8_REV: WebGL takes no data for it
    default: return size === 2 ? new Uint16Array(buf, off, n) : new Uint32Array(buf, off, n);
  }
}

export class VirglRenderer {
  readonly gl: WebGL2RenderingContext;
  private ram: () => Uint8Array;
  private log: (m: string) => void;
  readonly resources = new Map<number, Res>();
  private contexts = new Map<number, Ctx>();
  private programs = new Map<string, Program | null>();
  private serial = 0;
  readonly stats: RendererStats = { submits: 0, commands: 0, draws: 0, errors: 0, programs: 0, uploads: 0, uploadBytes: 0, readbacks: 0, readbackBytes: 0, compileMs: 0 };
  /** The contexts' video codecs and buffers, and the pictures decoded (web/virgl-video.ts). */
  readonly videoStats: VideoStats = { codecs: 0, buffers: 0, frames: 0, decoded: 0, dropped: 0, bitstreamBytes: 0, errors: 0 };
  /** The video decoders (the GPU worker's WebCodecs; none: pictures are only counted) and the profiles decoded in hardware. */
  private video?: { decoders: DecoderFactory; hardware: readonly number[] };
  /** Called when a picture is written or given up (the GPU worker's queue goes on: `videoWaiting`). */
  onVideoSettled?: () => void;
  private fbo: WebGLFramebuffer;
  private readFbo: WebGLFramebuffer;
  private blitProg?: { prog: WebGLProgram; loc: Map<string, WebGLUniformLocation | null> };
  private anisotropy: boolean;
  private colorBufferFloat: boolean;
  private readonly maxSamples: number;
  private queries: Query[] = [];
  /** Primitive queries (generated, emitted by stream output) counted by the draws, with their context. */
  private counting = new Map<Query, number>();
  /** A framebuffer for draws that only capture (stream output with nothing bound to draw on). */
  private nullFbo?: WebGLFramebuffer;
  private errorsLogged = 0;
  private errorKinds = new Map<string, number>();

  /** A trace of what the guest makes and draws with, each line once (`?gpu=virgl,debug`): resources, surfaces, views, draws. */
  private debug?: (m: string) => void;

  constructor(gl: WebGL2RenderingContext, o: { ram: () => Uint8Array; log?: (m: string) => void; debug?: (m: string) => void; video?: { decoders: DecoderFactory; hardware: readonly number[] } }) {
    this.gl = gl;
    this.ram = o.ram;
    this.video = o.video;
    this.debug = o.debug;
    this.log = o.log ?? ((m) => console.warn(`virgl: ${m}`));
    this.fbo = gl.createFramebuffer()!;
    this.readFbo = gl.createFramebuffer()!;
    this.anisotropy = !!gl.getExtension('EXT_texture_filter_anisotropic');
    this.colorBufferFloat = !!gl.getExtension('EXT_color_buffer_float');
    this.maxSamples = gl.getParameter(E.MAX_SAMPLES) as number;
    gl.getExtension('EXT_color_buffer_half_float');
    gl.getExtension('EXT_texture_norm16');
    gl.getExtension('OES_texture_float_linear');
    for (const e of ['WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb', 'WEBGL_compressed_texture_etc', 'EXT_texture_compression_rgtc', 'EXT_texture_compression_bptc']) gl.getExtension(e);
    gl.pixelStorei(E.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(E.PACK_ALIGNMENT, 1);
  }

  /** Logged: each kind of error (its first 40 characters) 5 times, 200 in all (one noisy kind hid the others). */
  private error(m: string) {
    this.stats.errors++;
    const kind = m.slice(0, 40), n = this.errorKinds.get(kind) ?? 0;
    this.errorKinds.set(kind, n + 1);
    if (n < 5 && this.errorsLogged++ < 200) this.log(m);
  }

  // --- contexts --------------------------------------------------------------------------------------------------

  createContext(id: number) {
    if (this.contexts.has(id)) return false;
    const sub = this.newSub(0);
    this.contexts.set(id, { id, subs: new Map([[0, sub]]), sub, attached: new Set() });
    return true;
  }

  destroyContext(id: number) {
    const c = this.contexts.get(id);
    if (!c) return false;
    for (const s of c.subs.values()) this.destroySub(s);
    c.video?.destroy();
    for (const r of c.attached) this.detach(id, r);
    this.contexts.delete(id);
    return true;
  }

  get contextCount() { return this.contexts.size; }

  /** A virtio reset: every context and resource is gone. */
  reset() {
    for (const id of [...this.contexts.keys()]) this.destroyContext(id);
    for (const id of [...this.resources.keys()]) this.unrefResource(id);
    this.queries = [];
    this.counting.clear();
  }

  private newSub(id: number): Sub {
    return {
      id, objects: new Map(), shaders: {}, vbs: [], ib: null,
      consts: { vs: new Uint32Array(0), fs: new Uint32Array(0) },
      ubos: { vs: new Map(), fs: new Map() },
      views: { vs: [], fs: [] }, samplers: { vs: [], fs: [] },
      fb: { cbufs: [] }, viewport: { scale: [1, 1, 1], translate: [0, 0, 0] }, scissor: { minx: 0, miny: 0, maxx: 0, maxy: 0 },
      stencilRef: [0, 0], blendColor: [0, 0, 0, 0], stipple: new Uint32Array(32).fill(0xffffffff), sampleMask: ~0,
      so: { targets: [], seen: new Set() }, longShader: new Map(),
    };
  }

  private destroySub(s: Sub) {
    for (const o of s.objects.values()) this.destroyObject(o);
    if (s.vao) this.gl.deleteVertexArray(s.vao);
    if (s.so.tf) this.gl.deleteTransformFeedback(s.so.tf);
  }

  private destroyObject(o: Obj) {
    if (o.kind === 'sampler' && o.v.sampler) this.gl.deleteSampler(o.v.sampler);
    if (o.kind === 'query' && o.v.q) this.gl.deleteQuery(o.v.q);
    if (o.kind === 'query') {
      this.counting.delete(o.v);
      // A deleted query never has its result: pending, it would hold every later fence (FenceGate) for good, and the
      // guest's control queue filled behind them (dEQP-GLES3 hung at a context's end).
      o.v.pending = false;
      this.queries = this.queries.filter((q) => q !== o.v);
    }
  }

  // --- resources -------------------------------------------------------------------------------------------------

  createResource(d: ResourceDesc): boolean {
    if (this.resources.has(d.id)) return false;
    const gl = this.gl;
    const res: Res = { ...d, fmt: FORMATS.get(d.format), backing: null, refs: new Set() };
    this.debug?.(`resource ${d.id} ${res.fmt?.name ?? d.format} ${d.width}x${d.height} target ${d.target} bind ${d.bind.toString(16)}`);
    this.resources.set(d.id, res);
    if (d.target === PIPE_BUFFER) {
      // A staging buffer is only ever the guest's pages.
      if (d.bind & BIND_STAGING) return true;
      res.shadow = new Uint8Array(d.width);
      res.buf = gl.createBuffer()!;
      gl.bindBuffer(E.COPY_WRITE_BUFFER, res.buf);
      gl.bufferData(E.COPY_WRITE_BUFFER, d.width, E.DYNAMIC_DRAW);
      res.idirty = true;
      return true;
    }
    const f = res.fmt;
    if (!f) {
      this.error(`resource ${d.id}: format ${d.format} isn't supported`);
      return true; // the guest's object exists; using it reports errors
    }
    const levels = d.lastLevel + 1;
    if (d.samples > 1 || f.kind === 'stencil') {
      res.rb = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(E.RENDERBUFFER, res.rb);
      if (d.samples > 1) gl.renderbufferStorageMultisample(E.RENDERBUFFER, Math.min(d.samples, this.maxSamples), f.internal, d.width, d.height);
      else gl.renderbufferStorage(E.RENDERBUFFER, f.internal, d.width, d.height);
      return true;
    }
    res.tex = gl.createTexture()!;
    switch (d.target) {
      case PIPE_TEXTURE_1D: case PIPE_TEXTURE_2D: case PIPE_TEXTURE_RECT:
        res.glTarget = E.TEXTURE_2D;
        gl.bindTexture(E.TEXTURE_2D, res.tex);
        gl.texStorage2D(E.TEXTURE_2D, levels, f.internal, d.width, d.target === PIPE_TEXTURE_1D ? 1 : d.height);
        break;
      case PIPE_TEXTURE_CUBE:
        res.glTarget = E.TEXTURE_CUBE_MAP;
        gl.bindTexture(E.TEXTURE_CUBE_MAP, res.tex);
        gl.texStorage2D(E.TEXTURE_CUBE_MAP, levels, f.internal, d.width, d.height);
        break;
      case PIPE_TEXTURE_3D:
        res.glTarget = E.TEXTURE_3D;
        gl.bindTexture(E.TEXTURE_3D, res.tex);
        gl.texStorage3D(E.TEXTURE_3D, levels, f.internal, d.width, d.height, d.depth);
        break;
      case PIPE_TEXTURE_1D_ARRAY: case PIPE_TEXTURE_2D_ARRAY:
        res.glTarget = E.TEXTURE_2D_ARRAY;
        gl.bindTexture(E.TEXTURE_2D_ARRAY, res.tex);
        gl.texStorage3D(E.TEXTURE_2D_ARRAY, levels, f.internal, d.width, d.target === PIPE_TEXTURE_1D_ARRAY ? 1 : d.height, d.arraySize);
        break;
      default:
        this.error(`resource ${d.id}: target ${d.target} isn't supported`);
        gl.deleteTexture(res.tex);
        res.tex = undefined;
        return true;
    }
    // Sampling state lives in sampler objects; the texture's own filters stay at their defaults but a mip filter
    // would make an incomplete texture of a single level unsampleable without one, so set a level range.
    gl.texParameteri(res.glTarget, E.TEXTURE_MAX_LEVEL, d.lastLevel);
    return true;
  }

  unrefResource(id: number) {
    const r = this.resources.get(id);
    if (!r) return false;
    this.resources.delete(id);
    r.dead = true;
    for (const c of r.refs) this.contexts.get(c)?.attached.delete(id);
    this.freeResource(r);
    return true;
  }

  private freeResource(r: Res) {
    const gl = this.gl;
    if (r.buf) gl.deleteBuffer(r.buf);
    if (r.ibuf) gl.deleteBuffer(r.ibuf);
    if (r.msResolved?.tex) gl.deleteTexture(r.msResolved.tex);
    if (r.tex) gl.deleteTexture(r.tex);
    if (r.rb) gl.deleteRenderbuffer(r.rb);
    this.fbCache.clear();
  }

  attachBacking(id: number, backing: Backing) {
    const r = this.resources.get(id);
    if (!r) return false;
    // Adjacent entries merged: most backings are a few contiguous runs, and a contiguous range is read in place.
    const merged: Backing = [];
    for (const b of backing) {
      const last = merged[merged.length - 1];
      if (last && last.off + last.len === b.off) last.len += b.len;
      else merged.push({ ...b });
    }
    r.backing = merged;
    return true;
  }

  detachBacking(id: number) {
    const r = this.resources.get(id);
    if (!r) return false;
    r.backing = null;
    return true;
  }

  attach(ctx: number, res: number) {
    const c = this.contexts.get(ctx), r = this.resources.get(res);
    if (!c || !r) return false;
    c.attached.add(res);
    r.refs.add(ctx);
    return true;
  }

  detach(ctx: number, res: number) {
    const c = this.contexts.get(ctx), r = this.resources.get(res);
    c?.attached.delete(res);
    r?.refs.delete(ctx);
    return !!c;
  }

  /** The resource the context may use (attached), or undefined (an error). */
  private lookup(c: Ctx, id: number): Res | undefined {
    const r = this.resources.get(id);
    if (!r || !c.attached.has(id)) {
      if (id) this.error(`ctx ${c.id}: resource ${id} isn't attached`);
      return undefined;
    }
    return r;
  }

  // --- guest memory ----------------------------------------------------------------------------------------------

  /** `len` bytes at `offset` in the resource's backing: a view of guest RAM if they're contiguous, else a copy. */
  private readBacking(r: Res, offset: number, len: number): Uint8Array | null {
    if (!r.backing) return null;
    const ram = this.ram();
    let skip = offset;
    for (let k = 0; k < r.backing.length; k++) {
      const b = r.backing[k];
      if (skip >= b.len) { skip -= b.len; continue; }
      if (skip + len <= b.len) return ram.subarray(b.off + skip, b.off + skip + len);
      const out = new Uint8Array(len);
      let at = 0;
      for (let j = k; j < r.backing.length && at < len; j++) {
        const e = r.backing[j];
        const n = Math.min(e.len - (j === k ? skip : 0), len - at);
        out.set(ram.subarray(e.off + (j === k ? skip : 0), e.off + (j === k ? skip : 0) + n), at);
        at += n;
      }
      return at === len ? out : null;
    }
    return null;
  }

  /** Writes `bytes` at `offset` of the resource's backing. False if it doesn't fit. */
  private writeBacking(r: Res, offset: number, bytes: Uint8Array) {
    if (!r.backing) return false;
    const ram = this.ram();
    let skip = offset, at = 0;
    for (const b of r.backing) {
      if (skip >= b.len) { skip -= b.len; continue; }
      const n = Math.min(b.len - skip, bytes.length - at);
      ram.set(bytes.subarray(at, at + n), b.off + skip);
      at += n;
      skip = 0;
      if (at === bytes.length) return true;
    }
    return at === bytes.length;
  }

  private backingSize(r: Res) {
    return r.backing ? r.backing.reduce((n, b) => n + b.len, 0) : 0;
  }

  // --- transfers -------------------------------------------------------------------------------------------------

  /**
   * Copies guest data into a resource: `data` holds the box with rows `stride` bytes apart and layers `layerStride`
   * apart (0: packed). A buffer's box is bytes: x is the offset, w the length.
   */
  private upload(r: Res, level: number, box: Box, data: Uint8Array, stride: number, layerStride: number) {
    const gl = this.gl;
    this.stats.uploads++;
    this.stats.uploadBytes += data.length;
    if (r.target !== PIPE_BUFFER && this.debug) {
      // For 4-byte formats: how many texels have alpha (the fourth byte) 0, 255 and in between, and the first texel.
      let a0 = 0, a255 = 0, mid = 0;
      if (r.fmt?.bpp === 4) for (let k = 3; k < data.length; k += 4) data[k] === 0 ? a0++ : data[k] === 255 ? a255++ : mid++;
      this.debug(`upload ${r.id}:${r.fmt?.name} ${box.w}x${box.h}${box.w === r.width && box.h === r.height ? ' (all)' : ''} stride ${stride}${r.fmt?.bpp === 4 ? ` alpha 0:${a0} 255:${a255} other:${mid} first ${[...data.subarray(0, 4)].join(',')}` : ''}`);
    }
    if (r.target === PIPE_BUFFER) {
      if (!r.shadow) return; // staging: nothing on the host
      if (box.x + box.w > r.shadow.length) return this.error(`upload past the end of buffer ${r.id}`);
      const src = data.subarray(0, box.w);
      r.shadow.set(src, box.x);
      gl.bindBuffer(E.COPY_WRITE_BUFFER, r.buf!);
      gl.bufferSubData(E.COPY_WRITE_BUFFER, box.x, r.shadow, box.x, box.w);
      r.idirty = true;
      return;
    }
    const f = r.fmt;
    if (!f || !r.tex) return this.error(`upload to resource ${r.id} without a texture`);
    if (f.id === 126) return this.drawZ32S8(r, level, box, data, stride, layerStride);
    if (f.id === 19 || f.id === 21) {
      // Z24_UNORM_S8_UINT and Z24X8_UNORM keep depth in a word's low 24 bits; GL's UNSIGNED_INT_24_8 (and a 24-bit
      // depth as UNSIGNED_INT) in its high 24: each word rotated, the stencil (or X) byte to the bottom.
      const w = new Uint32Array(data.slice(0, data.length & ~3).buffer);
      for (let k = 0; k < w.length; k++) w[k] = ((w[k] << 8) | (f.id === 19 ? w[k] >>> 24 : 0)) >>> 0;
      data = new Uint8Array(w.buffer);
    }
    const b = f.block;
    const rowBytes = Math.ceil(box.w / b) * f.bpp;
    stride ||= rowBytes;
    const rows = Math.ceil(box.h / b);
    layerStride ||= stride * rows;
    if (stride % f.bpp && b === 1) {
      // A stride that isn't a whole number of pixels: repack.
      const out = new Uint8Array(rowBytes * rows * box.d);
      for (let z = 0; z < box.d; z++) for (let y = 0; y < rows; y++) out.set(data.subarray(z * layerStride + y * stride, z * layerStride + y * stride + rowBytes), (z * rows + y) * rowBytes);
      [data, stride, layerStride] = [out, rowBytes, rowBytes * rows];
    }
    if (!f.write && b === 1 && f.kind !== 'depth' && f.kind !== 'depthstencil' && f.kind !== 'stencil') this.keepTexels(r, level, box, data, stride, layerStride);
    const t = r.glTarget!;
    gl.bindTexture(t, r.tex);
    gl.bindBuffer(E.PIXEL_UNPACK_BUFFER, null);
    if (b > 1) {
      // Compressed: blocks, tightly packed per row of blocks.
      const packed = rowBytes * rows;
      for (let z = 0; z < box.d; z++) {
        let layer = data.subarray(z * layerStride, z * layerStride + stride * rows);
        if (stride !== rowBytes) {
          const out = new Uint8Array(packed);
          for (let y = 0; y < rows; y++) out.set(layer.subarray(y * stride, y * stride + rowBytes), y * rowBytes);
          layer = out;
        }
        if (t === E.TEXTURE_2D) gl.compressedTexSubImage2D(t, level, box.x, box.y, box.w, box.h, f.internal, layer);
        else if (t === E.TEXTURE_CUBE_MAP) gl.compressedTexSubImage2D(E.TEXTURE_CUBE_MAP_POSITIVE_X + box.z + z, level, box.x, box.y, box.w, box.h, f.internal, layer);
        else gl.compressedTexSubImage3D(t, level, box.x, box.y, box.z + z, box.w, box.h, 1, f.internal, layer);
      }
      return;
    }
    gl.pixelStorei(E.UNPACK_ROW_LENGTH, stride / f.bpp);
    gl.pixelStorei(E.UNPACK_IMAGE_HEIGHT, layerStride / stride);
    const view = viewFor(f.type, data.subarray(0, boxBytes(f, box.w, box.h, box.d, stride, layerStride)));
    if (t === E.TEXTURE_2D) {
      const y = r.target === PIPE_TEXTURE_1D ? 0 : box.y, h = r.target === PIPE_TEXTURE_1D ? 1 : box.h;
      gl.texSubImage2D(t, level, box.x, y, box.w, h, f.format, f.type, view);
    } else if (t === E.TEXTURE_CUBE_MAP) {
      for (let z = 0; z < box.d; z++) {
        const v = viewFor(f.type, data.subarray(z * layerStride, z * layerStride + stride * box.h));
        gl.texSubImage2D(E.TEXTURE_CUBE_MAP_POSITIVE_X + box.z + z, level, box.x, box.y, box.w, box.h, f.format, f.type, v);
      }
    } else if (r.target === PIPE_TEXTURE_1D_ARRAY) {
      // A 1D array's box: y is the first layer, h the layer count.
      gl.pixelStorei(E.UNPACK_IMAGE_HEIGHT, 1);
      gl.texSubImage3D(t, level, box.x, 0, box.y, box.w, 1, box.h, f.format, f.type, view);
    } else gl.texSubImage3D(t, level, box.x, box.y, box.z, box.w, box.h, box.d, f.format, f.type, view);
    gl.pixelStorei(E.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(E.UNPACK_IMAGE_HEIGHT, 0);
  }

  /**
   * Reads a resource's box back, laid out with `stride`/`layerStride` (0: packed), for the guest. Null if the format
   * can't be read back (the guest isn't told it can: `supported_readback_formats`).
   */
  private readback(r: Res, level: number, box: Box, stride: number, layerStride: number): Uint8Array | null {
    const gl = this.gl;
    this.stats.readbacks++;
    if (r.target === PIPE_BUFFER) {
      if (!r.shadow) return null;
      this.stats.readbackBytes += box.w;
      return r.shadow.slice(box.x, box.x + box.w);
    }
    const f = r.fmt;
    if (!f || f.block > 1) return null;
    const rowBytes = box.w * f.bpp;
    stride ||= rowBytes;
    layerStride ||= stride * box.h;
    const out = new Uint8Array(boxBytes(f, box.w, box.h, box.d, stride, layerStride));
    this.stats.readbackBytes += rowBytes * box.h * box.d;
    const reader = readbackOf(f, this.colorBufferFloat);
    if (!reader) return null;
    const tmp = new Uint8Array(box.w * box.h * reader.bytes);
    for (let z = 0; z < box.d; z++) {
      if (!this.bindForRead(r, level, box.z + z)) return null;
      const view = reader.type === E.FLOAT ? new Float32Array(tmp.buffer) : reader.type === E.UNSIGNED_INT ? new Uint32Array(tmp.buffer) : reader.type === E.INT ? new Int32Array(tmp.buffer) : reader.type === E.UNSIGNED_INT_2_10_10_10_REV ? new Uint32Array(tmp.buffer) : tmp;
      gl.readPixels(box.x, box.y, box.w, box.h, reader.format, reader.type, view);
      for (let y = 0; y < box.h; y++) reader.pack(tmp.subarray(y * box.w * reader.bytes, (y + 1) * box.w * reader.bytes), out.subarray(z * layerStride + y * stride, z * layerStride + y * stride + rowBytes), box.w);
    }
    gl.bindFramebuffer(E.READ_FRAMEBUFFER, null);
    return out;
  }

  /** The read framebuffer with the resource's level (and layer) as its color attachment. */
  private bindForRead(r: Res, level: number, layer: number) {
    const gl = this.gl;
    gl.bindFramebuffer(E.READ_FRAMEBUFFER, this.readFbo);
    this.attachTo(E.READ_FRAMEBUFFER, E.COLOR_ATTACHMENT0, r, level, layer);
    return gl.checkFramebufferStatus(E.READ_FRAMEBUFFER) === E.FRAMEBUFFER_COMPLETE;
  }

  private attachTo(target: number, point: number, r: Res | undefined, level: number, layer: number) {
    const gl = this.gl;
    if (!r) { gl.framebufferRenderbuffer(target, point, E.RENDERBUFFER, null); return; }
    if (r.rb) gl.framebufferRenderbuffer(target, point, E.RENDERBUFFER, r.rb);
    else if (r.glTarget === E.TEXTURE_2D) gl.framebufferTexture2D(target, point, E.TEXTURE_2D, r.tex!, level);
    else if (r.glTarget === E.TEXTURE_CUBE_MAP) gl.framebufferTexture2D(target, point, E.TEXTURE_CUBE_MAP_POSITIVE_X + layer, r.tex!, level);
    else gl.framebufferTextureLayer(target, point, r.tex!, level, layer);
  }

  /** TRANSFER_TO_HOST_3D / TRANSFER_FROM_HOST_3D (the virtio commands): the resource's own backing at `offset`. */
  transfer(ctx: number, id: number, level: number, box: Box, offset: number, stride: number, layerStride: number, toHost: boolean) {
    const r = this.resources.get(id);
    if (!r) return false;
    void ctx;
    return this.transferIov(r, level, box, offset, stride, layerStride, toHost);
  }

  /**
   * A transfer's strides as vrend reads them: 0 is the level's own row pitch (and image size), the backing laid out
   * as the whole level, not the box (a sub-rectangle narrower than its level read the wrong rows).
   */
  private levelStrides(r: Res, level: number, stride: number, layerStride: number) {
    const f = r.fmt;
    if (!f || r.target === PIPE_BUFFER) return [stride, layerStride];
    const b = f.block, { w, h } = this.levelSize(r, level);
    stride ||= Math.ceil(w / b) * f.bpp;
    layerStride ||= stride * (r.target === PIPE_TEXTURE_1D_ARRAY ? 1 : Math.ceil(h / b));
    return [stride, layerStride];
  }

  private transferIov(r: Res, level: number, box: Box, offset: number, stride: number, layerStride: number, toHost: boolean) {
    [stride, layerStride] = this.levelStrides(r, level, stride, layerStride);
    const n = r.target === PIPE_BUFFER ? box.w : boxBytes(r.fmt, box.w, box.h, box.d, stride, layerStride);
    if (offset + n > this.backingSize(r)) { this.error(`transfer past resource ${r.id}'s backing`); return false; }
    if (toHost) {
      const data = this.readBacking(r, offset, n);
      if (!data) return false;
      this.upload(r, level, box, data, stride, layerStride);
    } else {
      const data = this.readback(r, level, box, stride, layerStride);
      if (!data) { this.error(`can't read back resource ${r.id} (format ${r.format})`); return false; }
      if (r.target === PIPE_BUFFER) this.debug?.(`read back ${r.id} [${box.x}, +${box.w}) to its backing at ${offset}: ${[...data.subarray(0, 16)].join(',')}`);
      this.writeBacking(r, offset, data);
    }
    return true;
  }

  // --- the command stream ----------------------------------------------------------------------------------------

  /** SUBMIT_3D: runs a context's command buffer. Returns false if it was malformed (the rest is skipped). */
  submit(ctxId: number, words: Uint32Array): boolean {
    const c = this.contexts.get(ctxId);
    if (!c) return false;
    this.stats.submits++;
    for (let at = 0; at < words.length;) {
      const h = words[at];
      const len = h >>> 16;
      if (at + 1 + len > words.length) { this.error(`ctx ${ctxId}: a command runs past the buffer`); return false; }
      const p = words.subarray(at + 1, at + 1 + len);
      this.stats.commands++;
      try {
        this.command(c, h & 0xff, (h >>> 8) & 0xff, p);
      } catch (e) {
        this.error(`ctx ${ctxId}: command ${h & 0xff}: ${e instanceof Error ? e.message : e}`);
      }
      at += 1 + len;
    }
    return true;
  }

  private command(c: Ctx, cmd: number, obj: number, p: Uint32Array) {
    const s = c.sub;
    switch (cmd) {
      case 0: return; // NOP
      case 1: return this.createObject(c, obj, p);
      case 2: return this.bindObject(s, obj, p);
      case 3: { const o = s.objects.get(p[0]); if (o) { this.destroyObject(o); s.objects.delete(p[0]); } return; }
      case 4: { // SET_VIEWPORT_STATE: start slot, then scale xyz, translate xyz per viewport
        if (p.length >= 7 && p[0] === 0) s.viewport = { scale: [uif(p[1]), uif(p[2]), uif(p[3])], translate: [uif(p[4]), uif(p[5]), uif(p[6])] };
        return;
      }
      case 5: { // SET_FRAMEBUFFER_STATE: nr_cbufs, zsurf, cbufs
        const n = p[0];
        if (p.length !== 2 + n || n > 8) throw new Error('bad SET_FRAMEBUFFER_STATE');
        s.fb = { cbufs: Array.from({ length: n }, (_, k) => this.surface(s, p[2 + k])), zs: this.surface(s, p[1]) };
        return;
      }
      case 6: { // SET_VERTEX_BUFFERS: stride, offset, handle per buffer
        if (p.length % 3) throw new Error('bad SET_VERTEX_BUFFERS');
        s.vbs = Array.from({ length: p.length / 3 }, (_, k) => ({ stride: p[3 * k], offset: p[3 * k + 1], res: p[3 * k + 2] }));
        return;
      }
      case 7: return this.clear(c, p);
      case 8: return this.draw(c, p);
      case 9: { // RESOURCE_INLINE_WRITE: transfer header then data
        if (p.length < 11) throw new Error('bad RESOURCE_INLINE_WRITE');
        const r = this.lookup(c, p[0]);
        if (!r) return;
        const box = { x: p[5], y: p[6], z: p[7], w: p[8], h: p[9], d: p[10] };
        this.upload(r, p[1], box, new Uint8Array(p.buffer, p.byteOffset + 44, (p.length - 11) * 4), p[3], p[4]);
        return;
      }
      case 10: { // SET_SAMPLER_VIEWS: shader, start slot, handles
        const st = this.stage(p[0]);
        if (!st) return;
        for (let k = 2; k < p.length; k++) {
          const o = s.objects.get(p[k]);
          s.views[st][p[1] + k - 2] = o?.kind === 'view' ? o.v : undefined;
        }
        return;
      }
      case 11: s.ib = p.length >= 3 ? { res: p[0], size: p[1], offset: p[2] } : p[0] ? { res: p[0], size: 0, offset: 0 } : null; return;
      case 12: { // SET_CONSTANT_BUFFER: shader, index, data
        const st = this.stage(p[0]);
        if (st) s.consts[st] = p.slice(2);
        return;
      }
      case 13: s.stencilRef = [p[0] & 0xff, (p[0] >>> 8) & 0xff]; return;
      case 14: s.blendColor = [uif(p[0]), uif(p[1]), uif(p[2]), uif(p[3])]; return;
      case 15: { // SET_SCISSOR_STATE: start slot, minx|miny, maxx|maxy
        if (p.length >= 3 && p[0] === 0) s.scissor = { minx: p[1] & 0xffff, miny: p[1] >>> 16, maxx: p[2] & 0xffff, maxy: p[2] >>> 16 };
        return;
      }
      case 16: return this.blit(c, p);
      case 17: return this.copyRegion(c, p);
      case 18: { // BIND_SAMPLER_STATES: shader, start slot, handles
        const st = this.stage(p[0]);
        if (!st) return;
        for (let k = 2; k < p.length; k++) {
          const o = s.objects.get(p[k]);
          s.samplers[st][p[1] + k - 2] = o?.kind === 'sampler' ? o.v : undefined;
        }
        return;
      }
      case 19: return this.beginQuery(c, p[0]);
      case 20: return this.endQuery(c, p[0]);
      case 21: return this.getQueryResult(c, p[0]);
      case 22: s.stipple = p.slice(0, 32); return; // SET_POLYGON_STIPPLE
      case 23: return; // SET_CLIP_STATE: user clip planes need clip distances (not advertised)
      case 24: s.sampleMask = p[0]; return;
      case 25: { // SET_STREAMOUT_TARGETS: append mask (Mesa sends 0; vrend ignores it), handles
        // As vrend: a set of targets seen before resumes where it stopped (Mesa's resume after a pause sets the same
        // targets again); a new set starts at its targets' beginnings (Mesa makes new targets at each Begin).
        const handles = [...p.subarray(1)];
        s.so.targets = handles.map((h) => { const o = s.objects.get(h); return o?.kind === 'so' ? o.v : undefined; });
        const key = handles.join();
        if (handles.length && !s.so.seen.has(key)) {
          s.so.seen.add(key);
          for (const t of s.so.targets) if (t) t.filled = 0;
        }
        return;
      }
      case 26: return; // SET_RENDER_CONDITION: not advertised
      case 27: { // SET_UNIFORM_BUFFER: shader, index, offset, length, handle
        const st = this.stage(p[0]);
        if (!st) return;
        if (p[4]) s.ubos[st].set(p[1], { res: p[4], offset: p[2], length: p[3] });
        else s.ubos[st].delete(p[1]);
        return;
      }
      case 28: { // SET_SUB_CTX
        const sub = c.subs.get(p[0]);
        if (sub) c.sub = sub;
        else this.error(`ctx ${c.id}: no sub-context ${p[0]}`);
        return;
      }
      case 29: if (!c.subs.has(p[0])) c.subs.set(p[0], this.newSub(p[0])); return;
      case 30: { // DESTROY_SUB_CTX (0 stays)
        const sub = c.subs.get(p[0]);
        if (!sub || p[0] === 0) return;
        this.destroySub(sub);
        c.subs.delete(p[0]);
        if (c.sub === sub) c.sub = c.subs.get(0)!;
        return;
      }
      case 31: { // BIND_SHADER: handle, type
        const st = this.stage(p[1]);
        const o = s.objects.get(p[0]);
        if (st) s.shaders[st] = o?.kind === 'shader' ? o.v : undefined;
        return;
      }
      case 32: case 33: return; // SET_TESS_STATE, SET_MIN_SAMPLES
      case 36: case 39: return; // MEMORY_BARRIER, TEXTURE_BARRIER: one context, in order
      case 41: case 46: case 51: return; // SET_DEBUG_FLAGS, SET_TWEAKS, SEND_STRING_MARKER
      case 43: { // TRANSFER3D: the resource's own backing at DATA_OFFSET, direction
        if (p.length < 13) throw new Error('bad TRANSFER3D');
        const r = this.lookup(c, p[0]);
        if (!r) return;
        this.transferIov(r, p[1], { x: p[5], y: p[6], z: p[7], w: p[8], h: p[9], d: p[10] }, p[11], p[3], p[4], p[12] === 1);
        return;
      }
      case 44: return; // END_TRANSFERS
      case 45: return this.copyTransfer(c, p);
      case 47: return this.clearTexture(c, p);
      case 52: return; // LINK_SHADER: programs are made at the draw that needs them
      case 53: case 54: case 55: case 56: case 57: case 58: case 59: case 60: case 61:
        return (c.video ??= this.videoContext(c)).command(cmd, p);
      case 62: return this.clearSurface(c, p);
      default:
        this.error(`ctx ${c.id}: command ${cmd} isn't supported`);
    }
  }

  private videoContext(c: Ctx) {
    return new VideoContext({
      read: (res, len) => {
        const r = this.lookup(c, res);
        return r ? this.readBacking(r, 0, len) : null;
      },
      size: (res) => {
        const r = this.lookup(c, res);
        return r ? this.backingSize(r) : 0;
      },
      error: (m) => this.error(`ctx ${c.id}: ${m}`),
      debug: this.debug,
      decoders: this.video?.decoders,
      hardware: this.video?.hardware,
      write: (planes, pic) => this.writePicture(c, planes, pic),
      settled: () => this.onVideoSettled?.(),
    }, this.videoStats);
  }

  /** A decoded picture into a video buffer's planes: NV12's R8 luma and RG8 chroma, or I420's three R8 planes (each clipped to its texture). */
  private writePicture(c: Ctx, planes: number[], pic: DecodedPicture) {
    const cw = (pic.width + 1) >> 1, ch = (pic.height + 1) >> 1;
    const put = (res: number, data: Uint8Array, w: number, h: number, stride: number) => {
      const r = this.lookup(c, res);
      if (r) this.upload(r, 0, { x: 0, y: 0, z: 0, w: Math.min(w, r.width), h: Math.min(h, r.height), d: 1 }, data, stride, 0);
    };
    put(planes[0], pic.y, pic.width, pic.height, pic.width);
    if (planes.length === 2) put(planes[1], pic.uv, cw, ch, cw * 2);
    else if (planes.length === 3) {
      const u = new Uint8Array(cw * ch), v = new Uint8Array(cw * ch);
      for (let k = 0; k < u.length; k++) {
        u[k] = pic.uv[2 * k];
        v[k] = pic.uv[2 * k + 1];
      }
      put(planes[1], u, cw, ch, cw);
      put(planes[2], v, cw, ch, cw);
    }
  }

  /** Pictures sent to a decoder and not yet written (web/virgl-video.ts): the GPU worker holds what follows them. */
  get videoWaiting() {
    let n = 0;
    for (const c of this.contexts.values()) n += c.video?.waiting ?? 0;
    return n;
  }

  /** Has the decoders that hold pictures for reordering output them (`VideoContext.drain`). */
  videoDrain() {
    for (const c of this.contexts.values()) c.video?.drain();
  }

  /** Gives up the pending pictures sent before `before` (`VideoContext.giveUp`). */
  videoGiveUp(before?: number) {
    for (const c of this.contexts.values()) c.video?.giveUp(before);
  }

  private stage(shader: number): Stage | undefined {
    return shader === SHADER_VERTEX ? 'vs' : shader === SHADER_FRAGMENT ? 'fs' : undefined;
  }

  private surface(s: Sub, handle: number) {
    if (!handle) return undefined;
    const o = s.objects.get(handle);
    return o?.kind === 'surface' ? o.v : undefined;
  }

  // --- objects ---------------------------------------------------------------------------------------------------

  private createObject(c: Ctx, type: number, p: Uint32Array) {
    const s = c.sub;
    const h = p[0];
    if (!h) throw new Error('object handle 0');
    let o: Obj | undefined;
    switch (type) {
      case 1: { // BLEND: s0, s1 (logicop), 8 per-RT words
        if (p.length !== 11) throw new Error('bad blend');
        o = { kind: 'blend', v: { independent: !!(p[1] & 1), logicop: !!(p[1] & 2), alphaToCoverage: !!(p[1] & 8), rt: Array.from({ length: 8 }, (_, k) => {
          const t = p[3 + k];
          return { enable: !!(t & 1), rgbFunc: (t >>> 1) & 7, rgbSrc: (t >>> 4) & 0x1f, rgbDst: (t >>> 9) & 0x1f, aFunc: (t >>> 14) & 7, aSrc: (t >>> 17) & 0x1f, aDst: (t >>> 22) & 0x1f, mask: (t >>> 27) & 0xf };
        }) } };
        break;
      }
      case 2: { // RASTERIZER
        if (p.length !== 9) throw new Error('bad rasterizer');
        const t = p[1];
        const bit = (b: number) => !!((t >>> b) & 1);
        o = { kind: 'rs', v: {
          flatshade: bit(0), depthClip: bit(1), discard: bit(3), lightTwoSide: bit(5), spriteUpperLeft: bit(6), pointQuad: bit(7),
          cullFace: (t >>> 8) & 3, scissor: bit(14), frontCcw: bit(15), clampFragmentColor: bit(17), offsetTri: bit(20), stipple: bit(22),
          pointSizePerVertex: bit(24), multisample: bit(25), pointSize: uif(p[2]), spriteCoordEnable: p[3], lineWidth: uif(p[5]),
          offsetUnits: uif(p[6]), offsetScale: uif(p[7]),
        } };
        break;
      }
      case 3: { // DSA
        if (p.length !== 5) throw new Error('bad dsa');
        const t = p[1];
        o = { kind: 'dsa', v: {
          depth: { enabled: !!(t & 1), write: !!(t & 2), func: (t >>> 2) & 7 },
          alpha: { enabled: !!((t >>> 8) & 1), func: (t >>> 9) & 7, ref: uif(p[4]) },
          stencil: [p[2], p[3]].map((x) => ({ enabled: !!(x & 1), func: (x >>> 1) & 7, fail: (x >>> 4) & 7, zpass: (x >>> 7) & 7, zfail: (x >>> 10) & 7, valueMask: (x >>> 13) & 0xff, writeMask: (x >>> 21) & 0xff })),
        } };
        break;
      }
      case 4: return this.createShader(s, p);
      case 5: { // VERTEX_ELEMENTS: offset, divisor, vb index, format
        if ((p.length - 1) % 4) throw new Error('bad vertex elements');
        o = { kind: 've', v: Array.from({ length: (p.length - 1) / 4 }, (_, k) => ({ offset: p[1 + 4 * k], divisor: p[2 + 4 * k], vb: p[3 + 4 * k], format: p[4 + 4 * k] })) };
        break;
      }
      case 6: { // SAMPLER_VIEW: res, format | target << 24, layer/element range, level range, swizzle
        if (p.length !== 6) throw new Error('bad sampler view');
        const r = this.lookup(c, p[1]);
        if (!r) return;
        const sw = p[5];
        this.debug?.(`view res ${p[1]} (${r.fmt?.name}) as ${FORMATS.get(p[2] & 0xffffff)?.name ?? p[2] & 0xffffff} swizzle ${[0, 3, 6, 9].map((b) => (sw >>> b) & 7).join('')}`);
        o = { kind: 'view', v: { res: p[1], format: p[2] & 0xffffff, target: p[2] >>> 24, first: p[3] & 0xffff, last: p[3] >>> 16, firstLevel: p[4] & 0xff, lastLevel: (p[4] >>> 8) & 0xff, swizzle: [sw & 7, (sw >>> 3) & 7, (sw >>> 6) & 7, (sw >>> 9) & 7] } };
        break;
      }
      case 7: { // SAMPLER_STATE
        if (p.length !== 9) throw new Error('bad sampler state');
        const t = p[1];
        o = { kind: 'sampler', v: { wrap: [t & 7, (t >>> 3) & 7, (t >>> 6) & 7], minImg: (t >>> 9) & 1, minMip: (t >>> 11) & 3, magImg: (t >>> 13) & 1, compare: !!((t >>> 15) & 1), compareFunc: (t >>> 16) & 7, maxAniso: (t >>> 20) & 0x1f, lodBias: uif(p[2]), minLod: uif(p[3]), maxLod: uif(p[4]) } };
        break;
      }
      case 8: case 11: { // SURFACE (and MSAA_SURFACE): res, format, level (or first element), layers
        if (p.length < 5) throw new Error('bad surface');
        const r = this.lookup(c, p[1]);
        if (!r) return;
        this.debug?.(`surface res ${p[1]} (${r.fmt?.name}) as ${FORMATS.get(p[2])?.name ?? p[2]}`);
        o = { kind: 'surface', v: { res: p[1], format: p[2], level: p[3], firstLayer: p[4] & 0xffff, lastLayer: p[4] >>> 16 } };
        break;
      }
      case 9: { // QUERY: type | index << 16, offset, res
        if (p.length !== 4) throw new Error('bad query');
        o = { kind: 'query', v: { type: p[1] & 0xffff, index: p[1] >>> 16, offset: p[2], res: p[3], result: 0 } };
        break;
      }
      case 10: { // STREAMOUT_TARGET: res, offset, size
        if (p.length !== 4) throw new Error('bad streamout target');
        o = { kind: 'so', v: { res: p[1], offset: p[2], size: p[3], filled: 0 } };
        break;
      }
      default: throw new Error(`object type ${type}`);
    }
    if (o) {
      const old = s.objects.get(h);
      if (old) this.destroyObject(old);
      s.objects.set(h, o);
    }
  }

  private createShader(s: Sub, p: Uint32Array) {
    // handle, type, offset/length (bit 31: a continuation), tokens, stream outputs, [so strides ×4, so outputs ×2n], text
    const [h, type, offlen, , nso] = p;
    const textAt = 5 + (nso ? 4 + 2 * nso : 0);
    if (p.length < textAt) throw new Error('bad shader');
    const chunk = new Uint8Array(p.buffer, p.byteOffset + textAt * 4, (p.length - textAt) * 4);
    const cont = (offlen >>> 31) & 1;
    if (cont) {
      const long = s.longShader.get(type);
      if (!long || long.handle !== h) throw new Error('a shader continuation without its start');
      long.shader.text += new TextDecoder().decode(chunk);
      if (long.shader.text.length >= long.shader.expected) {
        s.longShader.delete(type);
        this.finishShader(long.shader);
      }
      return;
    }
    let so: Shader['so'];
    if (nso) so = { strides: [p[5], p[6], p[7], p[8]], outputs: Array.from({ length: nso }, (_, k) => { const t = p[9 + 2 * k]; return { reg: t & 0xff, start: (t >>> 8) & 3, comps: (t >>> 10) & 7, buffer: (t >>> 13) & 7, offset: (t >>> 16) & 0xffff }; }) };
    const shader: Shader = { serial: ++this.serial, type, text: new TextDecoder().decode(chunk), expected: offlen, so };
    s.objects.set(h, { kind: 'shader', v: shader });
    if (chunk.length < offlen) s.longShader.set(type, { handle: h, shader });
    else this.finishShader(shader);
  }

  private finishShader(sh: Shader) {
    const nul = sh.text.indexOf('\0');
    if (nul >= 0) sh.text = sh.text.slice(0, nul);
    if (sh.so) this.debug?.(`shader ${sh.serial} so ${JSON.stringify(sh.so)}: ${sh.text.split('\n').filter((l) => /^DCL (IN|OUT)|^ *[0-9]+: /.test(l)).join(' | ')}`);
    try {
      sh.tgsi = parseTgsi(sh.text);
    } catch (e) {
      sh.error = e instanceof Error ? e.message : String(e);
      this.error(`shader ${sh.serial}: ${sh.error}`);
    }
  }

  private bindObject(s: Sub, type: number, p: Uint32Array) {
    const o = p[0] ? s.objects.get(p[0]) : undefined;
    switch (type) {
      case 1: s.blend = o?.kind === 'blend' ? o.v : undefined; return;
      case 2: s.rs = o?.kind === 'rs' ? o.v : undefined; return;
      case 3: s.dsa = o?.kind === 'dsa' ? o.v : undefined; return;
      case 5: s.ve = o?.kind === 've' ? o.v : undefined; return;
      default: throw new Error(`bind of object type ${type}`);
    }
  }

  // --- copies between resources and the guest --------------------------------------------------------------------

  private copyTransfer(c: Ctx, p: Uint32Array) {
    // dst, level, usage, stride, layer stride, box, src (staging), src offset, flags (2: read from the host)
    if (p.length !== 14) throw new Error('bad COPY_TRANSFER3D');
    const readBack = !!(p[13] & 2);
    const r = this.lookup(c, p[0]), staging = this.lookup(c, p[11]);
    if (!r || !staging) return;
    const box = { x: p[5], y: p[6], z: p[7], w: p[8], h: p[9], d: p[10] };
    const [stride, layerStride] = this.levelStrides(r, p[1], p[3], p[4]), offset = p[12];
    const n = r.target === PIPE_BUFFER ? box.w : boxBytes(r.fmt, box.w, box.h, box.d, stride, layerStride);
    if (offset + n > this.backingSize(staging)) return this.error(`COPY_TRANSFER3D past staging ${staging.id}`);
    if (readBack) {
      const data = this.readback(r, p[1], box, stride, layerStride);
      if (!data) return this.error(`can't read back resource ${r.id} (format ${r.format})`);
      if (r.target === PIPE_BUFFER) this.debug?.(`read back ${r.id} [${box.x}, +${box.w}) to staging ${staging.id} at ${offset}: ${[...data.subarray(0, 16)].join(',')}`);
      this.writeBacking(staging, offset, data);
    } else {
      const data = this.readBacking(staging, offset, n);
      if (data) this.upload(r, p[1], box, data, stride, layerStride);
    }
  }

  /** A level's size in texels: width, height and depth (or layers). */
  private levelSize(r: Res, level: number) {
    return { w: Math.max(1, r.width >> level), h: Math.max(1, r.height >> level), d: r.target === 3 ? Math.max(1, r.depth >> level) : Math.max(1, r.arraySize) };
  }

  /** Copies an upload into the texture's CPU copy of the level (`Res.texels`). */
  private keepTexels(r: Res, level: number, box: Box, data: Uint8Array, stride: number, layerStride: number) {
    const bpp = r.fmt!.bpp, { w, h, d } = this.levelSize(r, level);
    r.texels ??= new Map();
    let lv = r.texels.get(level);
    if (!lv) r.texels.set(level, (lv = new Uint8Array(w * h * d * bpp)));
    const row = box.w * bpp;
    for (let z = 0; z < box.d; z++) for (let y = 0; y < box.h; y++) {
      const at = (((box.z + z) * h + box.y + y) * w + box.x) * bpp;
      if (at + row <= lv.length) lv.set(data.subarray(z * layerStride + y * stride, z * layerStride + y * stride + row), at);
    }
  }

  private copyRegion(c: Ctx, p: Uint32Array) {
    // dst, dst level, dst x y z, src, src level, src box
    if (p.length !== 13) throw new Error('bad RESOURCE_COPY_REGION');
    const dst = this.lookup(c, p[0]), src = this.lookup(c, p[5]);
    if (!dst || !src) return;
    this.debug?.(`copy ctx ${c.id} ${p[5]}:${src.fmt?.name} level ${p[6]} box ${p.slice(7, 13).join(',')} -> ${p[0]}:${dst.fmt?.name} level ${p[1]} at ${p.slice(2, 5).join(',')}`);
    const gl = this.gl;
    const [dx, dy, dz] = [p[2], p[3], p[4]];
    const box = { x: p[7], y: p[8], z: p[9], w: p[10], h: p[11], d: p[12] };
    if (dst.target === PIPE_BUFFER && src.target === PIPE_BUFFER) {
      if (!src.shadow || !dst.shadow) return;
      dst.shadow.set(src.shadow.subarray(box.x, box.x + box.w), dx);
      gl.bindBuffer(E.COPY_WRITE_BUFFER, dst.buf!);
      gl.bufferSubData(E.COPY_WRITE_BUFFER, dx, dst.shadow, dx, box.w);
      dst.idirty = true;
      return;
    }
    // A source no framebuffer can read (a format WebGL can't render to): from its texels' CPU copy, uploaded again.
    const lv = !src.fmt?.write && src.texels?.get(p[6]);
    if (lv) {
      const bpp = src.fmt!.bpp, { w, h } = this.levelSize(src, p[6]), row = box.w * bpp;
      const out = new Uint8Array(row * box.h * box.d);
      for (let z = 0; z < box.d; z++) for (let y = 0; y < box.h; y++) out.set(lv.subarray((((box.z + z) * h + box.y + y) * w + box.x) * bpp, (((box.z + z) * h + box.y + y) * w + box.x) * bpp + row), (z * box.h + y) * row);
      this.upload(dst, p[1], { x: dx, y: dy, z: dz, w: box.w, h: box.h, d: box.d }, out, row, row * box.h);
      return;
    }
    // Textures: a raw copy of texels, layer by layer, through a blit (same storage formats: same bytes).
    for (let z = 0; z < box.d; z++) {
      const depth = src.fmt && (src.fmt.kind === 'depth' || src.fmt.kind === 'depthstencil');
      const point = depth ? (src.fmt!.kind === 'depth' ? E.DEPTH_ATTACHMENT : E.DEPTH_STENCIL_ATTACHMENT) : E.COLOR_ATTACHMENT0;
      if (depth) {
        // A depth source is read from its depth attachment (as a color one it can't be: Mesa copies its depth
        // textures' uploads this way, and shadow lookups sampled empty textures).
        gl.bindFramebuffer(E.READ_FRAMEBUFFER, this.readFbo);
        this.attachTo(E.READ_FRAMEBUFFER, E.COLOR_ATTACHMENT0, undefined, 0, 0);
        this.attachTo(E.READ_FRAMEBUFFER, point, src, p[6], box.z + z);
        if (gl.checkFramebufferStatus(E.READ_FRAMEBUFFER) !== E.FRAMEBUFFER_COMPLETE) {
          this.attachTo(E.READ_FRAMEBUFFER, point, undefined, 0, 0);
          return this.error('copy region: the depth source can\'t be read');
        }
      } else if (!this.bindForRead(src, p[6], box.z + z)) return this.error('copy region: the source can\'t be read');
      gl.bindFramebuffer(E.DRAW_FRAMEBUFFER, this.fbo);
      for (let k = 1; k < 8; k++) this.attachTo(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0 + k, undefined, 0, 0);
      this.attachTo(E.DRAW_FRAMEBUFFER, E.DEPTH_STENCIL_ATTACHMENT, undefined, 0, 0);
      this.attachTo(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0, depth ? undefined : dst, p[1], dz + z);
      if (depth) this.attachTo(E.DRAW_FRAMEBUFFER, point, dst, p[1], dz + z);
      gl.drawBuffers([depth ? E.NONE : E.COLOR_ATTACHMENT0]);
      gl.disable(E.SCISSOR_TEST);
      gl.blitFramebuffer(box.x, box.y, box.x + box.w, box.y + box.h, dx, dy, dx + box.w, dy + box.h, depth ? E.DEPTH_BUFFER_BIT | (src.fmt!.kind === 'depthstencil' ? E.STENCIL_BUFFER_BIT : 0) : E.COLOR_BUFFER_BIT, E.NEAREST);
      if (depth) this.attachTo(E.READ_FRAMEBUFFER, point, undefined, 0, 0);
    }
    this.fbCache.clear();
  }

  private blit(c: Ctx, p: Uint32Array) {
    if (p.length !== 21) throw new Error('bad BLIT');
    const gl = this.gl;
    const mask = p[0] & 0xff, filter = (p[0] >>> 8) & 3, scissor = !!((p[0] >>> 10) & 1);
    const dst = this.lookup(c, p[3]);
    let src = this.lookup(c, p[12]);
    if (!dst || !src) return;
    const db = { level: p[4], format: p[5], x: p[6] | 0, y: p[7] | 0, z: p[8], w: p[9] | 0, h: p[10] | 0, d: p[11] };
    const sb = { level: p[13], format: p[14], x: p[15] | 0, y: p[16] | 0, z: p[17], w: p[18] | 0, h: p[19] | 0, d: p[20] };
    const color = !!(mask & 0xf), zs = mask & 0x30;
    const sf = FORMATS.get(sb.format) ?? src.fmt, df = FORMATS.get(db.format) ?? dst.fmt;
    if (!sf || !df) return this.error('blit: unknown formats');
    this.debug?.(`blit ctx ${c.id} mask ${mask.toString(16)} ${p[12]}:${sf.name}(${src.fmt?.name}) -> ${p[3]}:${df.name}(${dst.fmt?.name})`);
    // Same stored layout (both RGBA-order bytes, or the same format): a framebuffer blit. Otherwise a draw that
    // samples the source through its format's swizzle and writes through the destination's.
    const same = sf.internal === df.internal && sf.sample.join() === df.sample.join() && (sf.kind === 'uint' || sf.kind === 'sint' ? sf.kind === df.kind : true);
    // Integer formats of one signedness, stored in GL's channel order: GL's blit converts between them (and an
    // integer texture can't be sampled as a float one, which the draw below would need).
    const plain = (f: Format) => f.sample.every((q, k) => q === k || q === SW_0 || q === SW_1);
    const ints = (sf.kind === 'uint' || sf.kind === 'sint') && sf.kind === df.kind && plain(sf) && plain(df);
    // A multisampled source resolves only onto the same rectangle and between equal formats (GL copies the bytes:
    // RGBA8 onto a B8G8R8A8 window swapped red and blue), and Mesa's blits onto a window are flipped: it is resolved
    // into a texture of its own format first, then blitted or drawn from there.
    if (src.rb && src.samples > 1 && (sb.x !== db.x || sb.y !== db.y || sb.w !== db.w || sb.h !== db.h || (color && !same && !ints))) {
      const tmp = this.resolve(src, color ? E.COLOR_BUFFER_BIT : (src.fmt?.kind === 'depth' ? E.DEPTH_BUFFER_BIT : E.DEPTH_BUFFER_BIT | E.STENCIL_BUFFER_BIT));
      if (!tmp) return this.error('blit: the multisampled source can\'t be resolved');
      src = tmp;
    }
    for (let z = 0; z < Math.max(1, db.d); z++) {
      const sz = sb.z + Math.floor((z * sb.d) / Math.max(1, db.d));
      if (color) {
        if (same || ints || src.rb) {
          if (!this.bindForRead(src, sb.level, sz)) return this.error('blit: the source can\'t be read');
          gl.bindFramebuffer(E.DRAW_FRAMEBUFFER, this.fbo);
          this.attachTo(E.DRAW_FRAMEBUFFER, E.DEPTH_STENCIL_ATTACHMENT, undefined, 0, 0);
          this.attachTo(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0, dst, db.level, db.z + z);
          gl.drawBuffers([E.COLOR_ATTACHMENT0]);
          this.blitScissor(scissor, p);
          gl.colorMask(true, true, true, true);
          gl.blitFramebuffer(sb.x, sb.y, sb.x + sb.w, sb.y + sb.h, db.x, db.y, db.x + db.w, db.y + db.h, E.COLOR_BUFFER_BIT, filter ? E.LINEAR : E.NEAREST);
        } else this.drawBlit(src, sf, sb, sz, dst, df, db, db.z + z, filter ? E.LINEAR : E.NEAREST, scissor ? p : undefined);
      }
      if (zs && src.fmt && dst.fmt) {
        const pt = (f: Format) => (f.kind === 'depth' ? E.DEPTH_ATTACHMENT : f.kind === 'stencil' ? E.STENCIL_ATTACHMENT : E.DEPTH_STENCIL_ATTACHMENT);
        gl.bindFramebuffer(E.READ_FRAMEBUFFER, this.readFbo);
        this.attachTo(E.READ_FRAMEBUFFER, E.COLOR_ATTACHMENT0, undefined, 0, 0);
        this.attachTo(E.READ_FRAMEBUFFER, pt(src.fmt), src, sb.level, sz);
        gl.bindFramebuffer(E.DRAW_FRAMEBUFFER, this.fbo);
        this.attachTo(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0, undefined, 0, 0);
        this.attachTo(E.DRAW_FRAMEBUFFER, pt(dst.fmt), dst, db.level, db.z + z);
        gl.drawBuffers([E.NONE]);
        this.blitScissor(scissor, p);
        gl.depthMask(true);
        gl.stencilMask(0xff);
        gl.blitFramebuffer(sb.x, sb.y, sb.x + sb.w, sb.y + sb.h, db.x, db.y, db.x + db.w, db.y + db.h, (mask & 0x10 ? E.DEPTH_BUFFER_BIT : 0) | (mask & 0x20 ? E.STENCIL_BUFFER_BIT : 0), E.NEAREST);
        this.attachTo(E.READ_FRAMEBUFFER, pt(src.fmt), undefined, 0, 0);
        this.attachTo(E.DRAW_FRAMEBUFFER, pt(dst.fmt), undefined, 0, 0);
      }
    }
    gl.disable(E.SCISSOR_TEST);
    this.fbCache.clear();
  }

  private blitScissor(on: boolean, p: Uint32Array) {
    const gl = this.gl;
    if (!on) { gl.disable(E.SCISSOR_TEST); return; }
    gl.enable(E.SCISSOR_TEST);
    const [x0, y0, x1, y1] = [p[1] & 0xffff, p[1] >>> 16, p[2] & 0xffff, p[2] >>> 16];
    gl.scissor(x0, y0, x1 - x0, y1 - y0);
  }

  private resolved?: Res;
  /**
   * A multisampled resource resolved into a single-sampled texture of its format and size (`bits`: its color, or its
   * depth and stencil), kept for the next (one texture, remade when the format or size changes).
   */
  private resolve(src: Res, bits: number, own = false): Res | undefined {
    const gl = this.gl, f = src.fmt;
    if (!f) return undefined;
    let t = own ? src.msResolved : this.resolved;
    if (!(t?.fmt?.internal === f.internal && t.width === src.width && t.height === src.height)) {
      if (t?.tex) gl.deleteTexture(t.tex);
      const tex = gl.createTexture()!;
      gl.bindTexture(E.TEXTURE_2D, tex);
      gl.texStorage2D(E.TEXTURE_2D, 1, f.internal, src.width, src.height);
      t = { ...src, rb: undefined, msResolved: undefined, samples: 0, lastLevel: 0, tex, glTarget: E.TEXTURE_2D, backing: null, refs: new Set() };
      if (own) src.msResolved = t;
      else this.resolved = t;
    }
    const color = bits === E.COLOR_BUFFER_BIT;
    const point = color ? E.COLOR_ATTACHMENT0 : f.kind === 'depth' ? E.DEPTH_ATTACHMENT : E.DEPTH_STENCIL_ATTACHMENT;
    gl.bindFramebuffer(E.READ_FRAMEBUFFER, this.readFbo);
    for (const pt of [E.COLOR_ATTACHMENT0, E.DEPTH_STENCIL_ATTACHMENT]) this.attachTo(E.READ_FRAMEBUFFER, pt, undefined, 0, 0);
    this.attachTo(E.READ_FRAMEBUFFER, point, src, 0, 0);
    gl.bindFramebuffer(E.DRAW_FRAMEBUFFER, this.fbo);
    for (let k = 0; k < 8; k++) this.attachTo(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0 + k, undefined, 0, 0);
    this.attachTo(E.DRAW_FRAMEBUFFER, E.DEPTH_STENCIL_ATTACHMENT, undefined, 0, 0);
    this.attachTo(E.DRAW_FRAMEBUFFER, point, t, 0, 0);
    gl.readBuffer(color ? E.COLOR_ATTACHMENT0 : E.NONE);
    gl.drawBuffers([color ? E.COLOR_ATTACHMENT0 : E.NONE]);
    gl.disable(E.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    gl.stencilMask(0xff);
    gl.blitFramebuffer(0, 0, src.width, src.height, 0, 0, src.width, src.height, bits, E.NEAREST);
    this.attachTo(E.READ_FRAMEBUFFER, point, undefined, 0, 0);
    this.attachTo(E.DRAW_FRAMEBUFFER, point, undefined, 0, 0);
    gl.readBuffer(E.COLOR_ATTACHMENT0); // the read framebuffer's own state: the other reads expect it
    this.fbCache.clear();
    return t;
  }

  /** A blit as a draw: the source sampled through its format's swizzle, written through the destination's. */
  private drawBlit(src: Res, sf: Format, sb: { level: number; x: number; y: number; w: number; h: number }, sz: number, dst: Res, df: Format, db: { level: number; x: number; y: number; w: number; h: number }, dz: number, filter: number, scissor?: Uint32Array) {
    const gl = this.gl;
    if (!src.tex || src.glTarget !== E.TEXTURE_2D) return this.error('blit: only 2D sources are converted');
    const b = this.blitProgram();
    gl.bindFramebuffer(E.DRAW_FRAMEBUFFER, this.fbo);
    // Only the destination attached: the source may still be another of the last draw's targets, and sampling an
    // attached texture is a feedback loop WebGL refuses (dEQP-GLES3 fragment_out: the second of three outputs).
    for (let k = 1; k < 8; k++) this.attachTo(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0 + k, undefined, 0, 0);
    this.attachTo(E.DRAW_FRAMEBUFFER, E.DEPTH_STENCIL_ATTACHMENT, undefined, 0, 0);
    this.attachTo(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0, dst, db.level, dz);
    gl.drawBuffers([E.COLOR_ATTACHMENT0]);
    gl.useProgram(b.prog);
    gl.bindVertexArray(null);
    gl.activeTexture(E.TEXTURE0);
    gl.bindTexture(E.TEXTURE_2D, src.tex);
    gl.bindSampler(0, null);
    gl.texParameteri(E.TEXTURE_2D, E.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(E.TEXTURE_2D, E.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(E.TEXTURE_2D, E.TEXTURE_BASE_LEVEL, sb.level);
    const w = src.width >> sb.level || 1, h = src.height >> sb.level || 1;
    gl.uniform4f(b.loc.get('u_src')!, sb.x / w, sb.y / h, sb.w / w, sb.h / h);
    // u_swz: for each logical channel, the source's stored component or a constant; u_wr: per stored destination component, the logical channel.
    gl.uniform4iv(b.loc.get('u_swz')!, sf.sample.map((s) => (s === SW_0 ? -1 : s === SW_1 ? -2 : s)));
    gl.uniform4iv(b.loc.get('u_wr')!, (df.write ?? [0, 1, 2, 3]).concat([3, 3, 3]).slice(0, 4));
    gl.viewport(db.x, db.y, db.w, db.h);
    gl.disable(E.BLEND); gl.disable(E.DEPTH_TEST); gl.disable(E.STENCIL_TEST); gl.disable(E.CULL_FACE); gl.disable(E.RASTERIZER_DISCARD);
    gl.colorMask(true, true, true, true);
    if (scissor) this.blitScissor(true, scissor); else gl.disable(E.SCISSOR_TEST);
    gl.drawArrays(E.TRIANGLE_STRIP, 0, 4);
    gl.texParameteri(E.TEXTURE_2D, E.TEXTURE_BASE_LEVEL, 0);
  }

  private zsProg?: { prog: WebGLProgram; loc: Map<string, WebGLUniformLocation | null> };
  private zsTex?: [WebGLTexture, WebGLTexture];
  /**
   * An upload to Z32_FLOAT_S8X24_UINT (DEPTH32F_STENCIL8), which WebGL2 takes no data for: drawn. The depths go up as
   * an R32F texture and the stencil bytes as an R8UI one; one pass writes the depth (from `gl_FragDepth`) and clears
   * the stencil, then a pass a stencil bit sets it where the byte has it (dEQP-GLES3 texture.format.sized and
   * specification, depth32f_stencil8). Texels are 8 bytes: the depth's float, then the stencil in the low byte.
   */
  private drawZ32S8(r: Res, level: number, box: Box, data: Uint8Array, stride: number, layerStride: number) {
    const gl = this.gl;
    if (!this.zsProg) {
      const prog = this.link(`#version 300 es
void main() { vec2 p = vec2(gl_VertexID & 1, gl_VertexID >> 1); gl_Position = vec4(p * 4.0 - 1.0, 0.0, 1.0); }`, `#version 300 es
precision highp float;
uniform highp sampler2D u_d;
uniform highp usampler2D u_s;
uniform ivec2 u_org;
uniform uint u_bit;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) - u_org;
  gl_FragDepth = texelFetch(u_d, p, 0).r;
  if (u_bit != 0u && (texelFetch(u_s, p, 0).r & u_bit) == 0u) discard;
}`);
      if (!prog) return this.error('the depth-stencil upload program doesn\'t compile');
      const loc = new Map<string, WebGLUniformLocation | null>();
      for (const n of ['u_d', 'u_s', 'u_org', 'u_bit']) loc.set(n, gl.getUniformLocation(prog, n));
      this.zsProg = { prog, loc };
      this.zsTex = [gl.createTexture()!, gl.createTexture()!];
    }
    const { prog, loc } = this.zsProg;
    const [dt, st] = this.zsTex!;
    const n = box.w * box.h;
    const depth = new Float32Array(n), sten = new Uint8Array(n);
    gl.bindVertexArray(null);
    gl.useProgram(prog);
    gl.uniform1i(loc.get('u_d')!, 0);
    gl.uniform1i(loc.get('u_s')!, 1);
    gl.uniform2i(loc.get('u_org')!, box.x, box.y);
    gl.bindBuffer(E.PIXEL_UNPACK_BUFFER, null);
    gl.pixelStorei(E.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(E.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(E.UNPACK_IMAGE_HEIGHT, 0);
    for (const t of [dt, st]) {
      gl.bindTexture(E.TEXTURE_2D, t);
      gl.texParameteri(E.TEXTURE_2D, E.TEXTURE_MIN_FILTER, E.NEAREST);
      gl.texParameteri(E.TEXTURE_2D, E.TEXTURE_MAG_FILTER, E.NEAREST);
    }
    gl.bindFramebuffer(E.DRAW_FRAMEBUFFER, this.fbo);
    for (let k = 0; k < 8; k++) this.attachTo(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0 + k, undefined, 0, 0);
    gl.drawBuffers([E.NONE]);
    for (const e of [E.BLEND, E.CULL_FACE, E.SCISSOR_TEST, E.POLYGON_OFFSET_FILL, E.RASTERIZER_DISCARD, E.SAMPLE_COVERAGE, E.SAMPLE_ALPHA_TO_COVERAGE]) gl.disable(e);
    gl.viewport(box.x, box.y, box.w, box.h);
    gl.enable(E.DEPTH_TEST);
    gl.depthFunc(E.ALWAYS);
    gl.enable(E.STENCIL_TEST);
    gl.stencilOpSeparate(E.FRONT_AND_BACK, E.REPLACE, E.REPLACE, E.REPLACE);
    for (let z = 0; z < Math.max(1, box.d); z++) {
      const dv = new DataView(data.buffer, data.byteOffset, data.length);
      for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) {
        const o = z * layerStride + y * stride + x * 8;
        if (o + 8 > data.length) continue;
        depth[y * box.w + x] = dv.getFloat32(o, true);
        sten[y * box.w + x] = data[o + 4];
      }
      gl.activeTexture(E.TEXTURE0);
      gl.bindTexture(E.TEXTURE_2D, dt);
      gl.texImage2D(E.TEXTURE_2D, 0, GL.R32F, box.w, box.h, 0, GL.RED, E.FLOAT, depth);
      gl.activeTexture(E.TEXTURE0 + 1);
      gl.bindTexture(E.TEXTURE_2D, st);
      gl.texImage2D(E.TEXTURE_2D, 0, GL.R8UI, box.w, box.h, 0, GL.RED_INTEGER, E.UNSIGNED_BYTE, sten);
      gl.activeTexture(E.TEXTURE0);
      gl.bindSampler(0, null);
      gl.bindSampler(1, null);
      this.attachTo(E.DRAW_FRAMEBUFFER, E.DEPTH_STENCIL_ATTACHMENT, r, level, box.z + z);
      // The depth, and the stencil cleared to 0; then each stencil bit where the byte has it.
      gl.depthMask(true);
      gl.stencilFuncSeparate(E.FRONT_AND_BACK, E.ALWAYS, 0, 0xff);
      gl.stencilMaskSeparate(E.FRONT_AND_BACK, 0xff);
      gl.uniform1ui(loc.get('u_bit')!, 0);
      gl.drawArrays(E.TRIANGLES, 0, 3);
      gl.depthMask(false);
      for (let b = 0; b < 8; b++) {
        gl.stencilFuncSeparate(E.FRONT_AND_BACK, E.ALWAYS, 0xff, 0xff);
        gl.stencilMaskSeparate(E.FRONT_AND_BACK, 1 << b);
        gl.uniform1ui(loc.get('u_bit')!, 1 << b);
        gl.drawArrays(E.TRIANGLES, 0, 3);
      }
    }
    this.attachTo(E.DRAW_FRAMEBUFFER, E.DEPTH_STENCIL_ATTACHMENT, undefined, 0, 0);
    gl.depthMask(true);
    this.fbCache.clear();
  }

  private blitProgram() {
    if (this.blitProg) return this.blitProg;
    const vs = `#version 300 es
uniform vec4 u_src;
out vec2 uv;
void main() { vec2 p = vec2(gl_VertexID & 1, gl_VertexID >> 1); uv = u_src.xy + p * u_src.zw; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
    const fs = `#version 300 es
precision highp float;
uniform sampler2D s;
uniform ivec4 u_swz;
uniform ivec4 u_wr;
in vec2 uv;
out vec4 o;
float ch(vec4 t, int k) { return k == -1 ? 0.0 : k == -2 ? 1.0 : t[k]; }
void main() {
  vec4 t = texture(s, uv);
  vec4 l = vec4(ch(t, u_swz.x), ch(t, u_swz.y), ch(t, u_swz.z), ch(t, u_swz.w));
  o = vec4(u_wr.x < 0 ? 1.0 : l[u_wr.x], u_wr.y < 0 ? 1.0 : l[u_wr.y], u_wr.z < 0 ? 1.0 : l[u_wr.z], u_wr.w < 0 ? 1.0 : l[u_wr.w]);
}`;
    const prog = this.link(vs, fs);
    if (!prog) throw new Error('the blit program doesn\'t compile');
    const loc = new Map<string, WebGLUniformLocation | null>();
    for (const n of ['u_src', 'u_swz', 'u_wr', 's']) loc.set(n, this.gl.getUniformLocation(prog, n));
    this.gl.useProgram(prog);
    this.gl.uniform1i(loc.get('s')!, 0);
    return (this.blitProg = { prog, loc });
  }

  private link(vs: string, fs: string, tf?: ProgramLayout['tf']): WebGLProgram | null {
    const gl = this.gl;
    const compile = (type: number, src: string) => { const sh = gl.createShader(type)!; gl.shaderSource(sh, src); gl.compileShader(sh); return sh; };
    const v = compile(E.VERTEX_SHADER, vs), f = compile(E.FRAGMENT_SHADER, fs);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, v);
    gl.attachShader(prog, f);
    if (tf) gl.transformFeedbackVaryings(prog, tf.varyings, tf.separate ? E.SEPARATE_ATTRIBS : E.INTERLEAVED_ATTRIBS);
    gl.linkProgram(prog);
    const ok = gl.getProgramParameter(prog, E.LINK_STATUS);
    if (!ok) {
      const which = !gl.getShaderParameter(v, E.COMPILE_STATUS) ? `vertex: ${gl.getShaderInfoLog(v)}\n${vs}` : !gl.getShaderParameter(f, E.COMPILE_STATUS) ? `fragment: ${gl.getShaderInfoLog(f)}\n${fs}` : `link: ${gl.getProgramInfoLog(prog)}`;
      this.error(`program: ${which}`);
    }
    gl.deleteShader(v);
    gl.deleteShader(f);
    if (!ok) { gl.deleteProgram(prog); return null; }
    return prog;
  }

  private clearTexture(c: Ctx, p: Uint32Array) {
    // res, level, box, 4 words of the clear value in the resource's format
    if (p.length !== 12) throw new Error('bad CLEAR_TEXTURE');
    const r = this.lookup(c, p[0]);
    if (!r?.fmt) return;
    const box = { x: p[2], y: p[3], z: p[4], w: p[5], h: p[6], d: p[7] };
    const px = new Uint8Array(new Uint32Array([p[8], p[9], p[10], p[11]]).buffer).subarray(0, r.fmt.bpp);
    const data = new Uint8Array(box.w * box.h * box.d * r.fmt.bpp);
    for (let k = 0; k < data.length; k += r.fmt.bpp) data.set(px, k);
    this.upload(r, p[1], box, data, 0, 0);
  }

  // --- clears and draws ------------------------------------------------------------------------------------------

  private fbCache = new Map<string, true>();

  /** Binds the draw framebuffer for the sub-context's surfaces; false if it can't be drawn to. */
  private bindFramebuffer(c: Ctx, s: Sub): { width: number; height: number } | null {
    const gl = this.gl;
    gl.bindFramebuffer(E.DRAW_FRAMEBUFFER, this.fbo);
    let width = 0, height = 0;
    const bufs: number[] = [];
    for (let k = 0; k < 8; k++) {
      const sf = s.fb.cbufs[k];
      const r = sf && this.lookup(c, sf.res);
      this.attachTo(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0 + k, r, sf?.level ?? 0, sf?.firstLayer ?? 0);
      if (k < s.fb.cbufs.length) bufs.push(r ? E.COLOR_ATTACHMENT0 + k : E.NONE);
      if (r) [width, height] = [Math.max(1, r.width >> sf!.level), Math.max(1, r.height >> sf!.level)];
    }
    const zs = s.fb.zs && this.lookup(c, s.fb.zs.res);
    this.attachTo(E.DRAW_FRAMEBUFFER, E.DEPTH_STENCIL_ATTACHMENT, undefined, 0, 0);
    this.attachTo(E.DRAW_FRAMEBUFFER, E.DEPTH_ATTACHMENT, undefined, 0, 0);
    this.attachTo(E.DRAW_FRAMEBUFFER, E.STENCIL_ATTACHMENT, undefined, 0, 0);
    if (zs?.fmt) {
      const point = zs.fmt.kind === 'depth' ? E.DEPTH_ATTACHMENT : zs.fmt.kind === 'stencil' ? E.STENCIL_ATTACHMENT : E.DEPTH_STENCIL_ATTACHMENT;
      this.attachTo(E.DRAW_FRAMEBUFFER, point, zs, s.fb.zs!.level, s.fb.zs!.firstLayer);
      if (!width) [width, height] = [Math.max(1, zs.width >> s.fb.zs!.level), Math.max(1, zs.height >> s.fb.zs!.level)];
    }
    gl.drawBuffers(bufs.length ? bufs : [E.NONE]);
    if (!width) return null;
    return { width, height };
  }

  private clear(c: Ctx, p: Uint32Array) {
    // buffers, color (4 words, as bits), depth (a double), stencil
    if (p.length !== 8) throw new Error('bad CLEAR');
    const gl = this.gl;
    const s = c.sub;
    const fb = this.bindFramebuffer(c, s);
    if (!fb) return;
    const buffers = p[0];
    this.debug?.(`clear ctx ${c.id} buffers ${buffers.toString(16)} [${s.fb.cbufs.map((cb) => cb ? `${cb.res}:${FORMATS.get(cb.format)?.name}` : '-').join(' ')}] color ${[1, 2, 3, 4].map((k) => uif(p[k]).toFixed(2)).join(',')}`);
    // Gallium's clear ignores the scissor and the write masks.
    gl.disable(E.SCISSOR_TEST);
    gl.disable(E.RASTERIZER_DISCARD);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    gl.stencilMask(0xff);
    const bits = new Uint32Array([p[1], p[2], p[3], p[4]]);
    for (let k = 0; k < s.fb.cbufs.length; k++) {
      if (!(buffers & (4 << k))) continue;
      const sf = s.fb.cbufs[k];
      const r = sf && this.resources.get(sf.res);
      const f = (sf && FORMATS.get(sf.format)) ?? r?.fmt;
      if (!f) continue;
      const write = f.write ?? [0, 1, 2, 3];
      const pick = (arr: ArrayLike<number>, one: number) => [0, 1, 2, 3].map((q) => (write[q] === undefined ? 0 : write[q] < 0 ? one : arr[write[q]]));
      if (f.kind === 'uint') gl.clearBufferuiv(E.COLOR, k, pick(bits, 1));
      else if (f.kind === 'sint') gl.clearBufferiv(E.COLOR, k, pick(new Int32Array(bits.buffer), 1));
      else gl.clearBufferfv(E.COLOR, k, pick(new Float32Array(bits.buffer), 1));
    }
    const depth = new Float64Array(new Uint32Array([p[5], p[6]]).buffer)[0];
    const zs = s.fb.zs && this.resources.get(s.fb.zs.res)?.fmt;
    if (zs && buffers & 3) {
      const hasD = zs.kind !== 'stencil', hasS = zs.kind === 'stencil' || zs.kind === 'depthstencil';
      if (buffers & 1 && buffers & 2 && hasD && hasS) gl.clearBufferfi(E.DEPTH_STENCIL, 0, depth, p[7]);
      else {
        if (buffers & 1 && hasD) gl.clearBufferfv(E.DEPTH, 0, [depth]);
        if (buffers & 2 && hasS) gl.clearBufferiv(E.STENCIL, 0, [p[7]]);
      }
    }
  }

  private clearSurface(c: Ctx, p: Uint32Array) {
    // s0 (render condition, buffers << 1), surface, color ×4, x, y, w, h
    if (p.length !== 10) throw new Error('bad CLEAR_SURFACE');
    const s = c.sub;
    const sf = this.surface(s, p[1]);
    if (!sf) return;
    this.debug?.(`clear surface ctx ${c.id} ${sf.res}:${FORMATS.get(sf.format)?.name}`);
    const saved = s.fb;
    s.fb = { cbufs: [sf] };
    const gl = this.gl;
    const fb = this.bindFramebuffer(c, s);
    s.fb = saved;
    if (!fb) return;
    gl.enable(E.SCISSOR_TEST);
    gl.scissor(p[6], p[7], p[8], p[9]);
    gl.colorMask(true, true, true, true);
    const f = FORMATS.get(sf.format);
    const write = f?.write ?? [0, 1, 2, 3];
    const bits = new Uint32Array([p[2], p[3], p[4], p[5]]);
    const pick = (arr: ArrayLike<number>) => [0, 1, 2, 3].map((q) => (write[q] === undefined ? 0 : write[q] < 0 ? 1 : arr[write[q]]));
    if (f?.kind === 'uint') gl.clearBufferuiv(E.COLOR, 0, pick(bits));
    else if (f?.kind === 'sint') gl.clearBufferiv(E.COLOR, 0, pick(new Int32Array(bits.buffer)));
    else gl.clearBufferfv(E.COLOR, 0, pick(new Float32Array(bits.buffer)));
    gl.disable(E.SCISSOR_TEST);
  }

  /** The sampler key of a view: its texture's type and the swizzle from the stored texel to what the shader sees. */
  private samplerKey(c: Ctx, v: SamplerView | undefined): SamplerKey | undefined {
    if (!v) return undefined;
    const r = this.resources.get(v.res);
    const f = FORMATS.get(v.format) ?? r?.fmt;
    if (!r || !f) return undefined;
    const type = f.kind === 'uint' ? 'u' : f.kind === 'sint' ? 'i' : 'f';
    // The format's own swizzle (where each logical channel is stored), then the view's (which logical channel each
    // output reads); a depth-stencil texture sampled reads depth in R.
    const fsw = f.kind === 'depth' || f.kind === 'depthstencil' ? [0, SW_0, SW_0, SW_1] : f.sample;
    const swizzle = v.swizzle.map((q) => (q < 4 ? fsw[q] : q === 4 ? SW_0 : SW_1));
    const gl = r.glTarget === E.TEXTURE_3D ? '3D' : r.glTarget === E.TEXTURE_CUBE_MAP ? 'CUBE' : r.glTarget === E.TEXTURE_2D_ARRAY ? '2D_ARRAY' : '2D';
    void c;
    return { type, swizzle, gl, rect: r.target === PIPE_TEXTURE_RECT, oneD: r.target === PIPE_TEXTURE_1D || r.target === PIPE_TEXTURE_1D_ARRAY };
  }

  private program(vs: Shader, fs: Shader, key: ProgramKey): Program | null {
    const id = `${vs.serial}/${fs.serial}/${JSON.stringify(key)}`;
    const cached = this.programs.get(id);
    if (cached !== undefined) return cached;
    let layout: ProgramLayout;
    try {
      layout = generate(vs.tgsi!, fs.tgsi!, key);
    } catch (e) {
      this.error(`program ${vs.serial}/${fs.serial}: ${e instanceof Error ? e.message : e}`);
      this.programs.set(id, null);
      return null;
    }
    const gl = this.gl;
    const t0 = performance.now();
    const prog = this.link(layout.vs, layout.fs, layout.tf);
    this.stats.compileMs += performance.now() - t0; // translating aside: the browser's compile and link (synchronous here)
    if (!prog) { this.programs.set(id, null); return null; }
    this.stats.programs++;
    const loc = new Map<string, WebGLUniformLocation | null>();
    const names = ['vc0', 'fc0', 'u_adjy', 'u_adjz', 'u_fbh', 'u_alpharef', 'u_psize', 'u_stipple', 'u_blendc', ...layout.samplers.vs.map((n) => `vs${n}`), ...layout.samplers.fs.map((n) => `fs${n}`)];
    for (const n of names) loc.set(n, gl.getUniformLocation(prog, n));
    gl.useProgram(prog);
    for (const n of layout.samplers.fs) gl.uniform1i(loc.get(`fs${n}`)!, samplerUnit('fs', n, VS_UNIT_BASE));
    for (const n of layout.samplers.vs) gl.uniform1i(loc.get(`vs${n}`)!, samplerUnit('vs', n, VS_UNIT_BASE));
    for (const [st, ubos] of [['vs', layout.ubos.vs], ['fs', layout.ubos.fs]] as const) {
      for (const k of ubos.keys()) {
        const idx = gl.getUniformBlockIndex(prog, `${st[0].toUpperCase()}B${k}`);
        if (idx !== 0xffffffff) gl.uniformBlockBinding(prog, idx, uboBinding(st, k));
      }
    }
    const p = { prog, layout, loc };
    this.programs.set(id, p);
    return p;
  }

  private draw(c: Ctx, p: Uint32Array) {
    if (p.length !== 12 && p.length !== 14 && p.length !== 20) throw new Error('bad DRAW_VBO');
    if (p.length === 20 && p[14]) return this.error('indirect draws aren\'t supported');
    const gl = this.gl;
    const s = c.sub;
    const [start, count, mode, indexed, instances, indexBias, , restart, restartIndex] = [p[0], p[1], p[2], p[3], p[4], p[5] | 0, p[6], p[7], p[8]];
    if (mode >= PRIM.length) return this.error(`primitive ${mode} isn't supported`);
    const { vs, fs } = s.shaders;
    if (!vs?.tgsi || !fs?.tgsi || !s.ve) return;
    // Stream output (transform feedback): what the vertex shader writes, captured into the bound targets.
    const so = vs.so && s.so.targets.some((t) => t) ? this.soPlan(vs.so, s.so.targets) : undefined;
    // Multisampled textures sampled are resolved first (it rebinds the framebuffers).
    for (const st of ['vs', 'fs'] as const) for (const v of s.views[st]) {
      const r = v && this.resources.get(v.res);
      if (r?.rb && r.samples > 1 && r.fmt) this.resolve(r, r.fmt.kind === 'depth' || r.fmt.kind === 'depthstencil' ? E.DEPTH_BUFFER_BIT : E.COLOR_BUFFER_BIT, true);
    }
    let fb = this.bindFramebuffer(c, s);
    // Nothing to draw on, only captures: a framebuffer of its own (WebGL2 draws on a complete one), rasterizer off.
    const captureOnly = !fb && !!so;
    if (captureOnly) fb = this.bindNullFramebuffer();
    if (!fb) {
      // Nothing to draw on and nothing captured: only a primitives-generated query sees the draw.
      for (const [q, ctx] of this.counting) if (ctx === c.id && q.type === Q_GENERATED) q.result += primitives(mode, count) * Math.max(1, instances);
      return;
    }
    const rs = s.rs, dsa = s.dsa, blend = s.blend;
    // The program for this state.
    const key: ProgramKey = {
      attribs: s.ve.map((e) => VERTEX_FORMATS.get(e.format)?.int ?? 'f'),
      samplers: { vs: s.views.vs.map((v) => this.samplerKey(c, v)), fs: s.views.fs.map((v) => this.samplerKey(c, v)) },
      cbufs: s.fb.cbufs.map((sf) => {
        if (!sf) return undefined;
        const f = FORMATS.get(sf.format) ?? this.resources.get(sf.res)?.fmt;
        if (!f) return undefined;
        return { type: f.kind === 'uint' ? 'u' : f.kind === 'sint' ? 'i' : 'f', write: [...(f.write ?? [0, 1, 2, 3])] };
      }),
      alphaFunc: dsa?.alpha.enabled ? dsa.alpha.func : undefined,
      flatshade: rs?.flatshade, twoSide: rs?.lightTwoSide, clampColor: rs?.clampFragmentColor, stipple: rs?.stipple, blendSrc: foldedBlend(blend),
      points: mode === 0, pointSizePerVertex: rs?.pointSizePerVertex,
      spriteCoordEnable: mode === 0 && rs?.pointQuad ? rs.spriteCoordEnable : undefined, spriteUpperLeft: rs?.spriteUpperLeft,
      ...(so ? { so: so.outputs.map(({ reg, start, comps }) => ({ reg, start, comps })) } : {}),
    };
    const prog = this.program(vs, fs, key);
    if (!prog) return;
    gl.useProgram(prog.prog);
    // Uniforms: constant buffer 0 and the system values.
    for (const st of ['vs', 'fs'] as const) {
      const n = prog.layout.consts[st];
      if (!n) continue;
      let data = s.consts[st];
      if (data.length < n * 4) { const d = new Uint32Array(n * 4); d.set(data); data = d; }
      gl.uniform4uiv(prog.loc.get(`${st[0]}c0`)!, data, 0, n * 4);
    }
    const vp = s.viewport;
    const negative = vp.scale[1] < 0;
    const set1 = (n: string, v: number) => { const l = prog.loc.get(n); if (l) gl.uniform1f(l, v); };
    set1('u_adjy', negative ? -1 : 1);
    set1('u_adjz', s.viewport.scale[2] < 0 ? -1 : 1);
    set1('u_fbh', fb.height);
    if (dsa) set1('u_alpharef', dsa.alpha.ref);
    const lbc = prog.loc.get('u_blendc');
    if (lbc) gl.uniform4fv(lbc, s.blendColor);
    set1('u_psize', rs?.pointSize || 1);
    const stl = prog.loc.get('u_stipple');
    if (stl) gl.uniform1uiv(stl, s.stipple);
    // Textures and samplers.
    for (const st of ['vs', 'fs'] as const) {
      for (const n of prog.layout.samplers[st]) {
        const unit = samplerUnit(st, n, VS_UNIT_BASE);
        const v = s.views[st][n];
        const r0 = v && this.resources.get(v.res);
        const r = r0?.msResolved ?? r0;
        gl.activeTexture(E.TEXTURE0 + unit);
        if (!r?.tex) { gl.bindTexture(E.TEXTURE_2D, null); continue; }
        gl.bindTexture(r.glTarget!, r.tex);
        gl.texParameteri(r.glTarget!, E.TEXTURE_BASE_LEVEL, v!.firstLevel);
        gl.texParameteri(r.glTarget!, E.TEXTURE_MAX_LEVEL, Math.max(v!.firstLevel, Math.min(v!.lastLevel, r.lastLevel)));
        gl.bindSampler(unit, this.glSampler(s.samplers[st][n], r));
      }
    }
    // Uniform buffers.
    for (const st of ['vs', 'fs'] as const) {
      for (const k of prog.layout.ubos[st].keys()) {
        const u = s.ubos[st].get(k);
        const r = u && this.resources.get(u.res);
        const need = prog.layout.ubos[st].get(k)! * 16;
        if (!r?.buf) continue;
        if (u!.offset + need <= r.width) gl.bindBufferRange(E.UNIFORM_BUFFER, uboBinding(st, k), r.buf, u!.offset, need);
        else this.error(`uniform buffer ${k} is shorter than the shader's block`);
      }
    }
    // Rasterizer, viewport, scissor.
    const fbw = fb.width, fbh = fb.height;
    const x = vp.translate[0] - vp.scale[0], w = vp.scale[0] * 2;
    const h = Math.abs(vp.scale[1]) * 2;
    const y = negative ? vp.translate[1] - Math.abs(vp.scale[1]) : vp.translate[1] - vp.scale[1];
    gl.viewport(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
    // WebGL refuses a depth range whose near is above its far (GLES allows it): such a range goes the right way round,
    // with z negated in the vertex shader (u_adjz), which lands every depth where the inverted range would.
    const near = vp.translate[2] - vp.scale[2], far = vp.translate[2] + vp.scale[2];
    const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
    gl.depthRange(clamp01(Math.min(near, far)), clamp01(Math.max(near, far)));
    if (rs?.scissor) {
      gl.enable(E.SCISSOR_TEST);
      gl.scissor(s.scissor.minx, s.scissor.miny, s.scissor.maxx - s.scissor.minx, s.scissor.maxy - s.scissor.miny);
    } else gl.disable(E.SCISSOR_TEST);
    void fbw; void fbh;
    if (rs && rs.cullFace) {
      gl.enable(E.CULL_FACE);
      gl.cullFace([0, E.FRONT, E.BACK, E.FRONT_AND_BACK][rs.cullFace]);
    } else gl.disable(E.CULL_FACE);
    // Gallium's front face is in its y-down window space: the opposite winding of GL's for the same rows.
    gl.frontFace(rs?.frontCcw ? E.CW : E.CCW);
    if (rs?.offsetTri) { gl.enable(E.POLYGON_OFFSET_FILL); gl.polygonOffset(rs.offsetScale, rs.offsetUnits); } else gl.disable(E.POLYGON_OFFSET_FILL);
    if (rs?.discard || captureOnly) gl.enable(E.RASTERIZER_DISCARD); else gl.disable(E.RASTERIZER_DISCARD);
    gl.disable(E.DITHER);
    // Blend (render target 0's for all: WebGL2 blends all buffers alike), through the first buffer's layout.
    const cb0 = key.cbufs.find((k) => k);
    const f0 = s.fb.cbufs[0] && (FORMATS.get(s.fb.cbufs[0].format) ?? this.resources.get(s.fb.cbufs[0].res)?.fmt);
    const rt = blend?.rt[0];
    if (rt?.enable && cb0?.type === 'f') {
      gl.enable(E.BLEND);
      const noAlpha = !!f0?.x;
      const fac = (g: number) => {
        let v = BLEND_FACTOR[g] ?? E.ONE;
        if (noAlpha) v = v === E.DST_ALPHA ? E.ONE : v === E.ONE_MINUS_DST_ALPHA ? E.ZERO : v;
        return v;
      };
      // A constant color and a constant alpha together, which WebGL refuses: the source RGB factor is the shader's
      // (`ProgramKey.blendSrc`); on alpha, constant color is constant alpha.
      const asAlpha = (g: number) => (g === 7 ? 8 : g === 0x17 ? 0x18 : g);
      gl.blendFuncSeparate(key.blendSrc ? E.ONE : fac(rt.rgbSrc), fac(rt.rgbDst), fac(asAlpha(rt.aSrc)), fac(asAlpha(rt.aDst)));
      gl.blendEquationSeparate(BLEND_FUNC[rt.rgbFunc] ?? E.FUNC_ADD, BLEND_FUNC[rt.aFunc] ?? E.FUNC_ADD);
      const bc = s.blendColor, wr = cb0.write;
      gl.blendColor(...([0, 1, 2, 3].map((q) => (wr[q] === undefined || wr[q] < 0 ? 1 : bc[wr[q]])) as [number, number, number, number]));
    } else gl.disable(E.BLEND);
    // The color mask goes through the stored layout too. A component the first buffer doesn't store stays on: WebGL2
    // has one mask for all buffers, and another may store it (an RG target first masked an RGBA one's B and A:
    // dEQP-GLES3 fragment_out.random).
    const m = rt ? rt.mask : 0xf;
    const wr = cb0?.write ?? [0, 1, 2, 3];
    const bit = (q: number) => (wr[q] === undefined || wr[q] < 0 ? true : !!(m & (1 << wr[q])));
    gl.colorMask(bit(0), bit(1), bit(2), bit(3));
    if (blend?.alphaToCoverage) gl.enable(E.SAMPLE_ALPHA_TO_COVERAGE); else gl.disable(E.SAMPLE_ALPHA_TO_COVERAGE);
    this.sampleMask(c, s);
    // Depth and stencil.
    if (dsa?.depth.enabled) {
      gl.enable(E.DEPTH_TEST);
      gl.depthFunc(COMPARE[dsa.depth.func]);
    } else gl.disable(E.DEPTH_TEST);
    gl.depthMask(!!dsa?.depth.write && !!dsa.depth.enabled);
    const st0 = dsa?.stencil[0];
    // WebGL refuses a draw whose front and back stencil reference, value mask or write mask differ (GLES allows it):
    // such a draw goes twice, each face's triangles with its own state on both faces, the other face culled.
    let faces: { cull?: number; st: Dsa['stencil'][number]; ref: number }[] = [];
    if (st0?.enabled) {
      gl.enable(E.STENCIL_TEST);
      const back = dsa!.stencil[1].enabled ? dsa!.stencil[1] : st0;
      const refBack = dsa!.stencil[1].enabled ? s.stencilRef[1] : s.stencilRef[0];
      const stencil = (face: number, st: typeof st0, ref: number) => {
        gl.stencilFuncSeparate(face, COMPARE[st.func], ref, st.valueMask);
        gl.stencilOpSeparate(face, STENCIL_OP[st.fail], STENCIL_OP[st.zfail], STENCIL_OP[st.zpass]);
        gl.stencilMaskSeparate(face, st.writeMask);
      };
      const split = s.stencilRef[0] !== refBack || st0.valueMask !== back.valueMask || st0.writeMask !== back.writeMask;
      if (split) {
        const cull = rs?.cullFace ?? 0;
        const tris = mode >= 4 && mode <= 6; // points and lines are front-facing
        faces = tris ? [
          ...(cull === 1 || cull === 3 ? [] : [{ cull: E.BACK, st: st0, ref: s.stencilRef[0] }]),
          ...(cull === 2 || cull === 3 ? [] : [{ cull: E.FRONT, st: back, ref: refBack }]),
        ] : [{ st: st0, ref: s.stencilRef[0] }];
        stencil(E.FRONT_AND_BACK, st0, s.stencilRef[0]);
      } else {
        stencil(E.FRONT, st0, s.stencilRef[0]);
        stencil(E.BACK, back, refBack);
      }
    } else gl.disable(E.STENCIL_TEST);
    // Vertex attributes.
    s.vao ??= gl.createVertexArray()!;
    gl.bindVertexArray(s.vao);
    let maxVertex = 0;
    for (let k = 0; k < 16; k++) {
      const e = s.ve[k];
      if (!e || !prog.layout.attribs.includes(k)) { gl.disableVertexAttribArray(k); continue; }
      const vf = VERTEX_FORMATS.get(e.format);
      const vb = s.vbs[e.vb];
      const r = vb && this.resources.get(vb.res);
      if (!vf || !r?.buf || !r.shadow) {
        gl.disableVertexAttribArray(k);
        if (!vf) this.error(`vertex format ${e.format} isn't supported`);
        continue;
      }
      if (vb.stride === 0) {
        // One value for every vertex: from the buffer's copy.
        gl.disableVertexAttribArray(k);
        this.constantAttrib(k, vf, r.shadow, vb.offset + e.offset);
        continue;
      }
      gl.enableVertexAttribArray(k);
      let [stride, at] = [vb.stride, vb.offset + e.offset];
      const comp = vf.type === E.FLOAT || vf.type === E.INT || vf.type === E.UNSIGNED_INT || vf.type === 0x8368 || vf.type === 0x8d9f ? 4 : vf.type === E.SHORT || vf.type === E.UNSIGNED_SHORT || vf.type === E.HALF_FLOAT ? 2 : 1;
      if (stride % comp || at % comp || stride > 255) {
        // WebGL refuses a stride or offset that isn't a multiple of the type's size, and strides over 255 (GLES allows
        // both): the attribute repacked from the buffer's copy, every element the buffer holds, 4-byte aligned.
        const n = Math.max(0, Math.floor((r.shadow.length - at - vf.bytes) / stride) + 1);
        const st = Math.ceil(vf.bytes / 4) * 4;
        const packed = new Uint8Array(Math.max(4, n * st));
        for (let i = 0; i < n; i++) packed.set(r.shadow.subarray(at + i * stride, at + i * stride + vf.bytes), i * st);
        const buf = (this.scratchVb[k] ??= gl.createBuffer()!);
        gl.bindBuffer(E.ARRAY_BUFFER, buf);
        gl.bufferData(E.ARRAY_BUFFER, packed, E.STREAM_DRAW);
        [stride, at] = [st, 0];
      } else gl.bindBuffer(E.ARRAY_BUFFER, r.buf);
      if (vf.int) gl.vertexAttribIPointer(k, vf.size, vf.type, stride, at);
      else gl.vertexAttribPointer(k, vf.size, vf.type, vf.normalized, stride, at);
      gl.vertexAttribDivisor(k, e.divisor);
      maxVertex = Math.max(maxVertex, 0);
    }
    const prim = PRIM[mode];
    this.stats.draws++;
    if (this.debug) {
      const s = c.sub, rt = s.blend?.rt[0];
      const fmt = (res: number, f: number) => `${res}:${FORMATS.get(f)?.name ?? f}`;
      this.debug(`draw ctx ${c.id} into [${s.fb.cbufs.map((cb) => cb ? fmt(cb.res, cb.format) : '-').join(' ')}]${s.fb.zs ? ` zs ${fmt(s.fb.zs.res, s.fb.zs.format)}` : ''} vp ${s.viewport.scale[1] < 0 ? '-y' : '+y'} ${s.rs ? `ccw ${+s.rs.frontCcw} cull ${s.rs.cullFace}` : ''}${s.dsa?.stencil[0].enabled ? ` stencil ${JSON.stringify(s.dsa.stencil)}` : ''} blend ${rt?.enable ? `${rt.rgbSrc},${rt.rgbDst},${rt.aSrc},${rt.aDst} mask ${rt.mask}` : 'off'} sampling [${s.views.fs.map((v) => v ? `${fmt(v.res, v.format)}/${v.swizzle.join('')}` : '-').join(' ')}] samplers [${s.samplers.fs.map((x) => (x ? `${x.compare ? `cmp ${x.compareFunc}` : 'nocmp'} min ${x.minImg}/${x.minMip} mag ${x.magImg}` : '-')).join(' ')}]`);
    }
    const inst = Math.max(1, instances);
    let drawCount = count, drawInstances = instances, emitted = 0;
    let capture: { plan: SoPlan; vertices: number } | undefined;
    if (so) {
      // WebGL2 (GLES 3.0) captures unindexed point, line and triangle lists only, and refuses a draw that would overflow
      // a buffer: Gallium stops writing at the end instead, so the draw is cut to the primitives that fit (and what it
      // draws with them: a draw that overflows its targets is rare and draws partly).
      const vpp = mode === 0 ? 1 : mode === 1 ? 2 : mode === 4 ? 3 : 0;
      if (!vpp || indexed) this.error(`stream output from ${indexed ? 'an indexed draw' : `primitive ${mode}`}: WebGL2 captures unindexed lists only`);
      else {
        const fit = Math.min(...so.plan.targets.map((b) => Math.floor(Math.max(0, b.t.size - b.t.filled) / (b.stride * 4 * vpp))));
        const per = Math.floor(count / vpp);
        if (inst === 1) emitted = Math.min(per, fit);
        else { drawInstances = per ? Math.min(inst, Math.floor(fit / per)) : inst; emitted = drawInstances * per; }
        if (emitted > 0) {
          if (inst === 1) drawCount = emitted * vpp;
          capture = { plan: so.plan, vertices: emitted * vpp };
        } else drawInstances = instances;
      }
    }
    if (so && this.debug) {
      // The first vertex's attributes, from the buffers' copies (as words).
      const attrs = (s.ve ?? []).map((e, k) => {
        const vb = s.vbs[e.vb], r = vb && this.resources.get(vb.res);
        if (!r?.shadow) return `${k}:-`;
        const at = vb.offset + e.offset + start * vb.stride;
        const dv = new DataView(r.shadow.buffer, r.shadow.byteOffset);
        return `${k}:res ${vb.res} @${at} stride ${vb.stride} fmt ${e.format} = ${[0, 1, 2, 3].map((q) => at + 4 * q + 4 <= r.shadow!.length ? dv.getUint32(at + 4 * q, true).toString(16) : '?').join(' ')}`;
      });
      this.debug(`stream output draw start ${start}: ${attrs.join('; ')}`);
    }
    if (so) this.debug?.(`stream output: mode ${mode} count ${count} x${inst}${indexed ? ' indexed' : ''}: ${emitted} primitives captured; targets ${so.plan.targets.map((t) => `${t.t.res}@${t.t.offset}+${t.t.size} filled ${t.t.filled} stride ${t.stride}`).join(', ')}; outputs ${so.outputs.map((o) => `${o.buffer}:${o.offset}+${o.comps}`).join(' ')}`);
    for (const [q, ctx] of this.counting) if (ctx === c.id) q.result += q.type === Q_GENERATED ? primitives(mode, count) * inst : emitted;
    if (capture) this.beginCapture(s, capture.plan, capture.vertices, prim);
    if (indexed) {
      const ib = s.ib;
      const r = ib && this.resources.get(ib.res);
      if (!ib || !r?.shadow) return this.error('an indexed draw without an index buffer');
      let size = ib.size || 2;
      // Mesa folds the draw's start into the index buffer's offset (vrend reads only the offset).
      let offset = ib.offset;
      if (r.idirty || !r.ibuf) {
        r.ibuf ??= gl.createBuffer()!;
        gl.bindBuffer(E.ELEMENT_ARRAY_BUFFER, r.ibuf);
        gl.bufferData(E.ELEMENT_ARRAY_BUFFER, r.shadow, E.DYNAMIC_DRAW);
        r.idirty = false;
        r.imax = undefined;
      }
      const max = size === 1 ? 0xff : size === 2 ? 0xffff : 0xffffffff;
      // WebGL2 always restarts primitives at the type's largest index: without restart (GLES 2, or restart off) an
      // index that large is drawn widened to the next type, and another restart index is mapped onto the largest.
      const widen = size < 4 && (restart ? restartIndex !== max : this.holdsMax(r, offset, count, size));
      let ebuf: WebGLBuffer;
      if (indexBias || widen || (restart && restartIndex !== max)) {
        // No base vertex in WebGL2 either: the indices rebased into a scratch buffer.
        const n = count;
        const src = r.shadow.subarray(offset, offset + n * size);
        const inp = size === 1 ? src : size === 2 ? new Uint16Array(src.slice().buffer) : new Uint32Array(src.slice().buffer);
        if (widen) size *= 2;
        const out = size === 1 ? new Uint8Array(n) : size === 2 ? new Uint16Array(n) : new Uint32Array(n);
        const outMax = size === 1 ? 0xff : size === 2 ? 0xffff : 0xffffffff;
        for (let k = 0; k < n; k++) out[k] = restart && inp[k] === restartIndex ? outMax : inp[k] + indexBias;
        ebuf = this.scratchIndex(out);
        offset = 0;
      } else ebuf = r.ibuf;
      const type = size === 1 ? E.UNSIGNED_BYTE : size === 2 ? E.UNSIGNED_SHORT : E.UNSIGNED_INT;
      gl.bindBuffer(E.ELEMENT_ARRAY_BUFFER, ebuf);
      this.byFace(faces, () => {
        if (instances > 1) gl.drawElementsInstanced(prim, count, type, offset, instances);
        else gl.drawElements(prim, count, type, offset);
      });
    } else if (drawInstances > 1) this.byFace(faces, () => gl.drawArraysInstanced(prim, start, drawCount, drawInstances));
    else if (drawInstances === 1 || instances <= 1) this.byFace(faces, () => gl.drawArrays(prim, start, drawCount));
    gl.bindVertexArray(null);
    if (capture) this.endCapture(capture.plan, capture.vertices);
  }

  /**
   * The sample mask (SET_SAMPLE_MASK) as WebGL2's sample coverage, which is all it has: Mesa makes the mask from
   * glSampleCoverage as the first ⌊value × samples⌋ bits, inverted or not, and those map back exactly; any other mask
   * is approximated by its count of samples.
   */
  private sampleMask(c: Ctx, s: Sub) {
    const gl = this.gl;
    let n = 0;
    for (const sf of [...s.fb.cbufs, s.fb.zs]) {
      const r = sf && this.lookup(c, sf.res);
      if (r?.rb && r.samples > 1) n = Math.max(n, Math.min(r.samples, this.maxSamples));
    }
    const all = n > 1 ? (1 << n) - 1 : 0;
    const m = s.sampleMask & all;
    if (!all || m === all) return gl.disable(E.SAMPLE_COVERAGE);
    let k = 0;
    for (let b = m; b; b &= b - 1) k++;
    gl.enable(E.SAMPLE_COVERAGE);
    const low = (1 << k) - 1;
    if (m === low) gl.sampleCoverage(k / n, false);
    else if (m === (all & ~((1 << (n - k)) - 1))) gl.sampleCoverage((n - k) / n, true);
    else gl.sampleCoverage(k / n, false);
  }

  /** A draw once, or once a face when the stencil's faces must be split (`faces`: each face's state, the other culled). */
  private byFace(faces: { cull?: number; st: Dsa['stencil'][number]; ref: number }[], draw: () => void) {
    if (!faces.length) return draw();
    const gl = this.gl;
    for (const f of faces) {
      gl.stencilFuncSeparate(E.FRONT_AND_BACK, COMPARE[f.st.func], f.ref, f.st.valueMask);
      gl.stencilOpSeparate(E.FRONT_AND_BACK, STENCIL_OP[f.st.fail], STENCIL_OP[f.st.zfail], STENCIL_OP[f.st.zpass]);
      gl.stencilMaskSeparate(E.FRONT_AND_BACK, f.st.writeMask);
      if (f.cull !== undefined) { gl.enable(E.CULL_FACE); gl.cullFace(f.cull); }
      draw();
    }
  }

  /** How a vertex shader's stream outputs (to the targets bound) are captured (`SoPlan`). */
  private soPlan(so: NonNullable<Shader['so']>, targets: (SoTarget | undefined)[]): { plan: SoPlan; outputs: SoOutput[] } | undefined {
    const outputs = so.outputs.filter((o) => targets[o.buffer]).sort((a, b) => a.buffer - b.buffer || a.offset - b.offset);
    if (!outputs.length) return undefined;
    const plan: SoPlan = { outputs, total: outputs.reduce((n, o) => n + o.comps, 0), targets: [] };
    if (plan.total > 64) { this.error(`stream output of ${plan.total} words a vertex (WebGL2 captures 64)`); return undefined; }
    for (const buffer of new Set(outputs.map((o) => o.buffer))) {
      const t = targets[buffer]!, r = this.resources.get(t.res);
      if (!r?.buf || !r.shadow) { this.error(`stream output to resource ${t.res}, not a buffer`); return undefined; }
      if ((t.offset & 3) !== 0) { this.error(`stream output at offset ${t.offset} (not a multiple of 4)`); return undefined; }
      const stride = so.strides[buffer] || Math.max(...outputs.filter((o) => o.buffer === buffer).map((o) => o.offset + o.comps));
      plan.targets.push({ buffer, t, r, stride });
    }
    return { plan, outputs };
  }

  private beginCapture(s: Sub, plan: SoPlan, vertices: number, prim: number) {
    const gl = this.gl;
    s.so.tf ??= gl.createTransformFeedback()!;
    this.soScratch ??= gl.createBuffer()!;
    // The scratch buffer is only ever a transform feedback buffer (WebGL keeps those apart from every other binding).
    gl.bindTransformFeedback(E.TRANSFORM_FEEDBACK, s.so.tf);
    gl.bindBuffer(E.TRANSFORM_FEEDBACK_BUFFER, this.soScratch);
    gl.bufferData(E.TRANSFORM_FEEDBACK_BUFFER, Math.max(4, vertices * plan.total * 4), E.STREAM_READ);
    gl.bindBufferBase(E.TRANSFORM_FEEDBACK_BUFFER, 0, this.soScratch);
    gl.beginTransformFeedback(prim);
  }

  private endCapture(plan: SoPlan, vertices: number) {
    const gl = this.gl;
    gl.endTransformFeedback();
    const words = new Uint32Array(vertices * plan.total);
    gl.bindBuffer(E.TRANSFORM_FEEDBACK_BUFFER, this.soScratch!);
    gl.getBufferSubData(E.TRANSFORM_FEEDBACK_BUFFER, 0, words);
    this.debug?.(`captured ${vertices} vertices: ${[...words.subarray(0, 8)].map((w) => w.toString(16)).join(' ')}`);
    gl.bindBufferBase(E.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindTransformFeedback(E.TRANSFORM_FEEDBACK, null);
    // Each output's words to its target at its offset, in the buffer's CPU copy, then the range written up to its buffer.
    for (const tg of plan.targets) {
      const dv = new DataView(tg.r.shadow!.buffer, tg.r.shadow!.byteOffset, tg.r.shadow!.length);
      const base = tg.t.offset + tg.t.filled;
      let at = 0;
      for (const o of plan.outputs) {
        if (o.buffer === tg.buffer) {
          for (let v = 0; v < vertices; v++) {
            for (let c = 0; c < o.comps; c++) dv.setUint32(base + (v * tg.stride + o.offset + c) * 4, words[v * plan.total + at + c], true);
          }
        }
        at += o.comps;
      }
      const n = vertices * tg.stride * 4;
      gl.bindBuffer(E.COPY_WRITE_BUFFER, tg.r.buf!);
      gl.bufferSubData(E.COPY_WRITE_BUFFER, base, tg.r.shadow!, base, n);
      tg.r.idirty = true;
      tg.t.filled += n;
    }
    gl.bindBuffer(E.COPY_WRITE_BUFFER, null);
  }

  private bindNullFramebuffer() {
    const gl = this.gl;
    if (!this.nullFbo) {
      this.nullFbo = gl.createFramebuffer()!;
      const rb = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(E.RENDERBUFFER, rb);
      gl.renderbufferStorage(E.RENDERBUFFER, E.RGBA8, 1, 1);
      gl.bindFramebuffer(E.DRAW_FRAMEBUFFER, this.nullFbo);
      gl.framebufferRenderbuffer(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0, E.RENDERBUFFER, rb);
    }
    gl.bindFramebuffer(E.DRAW_FRAMEBUFFER, this.nullFbo);
    gl.drawBuffers([E.COLOR_ATTACHMENT0]);
    return { width: 1, height: 1 };
  }

  private scratch?: WebGLBuffer;
  /** Repacked vertex attributes, by slot (never element arrays: WebGL keeps the two kinds of buffer apart). */
  private scratchVb: WebGLBuffer[] = [];
  /** Transform feedback's scratch buffer (`SoPlan`). */
  private soScratch?: WebGLBuffer;

  /** Whether an index buffer's range holds its type's largest index (cached until the buffer changes). */
  private holdsMax(r: Res, offset: number, count: number, size: number) {
    const key = `${offset}:${count}:${size}`;
    const hit = r.imax?.get(key);
    if (hit !== undefined) return hit;
    const src = r.shadow!.subarray(offset, offset + count * size);
    const a = size === 1 ? src : size === 2 ? new Uint16Array(src.slice().buffer) : new Uint32Array(src.slice().buffer);
    const max = size === 1 ? 0xff : size === 2 ? 0xffff : 0xffffffff;
    const found = a.includes(max);
    r.imax ??= new Map();
    if (r.imax.size > 64) r.imax.clear();
    r.imax.set(key, found);
    return found;
  }

  private scratchIndex(data: ArrayBufferView) {
    const gl = this.gl;
    this.scratch ??= gl.createBuffer()!;
    gl.bindBuffer(E.ELEMENT_ARRAY_BUFFER, this.scratch);
    gl.bufferData(E.ELEMENT_ARRAY_BUFFER, data, E.STREAM_DRAW);
    return this.scratch;
  }

  private constantAttrib(k: number, vf: { size: number; type: number; normalized: boolean; int?: 'i' | 'u' }, shadow: Uint8Array, at: number) {
    const gl = this.gl;
    const dv = new DataView(shadow.buffer, shadow.byteOffset, shadow.length);
    const get = (i: number): number => {
      const o = at + i * (vf.type === E.FLOAT || vf.type === E.INT || vf.type === E.UNSIGNED_INT ? 4 : vf.type === E.SHORT || vf.type === E.UNSIGNED_SHORT || vf.type === E.HALF_FLOAT ? 2 : 1);
      if (o + 4 > shadow.length && vf.type === E.FLOAT) return 0;
      switch (vf.type) {
        case E.FLOAT: return dv.getFloat32(o, true);
        case E.UNSIGNED_BYTE: return vf.normalized ? dv.getUint8(o) / 255 : dv.getUint8(o);
        case E.BYTE: return vf.normalized ? Math.max(-1, dv.getInt8(o) / 127) : dv.getInt8(o);
        case E.UNSIGNED_SHORT: return vf.normalized ? dv.getUint16(o, true) / 65535 : dv.getUint16(o, true);
        case E.SHORT: return vf.normalized ? Math.max(-1, dv.getInt16(o, true) / 32767) : dv.getInt16(o, true);
        case E.UNSIGNED_INT: return dv.getUint32(o, true);
        case E.INT: return dv.getInt32(o, true);
        default: return 0;
      }
    };
    const v = [0, 0, 0, 1].map((d, i) => (i < vf.size ? get(i) : d)) as [number, number, number, number];
    if (vf.int === 'u') gl.vertexAttribI4ui(k, ...v);
    else if (vf.int === 'i') gl.vertexAttribI4i(k, ...v);
    else gl.vertexAttrib4f(k, ...v);
  }

  private glSampler(st: SamplerState | undefined, r: Res): WebGLSampler | null {
    if (!st) return null;
    const gl = this.gl;
    if (st.sampler) return st.sampler;
    const sm = gl.createSampler()!;
    gl.samplerParameteri(sm, E.TEXTURE_WRAP_S, WRAP[st.wrap[0]]);
    gl.samplerParameteri(sm, E.TEXTURE_WRAP_T, WRAP[st.wrap[1]]);
    gl.samplerParameteri(sm, E.TEXTURE_WRAP_R, WRAP[st.wrap[2]]);
    const mag = st.magImg ? E.LINEAR : E.NEAREST;
    const min = st.minMip === 2 ? (st.minImg ? E.LINEAR : E.NEAREST)
      : st.minImg ? (st.minMip ? E.LINEAR_MIPMAP_LINEAR : E.LINEAR_MIPMAP_NEAREST) : (st.minMip ? E.NEAREST_MIPMAP_LINEAR : E.NEAREST_MIPMAP_NEAREST);
    gl.samplerParameteri(sm, E.TEXTURE_MAG_FILTER, mag);
    gl.samplerParameteri(sm, E.TEXTURE_MIN_FILTER, min);
    gl.samplerParameterf(sm, E.TEXTURE_MIN_LOD, st.minLod);
    gl.samplerParameterf(sm, E.TEXTURE_MAX_LOD, st.minMip === 2 ? st.minLod : st.maxLod);
    if (st.compare) {
      gl.samplerParameteri(sm, E.TEXTURE_COMPARE_MODE, E.COMPARE_REF_TO_TEXTURE);
      gl.samplerParameteri(sm, E.TEXTURE_COMPARE_FUNC, COMPARE[st.compareFunc]);
    }
    if (st.maxAniso > 1 && this.anisotropy) gl.samplerParameterf(sm, E.TEXTURE_MAX_ANISOTROPY, st.maxAniso);
    void r;
    st.sampler = sm;
    return sm;
  }

  // --- queries ---------------------------------------------------------------------------------------------------

  private query(c: Ctx, h: number) {
    const o = c.sub.objects.get(h);
    return o?.kind === 'query' ? o.v : undefined;
  }

  private beginQuery(c: Ctx, h: number) {
    const q = this.query(c, h);
    this.debug?.(`begin query ${h}: type ${q?.type} index ${q?.index}`);
    if (!q) return;
    const gl = this.gl;
    // Occlusion counters and predicates: WebGL2 has only "any samples passed" (a counter reads 0 or 1).
    if (q.type === Q_OCCLUSION_COUNTER || q.type === Q_OCCLUSION_PREDICATE || q.type === Q_OCCLUSION_CONSERVATIVE) {
      q.q ??= gl.createQuery()!;
      q.target = q.type === Q_OCCLUSION_CONSERVATIVE ? E.ANY_SAMPLES_PASSED_CONSERVATIVE : E.ANY_SAMPLES_PASSED;
      gl.beginQuery(q.target, q.q);
    }
    // PRIMITIVES_GENERATED and PRIMITIVES_EMITTED: the draws count them (they know their primitives and what they captured).
    if (q.type === Q_GENERATED || q.type === Q_EMITTED) {
      q.result = 0;
      this.counting.set(q, c.id);
    }
  }

  private endQuery(c: Ctx, h: number) {
    const q = this.query(c, h);
    this.debug?.(`end query ${h}: type ${q?.type} result ${q?.result}`);
    if (!q) return;
    const gl = this.gl;
    this.counting.delete(q);
    if (q.q) {
      gl.endQuery(q.target ?? E.ANY_SAMPLES_PASSED);
      q.pending = true;
      this.queries.push(q);
    }
    this.queryState(c, q, q.q ? 0 : 1);
  }

  private getQueryResult(c: Ctx, h: number) {
    const q = this.query(c, h);
    if (q && !q.pending) this.queryState(c, q, 1);
  }

  /** Writes a query's state for the guest (struct virgl_host_query_state: state, result size, u64 result). */
  private queryState(c: Ctx, q: Query, state: number) {
    const r = this.resources.get(q.res);
    if (!r) return;
    const b = new Uint8Array(16);
    const v = new DataView(b.buffer);
    v.setUint32(0, state ? 1 : 2, true); // DONE, or WAIT_HOST
    v.setUint32(4, 8, true);
    v.setBigUint64(8, BigInt(q.result), true);
    this.writeBacking(r, q.offset, b);
    void c;
  }

  /** Whether the occlusion queries ended so far have their results, as they become available (`FenceGate`). */
  queriesSettled(): () => boolean {
    const waiting = this.queries.filter((q) => q.pending);
    return () => waiting.every((q) => !q.pending);
  }

  /** Polls pending queries (the GPU worker calls it between tasks: WebGL results arrive after the task ends). */
  pollQueries() {
    const gl = this.gl;
    this.queries = this.queries.filter((q) => {
      if (!q.q || !gl.getQueryParameter(q.q, E.QUERY_RESULT_AVAILABLE)) return true;
      q.result = gl.getQueryParameter(q.q, E.QUERY_RESULT) ? 1 : 0;
      q.pending = false;
      const r = this.resources.get(q.res);
      if (r) {
        const b = new Uint8Array(16);
        const v = new DataView(b.buffer);
        v.setUint32(0, 1, true);
        v.setUint32(4, 8, true);
        v.setBigUint64(8, BigInt(q.result), true);
        this.writeBacking(r, q.offset, b);
      }
      return false;
    });
    return this.queries.length;
  }

  // --- for the screen --------------------------------------------------------------------------------------------

  /** A resource's texture and format, for the screen to show. */
  scanoutSource(id: number) {
    const r = this.resources.get(id);
    if (!r?.tex || !r.fmt || r.glTarget !== E.TEXTURE_2D) return undefined;
    return { tex: r.tex, fmt: r.fmt, width: r.width, height: r.height };
  }

  /** Reads a 2D resource's RGBA as stored (rows top first), for tests and screenshots. */
  readResource(id: number): Uint8Array | null {
    const r = this.resources.get(id);
    if (!r) return null;
    return this.readback(r, 0, { x: 0, y: 0, z: 0, w: r.width, h: r.height, d: 1 }, 0, 0);
  }
}

/** How a format's texels are read back: the readPixels format and type, bytes a pixel read, and the packer. */
export function readbackOf(f: Format, floats: boolean): { format: number; type: number; bytes: number; pack: (src: Uint8Array, dst: Uint8Array, w: number) => void } | null {
  if (f.kind === 'depth' || f.kind === 'depthstencil' || f.kind === 'stencil' || f.block > 1) return null;
  const take = (comps: number[], size: number) => (src: Uint8Array, dst: Uint8Array, w: number) => {
    for (let x = 0; x < w; x++) for (let k = 0; k < comps.length; k++) for (let b = 0; b < size; b++) dst[x * comps.length * size + k * size + b] = src[x * 4 * size + comps[k] * size + b];
  };
  if (f.internal === E.RGBA8 || f.internal === 0x8c43) return { format: E.RGBA, type: E.UNSIGNED_BYTE, bytes: 4, pack: (s, d, w) => d.set(s.subarray(0, w * 4)) };
  if (f.type === E.UNSIGNED_BYTE && f.kind === 'unorm' && f.bpp <= 2) return { format: E.RGBA, type: E.UNSIGNED_BYTE, bytes: 4, pack: take(f.bpp === 1 ? [0] : [0, 1], 1) };
  if (f.type === E.UNSIGNED_INT_2_10_10_10_REV && f.kind === 'unorm') return { format: E.RGBA, type: E.UNSIGNED_INT_2_10_10_10_REV, bytes: 4, pack: (s, d, w) => d.set(s.subarray(0, w * 4)) };
  if (f.type === 0x8363) {
    // RGB565: read as RGBA8 and packed again (8 → 5/6 bits round-trips).
    return { format: E.RGBA, type: E.UNSIGNED_BYTE, bytes: 4, pack: (s, d, w) => {
      for (let x = 0; x < w; x++) {
        const v = (Math.round((s[4 * x] * 31) / 255) << 11) | (Math.round((s[4 * x + 1] * 63) / 255) << 5) | Math.round((s[4 * x + 2] * 31) / 255);
        d[2 * x] = v & 0xff;
        d[2 * x + 1] = v >> 8;
      }
    } };
  }
  if (f.kind === 'uint' && f.type === E.UNSIGNED_INT_2_10_10_10_REV) {
    // RGB10_A2UI: read as four integers, packed again into 10, 10, 10 and 2 bits.
    return { format: E.RGBA_INTEGER, type: E.UNSIGNED_INT, bytes: 16, pack: (s, d, w) => {
      const sv = new DataView(s.buffer, s.byteOffset, w * 16), dv = new DataView(d.buffer, d.byteOffset, w * 4);
      for (let x = 0; x < w; x++) {
        const c = (k: number) => sv.getUint32(x * 16 + k * 4, true);
        dv.setUint32(x * 4, ((c(0) & 0x3ff) | (c(1) & 0x3ff) << 10 | (c(2) & 0x3ff) << 20 | (c(3) & 3) << 30) >>> 0, true);
      }
    } };
  }
  if (f.kind === 'uint' || f.kind === 'sint') {
    const comps = f.bpp / (([E.UNSIGNED_BYTE, E.BYTE] as number[]).includes(f.type) ? 1 : ([E.UNSIGNED_SHORT, E.SHORT] as number[]).includes(f.type) ? 2 : 4);
    const size = f.bpp / comps;
    return { format: E.RGBA_INTEGER, type: f.kind === 'uint' ? E.UNSIGNED_INT : E.INT, bytes: 16, pack: (s, d, w) => {
      for (let x = 0; x < w; x++) for (let k = 0; k < comps; k++) for (let b = 0; b < size; b++) d[x * f.bpp + k * size + b] = s[x * 16 + k * 4 + b];
    } };
  }
  if (f.kind === 'float' && floats && (f.type === E.FLOAT || f.type === E.HALF_FLOAT)) {
    const comps = f.bpp / (f.type === E.FLOAT ? 4 : 2);
    return { format: E.RGBA, type: E.FLOAT, bytes: 16, pack: (s, d, w) => {
      const fv = new Float32Array(s.buffer, s.byteOffset, w * 4);
      const dv = new DataView(d.buffer, d.byteOffset, d.length);
      for (let x = 0; x < w; x++) for (let k = 0; k < comps; k++) {
        if (f.type === E.FLOAT) dv.setFloat32((x * comps + k) * 4, fv[x * 4 + k], true);
        else dv.setUint16((x * comps + k) * 2, toHalf(fv[x * 4 + k]), true);
      }
    } };
  }
  return null;
}

/** Float32 to IEEE half (round to nearest even). */
export function toHalf(v: number) {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (((x >>> 23) & 0xff) === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  if (exp >= 0x1f) return sign | 0x7c00;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - exp;
    let h = mant >>> shift;
    const rem = mant & ((1 << shift) - 1), half = 1 << (shift - 1);
    if (rem > half || (rem === half && h & 1)) h++;
    return sign | h;
  }
  let h = (exp << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && h & 1)) h++;
  void exp;
  return sign | h;
}

/** The formats `readbackOf` can read (what the caps advertise as `supported_readback_formats`). */
export function readbackFormats(floats: boolean) {
  return [...FORMATS.values()].filter((f) => readbackOf(f, floats)).map((f) => f.id);
}
