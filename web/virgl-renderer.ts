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
import { FORMATS, VERTEX_FORMATS, boxBytes, type Format, SW_0, SW_1 } from './virgl-formats.ts';
import { generate, parseTgsi, samplerUnit, uboBinding, type ProgramKey, type ProgramLayout, type SamplerKey, type Tgsi } from './virgl-tgsi.ts';

/** A resource's guest pages: offsets into guest RAM and lengths. */
export type Backing = { off: number; len: number }[];

export type ResourceDesc = {
  id: number; target: number; format: number; bind: number; width: number; height: number;
  depth: number; arraySize: number; lastLevel: number; samples: number; flags: number;
};

export type Box = { x: number; y: number; z: number; w: number; h: number; d: number };

/** What a renderer does with the device's commands (the device worker calls these through `VirglHost`). */
export type RendererStats = { submits: number; commands: number; draws: number; errors: number; programs: number; uploads: number; uploadBytes: number; readbacks: number; readbackBytes: number };

type Res = ResourceDesc & {
  fmt?: Format;
  backing: Backing | null;
  /** A buffer: its GL buffer (ARRAY_BUFFER and the like), its CPU copy, and an element-array twin made on demand. */
  buf?: WebGLBuffer; shadow?: Uint8Array; ibuf?: WebGLBuffer; idirty?: boolean;
  /** A texture (or a renderbuffer, multisampled or stencil-only). */
  tex?: WebGLTexture; glTarget?: number; rb?: WebGLRenderbuffer;
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
type Query = { type: number; index: number; res: number; offset: number; q?: WebGLQuery; pending?: boolean; result: number };
/** A stream output target: a buffer's range, and the bytes written into it since it was last bound without append. */
type SoTarget = { res: number; offset: number; size: number; filled: number };
type SoOutput = NonNullable<Shader['so']>['outputs'][number];
/** How a draw's stream output goes to WebGL2: the outputs in capture order, and one binding per GL buffer index. */
type SoPlan = { outputs: SoOutput[]; separate: boolean; bindings: { t: SoTarget; r: Res; bytes: number }[] };
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
  so: { targets: (SoTarget | undefined)[]; tf?: WebGLTransformFeedback };
  vao?: WebGLVertexArrayObject;
  /** A long shader arriving in pieces (VIRGL_OBJ_SHADER_OFFSET_CONT), by stage. */
  longShader: Map<number, { handle: number; shader: Shader }>;
};
type Ctx = { id: number; subs: Map<number, Sub>; sub: Sub; attached: Set<number> };

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
  readonly stats: RendererStats = { submits: 0, commands: 0, draws: 0, errors: 0, programs: 0, uploads: 0, uploadBytes: 0, readbacks: 0, readbackBytes: 0 };
  private fbo: WebGLFramebuffer;
  private readFbo: WebGLFramebuffer;
  private blitProg?: { prog: WebGLProgram; loc: Map<string, WebGLUniformLocation | null> };
  private anisotropy: boolean;
  private colorBufferFloat: boolean;
  private queries: Query[] = [];
  /** Primitive queries (generated, emitted by stream output) counted by the draws, with their context. */
  private counting = new Map<Query, number>();
  /** A framebuffer for draws that only capture (stream output with nothing bound to draw on). */
  private nullFbo?: WebGLFramebuffer;
  private errorsLogged = 0;

  /** A trace of what the guest makes and draws with, each line once (`?gpu=virgl,debug`): resources, surfaces, views, draws. */
  private debug?: (m: string) => void;

  constructor(gl: WebGL2RenderingContext, o: { ram: () => Uint8Array; log?: (m: string) => void; debug?: (m: string) => void }) {
    this.gl = gl;
    this.ram = o.ram;
    this.debug = o.debug;
    this.log = o.log ?? ((m) => console.warn(`virgl: ${m}`));
    this.fbo = gl.createFramebuffer()!;
    this.readFbo = gl.createFramebuffer()!;
    this.anisotropy = !!gl.getExtension('EXT_texture_filter_anisotropic');
    this.colorBufferFloat = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('EXT_color_buffer_half_float');
    gl.getExtension('EXT_texture_norm16');
    gl.getExtension('OES_texture_float_linear');
    for (const e of ['WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb', 'WEBGL_compressed_texture_etc', 'EXT_texture_compression_rgtc', 'EXT_texture_compression_bptc']) gl.getExtension(e);
    gl.pixelStorei(E.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(E.PACK_ALIGNMENT, 1);
  }

  private error(m: string) {
    this.stats.errors++;
    if (this.errorsLogged++ < 50) this.log(m);
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
      so: { targets: [] }, longShader: new Map(),
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
    if (o.kind === 'query') this.counting.delete(o.v);
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
      if (d.samples > 1) gl.renderbufferStorageMultisample(E.RENDERBUFFER, Math.min(d.samples, gl.getParameter(E.MAX_SAMPLES) as number), f.internal, d.width, d.height);
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

  private transferIov(r: Res, level: number, box: Box, offset: number, stride: number, layerStride: number, toHost: boolean) {
    const n = r.target === PIPE_BUFFER ? box.w : boxBytes(r.fmt, box.w, box.h, box.d, stride, layerStride);
    if (offset + n > this.backingSize(r)) { this.error(`transfer past resource ${r.id}'s backing`); return false; }
    if (toHost) {
      const data = this.readBacking(r, offset, n);
      if (!data) return false;
      this.upload(r, level, box, data, stride, layerStride);
    } else {
      const data = this.readback(r, level, box, stride, layerStride);
      if (!data) { this.error(`can't read back resource ${r.id} (format ${r.format})`); return false; }
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
      case 25: { // SET_STREAMOUT_TARGETS: append mask, handles (a target not appended to is written from its start)
        s.so.targets = Array.from(p.subarray(1), (h, k) => {
          const o = s.objects.get(h);
          if (o?.kind !== 'so') return undefined;
          if (!((p[0] >>> k) & 1)) o.v.filled = 0;
          return o.v;
        });
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
      case 62: return this.clearSurface(c, p);
      default:
        this.error(`ctx ${c.id}: command ${cmd} isn't supported`);
    }
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
    const [stride, layerStride, offset] = [p[3], p[4], p[12]];
    const n = r.target === PIPE_BUFFER ? box.w : boxBytes(r.fmt, box.w, box.h, box.d, stride, layerStride);
    if (offset + n > this.backingSize(staging)) return this.error(`COPY_TRANSFER3D past staging ${staging.id}`);
    if (readBack) {
      const data = this.readback(r, p[1], box, stride, layerStride);
      if (!data) return this.error(`can't read back resource ${r.id} (format ${r.format})`);
      this.writeBacking(staging, offset, data);
    } else {
      const data = this.readBacking(staging, offset, n);
      if (data) this.upload(r, p[1], box, data, stride, layerStride);
    }
  }

  private copyRegion(c: Ctx, p: Uint32Array) {
    // dst, dst level, dst x y z, src, src level, src box
    if (p.length !== 13) throw new Error('bad RESOURCE_COPY_REGION');
    const dst = this.lookup(c, p[0]), src = this.lookup(c, p[5]);
    if (!dst || !src) return;
    this.debug?.(`copy ctx ${c.id} ${p[5]}:${src.fmt?.name} -> ${p[0]}:${dst.fmt?.name}`);
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
    // Textures: a raw copy of texels, layer by layer, through a blit (same storage formats: same bytes).
    for (let z = 0; z < box.d; z++) {
      if (!this.bindForRead(src, p[6], box.z + z)) return this.error('copy region: the source can\'t be read');
      gl.bindFramebuffer(E.DRAW_FRAMEBUFFER, this.fbo);
      for (let k = 1; k < 8; k++) this.attachTo(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0 + k, undefined, 0, 0);
      this.attachTo(E.DRAW_FRAMEBUFFER, E.DEPTH_STENCIL_ATTACHMENT, undefined, 0, 0);
      const depth = src.fmt && (src.fmt.kind === 'depth' || src.fmt.kind === 'depthstencil');
      const point = depth ? (src.fmt!.kind === 'depth' ? E.DEPTH_ATTACHMENT : E.DEPTH_STENCIL_ATTACHMENT) : E.COLOR_ATTACHMENT0;
      if (depth) {
        this.attachTo(E.READ_FRAMEBUFFER, E.COLOR_ATTACHMENT0, undefined, 0, 0);
        this.attachTo(E.READ_FRAMEBUFFER, point, src, p[6], box.z + z);
      }
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
    const dst = this.lookup(c, p[3]), src = this.lookup(c, p[12]);
    if (!dst || !src) return;
    const db = { level: p[4], format: p[5], x: p[6] | 0, y: p[7] | 0, z: p[8], w: p[9] | 0, h: p[10] | 0, d: p[11] };
    const sb = { level: p[13], format: p[14], x: p[15] | 0, y: p[16] | 0, z: p[17], w: p[18] | 0, h: p[19] | 0, d: p[20] };
    const color = !!(mask & 0xf), zs = mask & 0x30;
    const sf = FORMATS.get(sb.format) ?? src.fmt, df = FORMATS.get(db.format) ?? dst.fmt;
    if (!sf || !df) return this.error('blit: unknown formats');
    this.debug?.(`blit ctx ${c.id} mask ${mask.toString(16)} ${p[12]}:${sf.name}(${src.fmt?.name}) -> ${p[3]}:${df.name}(${dst.fmt?.name})`);
    for (let z = 0; z < Math.max(1, db.d); z++) {
      const sz = sb.z + Math.floor((z * sb.d) / Math.max(1, db.d));
      if (color) {
        // Same stored layout (both RGBA-order bytes, or the same format): a framebuffer blit. Otherwise a draw that
        // samples the source through its format's swizzle and writes through the destination's.
        const same = sf.internal === df.internal && sf.sample.join() === df.sample.join() && (sf.kind === 'uint' || sf.kind === 'sint' ? sf.kind === df.kind : true);
        if (same || src.rb) {
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

  /** A blit as a draw: the source sampled through its format's swizzle, written through the destination's. */
  private drawBlit(src: Res, sf: Format, sb: { level: number; x: number; y: number; w: number; h: number }, sz: number, dst: Res, df: Format, db: { level: number; x: number; y: number; w: number; h: number }, dz: number, filter: number, scissor?: Uint32Array) {
    const gl = this.gl;
    if (!src.tex || src.glTarget !== E.TEXTURE_2D) return this.error('blit: only 2D sources are converted');
    const b = this.blitProgram();
    gl.bindFramebuffer(E.DRAW_FRAMEBUFFER, this.fbo);
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
    const prog = this.link(layout.vs, layout.fs, layout.tf);
    if (!prog) { this.programs.set(id, null); return null; }
    this.stats.programs++;
    const loc = new Map<string, WebGLUniformLocation | null>();
    const names = ['vc0', 'fc0', 'u_adjy', 'u_fbh', 'u_alpharef', 'u_psize', 'u_stipple', ...layout.samplers.vs.map((n) => `vs${n}`), ...layout.samplers.fs.map((n) => `fs${n}`)];
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
    const [start, count, mode, indexed, instances, indexBias, , restart] = [p[0], p[1], p[2], p[3], p[4], p[5] | 0, p[6], p[7]];
    void restart;
    if (mode >= PRIM.length) return this.error(`primitive ${mode} isn't supported`);
    const { vs, fs } = s.shaders;
    if (!vs?.tgsi || !fs?.tgsi || !s.ve) return;
    // Stream output (transform feedback): what the vertex shader writes, captured into the bound targets.
    const so = vs.so && s.so.targets.some((t) => t) ? this.soPlan(vs.so, s.so.targets) : undefined;
    let fb = this.bindFramebuffer(c, s);
    // Nothing to draw on, only captures: a framebuffer of its own (WebGL2 draws on a complete one), rasterizer off.
    const captureOnly = !fb && !!so;
    if (captureOnly) fb = this.bindNullFramebuffer();
    if (!fb) return;
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
      flatshade: rs?.flatshade, twoSide: rs?.lightTwoSide, clampColor: rs?.clampFragmentColor, stipple: rs?.stipple,
      points: mode === 0, pointSizePerVertex: rs?.pointSizePerVertex,
      spriteCoordEnable: mode === 0 && rs?.pointQuad ? rs.spriteCoordEnable : undefined, spriteUpperLeft: rs?.spriteUpperLeft,
      ...(so ? { so: so.outputs.map(({ reg, start, comps }) => ({ reg, start, comps })), soSeparate: so.separate } : {}),
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
    set1('u_fbh', fb.height);
    if (dsa) set1('u_alpharef', dsa.alpha.ref);
    set1('u_psize', rs?.pointSize || 1);
    const stl = prog.loc.get('u_stipple');
    if (stl) gl.uniform1uiv(stl, s.stipple);
    // Textures and samplers.
    for (const st of ['vs', 'fs'] as const) {
      for (const n of prog.layout.samplers[st]) {
        const unit = samplerUnit(st, n, VS_UNIT_BASE);
        const v = s.views[st][n];
        const r = v && this.resources.get(v.res);
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
    const near = vp.translate[2] - vp.scale[2], far = vp.translate[2] + vp.scale[2];
    gl.depthRange(Math.min(Math.max(near, 0), 1), Math.min(Math.max(far, 0), 1));
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
      gl.blendFuncSeparate(fac(rt.rgbSrc), fac(rt.rgbDst), fac(rt.aSrc), fac(rt.aDst));
      gl.blendEquationSeparate(BLEND_FUNC[rt.rgbFunc] ?? E.FUNC_ADD, BLEND_FUNC[rt.aFunc] ?? E.FUNC_ADD);
      const bc = s.blendColor, wr = cb0.write;
      gl.blendColor(...([0, 1, 2, 3].map((q) => (wr[q] === undefined || wr[q] < 0 ? 1 : bc[wr[q]])) as [number, number, number, number]));
    } else gl.disable(E.BLEND);
    // The color mask goes through the stored layout too.
    const m = rt ? rt.mask : 0xf;
    const wr = cb0?.write ?? [0, 1, 2, 3];
    const bit = (q: number) => (wr[q] === undefined ? false : wr[q] < 0 ? true : !!(m & (1 << wr[q])));
    gl.colorMask(bit(0), bit(1), bit(2), bit(3));
    if (blend?.alphaToCoverage) gl.enable(E.SAMPLE_ALPHA_TO_COVERAGE); else gl.disable(E.SAMPLE_ALPHA_TO_COVERAGE);
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
      this.debug(`draw ctx ${c.id} into [${s.fb.cbufs.map((cb) => cb ? fmt(cb.res, cb.format) : '-').join(' ')}]${s.fb.zs ? ` zs ${fmt(s.fb.zs.res, s.fb.zs.format)}` : ''} vp ${s.viewport.scale[1] < 0 ? '-y' : '+y'} ${s.rs ? `ccw ${+s.rs.frontCcw} cull ${s.rs.cullFace}` : ''}${s.dsa?.stencil[0].enabled ? ` stencil ${JSON.stringify(s.dsa.stencil)}` : ''} blend ${rt?.enable ? `${rt.rgbSrc},${rt.rgbDst},${rt.aSrc},${rt.aDst} mask ${rt.mask}` : 'off'} sampling [${s.views.fs.map((v) => v ? `${fmt(v.res, v.format)}/${v.swizzle.join('')}` : '-').join(' ')}]`);
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
        const fit = Math.min(...so.plan.bindings.map((b) => Math.floor(Math.max(0, b.t.size - b.t.filled) / (b.bytes * vpp))));
        const per = Math.floor(count / vpp);
        if (inst === 1) emitted = Math.min(per, fit);
        else { drawInstances = per ? Math.min(inst, Math.floor(fit / per)) : inst; emitted = drawInstances * per; }
        if (emitted > 0) {
          if (inst === 1) drawCount = emitted * vpp;
          capture = { plan: so.plan, vertices: emitted * vpp };
        } else drawInstances = instances;
      }
    }
    for (const [q, ctx] of this.counting) if (ctx === c.id) q.result += q.type === 6 ? primitives(mode, count) * inst : emitted;
    if (capture) this.beginCapture(s, capture.plan, capture.vertices, prim);
    if (indexed) {
      const ib = s.ib;
      const r = ib && this.resources.get(ib.res);
      if (!ib || !r?.shadow) return this.error('an indexed draw without an index buffer');
      const size = ib.size || 2;
      const type = size === 1 ? E.UNSIGNED_BYTE : size === 2 ? E.UNSIGNED_SHORT : E.UNSIGNED_INT;
      let offset = ib.offset + start * size;
      let ebuf: WebGLBuffer;
      if (indexBias) {
        // No base vertex in WebGL2: the indices rebased into a scratch buffer.
        const n = count;
        const src = r.shadow.subarray(offset, offset + n * size);
        const out = size === 1 ? new Uint8Array(n) : size === 2 ? new Uint16Array(n) : new Uint32Array(n);
        const inp = size === 1 ? src : size === 2 ? new Uint16Array(src.slice().buffer) : new Uint32Array(src.slice().buffer);
        const max = size === 1 ? 0xff : size === 2 ? 0xffff : 0xffffffff;
        for (let k = 0; k < n; k++) out[k] = inp[k] === max ? max : inp[k] + indexBias;
        ebuf = this.scratchIndex(out);
        offset = 0;
      } else {
        if (!r.ibuf || r.idirty) {
          r.ibuf ??= gl.createBuffer()!;
          gl.bindBuffer(E.ELEMENT_ARRAY_BUFFER, r.ibuf);
          gl.bufferData(E.ELEMENT_ARRAY_BUFFER, r.shadow, E.DYNAMIC_DRAW);
          r.idirty = false;
        }
        ebuf = r.ibuf;
      }
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

  /**
   * How a vertex shader's stream outputs (to the targets bound) go to WebGL2, whose GLES 3.0 has two layouts: all of
   * them interleaved in one buffer, packed in order, or each in a buffer of its own; no gaps (no gl_SkipComponents).
   */
  private soPlan(so: NonNullable<Shader['so']>, targets: (SoTarget | undefined)[]): { plan: SoPlan; outputs: SoOutput[]; separate: boolean } | undefined {
    const outs = so.outputs.filter((o) => targets[o.buffer]);
    if (!outs.length) return undefined;
    const target = (buffer: number) => {
      const t = targets[buffer]!, r = this.resources.get(t.res);
      if (!r?.buf || !r.shadow) { this.error(`stream output to resource ${t.res}, not a buffer`); return undefined; }
      if ((t.offset & 3) !== 0) { this.error(`stream output at offset ${t.offset} (not a multiple of 4)`); return undefined; }
      return { t, r };
    };
    const make = (outputs: SoOutput[], separate: boolean, bindings: { buffer: number; bytes: number }[]) => {
      const bs = bindings.map((b) => { const tr = target(b.buffer); return tr && { ...tr, bytes: b.bytes }; });
      if (bs.some((b) => !b)) return undefined;
      const plan: SoPlan = { outputs, separate, bindings: bs as SoPlan['bindings'] };
      return { plan, outputs, separate };
    };
    if (outs.every((o) => o.buffer === outs[0].buffer)) {
      const sorted = [...outs].sort((a, b) => a.offset - b.offset);
      let at = 0;
      const packed = sorted.every((o) => { const ok = o.offset === at; at += o.comps; return ok; });
      if (packed && so.strides[outs[0].buffer] === at) return make(sorted, false, [{ buffer: outs[0].buffer, bytes: at * 4 }]);
    }
    if (new Set(outs.map((o) => o.buffer)).size === outs.length && outs.every((o) => o.offset === 0 && so.strides[o.buffer] === o.comps)) {
      const sorted = [...outs].sort((a, b) => a.buffer - b.buffer);
      return make(sorted, true, sorted.map((o) => ({ buffer: o.buffer, bytes: o.comps * 4 })));
    }
    this.error(`stream output's layout (${outs.map((o) => `${o.buffer}:${o.offset}+${o.comps}`).join(' ')}, strides ${so.strides.join(' ')}) has no WebGL2 equivalent`);
    return undefined;
  }

  private beginCapture(s: Sub, plan: SoPlan, vertices: number, prim: number) {
    const gl = this.gl;
    // A buffer bound for transform feedback may be bound nowhere else.
    for (const t of [E.ARRAY_BUFFER, E.COPY_READ_BUFFER, E.COPY_WRITE_BUFFER, E.PIXEL_PACK_BUFFER, E.PIXEL_UNPACK_BUFFER]) gl.bindBuffer(t, null);
    s.so.tf ??= gl.createTransformFeedback()!;
    gl.bindTransformFeedback(E.TRANSFORM_FEEDBACK, s.so.tf);
    plan.bindings.forEach((b, k) => gl.bindBufferRange(E.TRANSFORM_FEEDBACK_BUFFER, k, b.r.buf!, b.t.offset + b.t.filled, vertices * b.bytes));
    gl.beginTransformFeedback(prim);
  }

  private endCapture(plan: SoPlan, vertices: number) {
    const gl = this.gl;
    gl.endTransformFeedback();
    plan.bindings.forEach((_, k) => gl.bindBufferBase(E.TRANSFORM_FEEDBACK_BUFFER, k, null));
    gl.bindTransformFeedback(E.TRANSFORM_FEEDBACK, null);
    // The buffer's CPU copy follows (index buffers, constant attributes and read-backs come from it).
    for (const b of plan.bindings) {
      const at = b.t.offset + b.t.filled, n = vertices * b.bytes;
      gl.bindBuffer(E.COPY_READ_BUFFER, b.r.buf!);
      gl.getBufferSubData(E.COPY_READ_BUFFER, at, b.r.shadow!, at, n);
      b.r.idirty = true;
      b.t.filled += n;
    }
    gl.bindBuffer(E.COPY_READ_BUFFER, null);
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
    if (!q) return;
    const gl = this.gl;
    // Occlusion counters and predicates: WebGL2 has only "any samples passed" (a counter reads 0 or 1).
    if (q.type === 0 || q.type === 1 || q.type === 2) {
      q.q ??= gl.createQuery()!;
      gl.beginQuery(E.ANY_SAMPLES_PASSED_CONSERVATIVE, q.q);
    }
    // PRIMITIVES_GENERATED and PRIMITIVES_EMITTED: the draws count them (they know their primitives and what they captured).
    if (q.type === 6 || q.type === 7) {
      q.result = 0;
      this.counting.set(q, c.id);
    }
  }

  private endQuery(c: Ctx, h: number) {
    const q = this.query(c, h);
    if (!q) return;
    const gl = this.gl;
    this.counting.delete(q);
    if (q.q) {
      gl.endQuery(E.ANY_SAMPLES_PASSED_CONSERVATIVE);
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
function readbackOf(f: Format, floats: boolean): { format: number; type: number; bytes: number; pack: (src: Uint8Array, dst: Uint8Array, w: number) => void } | null {
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
