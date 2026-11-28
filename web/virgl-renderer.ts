// The virgl renderer on WebGL2 (docs/graphics.md "Decisions", "The renderer"): Mesa's virgl command
// stream (virglrenderer's virgl_protocol.h) decoded and run on one WebGL2 context. The decoder and the state model
// follow virglrenderer's vrend_decode.c and vrend_renderer.c (MIT, THIRD_PARTY.json): contexts with sub-contexts that
// own the objects (shaders, blend, depth-stencil-alpha and rasterizer states, vertex elements, sampler views and
// states, surfaces, queries), resources shared by the contexts they're attached to, and the GL state set from the
// sub-context at each draw (one WebGL2 context serves every guest context, so nothing is assumed bound across draws but
// what only the renderer sets: its framebuffers' attachments, each sub-context's vertex array, each program's uniforms,
// set where they differ; docs/graphics.md "The renderer"). Resources are guest-backed: uploads read the guest's pages (a staging buffer's for COPY_TRANSFER3D, the
// resource's own for TRANSFER3D), read-backs write them, before the submit's fence signals.
//
// WebGL2 is below what virglrenderer assumes of GLES 3.0 in places, and this is where it's made up for: a buffer
// can't be both an index buffer and anything else (buffers keep a CPU copy, and an element buffer is made from it
// when drawn with); vertex buffers with a zero stride (a constant attribute) are read from the copy; no BGRA, no
// texture swizzle, no 1D or rectangle textures (web/virgl-formats.ts, web/virgl-tgsi.ts); no base vertex (indices
// rebased on the CPU); no border colors (edge clamp); one blend state for all color buffers.
import { E } from './gl-enums.ts';
import { FORMATS, GL, VERTEX_FORMATS, boxBytes, type Format, SW_0, SW_1 } from './virgl-formats.ts';
import {
  generate,
  parseTgsi,
  quirksOf,
  samplerUnit,
  uboBinding,
  type ColorKey,
  type ProgramKey,
  type ProgramLayout,
  type Quirks,
  type SamplerKey,
} from './virgl-tgsi.ts';
import {
  padPlane,
  VideoContext,
  videoStats,
  type DecodedPicture,
  type DecoderFactory,
  type VideoStats,
  type VideoStream,
} from './virgl-video.ts';
import { bytes, type Ram } from './ram.ts';
import { walk } from './virgl.ts';
import { msg, type Msg } from './msg.ts';
import {
  type Backing,
  type Blend,
  type Box,
  type Ctx,
  type DrawState,
  type Dsa,
  type ExternalResource,
  type ExternalSource,
  type Obj,
  type Program,
  type Query,
  type RendererSnapshot,
  type Res,
  type ResourceDesc,
  type SamplerState,
  type SamplerView,
  type SavedLevel,
  type SavedObject,
  type SavedResource,
  type SavedSub,
  type Shader,
  type SoOutput,
  type SoPlan,
  type SoTarget,
  type Span,
  type Stage,
  type Sub,
  type Surface,
  type VertexElements,
} from './virgl-objects.ts';
import { readbackOf, snapshotReader, uif, viewFor } from './virgl-pixels.ts';

/** What a renderer does with the device's commands (the device worker calls these through `VirglHost`). */
export type RendererStats = {
  submits: number;
  commands: number;
  draws: number;
  errors: number;
  programs: number;
  uploads: number;
  uploadBytes: number;
  readbacks: number;
  readbackBytes: number;
  compileMs: number;
  /** Textures copied because a draw sampled what it drew into (`feedbackCopies`). */ feedbackCopies: number;
  /** Reads of a resource's backing (`readBacking`), and of them those whose range spans entries, copied into one buffer, and their bytes. */
  backingReads: number;
  joins: number;
  joinBytes: number;
};

/** Bytes `[lo, hi)` of a buffer's CPU copy were written: its element-array twin (if made) lacks them. */
function indexWritten(r: { ibuf?: WebGLBuffer; ilo?: number; ihi?: number }, lo: number, hi: number) {
  if (!r.ibuf || hi <= lo) return;
  if (r.ihi) {
    r.ilo = Math.min(r.ilo!, lo);
    r.ihi = Math.max(r.ihi, hi);
  } else [r.ilo, r.ihi] = [lo, hi];
}

/** The largest join of a backing's entries `readBacking` keeps its buffer for (a 1920×1080 RGBA frame is 7.9 MiB). */
const JOIN_KEPT = 16 << 20;

const PIPE_BUFFER = 0,
  PIPE_TEXTURE_1D = 1,
  PIPE_TEXTURE_2D = 2,
  PIPE_TEXTURE_3D = 3,
  PIPE_TEXTURE_CUBE = 4,
  PIPE_TEXTURE_RECT = 5;
const PIPE_TEXTURE_1D_ARRAY = 6,
  PIPE_TEXTURE_2D_ARRAY = 7;
const BIND_STAGING = 1 << 19;
const SHADER_VERTEX = 0,
  SHADER_FRAGMENT = 1;
/** Texture units: the fragment shader's samplers from 0, the vertex shader's from here. */
const VS_UNIT_BASE = 16;
/**
 * A stage's sampler view and sampler state slots (Gallium's PIPE_MAX_SAMPLERS): a start slot past them is refused (a
 * draw walks every slot below the highest set, so 2^31 of them hung it: tests/virgl-fuzz.ts).
 */
const MAX_SLOTS = 32;
/** The largest buffer resource: its CPU copy is as big (a guest's GL buffers are a few MiB; a VBO of 256 MiB is none's). */
const MAX_BUFFER = 256 << 20;

const BLEND_FACTOR: Record<number, number> = {
  0x1: E.ONE,
  0x2: E.SRC_COLOR,
  0x3: E.SRC_ALPHA,
  0x4: E.DST_ALPHA,
  0x5: E.DST_COLOR,
  0x6: E.SRC_ALPHA_SATURATE,
  0x7: E.CONSTANT_COLOR,
  0x8: E.CONSTANT_ALPHA,
  0x11: E.ZERO,
  0x12: E.ONE_MINUS_SRC_COLOR,
  0x13: E.ONE_MINUS_SRC_ALPHA,
  0x14: E.ONE_MINUS_DST_ALPHA,
  0x15: E.ONE_MINUS_DST_COLOR,
  0x17: E.ONE_MINUS_CONSTANT_COLOR,
  0x18: E.ONE_MINUS_CONSTANT_ALPHA,
};
const BLEND_FUNC = [E.FUNC_ADD, E.FUNC_SUBTRACT, E.FUNC_REVERSE_SUBTRACT, E.MIN, E.MAX];
const COMPARE = [E.NEVER, E.LESS, E.EQUAL, E.LEQUAL, E.GREATER, E.NOTEQUAL, E.GEQUAL, E.ALWAYS];
/**
 * A blend target's source RGB factor to fold into the shader (`ColorKey.blendSrc`): when it and the destination's mix
 * constant color and constant alpha.
 */
function foldedBlend(rt?: Blend['rt'][number]): number | undefined {
  if (!rt?.enable) return undefined;
  const kind = (g: number) => (g === 7 || g === 0x17 ? 'color' : g === 8 || g === 0x18 ? 'alpha' : undefined);
  const s = kind(rt.rgbSrc),
    d = kind(rt.rgbDst);
  return s && d && s !== d ? rt.rgbSrc : undefined;
}

/** Query types as virgl numbers them (VIRGL_QUERY_*: not Gallium's PIPE_QUERY_*, whose PRIMITIVES_GENERATED is 6). */
const Q_OCCLUSION_COUNTER = 0,
  Q_OCCLUSION_PREDICATE = 1,
  Q_GENERATED = 5,
  Q_EMITTED = 6,
  Q_OCCLUSION_CONSERVATIVE = 11;
const OCCLUSION = new Set([Q_OCCLUSION_COUNTER, Q_OCCLUSION_PREDICATE, Q_OCCLUSION_CONSERVATIVE]);
const STENCIL_OP = [E.KEEP, E.ZERO, E.REPLACE, E.INCR, E.DECR, E.INCR_WRAP, E.DECR_WRAP, E.INVERT];
const WRAP = [
  E.REPEAT,
  E.CLAMP_TO_EDGE,
  E.CLAMP_TO_EDGE,
  E.CLAMP_TO_EDGE,
  E.MIRRORED_REPEAT,
  E.MIRRORED_REPEAT,
  E.MIRRORED_REPEAT,
  E.MIRRORED_REPEAT,
];
/** The draw buffers of a pass that writes color attachment 0 only, or no color (`setDrawBuffers`; never changed). */
const COLOR0_ONLY: readonly number[] = [E.COLOR_ATTACHMENT0],
  NO_COLOR: readonly number[] = [E.NONE];
const PRIM = [E.POINTS, E.LINES, E.LINE_LOOP, E.LINE_STRIP, E.TRIANGLES, E.TRIANGLE_STRIP, E.TRIANGLE_FAN];
/** The primitives `n` vertices make, per Gallium primitive (PRIM's order). */
const primitives = (mode: number, n: number) =>
  [n, n >> 1, n >= 2 ? n : 0, Math.max(0, n - 1), Math.floor(n / 3), Math.max(0, n - 2), Math.max(0, n - 2)][mode] ?? 0;
/** The program key's `bgra`: the vertex elements stored blue first, by bit (absent when none, so other keys stay as they were). */
const bgraKey = (ve: readonly ({ format: number } | undefined)[]) => {
  let bits = 0;
  for (let k = 0; k < ve.length; k++) if (VERTEX_FORMATS.get(ve[k]?.format ?? -1)?.bgra) bits |= 1 << k;
  return bits ? { bgra: bits } : {};
};

/** The draw states kept, and the characters of their parts' JSON, before they are forgotten (`VirglRenderer.forgetStates`). */
const MAX_STATES = 4096,
  MAX_PART_CHARS = 1 << 20;
/** A rasterizer's part of a program's key (`VirglRenderer.signature`). */
type RasterizerPart = {
  flatshade: boolean;
  twoSide: boolean;
  clampColor: boolean;
  stipple: boolean;
  pointSizePerVertex: boolean;
  /** The rasterizer's, where points are drawn as quads. */
  spriteCoordEnable: number | undefined;
  spriteUpperLeft: boolean;
};
/** A color buffer's part of a program's key: `ColorKey` without the blend's. */
type ColorPart = Pick<ColorKey, 'type' | 'write'>;
const colorPart = (sf: Surface, r: Res | undefined): ColorPart | undefined => {
  const f = FORMATS.get(sf.format) ?? r?.fmt;
  if (!f) return undefined;
  return { type: f.kind === 'uint' ? 'u' : f.kind === 'sint' ? 'i' : 'f', write: [...(f.write ?? [0, 1, 2, 3])] };
};
/** What a framebuffer has at a point (`VirglRenderer.attached`): an object, and a texture's level and face or layer. */
type Attached = { obj: WebGLTexture | WebGLRenderbuffer | null; level: number; layer: number };
/** Whether `points` has `obj`'s level and layer at `point` already; if not, it has them from now on. */
const keepPoint = (
  points: Map<number, Attached>,
  point: number,
  obj: Attached['obj'],
  level: number,
  layer: number,
) => {
  const a = points.get(point);
  if (!a) points.set(point, { obj, level, layer });
  else if (a.obj !== obj || a.level !== level || a.layer !== layer) {
    a.obj = obj;
    a.level = level;
    a.layer = layer;
  } else return true;
  return false;
};
const sameSignature = (a: Int32Array, b: Int32Array, n: number) => {
  if (a.length !== n) return false;
  for (let k = 0; k < n; k++) if (a[k] !== b[k]) return false;
  return true;
};

export class VirglRenderer {
  readonly gl: WebGL2RenderingContext;
  private ram: () => Ram;
  private log: (m: string) => void;
  readonly resources = new Map<number, Res>();
  private contexts = new Map<number, Ctx>();
  /**
   * The parts of a program's key (`ProgramKey`), each kept once: a part's id is its place here, equal parts have one
   * id (`partIds`, by their JSON) and 0 is no part. A draw compares ids, not keys (`signature`).
   */
  private parts: unknown[] = [undefined];
  private partIds = new Map<string, number>();
  /** The part id of a state object that never changes (vertex elements, a blend, rasterizer or depth-stencil-alpha state). */
  private partOf = new WeakMap<object, number>();
  /** The part id of a sampler view or a surface, and the resource it was read with (the part is of its format and target). */
  private resPartOf = new WeakMap<object, { r: Res | undefined; id: number }>();
  /** The draw states kept, by their signature's hash (tens in a desktop session; `forgetStates` bounds them). */
  private states = new Map<number, DrawState[]>();
  /** How many states are kept, and the length of the kept parts' JSON (`forgetStates`' bounds). */
  private statesKept = 0;
  private partChars = 0;
  /** The signature of the draw being set up (`signature` fills it). */
  private sig = new Int32Array(96);
  /** Every part is read again at each draw, and one that differs from its kept id throws (tests, `?gpu=checkprograms`). */
  private checkPrograms: boolean;
  /** The draw states made so far (a draw makes one, and its key, only for a signature it doesn't find kept). */
  drawStates = 0;
  private serial = 0;
  /** `readBacking`'s joins, kept for the next one (at most `JOIN_KEPT` bytes). */
  private joined = new Uint8Array(0);
  readonly stats: RendererStats = {
    submits: 0,
    commands: 0,
    draws: 0,
    errors: 0,
    programs: 0,
    uploads: 0,
    uploadBytes: 0,
    readbacks: 0,
    readbackBytes: 0,
    compileMs: 0,
    feedbackCopies: 0,
    backingReads: 0,
    joins: 0,
    joinBytes: 0,
  };
  /** The contexts' video codecs and buffers, and the pictures decoded (web/virgl-video.ts). */
  readonly videoStats: VideoStats = videoStats();
  /** The video decoders (the GPU worker's WebCodecs; none: pictures are only counted) and the profiles decoded in hardware. */
  private video?: { decoders: DecoderFactory; hardware: readonly number[] };
  /** Called when a picture is written or given up, or an external resource's awaited bytes arrive (the GPU worker's queue goes on: `videoPending`). */
  onVideoSettled?: () => void;
  /** The place in the guest's order of the call running now (the GPU worker's `CallQueue` sets it): the pictures it sends take it. */
  videoOrder = 0;
  /** Whether a picture sent at `order` may be written into these planes now (`VideoEnv.mayWrite`: the GPU worker's `CallQueue.sees`). */
  videoMayWrite?: (planes: readonly number[], order: number) => boolean;
  /** Another renderer's blobs, imported by the guest (`ExternalResource`). */
  external?: ExternalSource;
  /** A video picture's plane written into a resource (rows of `w` texels of `bpp` bytes): Venus's textures imported from it take it too (web/venus-import.ts). */
  onPlane?: (res: number, data: Uint8Array, w: number, h: number, bpp: number) => void;
  /** Every exception a command's decoding caught (tests/virgl-fuzz.ts: anything but an `Error` thrown on purpose is a defect). */
  onCaught?: (e: unknown) => void;
  private externals = new Set<Res>();
  /** External resources whose bytes are on their way (`externalWait`): what may see them waits, as for a picture. */
  private externalWaits = new Set<number>();
  private fbo: WebGLFramebuffer;
  private readFbo: WebGLFramebuffer;
  /** Whether the GL's own read pair for an internal format is its upload's (`readsAsStored`). */
  private readonly ownReadPair = new Map<number, boolean>();
  /** The framebuffers the renderer last bound for drawing and reading (`bindFb`). */
  private boundFb = { draw: null as WebGLFramebuffer | null, read: null as WebGLFramebuffer | null };
  /**
   * What `fbo` and `readFbo` have attached, by point (an object, and a texture's level and face or layer), and `fbo`'s
   * draw buffers: a call that would set what is already there is left out. The draws set every point at each draw
   * (nothing is assumed bound), mostly to what it was, and ANGLE on Metal takes an empty point emptied again as a
   * change of the framebuffer: ~38 µs of the GPU process a draw (bench/gpu/state-cost.ts, PERF loop 79).
   */
  private attached = new Map<WebGLFramebuffer, Map<number, Attached>>();
  /** `fbo`'s draw buffers (the first `fboBufferCount`, at most `colorAttachments`: 8; -1: not set yet). */
  private fboBuffers = new Int32Array(8);
  private fboBufferCount = -1;
  /** The draw buffers `bindFramebuffer` gives a draw (reused). */
  private drawBufs: number[] = [];
  /** The blend color as float32s and their bits (`Program.set` compares a uniform's bits). */
  private blendBits = (() => {
    const f = new Float32Array(4);
    return { f, u: new Uint32Array(f.buffer) };
  })();
  /** `?gpu=noattachcache`: every attachment and draw buffer set again (`attached`; PERF loop 79's A/B). */
  private attachCache: boolean;
  /** `?gpu=nodrawcache`: a draw's vertex arrays and uniforms set again (`Sub.vaoState`, `Program.set`; PERF loop 79's A/B). */
  private drawCache: boolean;
  private blitProg?: { prog: WebGLProgram; loc: Map<string, WebGLUniformLocation | null> };
  private anisotropy: boolean;
  private colorBufferFloat: boolean;
  /**
   * Blending into 32-bit float targets (EXT_float_blend): WebGL2 refuses a draw that blends into one without it. The
   * caps can't say a render target isn't blendable (virgl's Mesa ignores PIPE_BIND_BLENDABLE), so without it such a
   * target is drawn unblended.
   */
  private floatBlend: boolean;
  /** Per-buffer blending and color masks (the caps' independent blending: web/virgl-caps.ts), if the browser has them. */
  private indexed: OES_draw_buffers_indexed | null;
  /** Clip control (the caps' CLIP_HALFZ), if the browser has it, and whether it's at 0 to 1 now. */
  private clipControl: { clipControlEXT(origin: number, depth: number): void } | null;
  private halfz = false;
  private readonly maxSamples: number;
  /** WebGL's limits on a texture's size (what the caps offer: web/virgl-caps.ts), checked at a resource's creation. */
  private readonly limits: { size: number; size3d: number; cube: number; layers: number };
  /** The color attachments the context has, up to the 8 the caps offer (WebGL2 promises 4; SwiftShader's Vulkan has 6). */
  private readonly colorAttachments: number;
  private queries: Query[] = [];
  /** Changes to the pending queries so far (one added or settled): the GPU worker's poll follows the set, not its size. */
  queryChanges = 0;
  /**
   * The span counting draws now (WebGL has one occlusion query active, and every context and sub-context draws on the
   * one WebGL context): begun at a sub-context's draw while it has occlusion queries active, ended when anything else
   * may draw (`pauseQueries`).
   */
  private counter?: { span: Span; sub: Sub };
  /** WebGL queries whose results were read, for new spans. */
  private spareQueries: WebGLQuery[] = [];
  private lostQueries = 0;
  /** Primitive queries (generated, emitted by stream output) counted by the draws, with their context. */
  private counting = new Map<Query, number>();
  /** A framebuffer for draws that only capture (stream output with nothing bound to draw on). */
  private nullFbo?: WebGLFramebuffer;
  private errorsLogged = 0;
  private quirks: Quirks;
  private errorKinds = new Map<string, number>();

  /** A trace of what the guest makes and draws with, each line once (`?gpu=virgl,debug`): resources, surfaces, views, draws. */
  private debug?: (m: string) => void;
  /** With `debug`: each resource's creation time and what passed through it, for its `life` line at its unref. */
  private life = new Map<number, { t0: number; uploads: number; bytes: number; staged: number }>();

  constructor(
    gl: WebGL2RenderingContext,
    o: {
      ram: () => Ram;
      log?: (m: string) => void;
      debug?: (m: string) => void;
      video?: { decoders: DecoderFactory; hardware: readonly number[] };
      checkPrograms?: boolean;
      noAttachCache?: boolean;
      noDrawCache?: boolean;
    },
  ) {
    this.gl = gl;
    this.checkPrograms = !!o.checkPrograms;
    this.ram = o.ram;
    this.video = o.video;
    this.debug = o.debug;
    this.log = o.log ?? ((m) => console.warn(`virgl: ${m}`));
    this.fbo = gl.createFramebuffer()!;
    this.readFbo = gl.createFramebuffer()!;
    this.attached.set(this.fbo, new Map()).set(this.readFbo, new Map());
    this.attachCache = !o.noAttachCache;
    this.drawCache = !o.noDrawCache;
    this.anisotropy = !!gl.getExtension('EXT_texture_filter_anisotropic');
    this.quirks = quirksOf(gl);
    this.colorBufferFloat = !!gl.getExtension('EXT_color_buffer_float');
    this.floatBlend = !!gl.getExtension('EXT_float_blend');
    this.indexed = gl.getExtension('OES_draw_buffers_indexed') as OES_draw_buffers_indexed | null;
    this.clipControl = gl.getExtension('EXT_clip_control') as {
      clipControlEXT(origin: number, depth: number): void;
    } | null;
    this.maxSamples = gl.getParameter(E.MAX_SAMPLES) as number;
    const p = (n: number) => gl.getParameter(n) as number;
    this.limits = {
      size: p(E.MAX_TEXTURE_SIZE),
      size3d: p(E.MAX_3D_TEXTURE_SIZE),
      cube: p(E.MAX_CUBE_MAP_TEXTURE_SIZE),
      layers: p(E.MAX_ARRAY_TEXTURE_LAYERS),
    };
    this.colorAttachments = Math.min(gl.getParameter(E.MAX_COLOR_ATTACHMENTS) as number, 8);
    gl.getExtension('EXT_color_buffer_half_float');
    gl.getExtension('EXT_texture_norm16');
    gl.getExtension('OES_texture_float_linear');
    for (const e of [
      'WEBGL_compressed_texture_s3tc',
      'WEBGL_compressed_texture_s3tc_srgb',
      'WEBGL_compressed_texture_etc',
      'EXT_texture_compression_rgtc',
      'EXT_texture_compression_bptc',
    ])
      gl.getExtension(e);
    gl.pixelStorei(E.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(E.PACK_ALIGNMENT, 1);
  }

  /** Logged: each kind of error (its first 40 characters) 5 times, 200 in all (one noisy kind hid the others). */
  private error(m: string) {
    this.stats.errors++;
    // A kind is the message without its numbers (most begin with a context's and a resource's), so each is said a few times.
    const kind = m.replace(/\d+/g, '#').slice(0, 60),
      n = this.errorKinds.get(kind) ?? 0;
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

  get contextCount() {
    return this.contexts.size;
  }

  /** A virtio reset: every context and resource is gone. */
  reset() {
    this.pauseQueries();
    for (const id of [...this.contexts.keys()]) this.destroyContext(id);
    for (const id of [...this.resources.keys()]) this.unrefResource(id);
    this.queries = [];
    this.queryChanges++;
    this.counting.clear();
  }

  private newSub(id: number): Sub {
    return {
      id,
      objects: new Map(),
      shaders: {},
      vbs: [],
      ib: null,
      consts: { vs: new Uint32Array(0), fs: new Uint32Array(0) },
      ubos: { vs: new Map(), fs: new Map() },
      views: { vs: [], fs: [] },
      samplers: { vs: [], fs: [] },
      fb: { cbufs: [] },
      viewport: { scale: [1, 1, 1], translate: [0, 0, 0] },
      scissor: { minx: 0, miny: 0, maxx: 0, maxy: 0 },
      stencilRef: [0, 0],
      blendColor: [0, 0, 0, 0],
      stipple: new Uint32Array(32).fill(0xffffffff),
      sampleMask: ~0,
      so: { targets: [], seen: new Set() },
      longShader: new Map(),
      occlusion: new Set(),
    };
  }

  private destroySub(s: Sub) {
    for (const o of s.objects.values()) this.destroyObject(o, s);
    if (s.vao) this.gl.deleteVertexArray(s.vao);
    if (s.so.tf) this.gl.deleteTransformFeedback(s.so.tf);
  }

  private destroyObject(o: Obj, s: Sub) {
    if (o.kind === 'sampler' && o.v.sampler) this.gl.deleteSampler(o.v.sampler);
    if (o.kind === 'shader') this.forgetShader(o.v);
    if (o.kind === 'query') {
      this.counting.delete(o.v);
      if (s.occlusion.delete(o.v) && this.counter?.sub === s) this.pauseQueries();
      this.dropSpans(o.v);
      // A deleted query never has its result: pending, it would hold every later fence (FenceGate) for good, and the
      // guest's control queue filled behind them (dEQP-GLES3 hung at a context's end).
      o.v.pending = false;
      this.queries = this.queries.filter((q) => q !== o.v);
      this.queryChanges++;
    }
  }

  /** A shader object gone: the programs made with it are deleted (a new object of the same text is another shader). */
  private forgetShader(sh: Shader) {
    this.dropPrograms(sh);
    // As a fragment shader: the vertex shaders' lists too (a long-lived vertex shader meets many fragment shaders).
    for (const vs of sh.pairs ?? []) {
      for (const p of vs.programs?.get(sh)?.values() ?? []) if (p) this.gl.deleteProgram(p.prog);
      vs.programs?.delete(sh);
    }
    sh.pairs = undefined;
  }

  /** The programs made with `vs` as their vertex shader, deleted. */
  private dropPrograms(vs: Shader) {
    for (const [fs, programs] of vs.programs ?? []) {
      for (const p of programs.values()) if (p) this.gl.deleteProgram(p.prog);
      fs.pairs?.delete(vs);
    }
    vs.programs = undefined;
  }

  // --- resources -------------------------------------------------------------------------------------------------

  createResource(d: ResourceDesc): boolean {
    if (this.resources.has(d.id)) return false;
    const gl = this.gl;
    const res: Res = { ...d, fmt: FORMATS.get(d.format), backing: null, refs: new Set() };
    this.debug?.(
      `resource ${d.id} ${res.fmt?.name ?? d.format} ${d.width}x${d.height} target ${d.target} bind ${d.bind.toString(16)}`,
    );
    this.resources.set(d.id, res);
    if (this.debug) this.life.set(d.id, { t0: performance.now(), uploads: 0, bytes: 0, staged: 0 });
    // Past the limits (as vrend's check_resource_valid) the guest's object exists with nothing on the host: a buffer's
    // CPU copy and a texture's kept texels are sized by it (a 2 GiB buffer was a 2 GiB copy: tests/virgl-fuzz.ts).
    const tooBig = this.tooBig(d);
    if (tooBig) {
      this.error(`resource ${d.id}: ${tooBig}`);
      return true;
    }
    if (d.target === PIPE_BUFFER) {
      // A staging buffer is only ever the guest's pages.
      if (d.bind & BIND_STAGING) return true;
      res.shadow = new Uint8Array(d.width);
      res.buf = gl.createBuffer()!;
      gl.bindBuffer(E.COPY_WRITE_BUFFER, res.buf);
      gl.bufferData(E.COPY_WRITE_BUFFER, d.width, E.DYNAMIC_DRAW);
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
      if (d.samples > 1)
        gl.renderbufferStorageMultisample(
          E.RENDERBUFFER,
          Math.min(d.samples, this.maxSamples),
          f.internal,
          d.width,
          d.height,
        );
      else gl.renderbufferStorage(E.RENDERBUFFER, f.internal, d.width, d.height);
      return true;
    }
    res.tex = gl.createTexture()!;
    switch (d.target) {
      case PIPE_TEXTURE_1D:
      case PIPE_TEXTURE_2D:
      case PIPE_TEXTURE_RECT:
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
      case PIPE_TEXTURE_1D_ARRAY:
      case PIPE_TEXTURE_2D_ARRAY:
        res.glTarget = E.TEXTURE_2D_ARRAY;
        gl.bindTexture(E.TEXTURE_2D_ARRAY, res.tex);
        gl.texStorage3D(
          E.TEXTURE_2D_ARRAY,
          levels,
          f.internal,
          d.width,
          d.target === PIPE_TEXTURE_1D_ARRAY ? 1 : d.height,
          d.arraySize,
        );
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

  /** Why a resource can't be made (its size past WebGL's limits), if it can't. */
  private tooBig(d: ResourceDesc) {
    const l = this.limits;
    if (d.target === PIPE_BUFFER) return d.width > MAX_BUFFER ? `a buffer of ${d.width} bytes` : undefined;
    const [size, layers] =
      d.target === PIPE_TEXTURE_3D
        ? [l.size3d, l.size3d]
        : d.target === PIPE_TEXTURE_CUBE
          ? [l.cube, 6]
          : [l.size, l.layers];
    if (d.width > size || d.height > size || (d.target === PIPE_TEXTURE_3D ? d.depth : d.arraySize) > layers)
      return `a texture of ${d.width}x${d.height}x${d.target === PIPE_TEXTURE_3D ? d.depth : d.arraySize}`;
    if (d.lastLevel > 31) return `${d.lastLevel + 1} levels`;
    return undefined;
  }

  unrefResource(id: number) {
    const r = this.resources.get(id);
    if (!r) return false;
    this.resources.delete(id);
    r.dead = true;
    const l = this.life.get(id);
    if (l) {
      this.life.delete(id);
      this.debug?.(
        `life ${id} ${r.fmt?.name ?? r.format} ${r.width}x${r.height} target ${r.target} bind ${r.bind.toString(16)}: ${(performance.now() - l.t0).toFixed(0)} ms, ${l.uploads} uploads of ${l.bytes} bytes, ${l.staged} bytes staged`,
      );
    }
    for (const c of r.refs) this.contexts.get(c)?.attached.delete(id);
    if (r.external) {
      this.externals.delete(r);
      this.externalWait(id, false);
    }
    this.freeResource(r);
    return true;
  }

  /**
   * PIPE_RESOURCE_SET_TYPE (handle, format, bind, width, height, usage, modifier, plane strides and offsets): the
   * guest's import of another renderer's blob (a Vulkan program's WSI image in the compositor): a 2D texture of that
   * format and size, attached to the context, whose bytes `external` writes before each submit that may use it.
   */
  private setType(c: Ctx, p: Uint32Array) {
    if (p.length < 8) throw new Error('bad PIPE_RESOURCE_SET_TYPE');
    const id = p[0];
    let r = this.resources.get(id);
    if (!r) {
      if (!this.external?.has(id)) return this.error(`ctx ${c.id}: resource ${id} isn't a blob of another renderer`);
      this.createResource({
        id,
        target: PIPE_TEXTURE_2D,
        format: p[1],
        bind: p[2],
        width: p[3],
        height: p[4],
        depth: 1,
        arraySize: 1,
        lastLevel: 0,
        samples: 0,
        flags: 0,
      });
      r = this.resources.get(id)!;
      if (!r.tex || !r.fmt || r.fmt.block !== 1 || (r.fmt.kind !== 'unorm' && r.fmt.kind !== 'float'))
        this.error(
          `resource ${id}: an imported blob of format ${r.fmt?.name ?? p[1]} isn't shared (colour formats only)`,
        );
      else {
        r.external = true;
        // The first plane's stride (VIRGL_PIPE_RES_SET_TYPE_PLANE_STRIDE(0)), past the modifier.
        if (p.length > 8) r.stride = p[8];
        this.externals.add(r);
      }
    }
    this.attach(c.id, id);
  }

  /**
   * An external resource's texels, from `src`: an image the size of the resource or smaller, whose colours are the
   * texels' stored channels (for a format kept as its bytes, B8G8R8A8's, the bytes in memory order; premultiplied
   * alpha left as it is), converted to the texture's format; or the texels' bytes, rows `stride` bytes apart.
   */
  writeExternal(
    id: number,
    src: TexImageSource | { bytes: Uint8Array; stride: number; width: number; height: number },
  ) {
    const r = this.resources.get(id);
    if (!r?.external || r.dead || !r.tex || !r.fmt) return;
    if ('bytes' in src)
      return this.upload(
        r,
        0,
        { x: 0, y: 0, z: 0, w: Math.min(r.width, src.width), h: Math.min(r.height, src.height), d: 1 },
        src.bytes,
        src.stride,
        0,
      );
    const gl = this.gl;
    gl.bindTexture(E.TEXTURE_2D, r.tex);
    gl.bindBuffer(E.PIXEL_UNPACK_BUFFER, null);
    gl.pixelStorei(E.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(E.UNPACK_COLORSPACE_CONVERSION_WEBGL, E.NONE);
    gl.texSubImage2D(E.TEXTURE_2D, 0, 0, 0, r.fmt.format, r.fmt.type, src);
    gl.pixelStorei(E.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(E.UNPACK_COLORSPACE_CONVERSION_WEBGL, E.BROWSER_DEFAULT_WEBGL);
    this.stats.uploads++;
  }

  /**
   * An external resource's texels in rows `ys`, each `w` wide from x 0, as its format stores them (web/venus-share.ts
   * checks a copy against its source); null if it can't be read.
   */
  readExternalRows(id: number, ys: number[], w: number): Uint8Array[] | null {
    const r = this.resources.get(id);
    if (!r?.external || r.dead || !r.tex) return null;
    const rows: Uint8Array[] = [];
    for (const y of ys) {
      const row = this.readback(r, 0, { x: 0, y, z: 0, w, h: 1, d: 1 }, 0, 0, this.hostReader(r));
      if (!row) return null;
      rows.push(row);
    }
    return rows;
  }

  /** Whether an external resource's bytes are on their way: a submit that may sample it waits until they arrive. */
  externalWait(id: number, waiting: boolean) {
    if (waiting) this.externalWaits.add(id);
    else if (this.externalWaits.delete(id)) this.onVideoSettled?.();
  }

  /** The external resources attached to a context (web/venus-share.ts readies them before its submit comes to run). */
  externalsOf(ctx: number): ExternalResource[] {
    const out: ExternalResource[] = [];
    for (const r of this.externals) if (r.refs.has(ctx)) out.push(r);
    return out;
  }

  private freeResource(r: Res) {
    const gl = this.gl;
    if (r.buf) gl.deleteBuffer(r.buf);
    if (r.ibuf) gl.deleteBuffer(r.ibuf);
    if (r.msResolved?.tex) gl.deleteTexture(r.msResolved.tex);
    if (r.feedback?.tex) gl.deleteTexture(r.feedback.tex);
    this.dropPicture(r);
    if (r.tex) gl.deleteTexture(r.tex);
    if (r.rb) gl.deleteRenderbuffer(r.rb);
  }

  attachBacking(id: number, backing: Backing) {
    const r = this.resources.get(id);
    if (!r) return false;
    // Adjacent entries merged: most backings are a few contiguous runs, and a contiguous range is read in place.
    const merged: Backing = [];
    for (const b of backing) {
      const last = merged[merged.length - 1];
      if (last && last.mem === b.mem && last.off + last.len === b.off) last.len += b.len;
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
    const c = this.contexts.get(ctx),
      r = this.resources.get(res);
    if (!c || !r) return false;
    c.attached.add(res);
    r.refs.add(ctx);
    return true;
  }

  detach(ctx: number, res: number) {
    const c = this.contexts.get(ctx),
      r = this.resources.get(res);
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

  /**
   * `len` bytes at `offset` in the resource's backing: a view of guest RAM if they're contiguous, else a copy (a join).
   * A join goes into `joined`, kept for the next (a staging buffer's pages are scattered: Firefox's scroll joins ~900 KB
   * 70 times a second, PERF loop 91), unless it's over `JOIN_KEPT`: so the bytes are the caller's until its next call
   * only, as a view of guest RAM is (an upload copies them at once). With `own`, they're the caller's for good: a copy
   * either way, a join into a fresh buffer (the video path, which reads two and keeps both). Empty for no bytes.
   */
  private readBacking(r: Res, offset: number, len: number, own = false): Uint8Array | null {
    if (!r.backing) return null;
    if (len <= 0) return new Uint8Array(0); // an empty box, at the backing's end too (PERF loop 93)
    const ram = this.ram();
    this.stats.backingReads++;
    let skip = offset;
    for (let k = 0; k < r.backing.length; k++) {
      const b = r.backing[k];
      if (skip >= b.len) {
        skip -= b.len;
        continue;
      }
      if (skip + len <= b.len)
        return own ? bytes(ram, b).slice(skip, skip + len) : bytes(ram, b).subarray(skip, skip + len);
      this.stats.joins++;
      this.stats.joinBytes += len;
      let out: Uint8Array;
      if (own || len > JOIN_KEPT) out = new Uint8Array(len);
      else {
        if (this.joined.length < len)
          this.joined = new Uint8Array(Math.min(JOIN_KEPT, Math.max(len, 2 * this.joined.length)));
        out = this.joined.subarray(0, len);
      }
      let at = 0;
      for (let j = k; j < r.backing.length && at < len; j++) {
        const e = r.backing[j];
        const n = Math.min(e.len - (j === k ? skip : 0), len - at);
        out.set(bytes(ram, e).subarray(j === k ? skip : 0, (j === k ? skip : 0) + n), at);
        at += n;
      }
      return at === len ? out : null;
    }
    return null;
  }

  /** Writes `bytes` at `offset` of the resource's backing. False if it doesn't fit. */
  private writeBacking(r: Res, offset: number, data: Uint8Array) {
    if (!r.backing) return false;
    const ram = this.ram();
    let skip = offset,
      at = 0;
    for (const b of r.backing) {
      if (skip >= b.len) {
        skip -= b.len;
        continue;
      }
      const n = Math.min(b.len - skip, data.length - at);
      bytes(ram, b).set(data.subarray(at, at + n), skip);
      at += n;
      skip = 0;
      if (at === data.length) return true;
    }
    return at === data.length;
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
    this.dropPicture(r);
    this.stats.uploads++;
    this.stats.uploadBytes += data.length;
    const l = this.life.get(r.id);
    if (l) {
      l.uploads++;
      l.bytes += data.length;
    }
    if (r.target !== PIPE_BUFFER && this.debug) {
      // For 4-byte formats: how many texels have alpha (the fourth byte) 0, 255 and in between, and the first texel.
      let a0 = 0,
        a255 = 0,
        mid = 0;
      if (r.fmt?.bpp === 4)
        for (let k = 3; k < data.length; k += 4) data[k] === 0 ? a0++ : data[k] === 255 ? a255++ : mid++;
      this.debug(
        `upload ${r.id}:${r.fmt?.name} ${box.w}x${box.h}${box.w === r.width && box.h === r.height ? ' (all)' : ''} stride ${stride}${r.fmt?.bpp === 4 ? ` alpha 0:${a0} 255:${a255} other:${mid} first ${[...data.subarray(0, 4)].join(',')}` : ''}`,
      );
    }
    if (r.target === PIPE_BUFFER) {
      if (!r.shadow) return; // staging: nothing on the host
      if (box.x + box.w > r.shadow.length) return this.error(`upload past the end of buffer ${r.id}`);
      const src = data.subarray(0, box.w);
      r.shadow.set(src, box.x);
      gl.bindBuffer(E.COPY_WRITE_BUFFER, r.buf!);
      gl.bufferSubData(E.COPY_WRITE_BUFFER, box.x, r.shadow, box.x, box.w);
      indexWritten(r, box.x, box.x + box.w);
      return;
    }
    const f = r.fmt;
    if (!f || !r.tex) return this.error(`upload to resource ${r.id} without a texture`);
    if (!this.inLevel(r, level, box)) return this.error(`upload to resource ${r.id}: the box isn't in level ${level}`);
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
    if (data.length < boxBytes(f, box.w, box.h, box.d, stride, layerStride))
      return this.error(`upload to resource ${r.id}: ${data.length} bytes for the box`);
    if (stride % f.bpp && b === 1) {
      // A stride that isn't a whole number of pixels: repack.
      const out = new Uint8Array(rowBytes * rows * box.d);
      for (let z = 0; z < box.d; z++)
        for (let y = 0; y < rows; y++)
          out.set(
            data.subarray(z * layerStride + y * stride, z * layerStride + y * stride + rowBytes),
            (z * rows + y) * rowBytes,
          );
      [data, stride, layerStride] = [out, rowBytes, rowBytes * rows];
    }
    if (!f.write && b === 1 && f.kind !== 'depth' && f.kind !== 'depthstencil' && f.kind !== 'stencil')
      this.keepTexels(r, level, box, data, stride, layerStride);
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
        this.keepBlocks(r, level, box, box.z + z, layer);
        if (t === E.TEXTURE_2D) gl.compressedTexSubImage2D(t, level, box.x, box.y, box.w, box.h, f.internal, layer);
        else if (t === E.TEXTURE_CUBE_MAP)
          gl.compressedTexSubImage2D(
            E.TEXTURE_CUBE_MAP_POSITIVE_X + box.z + z,
            level,
            box.x,
            box.y,
            box.w,
            box.h,
            f.internal,
            layer,
          );
        else gl.compressedTexSubImage3D(t, level, box.x, box.y, box.z + z, box.w, box.h, 1, f.internal, layer);
      }
      return;
    }
    gl.pixelStorei(E.UNPACK_ROW_LENGTH, stride / f.bpp);
    gl.pixelStorei(E.UNPACK_IMAGE_HEIGHT, layerStride / stride);
    const view = viewFor(f.type, data.subarray(0, boxBytes(f, box.w, box.h, box.d, stride, layerStride)));
    if (t === E.TEXTURE_2D) {
      const y = r.target === PIPE_TEXTURE_1D ? 0 : box.y,
        h = r.target === PIPE_TEXTURE_1D ? 1 : box.h;
      gl.texSubImage2D(t, level, box.x, y, box.w, h, f.format, f.type, view);
    } else if (t === E.TEXTURE_CUBE_MAP) {
      for (let z = 0; z < box.d; z++) {
        const v = viewFor(f.type, data.subarray(z * layerStride, z * layerStride + stride * box.h));
        gl.texSubImage2D(
          E.TEXTURE_CUBE_MAP_POSITIVE_X + box.z + z,
          level,
          box.x,
          box.y,
          box.w,
          box.h,
          f.format,
          f.type,
          v,
        );
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
  private readback(
    r: Res,
    level: number,
    box: Box,
    stride: number,
    layerStride: number,
    reader = r.fmt && readbackOf(r.fmt, this.colorBufferFloat),
  ): Uint8Array | null {
    const gl = this.gl;
    this.stats.readbacks++;
    if (r.target === PIPE_BUFFER) {
      if (!r.shadow) return null;
      this.stats.readbackBytes += box.w;
      return r.shadow.slice(box.x, box.x + box.w);
    }
    const f = r.fmt;
    if (!f || f.block > 1 || !this.inLevel(r, level, box)) return null;
    const rowBytes = box.w * f.bpp;
    stride ||= rowBytes;
    layerStride ||= stride * box.h;
    const out = new Uint8Array(boxBytes(f, box.w, box.h, box.d, stride, layerStride));
    this.stats.readbackBytes += rowBytes * box.h * box.d;
    if (!reader) return null;
    const packed = stride === rowBytes && layerStride === rowBytes * box.h;
    let straight: boolean | undefined;
    let tmp: Uint8Array | undefined;
    for (let z = 0; z < box.d; z++) {
      if (!this.bindForRead(r, level, box.z + z)) return null;
      // A packed box whose texels the GL reads as they're stored goes straight into `out`, unpacked by nothing.
      straight ??= packed && this.readsAsStored(f, reader);
      if (straight) {
        const layer = viewFor(f.type, out.subarray(z * layerStride, (z + 1) * layerStride))!;
        gl.readPixels(box.x, box.y, box.w, box.h, f.format, f.type, layer);
        continue;
      }
      tmp ??= new Uint8Array(box.w * box.h * reader.bytes);
      const view =
        reader.type === E.FLOAT
          ? new Float32Array(tmp.buffer)
          : reader.type === E.UNSIGNED_INT
            ? new Uint32Array(tmp.buffer)
            : reader.type === E.INT
              ? new Int32Array(tmp.buffer)
              : reader.type === E.UNSIGNED_INT_2_10_10_10_REV
                ? new Uint32Array(tmp.buffer)
                : reader.type === E.UNSIGNED_SHORT
                  ? new Uint16Array(tmp.buffer)
                  : tmp;
      gl.readPixels(box.x, box.y, box.w, box.h, reader.format, reader.type, view);
      for (let y = 0; y < box.h; y++)
        reader.pack(
          tmp.subarray(y * box.w * reader.bytes, (y + 1) * box.w * reader.bytes),
          out.subarray(z * layerStride + y * stride, z * layerStride + y * stride + rowBytes),
          box.w,
        );
    }
    this.bindFb(E.READ_FRAMEBUFFER, null);
    return out;
  }

  /**
   * Whether readPixels gives `f`'s texels as they're stored (the bytes an upload of `f.format` and `f.type` takes, `f.bpp`
   * a texel), with its level bound for reading: `reader` reads them so (RGBA8, RGB10_A2, the 32-bit RGBA formats), or
   * the GL's own read format and type for it are those (WebGL2 reads a color buffer as RGBA, RGBA_INTEGER or that one
   * pair: R8 and RG8 as RED and RG bytes, RGB565 as shorts, on ANGLE's Metal, Vulkan and SwiftShader), asked once per
   * internal format (a round trip to the GPU process). Then the read needs no copy and no repacking (PERF loop 85).
   */
  private readsAsStored(f: Format, reader: NonNullable<ReturnType<typeof readbackOf>>) {
    if (reader.format === f.format && reader.type === f.type && reader.bytes === f.bpp) return true;
    let own = this.ownReadPair.get(f.internal);
    if (own === undefined) {
      const gl = this.gl;
      own =
        gl.getParameter(E.IMPLEMENTATION_COLOR_READ_FORMAT) === f.format &&
        gl.getParameter(E.IMPLEMENTATION_COLOR_READ_TYPE) === f.type;
      this.ownReadPair.set(f.internal, own);
    }
    return own;
  }

  /**
   * Whether a texture's box lies in one of its levels (whole blocks of a compressed format): WebGL refuses the others,
   * and the CPU's work on a box (repacking, keeping texels, reading back) is sized by it (tests/virgl-fuzz.ts). A 1D
   * array's layers are its box's rows (an upload's) or its layers (a snapshot's read).
   */
  private inLevel(r: Res, level: number, box: Box) {
    if (level > r.lastLevel) return false;
    const b = r.fmt?.block ?? 1,
      { w, h, d } = this.levelSize(r, level);
    const [rows, layers] =
      r.target === PIPE_TEXTURE_1D
        ? [1, 1]
        : r.target === PIPE_TEXTURE_1D_ARRAY
          ? [Math.max(1, r.arraySize), Math.max(1, r.arraySize)]
          : r.target === PIPE_TEXTURE_CUBE
            ? [h, Math.max(6, d)]
            : [h, d];
    const fits = (at: number, n: number, size: number, block: number) =>
      Math.ceil((at + n) / block) <= Math.ceil(size / block);
    return (
      fits(box.x, box.w, w, b) &&
      fits(box.y, box.h, rows, r.target === PIPE_TEXTURE_1D_ARRAY ? 1 : b) &&
      box.z + box.d <= layers
    );
  }

  /** The read framebuffer with the resource's level (and layer) as its color attachment. */
  private bindForRead(r: Res, level: number, layer: number) {
    const gl = this.gl;
    this.bindFb(E.READ_FRAMEBUFFER, this.readFbo);
    this.attachTo(E.READ_FRAMEBUFFER, E.COLOR_ATTACHMENT0, r, level, layer);
    return gl.checkFramebufferStatus(E.READ_FRAMEBUFFER) === E.FRAMEBUFFER_COMPLETE;
  }

  /**
   * Binds `fb` at `target`, as `attachTo` and `setDrawBuffers` take it: every framebuffer binding on the context goes
   * through here, the Screen's too (`bindDefaultFramebuffer`), so `boundFb` is GL's binding between calls as well.
   */
  private bindFb(target: number, fb: WebGLFramebuffer | null) {
    if (target !== E.READ_FRAMEBUFFER) this.boundFb.draw = fb;
    if (target !== E.DRAW_FRAMEBUFFER) this.boundFb.read = fb;
    this.gl.bindFramebuffer(target, fb);
  }

  /** The default framebuffer bound for drawing and reading: the Screen's present and grab (web/virgl-screen.ts). */
  bindDefaultFramebuffer() {
    this.bindFb(E.FRAMEBUFFER, null);
  }

  /** The draw buffers of the framebuffer bound for drawing, left as they are on `fbo` when they already are (`attached`). */
  private setDrawBuffers(bufs: readonly number[]) {
    if (this.boundFb.draw === this.fbo && this.attachCache) {
      const kept = this.fboBuffers;
      let same = this.fboBufferCount === bufs.length;
      for (let k = 0; same && k < bufs.length; k++) same = kept[k] === bufs[k];
      if (same) return;
      kept.set(bufs);
      this.fboBufferCount = bufs.length;
    }
    this.gl.drawBuffers(bufs as number[]);
  }

  /** Attaches `r`'s level and layer (nothing without it) at `point` of the framebuffer bound at `target`; on `fbo` and
   * `readFbo`, only where something else is attached there (`attached`). */
  private attachTo(target: number, point: number, r: Res | undefined, level: number, layer: number) {
    const gl = this.gl;
    if (r && target === E.DRAW_FRAMEBUFFER) this.dropPicture(r); // drawn into: the plane is what's current
    const fb = target === E.READ_FRAMEBUFFER ? this.boundFb.read : this.boundFb.draw;
    const points = fb && this.attachCache ? this.attached.get(fb) : undefined;
    if (points) {
      const obj = r ? (r.rb ?? r.tex ?? null) : null;
      const lv = r && !r.rb ? level : 0,
        ly = r && !r.rb && r.glTarget !== E.TEXTURE_2D ? layer : 0;
      // DEPTH_STENCIL_ATTACHMENT is both the depth and the stencil point (GLES 3.0 §4.4.2.4).
      const ds = point === E.DEPTH_STENCIL_ATTACHMENT;
      const same = keepPoint(points, ds ? E.DEPTH_ATTACHMENT : point, obj, lv, ly);
      if ((ds ? keepPoint(points, E.STENCIL_ATTACHMENT, obj, lv, ly) : true) && same) return;
    }
    if (!r) {
      gl.framebufferRenderbuffer(target, point, E.RENDERBUFFER, null);
      return;
    }
    if (r.rb) gl.framebufferRenderbuffer(target, point, E.RENDERBUFFER, r.rb);
    else if (r.glTarget === E.TEXTURE_2D) gl.framebufferTexture2D(target, point, E.TEXTURE_2D, r.tex!, level);
    else if (r.glTarget === E.TEXTURE_CUBE_MAP)
      gl.framebufferTexture2D(target, point, E.TEXTURE_CUBE_MAP_POSITIVE_X + layer, r.tex!, level);
    else gl.framebufferTextureLayer(target, point, r.tex!, level, layer);
  }

  /** TRANSFER_TO_HOST_3D / TRANSFER_FROM_HOST_3D (the virtio commands): the resource's own backing at `offset`. */
  transfer(
    ctx: number,
    id: number,
    level: number,
    box: Box,
    offset: number,
    stride: number,
    layerStride: number,
    toHost: boolean,
  ) {
    const r = this.resources.get(id);
    if (!r) return false;
    return this.transferIov(r, level, box, offset, stride, layerStride, toHost);
  }

  /**
   * A transfer's strides as vrend reads them: 0 is the level's own row pitch (and image size), the backing laid out
   * as the whole level, not the box (a sub-rectangle narrower than its level read the wrong rows).
   */
  private levelStrides(r: Res, level: number, stride: number, layerStride: number) {
    const f = r.fmt;
    if (!f || r.target === PIPE_BUFFER) return [stride, layerStride];
    const b = f.block,
      { w, h } = this.levelSize(r, level);
    stride ||= Math.ceil(w / b) * f.bpp;
    layerStride ||= stride * (r.target === PIPE_TEXTURE_1D_ARRAY ? 1 : Math.ceil(h / b));
    return [stride, layerStride];
  }

  private transferIov(
    r: Res,
    level: number,
    box: Box,
    offset: number,
    stride: number,
    layerStride: number,
    toHost: boolean,
  ) {
    [stride, layerStride] = this.levelStrides(r, level, stride, layerStride);
    const n = r.target === PIPE_BUFFER ? box.w : boxBytes(r.fmt, box.w, box.h, box.d, stride, layerStride);
    if (offset + n > this.backingSize(r)) {
      this.error(`transfer past resource ${r.id}'s backing`);
      return false;
    }
    if (toHost) {
      const data = this.readBacking(r, offset, n);
      if (!data) return false;
      this.upload(r, level, box, data, stride, layerStride);
    } else {
      const data = this.readback(r, level, box, stride, layerStride);
      if (!data) {
        this.error(`can't read back resource ${r.id} (format ${r.format})`);
        return false;
      }
      if (r.target === PIPE_BUFFER)
        this.debug?.(
          `read back ${r.id} [${box.x}, +${box.w}) to its backing at ${offset}: ${[...data.subarray(0, 16)].join(',')}`,
        );
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
    if (this.external) for (const r of this.externals) if (r.refs.has(ctxId)) this.external.refresh(r);
    for (let at = 0; at < words.length;) {
      const h = words[at];
      const len = h >>> 16;
      if (at + 1 + len > words.length) {
        this.error(`ctx ${ctxId}: a command runs past the buffer`);
        this.pauseQueries();
        return false;
      }
      const p = words.subarray(at + 1, at + 1 + len);
      this.stats.commands++;
      try {
        this.command(c, h & 0xff, (h >>> 8) & 0xff, p);
      } catch (e) {
        this.onCaught?.(e);
        this.error(`ctx ${ctxId}: command ${h & 0xff}: ${e instanceof Error ? e.message : e}`);
      }
      at += 1 + len;
    }
    // Another context's commands, or the screen's, may draw next.
    this.pauseQueries();
    return true;
  }

  private command(c: Ctx, cmd: number, obj: number, p: Uint32Array) {
    const s = c.sub;
    switch (cmd) {
      case 0:
        return; // NOP
      case 1:
        return this.createObject(c, obj, p);
      case 2:
        return this.bindObject(s, obj, p);
      case 3: {
        const o = s.objects.get(p[0]);
        if (o) {
          this.destroyObject(o, s);
          s.objects.delete(p[0]);
        }
        return;
      }
      case 4: {
        // SET_VIEWPORT_STATE: start slot, then scale xyz, translate xyz per viewport
        if (p.length >= 7 && p[0] === 0)
          s.viewport = { scale: [uif(p[1]), uif(p[2]), uif(p[3])], translate: [uif(p[4]), uif(p[5]), uif(p[6])] };
        return;
      }
      case 5: {
        // SET_FRAMEBUFFER_STATE: nr_cbufs, zsurf, cbufs
        const n = p[0];
        if (p.length !== 2 + n || n > 8) throw new Error('bad SET_FRAMEBUFFER_STATE');
        s.fb = { cbufs: Array.from({ length: n }, (_, k) => this.surface(s, p[2 + k])), zs: this.surface(s, p[1]) };
        return;
      }
      case 6: {
        // SET_VERTEX_BUFFERS: stride, offset, handle per buffer
        if (p.length % 3) throw new Error('bad SET_VERTEX_BUFFERS');
        s.vbs = Array.from({ length: p.length / 3 }, (_, k) => ({
          stride: p[3 * k],
          offset: p[3 * k + 1],
          res: p[3 * k + 2],
        }));
        return;
      }
      case 7:
        return this.clear(c, p);
      case 8:
        return this.draw(c, p);
      case 9: {
        // RESOURCE_INLINE_WRITE: transfer header then data
        if (p.length < 11) throw new Error('bad RESOURCE_INLINE_WRITE');
        const r = this.lookup(c, p[0]);
        if (!r) return;
        const box = { x: p[5], y: p[6], z: p[7], w: p[8], h: p[9], d: p[10] };
        this.upload(r, p[1], box, new Uint8Array(p.buffer, p.byteOffset + 44, (p.length - 11) * 4), p[3], p[4]);
        return;
      }
      case 10: {
        // SET_SAMPLER_VIEWS: shader, start slot, handles
        const st = this.stage(p[0]);
        if (!st) return;
        if (p[1] + p.length - 2 > MAX_SLOTS) throw new Error('bad SET_SAMPLER_VIEWS');
        for (let k = 2; k < p.length; k++) {
          const o = s.objects.get(p[k]);
          s.views[st][p[1] + k - 2] = o?.kind === 'view' ? o.v : undefined;
        }
        return;
      }
      case 11:
        s.ib =
          p.length >= 3 ? { res: p[0], size: p[1], offset: p[2] } : p[0] ? { res: p[0], size: 0, offset: 0 } : null;
        return;
      case 12: {
        // SET_CONSTANT_BUFFER: shader, index, data
        const st = this.stage(p[0]);
        if (st) s.consts[st] = p.slice(2);
        return;
      }
      case 13:
        s.stencilRef = [p[0] & 0xff, (p[0] >>> 8) & 0xff];
        return;
      case 14:
        s.blendColor = [uif(p[0]), uif(p[1]), uif(p[2]), uif(p[3])];
        return;
      case 15: {
        // SET_SCISSOR_STATE: start slot, minx|miny, maxx|maxy
        if (p.length >= 3 && p[0] === 0)
          s.scissor = { minx: p[1] & 0xffff, miny: p[1] >>> 16, maxx: p[2] & 0xffff, maxy: p[2] >>> 16 };
        return;
      }
      // A blit or a copy counts no samples (one may be a draw: `drawBlit`; ANGLE's may be too).
      case 16:
        this.pauseQueries();
        return this.blit(c, p);
      case 17:
        this.pauseQueries();
        return this.copyRegion(c, p);
      case 18: {
        // BIND_SAMPLER_STATES: shader, start slot, handles
        const st = this.stage(p[0]);
        if (!st) return;
        if (p[1] + p.length - 2 > MAX_SLOTS) throw new Error('bad BIND_SAMPLER_STATES');
        for (let k = 2; k < p.length; k++) {
          const o = s.objects.get(p[k]);
          s.samplers[st][p[1] + k - 2] = o?.kind === 'sampler' ? o.v : undefined;
        }
        return;
      }
      case 19:
        return this.beginQuery(c, p[0]);
      case 20:
        return this.endQuery(c, p[0]);
      case 21:
        return this.getQueryResult(c, p[0]);
      case 22:
        s.stipple = p.slice(0, 32);
        return; // SET_POLYGON_STIPPLE
      case 23:
        return; // SET_CLIP_STATE: user clip planes need clip distances (not advertised)
      case 24:
        s.sampleMask = p[0];
        return;
      case 25: {
        // SET_STREAMOUT_TARGETS: append mask (Mesa sends 0; vrend ignores it), handles
        // As vrend: a set of targets seen before resumes where it stopped (Mesa's resume after a pause sets the same
        // targets again); a new set starts at its targets' beginnings (Mesa makes new targets at each Begin).
        const handles = [...p.subarray(1)];
        s.so.targets = handles.map((h) => {
          const o = s.objects.get(h);
          return o?.kind === 'so' ? o.v : undefined;
        });
        const key = handles.join();
        if (handles.length && !s.so.seen.has(key)) {
          s.so.seen.add(key);
          for (const t of s.so.targets) if (t) t.filled = 0;
        }
        return;
      }
      case 26:
        return; // SET_RENDER_CONDITION: not advertised
      case 27: {
        // SET_UNIFORM_BUFFER: shader, index, offset, length, handle
        const st = this.stage(p[0]);
        if (!st) return;
        if (p[4]) s.ubos[st].set(p[1], { res: p[4], offset: p[2], length: p[3] });
        else s.ubos[st].delete(p[1]);
        return;
      }
      case 28: {
        // SET_SUB_CTX
        const sub = c.subs.get(p[0]);
        if (sub) c.sub = sub;
        else this.error(`ctx ${c.id}: no sub-context ${p[0]}`);
        return;
      }
      case 29:
        if (!c.subs.has(p[0])) c.subs.set(p[0], this.newSub(p[0]));
        return;
      case 30: {
        // DESTROY_SUB_CTX (0 stays)
        const sub = c.subs.get(p[0]);
        if (!sub || p[0] === 0) return;
        this.destroySub(sub);
        c.subs.delete(p[0]);
        if (c.sub === sub) c.sub = c.subs.get(0)!;
        return;
      }
      case 31: {
        // BIND_SHADER: handle, type
        const st = this.stage(p[1]);
        const o = s.objects.get(p[0]);
        if (st) s.shaders[st] = o?.kind === 'shader' ? o.v : undefined;
        return;
      }
      case 32:
      case 33:
        return; // SET_TESS_STATE, SET_MIN_SAMPLES
      case 36:
      case 39:
        return; // MEMORY_BARRIER, TEXTURE_BARRIER: one context, in order
      case 41:
      case 46:
      case 51:
        return; // SET_DEBUG_FLAGS, SET_TWEAKS, SEND_STRING_MARKER
      case 43: {
        // TRANSFER3D: the resource's own backing at DATA_OFFSET, direction
        if (p.length < 13) throw new Error('bad TRANSFER3D');
        const r = this.lookup(c, p[0]);
        if (!r) return;
        this.transferIov(
          r,
          p[1],
          { x: p[5], y: p[6], z: p[7], w: p[8], h: p[9], d: p[10] },
          p[11],
          p[3],
          p[4],
          p[12] === 1,
        );
        return;
      }
      case 44:
        return; // END_TRANSFERS
      case 45:
        return this.copyTransfer(c, p);
      case 47:
        return this.clearTexture(c, p);
      case 49:
        return this.setType(c, p);
      case 52:
        return; // LINK_SHADER: programs are made at the draw that needs them
      case 53:
      case 54:
      case 55:
      case 56:
      case 57:
      case 58:
      case 59:
      case 60:
      case 61:
        return (c.video ??= this.videoContext(c)).command(cmd, p);
      case 62:
        return this.clearSurface(c, p);
      default:
        this.error(`ctx ${c.id}: command ${cmd} isn't supported`);
    }
  }

  private videoContext(c: Ctx) {
    return new VideoContext(
      {
        read: (res, len) => {
          const r = this.lookup(c, res);
          return r ? this.readBacking(r, 0, len, true) : null;
        },
        size: (res) => {
          const r = this.lookup(c, res);
          return r ? this.backingSize(r) : 0;
        },
        dims: (res) => this.resources.get(res),
        error: (m) => this.error(`ctx ${c.id}: ${m}`),
        caught: (e) => this.onCaught?.(e),
        debug: this.debug,
        decoders: this.video?.decoders,
        hardware: this.video?.hardware,
        write: (planes, pic) => this.writePicture(planes, pic),
        settled: () => this.onVideoSettled?.(),
        order: () => this.videoOrder,
        mayWrite: (planes, order) => this.videoMayWrite?.(planes, order) ?? true,
      },
      this.videoStats,
    );
  }

  /**
   * A decoded picture into a video buffer's planes: NV12's R8 luma and RG8 chroma, or I420's three R8 planes (each
   * clipped to its texture). The planes needn't be attached to the decoding context any more, only exist: they were
   * at END_FRAME, when virglrenderer writes them (`VideoEnv.write`).
   */
  private writePicture(planes: number[], pic: DecodedPicture) {
    const gl = this.gl;
    const cw = (pic.width + 1) >> 1,
      ch = (pic.height + 1) >> 1;
    // The arrays' sizes: the planes' own when the decoder was told them (`VideoEnv.dims`), written as they are.
    const W = pic.stride ?? pic.width,
      H = pic.rows ?? pic.height,
      CW = pic.cstride ?? cw,
      CH = pic.crows ?? ch;
    // Each plane filled to its texture's size, the picture's edges repeated (`padPlane`, where the array isn't that
    // size already), and a picture smaller than its plane also kept alone, for draws to sample (`Res.picture`):
    // copied from the plane on the GPU, which costs half of uploading its rows again (bench/video/upload.ts).
    const put = (res: number, data: Uint8Array, w: number, h: number, bpp: number, sw: number, sh: number) => {
      const r = this.resources.get(res);
      if (!r) return;
      // The last picture's texture, kept from the plane's upload (which drops it) for this picture if it's its size.
      const prev = r.picture;
      r.picture = undefined;
      const p = padPlane(data, w, h, bpp, r.width, r.height, sw, sh);
      this.upload(
        r,
        0,
        { x: 0, y: 0, z: 0, w: Math.min(p.w, r.width), h: Math.min(p.h, r.height), d: 1 },
        p.data,
        p.w * bpp,
        0,
      );
      this.onPlane?.(res, p.data, p.w, p.h, bpp);
      const t =
        r.tex && r.fmt && r.target === PIPE_TEXTURE_2D && r.lastLevel === 0 && (w < r.width || h < r.height)
          ? prev?.width === w && prev.height === h
            ? prev
            : this.pictureTexture(r, w, h)
          : undefined;
      if (prev && prev !== t) this.gl.deleteTexture(prev.tex!);
      if (t) {
        if (this.bindForRead(r, 0, 0)) {
          gl.bindTexture(E.TEXTURE_2D, t.tex!);
          gl.copyTexSubImage2D(E.TEXTURE_2D, 0, 0, 0, 0, 0, w, h);
        } else this.upload(t, 0, { x: 0, y: 0, z: 0, w, h, d: 1 }, p.data, p.w * bpp, 0);
        this.bindFb(E.READ_FRAMEBUFFER, null);
        r.picture = t;
      }
    };
    put(planes[0], pic.y, pic.width, pic.height, 1, W, H);
    const n = CW * CH;
    if (planes.length === 3 && pic.planar) {
      put(planes[1], pic.uv.subarray(0, n), cw, ch, 1, CW, CH);
      put(planes[2], pic.uv.subarray(n, 2 * n), cw, ch, 1, CW, CH);
    } else if (planes.length === 2 && !pic.planar) put(planes[1], pic.uv, cw, ch, 2, CW, CH);
    else if (planes.length === 3) {
      // Interleaved chroma for three planes (a decoder that wasn't told the planes' shape): parted.
      const u = new Uint8Array(cw * ch),
        v = new Uint8Array(cw * ch);
      for (let r = 0; r < ch; r++)
        for (let x = 0; x < cw; x++) {
          u[r * cw + x] = pic.uv[2 * (r * CW + x)];
          v[r * cw + x] = pic.uv[2 * (r * CW + x) + 1];
        }
      put(planes[1], u, cw, ch, 1, cw, ch);
      put(planes[2], v, cw, ch, 1, cw, ch);
    } else if (planes.length === 2) {
      // And planar chroma for two: interleaved.
      const uv = new Uint8Array(2 * cw * ch);
      for (let r = 0; r < ch; r++)
        for (let x = 0; x < cw; x++) {
          uv[2 * (r * cw + x)] = pic.uv[r * CW + x];
          uv[2 * (r * cw + x) + 1] = pic.uv[n + r * CW + x];
        }
      put(planes[1], uv, cw, ch, 2, cw, ch);
    }
  }

  /** A picture texture for the plane `r` (`Res.picture`), `w`×`h`. */
  private pictureTexture(r: Res, w: number, h: number): Res {
    const gl = this.gl,
      tex = gl.createTexture();
    gl.bindTexture(E.TEXTURE_2D, tex);
    gl.texStorage2D(E.TEXTURE_2D, 1, r.fmt!.internal, w, h);
    gl.texParameteri(E.TEXTURE_2D, E.TEXTURE_MAX_LEVEL, 0);
    return {
      ...r,
      width: w,
      height: h,
      tex,
      msResolved: undefined,
      feedback: undefined,
      picture: undefined,
      backing: null,
      refs: new Set(),
    };
  }

  /** Drops `r`'s picture texture (`Res.picture`): the plane itself is what's sampled again. */
  private dropPicture(r: Res) {
    if (!r.picture) return;
    this.gl.deleteTexture(r.picture.tex!);
    r.picture = undefined;
  }

  /** Every context's video codecs (`VideoContext.streams`; read once a second). */
  videoStreams(): VideoStream[] {
    const out: VideoStream[] = [];
    for (const c of this.contexts.values()) c.video?.streams(out);
    return out;
  }

  /** Pictures sent to a decoder and not yet written (web/virgl-video.ts): the GPU worker holds what follows them. */
  get videoWaiting() {
    let n = 0;
    for (const c of this.contexts.values()) n += c.video?.waiting ?? 0;
    return n;
  }

  /** What may see a pending picture (the GPU worker's `CallQueue`): a context with one's plane attached, the plane itself;
   * and what contexts share (what a context waiting for one draws, another may sample). */
  readonly videoPending = {
    ctx: (id: number, before = Infinity) => {
      const c = this.contexts.get(id);
      return !!c && this.pendingPlanes(before).some((r) => c.attached.has(r));
    },
    res: (id: number, before = Infinity) => this.pendingPlanes(before).includes(id),
    shared: (a: number, b: number) => {
      const x = this.contexts.get(a)?.attached,
        y = this.contexts.get(b)?.attached;
      if (!x || !y) return false;
      const [small, big] = x.size <= y.size ? [x, y] : [y, x];
      for (const r of small) if (big.has(r)) return true;
      return false;
    },
    holds: (ctx: number, res: number) => !!this.contexts.get(ctx)?.attached.has(res),
    /** Whether a submit could see a pending picture's plane, of those sent before `before` (`submitTouches`; one this can't read: any attached). */
    submit: (ctx: number, words: Uint32Array, before = Infinity) => {
      const planes = this.pendingPlanes(before);
      if (!planes.length) return false;
      const t = this.submitTouches(ctx, words);
      if (!t) return this.videoPending.ctx(ctx, before);
      return planes.some((r) => t.has(r));
    },
  };

  /**
   * The resources a submit of a context could read or write, as far as its commands and the context's state now say
   * (the GPU worker's `CallQueue` asks it of a context's first waiting submit, so every earlier call of the context
   * has run): what each sub-context it draws in has bound (views, surfaces, vertex, index, uniform and stream output
   * buffers), what its commands bind or name, and what the objects it makes refer to. Undefined if it has a command
   * this doesn't know (it may then see anything the context has attached).
   */
  submitTouches(ctxId: number, words: Uint32Array): Set<number> | undefined {
    const c = this.contexts.get(ctxId);
    if (!c) return new Set();
    const out = new Set<number>();
    const made = new Map<number, number>(); // objects the submit makes: handle -> resource
    let sub = c.sub;
    const subs = new Set<Sub>();
    const res = (h: number) => {
      if (made.has(h)) return made.get(h);
      const o = sub.objects.get(h);
      return !o
        ? undefined
        : o.kind === 'view' || o.kind === 'surface' || o.kind === 'so' || o.kind === 'query'
          ? o.v.res
          : undefined;
    };
    const add = (r: number | undefined) => {
      if (r) out.add(r);
    };
    let known = true;
    const n = walk(words, (cmd, obj, at, len) => {
      const p = words.subarray(at, at + len);
      subs.add(sub);
      switch (cmd) {
        case 1: // CREATE_OBJECT: a view's, a surface's and a stream output target's resource is p[1], a query's p[3]
          if (obj === 6 || obj === 8 || obj === 10) {
            made.set(p[0], p[1]);
            add(p[1]);
          } else if (obj === 9) {
            made.set(p[0], p[3]);
            add(p[3]);
          }
          return;
        case 5:
        case 10:
        case 25: // SET_FRAMEBUFFER_STATE, SET_SAMPLER_VIEWS, SET_STREAMOUT_TARGETS: object handles
          for (let k = cmd === 10 ? 2 : 1; k < p.length; k++) add(res(p[k]));
          return;
        case 6:
          for (let k = 2; k < p.length; k += 3) add(p[k]);
          return; // SET_VERTEX_BUFFERS
        case 9:
        case 11:
        case 43:
        case 47:
        case 49:
          add(p[0]);
          return; // INLINE_WRITE, SET_INDEX_BUFFER, TRANSFER3D, CLEAR_TEXTURE, SET_TYPE
        case 16:
          add(p[3]);
          add(p[12]);
          return; // BLIT
        case 17:
          add(p[0]);
          add(p[5]);
          return; // RESOURCE_COPY_REGION
        case 45:
          add(p[0]);
          add(p[11]);
          return; // COPY_TRANSFER3D
        case 19:
        case 20:
        case 21:
        case 62:
          add(res(p[cmd === 62 ? 1 : 0]));
          return; // queries, CLEAR_SURFACE
        case 27:
          add(p[4]);
          return; // SET_UNIFORM_BUFFER
        case 59:
          add(p[2]);
          add(p[3]);
          return; // DECODE_BITSTREAM's staging buffers (its picture: VideoContext's order)
        case 28: {
          const x = c.subs.get(p[0]);
          if (x) sub = x;
          return;
        } // SET_SUB_CTX
        case 0:
        case 2:
        case 3:
        case 4:
        case 7:
        case 8:
        case 12:
        case 13:
        case 14:
        case 15:
        case 18:
        case 22:
        case 23:
        case 24:
        case 26:
        case 29:
        case 30:
        case 31:
        case 32:
        case 33:
        case 36:
        case 39:
        case 41:
        case 44:
        case 46:
        case 51:
        case 52:
        case 53:
        case 54:
        case 55:
        case 56:
        case 57:
        case 58:
        case 60:
        case 61:
          return; // state, draws and clears (they use what's bound: below), video commands
        default:
          known = false;
      }
    });
    if (n < 0 || !known) return undefined;
    for (const x of subs) {
      for (const st of ['vs', 'fs'] as const) {
        for (const v of x.views[st]) add(v?.res);
        for (const u of x.ubos[st].values()) add(u.res);
      }
      for (const cb of x.fb.cbufs) add(cb?.res);
      add(x.fb.zs?.res);
      for (const vb of x.vbs) add(vb.res);
      add(x.ib?.res);
      for (const t of x.so.targets) add(t?.res);
      for (const q of x.occlusion) add(q.res);
    }
    return out;
  }

  /** The planes of the pictures sent by calls before `before` (an external resource's awaited bytes, always). */
  private pendingPlanes(before = Infinity) {
    const out: number[] = [...this.externalWaits];
    for (const c of this.contexts.values()) if (c.video?.waiting) out.push(...c.video.pendingPlanes(before));
    return out;
  }

  /** Writes the decoded pictures that waited for earlier calls (`VideoContext.land`): after the GPU worker's queue ran what it could. */
  videoLand() {
    for (const c of this.contexts.values()) if (c.video?.waiting) c.video.land();
  }

  /** Sends the AV1 frames that wait for the next one (`VideoContext.nudge`). */
  videoNudge() {
    for (const c of this.contexts.values()) c.video?.nudge();
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
      case 1: {
        // BLEND: s0, s1 (logicop), 8 per-RT words
        if (p.length !== 11) throw new Error('bad blend');
        o = {
          kind: 'blend',
          v: {
            independent: !!(p[1] & 1),
            logicop: !!(p[1] & 2),
            alphaToCoverage: !!(p[1] & 8),
            rt: Array.from({ length: 8 }, (_, k) => {
              const t = p[3 + k];
              return {
                enable: !!(t & 1),
                rgbFunc: (t >>> 1) & 7,
                rgbSrc: (t >>> 4) & 0x1f,
                rgbDst: (t >>> 9) & 0x1f,
                aFunc: (t >>> 14) & 7,
                aSrc: (t >>> 17) & 0x1f,
                aDst: (t >>> 22) & 0x1f,
                mask: (t >>> 27) & 0xf,
              };
            }),
          },
        };
        break;
      }
      case 2: {
        // RASTERIZER
        if (p.length !== 9) throw new Error('bad rasterizer');
        const t = p[1];
        const bit = (b: number) => !!((t >>> b) & 1);
        o = {
          kind: 'rs',
          v: {
            flatshade: bit(0),
            depthClip: bit(1),
            clipHalfz: bit(2),
            discard: bit(3),
            lightTwoSide: bit(5),
            spriteUpperLeft: bit(6),
            pointQuad: bit(7),
            cullFace: (t >>> 8) & 3,
            scissor: bit(14),
            frontCcw: bit(15),
            clampFragmentColor: bit(17),
            offsetTri: bit(20),
            stipple: bit(22),
            pointSizePerVertex: bit(24),
            multisample: bit(25),
            pointSize: uif(p[2]),
            spriteCoordEnable: p[3],
            lineWidth: uif(p[5]),
            offsetUnits: uif(p[6]),
            offsetScale: uif(p[7]),
          },
        };
        break;
      }
      case 3: {
        // DSA
        if (p.length !== 5) throw new Error('bad dsa');
        const t = p[1];
        o = {
          kind: 'dsa',
          v: {
            depth: { enabled: !!(t & 1), write: !!(t & 2), func: (t >>> 2) & 7 },
            alpha: { enabled: !!((t >>> 8) & 1), func: (t >>> 9) & 7, ref: uif(p[4]) },
            stencil: [p[2], p[3]].map((x) => ({
              enabled: !!(x & 1),
              func: (x >>> 1) & 7,
              fail: (x >>> 4) & 7,
              zpass: (x >>> 7) & 7,
              zfail: (x >>> 10) & 7,
              valueMask: (x >>> 13) & 0xff,
              writeMask: (x >>> 21) & 0xff,
            })),
          },
        };
        break;
      }
      case 4:
        return this.createShader(s, p);
      case 5: {
        // VERTEX_ELEMENTS: offset, divisor, vb index, format
        if ((p.length - 1) % 4) throw new Error('bad vertex elements');
        o = {
          kind: 've',
          v: Array.from({ length: (p.length - 1) / 4 }, (_, k) => ({
            offset: p[1 + 4 * k],
            divisor: p[2 + 4 * k],
            vb: p[3 + 4 * k],
            format: p[4 + 4 * k],
          })),
        };
        break;
      }
      case 6: {
        // SAMPLER_VIEW: res, format | target << 24, layer/element range, level range, swizzle
        if (p.length !== 6) throw new Error('bad sampler view');
        const r = this.lookup(c, p[1]);
        if (!r) return;
        const sw = p[5];
        this.debug?.(
          `view res ${p[1]} (${r.fmt?.name}) as ${FORMATS.get(p[2] & 0xffffff)?.name ?? p[2] & 0xffffff} swizzle ${[0, 3, 6, 9].map((b) => (sw >>> b) & 7).join('')}`,
        );
        o = {
          kind: 'view',
          v: {
            res: p[1],
            format: p[2] & 0xffffff,
            target: p[2] >>> 24,
            first: p[3] & 0xffff,
            last: p[3] >>> 16,
            firstLevel: p[4] & 0xff,
            lastLevel: (p[4] >>> 8) & 0xff,
            swizzle: [sw & 7, (sw >>> 3) & 7, (sw >>> 6) & 7, (sw >>> 9) & 7],
          },
        };
        break;
      }
      case 7: {
        // SAMPLER_STATE
        if (p.length !== 9) throw new Error('bad sampler state');
        const t = p[1];
        o = {
          kind: 'sampler',
          v: {
            wrap: [t & 7, (t >>> 3) & 7, (t >>> 6) & 7],
            minImg: (t >>> 9) & 1,
            minMip: (t >>> 11) & 3,
            magImg: (t >>> 13) & 1,
            compare: !!((t >>> 15) & 1),
            compareFunc: (t >>> 16) & 7,
            maxAniso: (t >>> 20) & 0x1f,
            lodBias: uif(p[2]),
            minLod: uif(p[3]),
            maxLod: uif(p[4]),
          },
        };
        break;
      }
      case 8:
      case 11: {
        // SURFACE (and MSAA_SURFACE): res, format, level (or first element), layers
        if (p.length < 5) throw new Error('bad surface');
        const r = this.lookup(c, p[1]);
        if (!r) return;
        this.debug?.(`surface res ${p[1]} (${r.fmt?.name}) as ${FORMATS.get(p[2])?.name ?? p[2]}`);
        o = {
          kind: 'surface',
          v: { res: p[1], format: p[2], level: p[3], firstLayer: p[4] & 0xffff, lastLayer: p[4] >>> 16 },
        };
        break;
      }
      case 9: {
        // QUERY: type | index << 16, offset, res
        if (p.length !== 4) throw new Error('bad query');
        o = { kind: 'query', v: { type: p[1] & 0xffff, index: p[1] >>> 16, offset: p[2], res: p[3], result: 0 } };
        break;
      }
      case 10: {
        // STREAMOUT_TARGET: res, offset, size
        if (p.length !== 4) throw new Error('bad streamout target');
        o = { kind: 'so', v: { res: p[1], offset: p[2], size: p[3], filled: 0 } };
        break;
      }
      default:
        throw new Error(`object type ${type}`);
    }
    if (o) {
      const old = s.objects.get(h);
      if (old) this.destroyObject(old, s);
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
    if (nso)
      so = {
        strides: [p[5], p[6], p[7], p[8]],
        outputs: Array.from({ length: nso }, (_, k) => {
          const t = p[9 + 2 * k];
          return {
            reg: t & 0xff,
            start: (t >>> 8) & 3,
            comps: (t >>> 10) & 7,
            buffer: (t >>> 13) & 7,
            offset: (t >>> 16) & 0xffff,
          };
        }),
      };
    const shader: Shader = { serial: ++this.serial, type, text: new TextDecoder().decode(chunk), expected: offlen, so };
    const old = s.objects.get(h);
    if (old) this.destroyObject(old, s);
    s.objects.set(h, { kind: 'shader', v: shader });
    if (chunk.length < offlen) s.longShader.set(type, { handle: h, shader });
    else this.finishShader(shader);
  }

  private finishShader(sh: Shader) {
    const nul = sh.text.indexOf('\0');
    if (nul >= 0) sh.text = sh.text.slice(0, nul);
    if (sh.so)
      this.debug?.(
        `shader ${sh.serial} so ${JSON.stringify(sh.so)}: ${sh.text
          .split('\n')
          .filter((l) => /^DCL (IN|OUT)|^ *[0-9]+: /.test(l))
          .join(' | ')}`,
      );
    try {
      sh.tgsi = parseTgsi(sh.text);
    } catch (e) {
      this.onCaught?.(e);
      sh.error = e instanceof Error ? e.message : String(e);
      this.error(`shader ${sh.serial}: ${sh.error}`);
    }
  }

  private bindObject(s: Sub, type: number, p: Uint32Array) {
    const o = p[0] ? s.objects.get(p[0]) : undefined;
    switch (type) {
      case 1:
        s.blend = o?.kind === 'blend' ? o.v : undefined;
        return;
      case 2:
        s.rs = o?.kind === 'rs' ? o.v : undefined;
        return;
      case 3:
        s.dsa = o?.kind === 'dsa' ? o.v : undefined;
        return;
      case 5:
        s.ve = o?.kind === 've' ? o.v : undefined;
        return;
      default:
        throw new Error(`bind of object type ${type}`);
    }
  }

  // --- copies between resources and the guest --------------------------------------------------------------------

  private copyTransfer(c: Ctx, p: Uint32Array) {
    // dst, level, usage, stride, layer stride, box, src (staging), src offset, flags (2: read from the host)
    if (p.length !== 14) throw new Error('bad COPY_TRANSFER3D');
    const readBack = !!(p[13] & 2);
    const r = this.lookup(c, p[0]),
      staging = this.lookup(c, p[11]);
    if (!r || !staging) return;
    const box = { x: p[5], y: p[6], z: p[7], w: p[8], h: p[9], d: p[10] };
    const [stride, layerStride] = this.levelStrides(r, p[1], p[3], p[4]),
      offset = p[12];
    const n = r.target === PIPE_BUFFER ? box.w : boxBytes(r.fmt, box.w, box.h, box.d, stride, layerStride);
    if (offset + n > this.backingSize(staging)) return this.error(`COPY_TRANSFER3D past staging ${staging.id}`);
    const l = this.life.get(staging.id);
    if (l) l.staged += n;
    if (readBack) {
      const data = this.readback(r, p[1], box, stride, layerStride);
      if (!data) return this.error(`can't read back resource ${r.id} (format ${r.format})`);
      if (r.target === PIPE_BUFFER)
        this.debug?.(
          `read back ${r.id} [${box.x}, +${box.w}) to staging ${staging.id} at ${offset}: ${[...data.subarray(0, 16)].join(',')}`,
        );
      this.writeBacking(staging, offset, data);
    } else {
      const data = this.readBacking(staging, offset, n);
      if (data) this.upload(r, p[1], box, data, stride, layerStride);
    }
  }

  /** A level's size in texels: width, height and depth (or layers). */
  private levelSize(r: Res, level: number) {
    return {
      w: Math.max(1, r.width >> level),
      h: Math.max(1, r.height >> level),
      d: r.target === 3 ? Math.max(1, r.depth >> level) : Math.max(1, r.arraySize),
    };
  }

  /** Copies a compressed upload's layer (rows of blocks, packed) into the texture's copy of the level (`Res.blocks`). */
  private keepBlocks(r: Res, level: number, box: Box, layer: number, data: Uint8Array) {
    const f = r.fmt!,
      b = f.block,
      { w, h, d } = this.levelSize(r, level);
    const bw = Math.ceil(w / b),
      bh = Math.ceil(h / b),
      row = Math.ceil(box.w / b) * f.bpp,
      x0 = Math.floor(box.x / b),
      y0 = Math.floor(box.y / b);
    r.blocks ??= new Map();
    let lv = r.blocks.get(level);
    if (!lv) r.blocks.set(level, (lv = new Uint8Array(bw * bh * d * f.bpp)));
    for (let y = 0; y < Math.ceil(box.h / b); y++) {
      const at = ((layer * bh + y0 + y) * bw + x0) * f.bpp;
      if (at + row <= lv.length && (y + 1) * row <= data.length) lv.set(data.subarray(y * row, (y + 1) * row), at);
    }
  }

  /** Copies an upload into the texture's CPU copy of the level (`Res.texels`). */
  private keepTexels(r: Res, level: number, box: Box, data: Uint8Array, stride: number, layerStride: number) {
    const bpp = r.fmt!.bpp,
      { w, h, d } = this.levelSize(r, level);
    r.texels ??= new Map();
    let lv = r.texels.get(level);
    if (!lv) r.texels.set(level, (lv = new Uint8Array(w * h * d * bpp)));
    const row = box.w * bpp;
    for (let z = 0; z < box.d; z++)
      for (let y = 0; y < box.h; y++) {
        const at = (((box.z + z) * h + box.y + y) * w + box.x) * bpp;
        if (at + row <= lv.length)
          lv.set(data.subarray(z * layerStride + y * stride, z * layerStride + y * stride + row), at);
      }
  }

  private copyRegion(c: Ctx, p: Uint32Array) {
    // dst, dst level, dst x y z, src, src level, src box
    if (p.length !== 13) throw new Error('bad RESOURCE_COPY_REGION');
    const dst = this.lookup(c, p[0]),
      src = this.lookup(c, p[5]);
    if (!dst || !src) return;
    this.debug?.(
      `copy ctx ${c.id} ${p[5]}:${src.fmt?.name} level ${p[6]} box ${p.slice(7, 13).join(',')} -> ${p[0]}:${dst.fmt?.name} level ${p[1]} at ${p.slice(2, 5).join(',')}`,
    );
    const gl = this.gl;
    const [dx, dy, dz] = [p[2], p[3], p[4]];
    const box = { x: p[7], y: p[8], z: p[9], w: p[10], h: p[11], d: p[12] };
    if (dst.target === PIPE_BUFFER && src.target === PIPE_BUFFER) {
      if (!src.shadow || !dst.shadow) return;
      dst.shadow.set(src.shadow.subarray(box.x, box.x + box.w), dx);
      gl.bindBuffer(E.COPY_WRITE_BUFFER, dst.buf!);
      gl.bufferSubData(E.COPY_WRITE_BUFFER, dx, dst.shadow, dx, box.w);
      indexWritten(dst, dx, dx + box.w);
      return;
    }
    // A source no framebuffer can read (a format WebGL can't render to): from its texels' CPU copy, uploaded again.
    const lv = !src.fmt?.write && src.texels?.get(p[6]);
    if (lv) {
      const bpp = src.fmt!.bpp,
        { w, h } = this.levelSize(src, p[6]),
        row = box.w * bpp;
      const out = new Uint8Array(row * box.h * box.d);
      for (let z = 0; z < box.d; z++)
        for (let y = 0; y < box.h; y++)
          out.set(
            lv.subarray(
              (((box.z + z) * h + box.y + y) * w + box.x) * bpp,
              (((box.z + z) * h + box.y + y) * w + box.x) * bpp + row,
            ),
            (z * box.h + y) * row,
          );
      this.upload(dst, p[1], { x: dx, y: dy, z: dz, w: box.w, h: box.h, d: box.d }, out, row, row * box.h);
      return;
    }
    // Textures: a raw copy of texels, layer by layer, through a blit (same storage formats: same bytes).
    for (let z = 0; z < box.d; z++) {
      const depth = src.fmt && (src.fmt.kind === 'depth' || src.fmt.kind === 'depthstencil');
      const point = depth
        ? src.fmt!.kind === 'depth'
          ? E.DEPTH_ATTACHMENT
          : E.DEPTH_STENCIL_ATTACHMENT
        : E.COLOR_ATTACHMENT0;
      if (depth) {
        // A depth source is read from its depth attachment (as a color one it can't be: Mesa copies its depth
        // textures' uploads this way, and shadow lookups sampled empty textures).
        this.bindFb(E.READ_FRAMEBUFFER, this.readFbo);
        this.attachTo(E.READ_FRAMEBUFFER, E.COLOR_ATTACHMENT0, undefined, 0, 0);
        this.attachTo(E.READ_FRAMEBUFFER, point, src, p[6], box.z + z);
        if (gl.checkFramebufferStatus(E.READ_FRAMEBUFFER) !== E.FRAMEBUFFER_COMPLETE) {
          this.attachTo(E.READ_FRAMEBUFFER, point, undefined, 0, 0);
          return this.error("copy region: the depth source can't be read");
        }
      } else if (!this.bindForRead(src, p[6], box.z + z)) return this.error("copy region: the source can't be read");
      this.bindFb(E.DRAW_FRAMEBUFFER, this.fbo);
      for (let k = 1; k < this.colorAttachments; k++)
        this.attachTo(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0 + k, undefined, 0, 0);
      this.attachTo(E.DRAW_FRAMEBUFFER, E.DEPTH_STENCIL_ATTACHMENT, undefined, 0, 0);
      this.attachTo(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0, depth ? undefined : dst, p[1], dz + z);
      if (depth) this.attachTo(E.DRAW_FRAMEBUFFER, point, dst, p[1], dz + z);
      this.setDrawBuffers(depth ? NO_COLOR : COLOR0_ONLY);
      gl.disable(E.SCISSOR_TEST);
      // GLES 3.0's blits ignore the write masks (§4.3.3: only the scissor and pixel ownership tests apply); every mask
      // on all the same, as `blit` and `resolve` set them, so no implementation leaves a draw's masks on a raw copy.
      gl.colorMask(true, true, true, true);
      gl.depthMask(true);
      gl.stencilMask(0xff);
      gl.blitFramebuffer(
        box.x,
        box.y,
        box.x + box.w,
        box.y + box.h,
        dx,
        dy,
        dx + box.w,
        dy + box.h,
        depth ? E.DEPTH_BUFFER_BIT | (src.fmt!.kind === 'depthstencil' ? E.STENCIL_BUFFER_BIT : 0) : E.COLOR_BUFFER_BIT,
        E.NEAREST,
      );
      if (depth) this.attachTo(E.READ_FRAMEBUFFER, point, undefined, 0, 0);
    }
  }

  private blit(c: Ctx, p: Uint32Array) {
    if (p.length !== 21) throw new Error('bad BLIT');
    const gl = this.gl;
    const mask = p[0] & 0xff,
      filter = (p[0] >>> 8) & 3,
      scissor = !!((p[0] >>> 10) & 1);
    const dst = this.lookup(c, p[3]);
    let src = this.lookup(c, p[12]);
    if (!dst || !src) return;
    const db = { level: p[4], format: p[5], x: p[6] | 0, y: p[7] | 0, z: p[8], w: p[9] | 0, h: p[10] | 0, d: p[11] };
    const sb = {
      level: p[13],
      format: p[14],
      x: p[15] | 0,
      y: p[16] | 0,
      z: p[17],
      w: p[18] | 0,
      h: p[19] | 0,
      d: p[20],
    };
    const color = !!(mask & 0xf),
      zs = mask & 0x30;
    const sf = FORMATS.get(sb.format) ?? src.fmt,
      df = FORMATS.get(db.format) ?? dst.fmt;
    if (!sf || !df) return this.error('blit: unknown formats');
    this.debug?.(
      `blit ctx ${c.id} mask ${mask.toString(16)} ${p[12]}:${sf.name}(${src.fmt?.name}) -> ${p[3]}:${df.name}(${dst.fmt?.name})`,
    );
    // Same stored layout (both RGBA-order bytes, or the same format): a framebuffer blit. Otherwise a draw that
    // samples the source through its format's swizzle and writes through the destination's.
    const same =
      sf.internal === df.internal &&
      sf.sample.join() === df.sample.join() &&
      (sf.kind === 'uint' || sf.kind === 'sint' ? sf.kind === df.kind : true);
    // Integer formats of one signedness, stored in GL's channel order: GL's blit converts between them (and an
    // integer texture can't be sampled as a float one, which the draw below would need).
    const plain = (f: Format) => f.sample.every((q, k) => q === k || q === SW_0 || q === SW_1);
    const ints = (sf.kind === 'uint' || sf.kind === 'sint') && sf.kind === df.kind && plain(sf) && plain(df);
    // A multisampled source resolves only onto the same rectangle and between equal formats (GL copies the bytes:
    // RGBA8 onto a B8G8R8A8 window swapped red and blue), and Mesa's blits onto a window are flipped: it is resolved
    // into a texture of its own format first, then blitted or drawn from there.
    if (
      src.rb &&
      src.samples > 1 &&
      (sb.x !== db.x || sb.y !== db.y || sb.w !== db.w || sb.h !== db.h || (color && !same && !ints))
    ) {
      const tmp = this.resolve(
        src,
        color
          ? E.COLOR_BUFFER_BIT
          : src.fmt?.kind === 'depth'
            ? E.DEPTH_BUFFER_BIT
            : E.DEPTH_BUFFER_BIT | E.STENCIL_BUFFER_BIT,
      );
      if (!tmp) return this.error("blit: the multisampled source can't be resolved");
      src = tmp;
    }
    // The destination's layers the box covers (a guest's depth of 2^32 was a loop of as many blits: tests/virgl-fuzz.ts).
    const layers = Math.min(Math.max(1, db.d), this.levelSize(dst, db.level).d - db.z);
    for (let z = 0; z < layers; z++) {
      const sz = sb.z + Math.floor((z * sb.d) / Math.max(1, db.d));
      if (color) {
        if (same || ints || src.rb) {
          if (!this.bindForRead(src, sb.level, sz)) return this.error("blit: the source can't be read");
          this.bindFb(E.DRAW_FRAMEBUFFER, this.fbo);
          this.attachTo(E.DRAW_FRAMEBUFFER, E.DEPTH_STENCIL_ATTACHMENT, undefined, 0, 0);
          this.attachTo(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0, dst, db.level, db.z + z);
          this.setDrawBuffers(COLOR0_ONLY);
          this.blitScissor(scissor, p);
          gl.colorMask(true, true, true, true);
          gl.blitFramebuffer(
            sb.x,
            sb.y,
            sb.x + sb.w,
            sb.y + sb.h,
            db.x,
            db.y,
            db.x + db.w,
            db.y + db.h,
            E.COLOR_BUFFER_BIT,
            filter ? E.LINEAR : E.NEAREST,
          );
        } else
          this.drawBlit(src, sf, sb, sz, dst, df, db, db.z + z, filter ? E.LINEAR : E.NEAREST, scissor ? p : undefined);
      }
      if (zs && src.fmt && dst.fmt) {
        const pt = (f: Format) =>
          f.kind === 'depth'
            ? E.DEPTH_ATTACHMENT
            : f.kind === 'stencil'
              ? E.STENCIL_ATTACHMENT
              : E.DEPTH_STENCIL_ATTACHMENT;
        this.bindFb(E.READ_FRAMEBUFFER, this.readFbo);
        this.attachTo(E.READ_FRAMEBUFFER, E.COLOR_ATTACHMENT0, undefined, 0, 0);
        this.attachTo(E.READ_FRAMEBUFFER, pt(src.fmt), src, sb.level, sz);
        this.bindFb(E.DRAW_FRAMEBUFFER, this.fbo);
        this.attachTo(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0, undefined, 0, 0);
        this.attachTo(E.DRAW_FRAMEBUFFER, pt(dst.fmt), dst, db.level, db.z + z);
        this.setDrawBuffers(NO_COLOR);
        this.blitScissor(scissor, p);
        gl.depthMask(true);
        gl.stencilMask(0xff);
        gl.blitFramebuffer(
          sb.x,
          sb.y,
          sb.x + sb.w,
          sb.y + sb.h,
          db.x,
          db.y,
          db.x + db.w,
          db.y + db.h,
          (mask & 0x10 ? E.DEPTH_BUFFER_BIT : 0) | (mask & 0x20 ? E.STENCIL_BUFFER_BIT : 0),
          E.NEAREST,
        );
        this.attachTo(E.READ_FRAMEBUFFER, pt(src.fmt), undefined, 0, 0);
        this.attachTo(E.DRAW_FRAMEBUFFER, pt(dst.fmt), undefined, 0, 0);
      }
    }
    gl.disable(E.SCISSOR_TEST);
  }

  private blitScissor(on: boolean, p: Uint32Array) {
    const gl = this.gl;
    if (!on) {
      gl.disable(E.SCISSOR_TEST);
      return;
    }
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
    const gl = this.gl,
      f = src.fmt;
    if (!f) return undefined;
    let t = own ? src.msResolved : this.resolved;
    if (!(t?.fmt?.internal === f.internal && t.width === src.width && t.height === src.height)) {
      if (t?.tex) gl.deleteTexture(t.tex);
      const tex = gl.createTexture();
      gl.bindTexture(E.TEXTURE_2D, tex);
      gl.texStorage2D(E.TEXTURE_2D, 1, f.internal, src.width, src.height);
      t = {
        ...src,
        rb: undefined,
        msResolved: undefined,
        samples: 0,
        lastLevel: 0,
        tex,
        glTarget: E.TEXTURE_2D,
        backing: null,
        refs: new Set(),
      };
      if (own) src.msResolved = t;
      else this.resolved = t;
    }
    const color = bits === E.COLOR_BUFFER_BIT;
    const point = color ? E.COLOR_ATTACHMENT0 : f.kind === 'depth' ? E.DEPTH_ATTACHMENT : E.DEPTH_STENCIL_ATTACHMENT;
    this.bindFb(E.READ_FRAMEBUFFER, this.readFbo);
    for (const pt of [E.COLOR_ATTACHMENT0, E.DEPTH_STENCIL_ATTACHMENT])
      this.attachTo(E.READ_FRAMEBUFFER, pt, undefined, 0, 0);
    this.attachTo(E.READ_FRAMEBUFFER, point, src, 0, 0);
    this.bindFb(E.DRAW_FRAMEBUFFER, this.fbo);
    for (let k = 0; k < this.colorAttachments; k++)
      this.attachTo(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0 + k, undefined, 0, 0);
    this.attachTo(E.DRAW_FRAMEBUFFER, E.DEPTH_STENCIL_ATTACHMENT, undefined, 0, 0);
    this.attachTo(E.DRAW_FRAMEBUFFER, point, t, 0, 0);
    gl.readBuffer(color ? E.COLOR_ATTACHMENT0 : E.NONE);
    this.setDrawBuffers(color ? COLOR0_ONLY : NO_COLOR);
    gl.disable(E.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    gl.stencilMask(0xff);
    gl.blitFramebuffer(0, 0, src.width, src.height, 0, 0, src.width, src.height, bits, E.NEAREST);
    this.attachTo(E.READ_FRAMEBUFFER, point, undefined, 0, 0);
    this.attachTo(E.DRAW_FRAMEBUFFER, point, undefined, 0, 0);
    gl.readBuffer(E.COLOR_ATTACHMENT0); // the read framebuffer's own state: the other reads expect it
    return t;
  }

  /** A blit as a draw: the source sampled through its format's swizzle, written through the destination's. */
  private drawBlit(
    src: Res,
    sf: Format,
    sb: { level: number; x: number; y: number; w: number; h: number },
    sz: number,
    dst: Res,
    df: Format,
    db: { level: number; x: number; y: number; w: number; h: number },
    dz: number,
    filter: number,
    scissor?: Uint32Array,
  ) {
    const gl = this.gl;
    if (!src.tex || src.glTarget !== E.TEXTURE_2D) return this.error('blit: only 2D sources are converted');
    this.pauseQueries(); // a blit counts no samples (also a resource copy's or an upload's)
    const b = this.blitProgram();
    this.bindFb(E.DRAW_FRAMEBUFFER, this.fbo);
    // Only the destination attached: the source may still be another of the last draw's targets, and sampling an
    // attached texture is a feedback loop WebGL refuses (dEQP-GLES3 fragment_out: the second of three outputs).
    for (let k = 1; k < this.colorAttachments; k++)
      this.attachTo(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0 + k, undefined, 0, 0);
    this.attachTo(E.DRAW_FRAMEBUFFER, E.DEPTH_STENCIL_ATTACHMENT, undefined, 0, 0);
    this.attachTo(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0, dst, db.level, dz);
    this.setDrawBuffers(COLOR0_ONLY);
    gl.useProgram(b.prog);
    gl.bindVertexArray(null);
    gl.activeTexture(E.TEXTURE0);
    gl.bindTexture(E.TEXTURE_2D, src.tex);
    gl.bindSampler(0, null);
    gl.texParameteri(E.TEXTURE_2D, E.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(E.TEXTURE_2D, E.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(E.TEXTURE_2D, E.TEXTURE_BASE_LEVEL, sb.level);
    const w = src.width >> sb.level || 1,
      h = src.height >> sb.level || 1;
    gl.uniform4f(b.loc.get('u_src')!, sb.x / w, sb.y / h, sb.w / w, sb.h / h);
    // u_swz: for each logical channel, the source's stored component or a constant; u_wr: per stored destination component, the logical channel.
    gl.uniform4iv(
      b.loc.get('u_swz')!,
      sf.sample.map((s) => (s === SW_0 ? -1 : s === SW_1 ? -2 : s)),
    );
    gl.uniform4iv(b.loc.get('u_wr')!, (df.write ?? [0, 1, 2, 3]).concat([3, 3, 3]).slice(0, 4));
    gl.viewport(db.x, db.y, db.w, db.h);
    gl.disable(E.BLEND);
    gl.disable(E.DEPTH_TEST);
    gl.disable(E.STENCIL_TEST);
    gl.disable(E.CULL_FACE);
    gl.disable(E.RASTERIZER_DISCARD);
    gl.colorMask(true, true, true, true);
    if (scissor) this.blitScissor(true, scissor);
    else gl.disable(E.SCISSOR_TEST);
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
    const dv = new DataView(data.buffer, data.byteOffset, data.length);
    this.drawZs(r, level, box, (z, depth, sten) => {
      for (let y = 0; y < box.h; y++)
        for (let x = 0; x < box.w; x++) {
          const o = z * layerStride + y * stride + x * 8;
          if (o + 8 > data.length) continue;
          depth[y * box.w + x] = dv.getFloat32(o, true);
          sten[y * box.w + x] = data[o + 4];
        }
    });
  }

  /**
   * Depths and stencil bytes drawn into a depth, stencil or depth-stencil resource's box (a texture's level and layers,
   * or a renderbuffer, multisampled too: every sample takes the value): `fill` gives layer `z`'s, a texel a value in
   * rows of `box.w`. Without `depth` (or `stencil`), that part is left as it is.
   */
  private drawZs(
    r: Res,
    level: number,
    box: Box,
    fill: (z: number, depth: Float32Array, sten: Uint8Array) => void,
    parts = { depth: true, stencil: true },
  ) {
    const gl = this.gl;
    this.pauseQueries(); // an upload counts no samples
    if (!this.zsProg) {
      const prog = this.link(
        `#version 300 es
void main() { vec2 p = vec2(gl_VertexID & 1, gl_VertexID >> 1); gl_Position = vec4(p * 4.0 - 1.0, 0.0, 1.0); }`,
        `#version 300 es
precision highp float;
uniform highp sampler2D u_d;
uniform highp usampler2D u_s;
uniform ivec2 u_org;
uniform uint u_bit;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) - u_org;
  gl_FragDepth = texelFetch(u_d, p, 0).r;
  if (u_bit != 0u && (texelFetch(u_s, p, 0).r & u_bit) == 0u) discard;
}`,
      );
      if (!prog) return this.error("the depth-stencil upload program doesn't compile");
      const loc = new Map<string, WebGLUniformLocation | null>();
      for (const n of ['u_d', 'u_s', 'u_org', 'u_bit']) loc.set(n, gl.getUniformLocation(prog, n));
      this.zsProg = { prog, loc };
      this.zsTex = [gl.createTexture(), gl.createTexture()];
    }
    const kind = r.fmt?.kind;
    const point =
      kind === 'depth' ? E.DEPTH_ATTACHMENT : kind === 'stencil' ? E.STENCIL_ATTACHMENT : E.DEPTH_STENCIL_ATTACHMENT;
    const writeDepth = parts.depth && kind !== 'stencil',
      writeStencil = parts.stencil && kind !== 'depth';
    const { prog, loc } = this.zsProg;
    const [dt, st] = this.zsTex!;
    const n = box.w * box.h;
    const depth = new Float32Array(n),
      sten = new Uint8Array(n);
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
    this.bindFb(E.DRAW_FRAMEBUFFER, this.fbo);
    for (let k = 0; k < this.colorAttachments; k++)
      this.attachTo(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0 + k, undefined, 0, 0);
    this.attachTo(E.DRAW_FRAMEBUFFER, E.DEPTH_STENCIL_ATTACHMENT, undefined, 0, 0);
    this.setDrawBuffers(NO_COLOR);
    for (const e of [
      E.BLEND,
      E.CULL_FACE,
      E.SCISSOR_TEST,
      E.POLYGON_OFFSET_FILL,
      E.RASTERIZER_DISCARD,
      E.SAMPLE_COVERAGE,
      E.SAMPLE_ALPHA_TO_COVERAGE,
    ])
      gl.disable(e);
    gl.viewport(box.x, box.y, box.w, box.h);
    gl.enable(E.DEPTH_TEST);
    gl.depthFunc(E.ALWAYS);
    if (writeStencil) gl.enable(E.STENCIL_TEST);
    else gl.disable(E.STENCIL_TEST);
    gl.stencilOpSeparate(E.FRONT_AND_BACK, E.REPLACE, E.REPLACE, E.REPLACE);
    for (let z = 0; z < Math.max(1, box.d); z++) {
      depth.fill(0);
      sten.fill(0);
      fill(z, depth, sten);
      gl.activeTexture(E.TEXTURE0);
      gl.bindTexture(E.TEXTURE_2D, dt);
      gl.texImage2D(E.TEXTURE_2D, 0, GL.R32F, box.w, box.h, 0, GL.RED, E.FLOAT, depth);
      gl.activeTexture(E.TEXTURE0 + 1);
      gl.bindTexture(E.TEXTURE_2D, st);
      gl.texImage2D(E.TEXTURE_2D, 0, GL.R8UI, box.w, box.h, 0, GL.RED_INTEGER, E.UNSIGNED_BYTE, sten);
      gl.activeTexture(E.TEXTURE0);
      gl.bindSampler(0, null);
      gl.bindSampler(1, null);
      this.attachTo(E.DRAW_FRAMEBUFFER, point, r, level, box.z + z);
      // The depth, and the stencil cleared to 0; then each stencil bit where the byte has it.
      gl.depthMask(writeDepth);
      gl.stencilFuncSeparate(E.FRONT_AND_BACK, E.ALWAYS, 0, 0xff);
      gl.stencilMaskSeparate(E.FRONT_AND_BACK, 0xff);
      gl.uniform1ui(loc.get('u_bit')!, 0);
      gl.drawArrays(E.TRIANGLES, 0, 3);
      gl.depthMask(false);
      if (writeStencil)
        for (let b = 0; b < 8; b++) {
          gl.stencilFuncSeparate(E.FRONT_AND_BACK, E.ALWAYS, 0xff, 0xff);
          gl.stencilMaskSeparate(E.FRONT_AND_BACK, 1 << b);
          gl.uniform1ui(loc.get('u_bit')!, 1 << b);
          gl.drawArrays(E.TRIANGLES, 0, 3);
        }
    }
    this.attachTo(E.DRAW_FRAMEBUFFER, point, undefined, 0, 0);
    gl.depthMask(true);
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
    if (!prog) throw new Error("the blit program doesn't compile");
    const loc = new Map<string, WebGLUniformLocation | null>();
    for (const n of ['u_src', 'u_swz', 'u_wr', 's']) loc.set(n, this.gl.getUniformLocation(prog, n));
    this.gl.useProgram(prog);
    this.gl.uniform1i(loc.get('s')!, 0);
    return (this.blitProg = { prog, loc });
  }

  private link(vs: string, fs: string, tf?: ProgramLayout['tf']): WebGLProgram | null {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      return sh;
    };
    const v = compile(E.VERTEX_SHADER, vs),
      f = compile(E.FRAGMENT_SHADER, fs);
    const prog = gl.createProgram();
    gl.attachShader(prog, v);
    gl.attachShader(prog, f);
    if (tf) gl.transformFeedbackVaryings(prog, tf.varyings, tf.separate ? E.SEPARATE_ATTRIBS : E.INTERLEAVED_ATTRIBS);
    gl.linkProgram(prog);
    let ok = gl.getProgramParameter(prog, E.LINK_STATUS);
    if (!ok) {
      const which = !gl.getShaderParameter(v, E.COMPILE_STATUS)
        ? `vertex: ${gl.getShaderInfoLog(v)}\n${vs}`
        : !gl.getShaderParameter(f, E.COMPILE_STATUS)
          ? `fragment: ${gl.getShaderInfoLog(f)}\n${fs}`
          : `link: ${gl.getProgramInfoLog(prog)}`;
      this.error(`program: ${which}`);
    } else if (this.quirks.d3d11) {
      // ANGLE's D3D11 backend links a program whose HLSL its compiler refused (the errors in the program's log, the
      // status true), and the first draw with it, compiling again for the draw's vertex or target layout, loses the
      // context: the GPU process exits and the machine crashes. Such a program draws nothing instead (graphics.md
      // "The translator": dEQP-GLES3's derivate cases with a derivative in a loop, X3018 in ANGLE's own HLSL).
      const log = gl.getProgramInfoLog(prog) ?? '';
      if (d3dRefused(log)) {
        ok = false;
        this.error(`program: D3D's compiler refused it: ${log.slice(0, 600)}\n${vs}\n${fs}`);
      }
    }
    gl.deleteShader(v);
    gl.deleteShader(f);
    if (!ok) {
      gl.deleteProgram(prog);
      return null;
    }
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

  /** Binds the draw framebuffer for the sub-context's surfaces; false if it can't be drawn to. */
  private bindFramebuffer(c: Ctx, s: Sub): { width: number; height: number } | null {
    this.bindFb(E.DRAW_FRAMEBUFFER, this.fbo);
    let width = 0,
      height = 0;
    const bufs = this.drawBufs;
    bufs.length = 0;
    for (let k = 0; k < this.colorAttachments; k++) {
      const sf = s.fb.cbufs[k];
      const r = sf && this.lookup(c, sf.res);
      this.attachTo(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0 + k, r, sf?.level ?? 0, sf?.firstLayer ?? 0);
      if (k < s.fb.cbufs.length) bufs.push(r ? E.COLOR_ATTACHMENT0 + k : E.NONE);
      if (r) {
        width = Math.max(1, r.width >> sf.level);
        height = Math.max(1, r.height >> sf.level);
      }
    }
    const zs = s.fb.zs && this.lookup(c, s.fb.zs.res);
    // The depth and stencil points: the target's, and only the one it leaves empty emptied (emptying the target's own
    // point first would detach and attach it again at every draw: two changes of the framebuffer, ~38 µs of ANGLE on
    // Metal's GPU process a draw; PERF loop 81).
    const kind = zs?.fmt?.kind;
    if (!zs || !kind) this.attachTo(E.DRAW_FRAMEBUFFER, E.DEPTH_STENCIL_ATTACHMENT, undefined, 0, 0);
    else {
      const { level, firstLayer } = s.fb.zs!;
      if (kind === 'depth' || kind === 'stencil') {
        const depth = kind === 'depth';
        this.attachTo(E.DRAW_FRAMEBUFFER, depth ? E.STENCIL_ATTACHMENT : E.DEPTH_ATTACHMENT, undefined, 0, 0);
        this.attachTo(E.DRAW_FRAMEBUFFER, depth ? E.DEPTH_ATTACHMENT : E.STENCIL_ATTACHMENT, zs, level, firstLayer);
      } else this.attachTo(E.DRAW_FRAMEBUFFER, E.DEPTH_STENCIL_ATTACHMENT, zs, level, firstLayer);
      if (!width) {
        width = Math.max(1, zs.width >> level);
        height = Math.max(1, zs.height >> level);
      }
    }
    this.setDrawBuffers(bufs.length ? bufs : NO_COLOR);
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
    this.debug?.(
      `clear ctx ${c.id} buffers ${buffers.toString(16)} [${s.fb.cbufs.map((cb) => (cb ? `${cb.res}:${FORMATS.get(cb.format)?.name}` : '-')).join(' ')}] color ${[1, 2, 3, 4].map((k) => uif(p[k]).toFixed(2)).join(',')}`,
    );
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
      const pick = (arr: ArrayLike<number>, one: number) =>
        [0, 1, 2, 3].map((q) => (write[q] === undefined ? 0 : write[q] < 0 ? one : arr[write[q]]));
      if (f.kind === 'uint') gl.clearBufferuiv(E.COLOR, k, pick(bits, 1));
      else if (f.kind === 'sint') gl.clearBufferiv(E.COLOR, k, pick(new Int32Array(bits.buffer), 1));
      else gl.clearBufferfv(E.COLOR, k, pick(new Float32Array(bits.buffer), 1));
    }
    const depth = new Float64Array(new Uint32Array([p[5], p[6]]).buffer)[0];
    const zs = s.fb.zs && this.resources.get(s.fb.zs.res)?.fmt;
    if (zs && buffers & 3) {
      const hasD = zs.kind !== 'stencil',
        hasS = zs.kind === 'stencil' || zs.kind === 'depthstencil';
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
    // As `clear`: GLES clears nothing with the rasterizer's discard on (a draw's, or a capture-only draw's).
    gl.disable(E.RASTERIZER_DISCARD);
    gl.enable(E.SCISSOR_TEST);
    gl.scissor(p[6], p[7], p[8], p[9]);
    gl.colorMask(true, true, true, true);
    const f = FORMATS.get(sf.format);
    const write = f?.write ?? [0, 1, 2, 3];
    const bits = new Uint32Array([p[2], p[3], p[4], p[5]]);
    const pick = (arr: ArrayLike<number>) =>
      [0, 1, 2, 3].map((q) => (write[q] === undefined ? 0 : write[q] < 0 ? 1 : arr[write[q]]));
    if (f?.kind === 'uint') gl.clearBufferuiv(E.COLOR, 0, pick(bits));
    else if (f?.kind === 'sint') gl.clearBufferiv(E.COLOR, 0, pick(new Int32Array(bits.buffer)));
    else gl.clearBufferfv(E.COLOR, 0, pick(new Float32Array(bits.buffer)));
    gl.disable(E.SCISSOR_TEST);
  }

  /** The sampler key of a view: its texture's type and the swizzle from the stored texel to what the shader sees. */
  private samplerKey(v: SamplerView, r: Res | undefined): SamplerKey | undefined {
    const f = FORMATS.get(v.format) ?? r?.fmt;
    if (!r || !f) return undefined;
    const type = f.kind === 'uint' ? 'u' : f.kind === 'sint' ? 'i' : 'f';
    // The format's own swizzle (where each logical channel is stored), then the view's (which logical channel each
    // output reads); a depth-stencil texture sampled reads depth in R.
    const fsw = f.kind === 'depth' || f.kind === 'depthstencil' ? [0, SW_0, SW_0, SW_1] : f.sample;
    const swizzle = v.swizzle.map((q) => (q < 4 ? fsw[q] : q === 4 ? SW_0 : SW_1));
    const gl =
      r.glTarget === E.TEXTURE_3D
        ? '3D'
        : r.glTarget === E.TEXTURE_CUBE_MAP
          ? 'CUBE'
          : r.glTarget === E.TEXTURE_2D_ARRAY
            ? '2D_ARRAY'
            : '2D';
    return {
      type,
      swizzle,
      gl,
      rect: r.target === PIPE_TEXTURE_RECT,
      oneD: r.target === PIPE_TEXTURE_1D || r.target === PIPE_TEXTURE_1D_ARRAY,
    };
  }

  /** Color buffer `k`'s blend target: its own with independent blending (where the browser backs it), else the first's. */
  private blendTarget(blend: Blend | undefined, k: number) {
    return blend?.rt[blend.independent && this.indexed ? k : 0];
  }

  private program(vs: Shader, fs: Shader, state: DrawState): Program | null {
    let programs = vs.programs?.get(fs);
    const cached = programs?.get(state.id);
    if (cached !== undefined) return cached;
    if (!programs) {
      programs = new Map();
      (vs.programs ??= new Map()).set(fs, programs);
      (fs.pairs ??= new Set()).add(vs);
    }
    const key = state.key;
    let layout: ProgramLayout;
    try {
      layout = generate(vs.tgsi!, fs.tgsi!, key, this.quirks);
    } catch (e) {
      this.onCaught?.(e);
      this.error(`program ${vs.serial}/${fs.serial}: ${e instanceof Error ? e.message : e}`);
      programs.set(state.id, null);
      return null;
    }
    const gl = this.gl;
    const t0 = performance.now();
    const prog = this.link(layout.vs, layout.fs, layout.tf);
    this.stats.compileMs += performance.now() - t0; // translating aside: the browser's compile and link (synchronous here)
    if (!prog) {
      programs.set(state.id, null);
      return null;
    }
    this.stats.programs++;
    const loc = new Map<string, WebGLUniformLocation | null>();
    const names = [
      'vc0',
      'fc0',
      'u_adjy',
      'u_adjz',
      'u_fbh',
      'u_alpharef',
      'u_psize',
      'u_stipple',
      'u_blendc',
      ...layout.samplers.vs.map((n) => `vs${n}`),
      ...layout.samplers.fs.map((n) => `fs${n}`),
    ];
    for (const n of names) loc.set(n, gl.getUniformLocation(prog, n));
    gl.useProgram(prog);
    for (const n of layout.samplers.fs) gl.uniform1i(loc.get(`fs${n}`)!, samplerUnit('fs', n, VS_UNIT_BASE));
    for (const n of layout.samplers.vs) gl.uniform1i(loc.get(`vs${n}`)!, samplerUnit('vs', n, VS_UNIT_BASE));
    for (const [st, ubos] of [
      ['vs', layout.ubos.vs],
      ['fs', layout.ubos.fs],
    ] as const) {
      for (const k of ubos.keys()) {
        const idx = gl.getUniformBlockIndex(prog, `${st[0].toUpperCase()}B${k}`);
        if (idx !== 0xffffffff) gl.uniformBlockBinding(prog, idx, uboBinding(st, k));
      }
    }
    const p = { prog, layout, loc };
    programs.set(state.id, p);
    return p;
  }

  /**
   * A texture a draw samples while it draws into it (a color or depth target): WebGL refuses the draw ("feedback loop
   * formed between Framebuffer and active Texture") when the attached level is among the levels sampled (the view's
   * range, or its first level alone without a mip filter), whatever the layer of an array or 3D texture, and a depth
   * texture even with depth writes off; GL draws it (different levels or layers are well defined, the same texels
   * undefined: the texels as they were before the draw are what drivers mostly give). Those textures are copied, the
   * levels sampled with every layer, and the draw samples the copies. Returns them by resource, or undefined.
   */
  private feedbackCopies(c: Ctx, s: Sub): Map<Res, Res> | undefined {
    const targets = new Map<Res, number[]>();
    for (const sf of [...s.fb.cbufs, s.fb.zs]) {
      const r = sf && this.lookup(c, sf.res);
      if (r?.tex) targets.set(r, [...(targets.get(r) ?? []), sf!.level]);
    }
    if (!targets.size) return undefined;
    // The levels sampled of each target texture, over every view of it that takes in a level drawn into.
    const sampled = new Map<Res, [number, number]>();
    for (const st of ['vs', 'fs'] as const)
      s.views[st].forEach((v, n) => {
        const r = v && this.resources.get(v.res);
        const levels = r && targets.get(r);
        if (!levels) return;
        const first = v.firstLevel;
        const last = s.samplers[st][n]?.minMip === 2 ? first : Math.max(first, Math.min(v.lastLevel, r.lastLevel));
        if (!levels.some((l) => l >= first && l <= last)) return;
        const had = sampled.get(r);
        sampled.set(r, had ? [Math.min(had[0], first), Math.max(had[1], last)] : [first, last]);
      });
    if (!sampled.size) return undefined;
    const copies = new Map<Res, Res>();
    for (const [r, [first, last]] of sampled) {
      const t = this.copyLevels(r, first, last);
      if (t) copies.set(r, t);
    }
    return copies;
  }

  /** `src`'s levels `first`..`last`, every layer, copied into its feedback texture (same target, format and size). */
  private copyLevels(src: Res, first: number, last: number): Res | undefined {
    const gl = this.gl,
      f = src.fmt;
    if (!f || !src.tex) return undefined;
    this.pauseQueries(); // a copy counts no samples
    let t = src.feedback;
    if (!t) {
      const tex = gl.createTexture();
      gl.bindTexture(src.glTarget!, tex);
      const levels = src.lastLevel + 1;
      if (src.glTarget === E.TEXTURE_3D || src.glTarget === E.TEXTURE_2D_ARRAY) {
        gl.texStorage3D(
          src.glTarget,
          levels,
          f.internal,
          src.width,
          src.target === PIPE_TEXTURE_1D_ARRAY ? 1 : src.height,
          src.glTarget === E.TEXTURE_3D ? src.depth : src.arraySize,
        );
      } else
        gl.texStorage2D(src.glTarget!, levels, f.internal, src.width, src.target === PIPE_TEXTURE_1D ? 1 : src.height);
      gl.texParameteri(src.glTarget!, E.TEXTURE_MAX_LEVEL, src.lastLevel);
      t = { ...src, msResolved: undefined, feedback: undefined, tex, backing: null, refs: new Set() };
      src.feedback = t;
    }
    const bits =
      f.kind === 'depth'
        ? E.DEPTH_BUFFER_BIT
        : f.kind === 'depthstencil'
          ? E.DEPTH_BUFFER_BIT | E.STENCIL_BUFFER_BIT
          : E.COLOR_BUFFER_BIT;
    const color = bits === E.COLOR_BUFFER_BIT;
    const point = color ? E.COLOR_ATTACHMENT0 : f.kind === 'depth' ? E.DEPTH_ATTACHMENT : E.DEPTH_STENCIL_ATTACHMENT;
    this.bindFb(E.READ_FRAMEBUFFER, this.readFbo);
    for (const pt of [E.COLOR_ATTACHMENT0, E.DEPTH_STENCIL_ATTACHMENT])
      this.attachTo(E.READ_FRAMEBUFFER, pt, undefined, 0, 0);
    this.bindFb(E.DRAW_FRAMEBUFFER, this.fbo);
    for (let k = 0; k < this.colorAttachments; k++)
      this.attachTo(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0 + k, undefined, 0, 0);
    this.attachTo(E.DRAW_FRAMEBUFFER, E.DEPTH_STENCIL_ATTACHMENT, undefined, 0, 0);
    gl.readBuffer(color ? E.COLOR_ATTACHMENT0 : E.NONE);
    this.setDrawBuffers(color ? COLOR0_ONLY : NO_COLOR);
    gl.disable(E.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    gl.stencilMask(0xff);
    for (let level = first; level <= last; level++) {
      const { w, h } = this.levelSize(src, level);
      const layers =
        src.glTarget === E.TEXTURE_CUBE_MAP
          ? 6
          : src.glTarget === E.TEXTURE_3D
            ? Math.max(1, src.depth >> level)
            : src.glTarget === E.TEXTURE_2D_ARRAY
              ? src.arraySize
              : 1;
      for (let z = 0; z < layers; z++) {
        this.attachTo(E.READ_FRAMEBUFFER, point, src, level, z);
        this.attachTo(E.DRAW_FRAMEBUFFER, point, t, level, z);
        gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, bits, E.NEAREST);
      }
    }
    this.attachTo(E.READ_FRAMEBUFFER, point, undefined, 0, 0);
    this.attachTo(E.DRAW_FRAMEBUFFER, point, undefined, 0, 0);
    gl.readBuffer(E.COLOR_ATTACHMENT0); // the read framebuffer's own state: the other reads expect it
    this.stats.feedbackCopies++;
    return t;
  }

  /** The id of a key's part (`parts`). */
  private partId(part: unknown): number {
    if (part === undefined) return 0;
    const text = JSON.stringify(part);
    let id = this.partIds.get(text);
    if (id === undefined) {
      id = this.parts.length;
      this.parts.push(part);
      this.partIds.set(text, id);
      this.partChars += text.length;
    }
    return id;
  }

  /** The kept part id of a state object, or -1: none yet, or `checkPrograms` (which reads every part again). */
  private keptPart(o: object): number {
    return this.checkPrograms ? -1 : (this.partOf.get(o) ?? -1);
  }

  private keepPart(o: object, part: unknown): number {
    const id = this.partId(part),
      kept = this.partOf.get(o);
    // Not an `Error` thrown on purpose (tests/virgl-fuzz.ts counts it a fault): a state object changed after its part was read.
    if (kept !== undefined && kept !== id)
      throw new RangeError(`a kept program key part is stale: ${JSON.stringify(part)}`);
    this.partOf.set(o, id);
    return id;
  }

  /** As `keptPart` and `keepPart`, for what reads a resource (`resPartOf`): kept while the resource of its number is the same one. */
  private keptResPart(o: SamplerView | Surface, r: Res | undefined): number {
    if (this.checkPrograms) return -1;
    const kept = this.resPartOf.get(o);
    return kept && kept.r === r ? kept.id : -1;
  }

  private keepResPart(o: SamplerView | Surface, r: Res | undefined, part: unknown): number {
    const id = this.partId(part),
      kept = this.resPartOf.get(o);
    if (kept && kept.r === r && kept.id !== id)
      throw new RangeError(`a kept program key part is stale: resource ${o.res}'s ${JSON.stringify(part)}`);
    if (kept) [kept.r, kept.id] = [r, id];
    else this.resPartOf.set(o, { r, id });
    return id;
  }

  /**
   * A draw's signature, into `sig` (its length returned): the part ids of everything its program's key is made from
   * (`keyOf` makes the key from these alone, so what the key reads is here): the vertex elements' types, the
   * rasterizer's flags, the alpha test, the blend factors folded into the shader, points or not, the stream outputs
   * captured, then each stage's sampler views and the color buffers, each list after its length.
   */
  private signature(
    s: Sub,
    vs: Shader,
    ve: VertexElements,
    points: boolean,
    so: { outputs: SoOutput[] } | undefined,
  ): number {
    const views = s.views,
      cbufs = s.fb.cbufs,
      rs = s.rs,
      dsa = s.dsa,
      blend = s.blend;
    const need = 9 + views.vs.length + views.fs.length + cbufs.length;
    if (need > this.sig.length) this.sig = new Int32Array(2 * need);
    const sig = this.sig;
    let id = this.keptPart(ve);
    sig[0] =
      id >= 0
        ? id
        : this.keepPart(ve, { attribs: ve.map((e) => VERTEX_FORMATS.get(e.format)?.int ?? 'f'), ...bgraKey(ve) });
    if (!rs) sig[1] = 0;
    else {
      id = this.keptPart(rs);
      sig[1] =
        id >= 0
          ? id
          : this.keepPart(rs, {
              flatshade: rs.flatshade,
              twoSide: rs.lightTwoSide,
              clampColor: rs.clampFragmentColor,
              stipple: rs.stipple,
              pointSizePerVertex: rs.pointSizePerVertex,
              spriteCoordEnable: rs.pointQuad ? rs.spriteCoordEnable : undefined,
              spriteUpperLeft: rs.spriteUpperLeft,
            } satisfies RasterizerPart);
    }
    if (!dsa) sig[2] = 0;
    else {
      id = this.keptPart(dsa);
      sig[2] = id >= 0 ? id : this.keepPart(dsa, dsa.alpha.enabled ? dsa.alpha.func : undefined);
    }
    if (!blend) sig[3] = 0;
    else {
      id = this.keptPart(blend);
      if (id < 0) {
        // Each color buffer's factor folded into the shader (0: none), by its blend target; no part where none is.
        const folded = blend.rt.map((_, k) => foldedBlend(this.blendTarget(blend, k)) ?? 0);
        id = this.keepPart(blend, folded.some((g) => g) ? folded : undefined);
      }
      sig[3] = id;
    }
    sig[4] = +points;
    // What a shader with stream outputs captures follows the targets bound (`soOutputs`): read at each draw.
    sig[5] = so
      ? this.partId({ so: so.outputs.map(({ reg, start, comps }) => ({ reg, start, comps })) })
      : vs.so
        ? this.partId(this.soKey(vs.so))
        : 0;
    let n = this.viewParts(views.vs, 6);
    n = this.viewParts(views.fs, n);
    sig[n++] = cbufs.length;
    for (let k = 0; k < cbufs.length; k++) {
      const sf = cbufs[k];
      if (!sf) {
        sig[n++] = 0;
        continue;
      }
      const r = this.resources.get(sf.res);
      id = this.keptResPart(sf, r);
      sig[n++] = id >= 0 ? id : this.keepResPart(sf, r, colorPart(sf, r));
    }
    return n;
  }

  /** A stage's sampler views into `sig` at `n` (their count, then each one's part id); returns where the next list goes. */
  private viewParts(list: (SamplerView | undefined)[], n: number): number {
    const sig = this.sig;
    sig[n++] = list.length;
    for (let k = 0; k < list.length; k++) {
      const v = list[k];
      if (!v) {
        sig[n++] = 0;
        continue;
      }
      const r = this.resources.get(v.res);
      const id = this.keptResPart(v, r);
      sig[n++] = id >= 0 ? id : this.keepResPart(v, r, this.samplerKey(v, r));
    }
    return n;
  }

  /**
   * The parts and the states forgotten, once a guest made more than any real one does (it can make them without end:
   * vertex elements of any length, states of any mix), and every program with them: each was made for a state, by its
   * id, and ids aren't given again, so a state met again makes its program again (kept, the old ones grew by a copy of
   * every program in use at each forget).
   */
  private forgetStates() {
    this.parts = [undefined];
    this.partIds.clear();
    this.partChars = 0;
    this.partOf = new WeakMap();
    this.resPartOf = new WeakMap();
    this.states.clear();
    this.statesKept = 0;
    // The vertex shaders hold the programs: every live shader object's, and the ones bound (a destroyed one may be).
    for (const c of this.contexts.values())
      for (const s of c.subs.values()) {
        for (const o of s.objects.values()) if (o.kind === 'shader') this.dropPrograms(o.v);
        if (s.shaders.vs) this.dropPrograms(s.shaders.vs);
      }
  }

  /** The state of the signature in `sig` (its first `n`): the one met before, or a new one with its key. */
  private stateOf(n: number): DrawState {
    const sig = this.sig;
    let hash = n;
    for (let k = 0; k < n; k++) hash = (Math.imul(hash, 31) + sig[k]) | 0;
    const met = this.states.get(hash);
    if (met) for (let k = 0; k < met.length; k++) if (sameSignature(met[k].sig, sig, n)) return met[k];
    const state = { id: ++this.drawStates, sig: sig.slice(0, n), key: this.keyOf(sig) };
    if (met) met.push(state);
    else this.states.set(hash, [state]);
    this.statesKept++;
    return state;
  }

  /** A signature's program key: its parts put together. */
  private keyOf(sig: Int32Array): ProgramKey {
    const parts = this.parts;
    let at = 6;
    const list = <T>() => Array.from({ length: sig[at++] }, () => parts[sig[at++]] as T | undefined);
    const rs = parts[sig[1]] as RasterizerPart | undefined,
      folded = parts[sig[3]] as number[] | undefined,
      points = !!sig[4];
    return {
      ...(parts[sig[0]] as Pick<ProgramKey, 'attribs' | 'bgra'>),
      samplers: { vs: list<SamplerKey>(), fs: list<SamplerKey>() },
      cbufs: list<ColorPart>().map(
        (cb, k) =>
          cb && { type: cb.type, write: cb.write, blendSrc: cb.type === 'f' && folded?.[k] ? folded[k] : undefined },
      ),
      alphaFunc: parts[sig[2]] as number | undefined,
      flatshade: rs?.flatshade,
      twoSide: rs?.twoSide,
      clampColor: rs?.clampColor,
      stipple: rs?.stipple,
      points,
      pointSizePerVertex: rs?.pointSizePerVertex,
      spriteCoordEnable: points ? rs?.spriteCoordEnable : undefined,
      spriteUpperLeft: rs?.spriteUpperLeft,
      ...(parts[sig[5]] as Pick<ProgramKey, 'so'> | undefined),
    };
  }

  private draw(c: Ctx, p: Uint32Array) {
    if (p.length !== 12 && p.length !== 14 && p.length !== 20) throw new Error('bad DRAW_VBO');
    if (p.length === 20 && p[14]) return this.error("indirect draws aren't supported");
    const gl = this.gl;
    const s = c.sub;
    const [start, count, mode, indexed, instances, indexBias, , restart, restartIndex] = [
      p[0],
      p[1],
      p[2],
      p[3],
      p[4],
      p[5] | 0,
      p[6],
      p[7],
      p[8],
    ];
    if (mode >= PRIM.length) return this.error(`primitive ${mode} isn't supported`);
    const { vs, fs } = s.shaders;
    if (!vs?.tgsi || !fs?.tgsi || !s.ve) return;
    // Stream output (transform feedback): what the vertex shader writes, captured into the bound targets.
    const so = vs.so && s.so.targets.some((t) => t) ? this.soPlan(vs.so, s.so.targets) : undefined;
    // Multisampled textures sampled are resolved first (it rebinds the framebuffers).
    for (const st of ['vs', 'fs'] as const)
      for (const v of s.views[st]) {
        const r = v && this.resources.get(v.res);
        if (r?.rb && r.samples > 1 && r.fmt)
          this.resolve(
            r,
            r.fmt.kind === 'depth' || r.fmt.kind === 'depthstencil' ? E.DEPTH_BUFFER_BIT : E.COLOR_BUFFER_BIT,
            true,
          );
      }
    // Textures the draw also draws into are sampled from copies (it rebinds the framebuffers too).
    const copies = this.feedbackCopies(c, s);
    let fb = this.bindFramebuffer(c, s);
    // Nothing to draw on, only captures: a framebuffer of its own (WebGL2 draws on a complete one), rasterizer off.
    const captureOnly = !fb && !!so;
    if (captureOnly) fb = this.bindNullFramebuffer();
    if (!fb) {
      // Nothing to draw on and nothing captured: only a primitives-generated query sees the draw.
      for (const [q, ctx] of this.counting)
        if (ctx === c.id && q.type === Q_GENERATED) q.result += primitives(mode, count) * Math.max(1, instances);
      return;
    }
    const rs = s.rs,
      dsa = s.dsa,
      blend = s.blend;
    // The program for this state: the state of the draw's signature, and the shaders' program for it.
    if (this.statesKept >= MAX_STATES || this.partChars > MAX_PART_CHARS) this.forgetStates();
    const state = this.stateOf(this.signature(s, vs, s.ve, mode === 0, so));
    const key = state.key;
    const prog = this.program(vs, fs, state);
    if (!prog) return;
    gl.useProgram(prog.prog);
    // Uniforms: constant buffer 0 and the system values; a value the program's uniform already has isn't set again
    // (`Program.set`).
    const kept = this.drawCache ? (prog.set ??= new Map<string, number | Uint32Array>()) : undefined;
    /** Whether uniform `n` holds `v`'s first `len` words already (bits: a float's −0 isn't its +0); if not, they're kept as its. */
    const holds = (n: string, v: Uint32Array, len = v.length) => {
      if (!kept) return false;
      let o = kept.get(n);
      if (o instanceof Uint32Array && o.length === len) {
        let k = 0;
        while (k < len && o[k] === v[k]) k++;
        if (k === len) return true;
      } else kept.set(n, (o = new Uint32Array(len)));
      for (let k = 0; k < len; k++) o[k] = v[k];
      return false;
    };
    for (const st of ['vs', 'fs'] as const) {
      const n = prog.layout.consts[st];
      if (!n) continue;
      let data = s.consts[st];
      if (data.length < n * 4) {
        const d = new Uint32Array(n * 4);
        d.set(data);
        data = d;
      }
      const name = `${st[0]}c0`;
      if (!holds(name, data, n * 4)) gl.uniform4uiv(prog.loc.get(name)!, data, 0, n * 4);
    }
    const vp = s.viewport;
    const negative = vp.scale[1] < 0;
    const set1 = (n: string, v: number) => {
      const l = prog.loc.get(n);
      if (!l || (kept && Object.is(kept.get(n), v))) return;
      kept?.set(n, v);
      gl.uniform1f(l, v);
    };
    set1('u_adjy', negative ? -1 : 1);
    // Clip control's 0-to-1 depth (the rasterizer's clip_halfz, CLIP_HALFZ in the caps), where the browser has it.
    const halfz = !!rs?.clipHalfz && !!this.clipControl;
    if (halfz !== this.halfz) {
      this.clipControl?.clipControlEXT(E.LOWER_LEFT_EXT, halfz ? E.ZERO_TO_ONE_EXT : E.NEGATIVE_ONE_TO_ONE_EXT);
      this.halfz = halfz;
    }
    const inverted = s.viewport.scale[2] < 0;
    const adjz = prog.loc.get('u_adjz');
    // An inverted depth range turns z round: -z between -1 and 1, w - z between 0 and 1.
    if (adjz) {
      const az = inverted ? -1 : 1,
        bz = inverted && halfz ? 1 : 0;
      if (kept?.get('u_adjz') !== az * 2 + bz) {
        kept?.set('u_adjz', az * 2 + bz);
        gl.uniform2f(adjz, az, bz);
      }
    }
    set1('u_fbh', fb.height);
    if (dsa) set1('u_alpharef', dsa.alpha.ref);
    const lbc = prog.loc.get('u_blendc');
    if (lbc) {
      const bc = this.blendBits;
      for (let k = 0; k < 4; k++) bc.f[k] = s.blendColor[k];
      if (!holds('u_blendc', bc.u)) gl.uniform4fv(lbc, s.blendColor);
    }
    set1('u_psize', rs?.pointSize || 1);
    const stl = prog.loc.get('u_stipple');
    if (stl && !holds('u_stipple', s.stipple)) gl.uniform1uiv(stl, s.stipple);
    // Textures and samplers.
    for (const st of ['vs', 'fs'] as const) {
      for (const n of prog.layout.samplers[st]) {
        const unit = samplerUnit(st, n, VS_UNIT_BASE);
        const v = s.views[st][n];
        const r0 = v && this.resources.get(v.res);
        const r = (r0 && copies?.get(r0)) ?? r0?.msResolved ?? r0?.picture ?? r0;
        gl.activeTexture(E.TEXTURE0 + unit);
        if (!r?.tex) {
          // Nothing to sample: no texture on any target (another context's would be sampled), no sampler.
          for (const t of [E.TEXTURE_2D, E.TEXTURE_CUBE_MAP, E.TEXTURE_3D, E.TEXTURE_2D_ARRAY]) gl.bindTexture(t, null);
          gl.bindSampler(unit, null);
          continue;
        }
        gl.bindTexture(r.glTarget!, r.tex);
        gl.texParameteri(r.glTarget!, E.TEXTURE_BASE_LEVEL, v!.firstLevel);
        gl.texParameteri(
          r.glTarget!,
          E.TEXTURE_MAX_LEVEL,
          Math.max(v!.firstLevel, Math.min(v!.lastLevel, r.lastLevel)),
        );
        gl.bindSampler(unit, this.glSampler(s.samplers[st][n], r));
      }
    }
    // Uniform buffers.
    for (const st of ['vs', 'fs'] as const) {
      for (const k of prog.layout.ubos[st].keys()) {
        const u = s.ubos[st].get(k);
        const r = u && this.resources.get(u.res);
        const need = prog.layout.ubos[st].get(k)! * 16;
        // Without a buffer (or a long enough one) nothing is bound: another context's would be read.
        if (r?.buf && u!.offset + need <= r.width)
          gl.bindBufferRange(E.UNIFORM_BUFFER, uboBinding(st, k), r.buf, u!.offset, need);
        else {
          gl.bindBufferBase(E.UNIFORM_BUFFER, uboBinding(st, k), null);
          if (r?.buf) this.error(`uniform buffer ${k} is shorter than the shader's block`);
        }
      }
    }
    // Rasterizer, viewport, scissor.
    const x = vp.translate[0] - vp.scale[0],
      w = vp.scale[0] * 2;
    const h = Math.abs(vp.scale[1]) * 2;
    const y = negative ? vp.translate[1] - Math.abs(vp.scale[1]) : vp.translate[1] - vp.scale[1];
    gl.viewport(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
    // WebGL refuses a depth range whose near is above its far (GLES allows it): such a range goes the right way round,
    // with z negated in the vertex shader (u_adjz), which lands every depth where the inverted range would.
    const near = halfz ? vp.translate[2] : vp.translate[2] - vp.scale[2],
      far = vp.translate[2] + vp.scale[2];
    const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
    gl.depthRange(clamp01(Math.min(near, far)), clamp01(Math.max(near, far)));
    if (rs?.scissor) {
      gl.enable(E.SCISSOR_TEST);
      gl.scissor(s.scissor.minx, s.scissor.miny, s.scissor.maxx - s.scissor.minx, s.scissor.maxy - s.scissor.miny);
    } else gl.disable(E.SCISSOR_TEST);
    if (rs && rs.cullFace) {
      gl.enable(E.CULL_FACE);
      gl.cullFace([0, E.FRONT, E.BACK, E.FRONT_AND_BACK][rs.cullFace]);
    } else gl.disable(E.CULL_FACE);
    // Gallium's front face is in its y-down window space: the opposite winding of GL's for the same rows.
    gl.frontFace(rs?.frontCcw ? E.CW : E.CCW);
    if (rs?.offsetTri) {
      gl.enable(E.POLYGON_OFFSET_FILL);
      gl.polygonOffset(rs.offsetScale, rs.offsetUnits);
    } else gl.disable(E.POLYGON_OFFSET_FILL);
    if (rs?.discard || captureOnly) gl.enable(E.RASTERIZER_DISCARD);
    else gl.disable(E.RASTERIZER_DISCARD);
    gl.disable(E.DITHER);
    // Blend and color mask, through each buffer's stored layout: per buffer where the browser can
    // (OES_draw_buffers_indexed, which backs the caps' independent blending and leaves an integer buffer beside a float
    // one unblended); otherwise the first buffer's for all.
    const ix = this.indexed && key.cbufs.length > 1 ? this.indexed : null;
    const first = key.cbufs.findIndex((k) => k);
    const targets = ix ? key.cbufs.flatMap((cb, k) => (cb ? [k] : [])) : [Math.max(first, 0)];
    let blendColorOf: ColorKey | undefined;
    // A 32-bit float target without EXT_float_blend: unblended (WebGL2 refuses the draw otherwise); without per-buffer
    // state, one such target leaves every buffer unblended.
    const float32 = (k: number) => {
      const sf = s.fb.cbufs[k];
      return !!(sf && (FORMATS.get(sf.format) ?? this.resources.get(sf.res)?.fmt))?.float32;
    };
    const anyFloat32 = !this.floatBlend && !ix && key.cbufs.some((cb, k) => !!cb && float32(k));
    const blendable = (k: number) => this.floatBlend || (ix ? !float32(k) : !anyFloat32);
    for (const k of targets) {
      const cb = key.cbufs[k];
      const rt = this.blendTarget(blend, ix ? k : 0);
      if (rt?.enable && cb?.type === 'f' && blendable(k)) {
        const sf = s.fb.cbufs[k];
        const noAlpha = !!(sf && (FORMATS.get(sf.format) ?? this.resources.get(sf.res)?.fmt))?.x;
        const fac = (g: number) => {
          let v = BLEND_FACTOR[g] ?? E.ONE;
          if (noAlpha) v = v === E.DST_ALPHA ? E.ONE : v === E.ONE_MINUS_DST_ALPHA ? E.ZERO : v;
          return v;
        };
        // A constant color and a constant alpha together, which WebGL refuses: the source RGB factor is the shader's
        // (`ColorKey.blendSrc`); on alpha, constant color is constant alpha.
        const asAlpha = (g: number) => (g === 7 ? 8 : g === 0x17 ? 0x18 : g);
        const func = [
          cb.blendSrc ? E.ONE : fac(rt.rgbSrc),
          fac(rt.rgbDst),
          fac(asAlpha(rt.aSrc)),
          fac(asAlpha(rt.aDst)),
        ] as const;
        const eq = [BLEND_FUNC[rt.rgbFunc] ?? E.FUNC_ADD, BLEND_FUNC[rt.aFunc] ?? E.FUNC_ADD] as const;
        if (ix) {
          ix.enableiOES(E.BLEND, k);
          ix.blendFuncSeparateiOES(k, ...func);
          ix.blendEquationSeparateiOES(k, ...eq);
        } else {
          gl.enable(E.BLEND);
          gl.blendFuncSeparate(...func);
          gl.blendEquationSeparate(...eq);
        }
        blendColorOf ??= cb;
      } else if (ix) ix.disableiOES(E.BLEND, k);
      else gl.disable(E.BLEND);
      // A component the buffer doesn't store stays on. Without per-buffer masks, another buffer may store it (an RG
      // target first masked an RGBA one's B and A: dEQP-GLES3 fragment_out.random).
      const m = rt ? rt.mask : 0xf;
      const wr = cb?.write ?? [0, 1, 2, 3];
      const bit = (q: number) => (wr[q] === undefined || wr[q] < 0 ? true : !!(m & (1 << wr[q])));
      if (ix) ix.colorMaskiOES(k, bit(0), bit(1), bit(2), bit(3));
      else gl.colorMask(bit(0), bit(1), bit(2), bit(3));
    }
    // One blend color for all buffers, through the first blended buffer's layout. Its alpha is a factor (CONSTANT_ALPHA),
    // not a stored component: the guest's where the layout stores no channel there (RGB565, an X: dEQP-GLES3
    // draw_buffers_indexed.random.max_implementation_draw_buffers.0, an RGB565 buffer first).
    if (blendColorOf) {
      const bc = s.blendColor,
        wr = blendColorOf.write;
      gl.blendColor(
        ...([0, 1, 2, 3].map((q) => (wr[q] !== undefined && wr[q] >= 0 ? bc[wr[q]] : q === 3 ? bc[3] : 1)) as [
          number,
          number,
          number,
          number,
        ]),
      );
    }
    if (blend?.alphaToCoverage) gl.enable(E.SAMPLE_ALPHA_TO_COVERAGE);
    else gl.disable(E.SAMPLE_ALPHA_TO_COVERAGE);
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
        faces = tris
          ? [
              ...(cull === 1 || cull === 3 ? [] : [{ cull: E.BACK, st: st0, ref: s.stencilRef[0] }]),
              ...(cull === 2 || cull === 3 ? [] : [{ cull: E.FRONT, st: back, ref: refBack }]),
            ]
          : [{ st: st0, ref: s.stencilRef[0] }];
        stencil(E.FRONT_AND_BACK, st0, s.stencilRef[0]);
      } else {
        stencil(E.FRONT, st0, s.stencilRef[0]);
        stencil(E.BACK, back, refBack);
      }
    } else gl.disable(E.STENCIL_TEST);
    // Vertex attributes.
    s.vao ??= gl.createVertexArray();
    gl.bindVertexArray(s.vao);
    // What the sub-context's array already has is left as it is (`Sub.vaoState`).
    const va = this.drawCache
      ? (s.vaoState ??= { on: 0, buf: [], ptr: new Float64Array(16 * 6).fill(NaN), divisor: [] })
      : undefined;
    const enable = (k: number, on: boolean) => {
      if (va) {
        const bit = 1 << k;
        if (!!(va.on & bit) === on) return;
        va.on = on ? va.on | bit : va.on & ~bit;
      }
      if (on) gl.enableVertexAttribArray(k);
      else gl.disableVertexAttribArray(k);
    };
    for (let k = 0; k < 16; k++) {
      const e = s.ve[k];
      if (!e || !prog.layout.attribs.includes(k)) {
        enable(k, false);
        continue;
      }
      const vf = VERTEX_FORMATS.get(e.format);
      const vb = s.vbs[e.vb];
      const r = vb && this.resources.get(vb.res);
      if (!vf || !r?.buf || !r.shadow) {
        enable(k, false);
        if (!vf) this.error(`vertex format ${e.format} isn't supported`);
        continue;
      }
      if (vb.stride === 0) {
        // One value for every vertex: from the buffer's copy.
        enable(k, false);
        this.constantAttrib(k, vf, r.shadow, vb.offset + e.offset);
        continue;
      }
      enable(k, true);
      let stride = vb.stride,
        at = vb.offset + e.offset;
      let buf = r.buf;
      const comp =
        vf.type === E.FLOAT ||
        vf.type === E.INT ||
        vf.type === E.UNSIGNED_INT ||
        vf.type === 0x8368 ||
        vf.type === 0x8d9f
          ? 4
          : vf.type === E.SHORT || vf.type === E.UNSIGNED_SHORT || vf.type === E.HALF_FLOAT
            ? 2
            : 1;
      if (stride % comp || at % comp || stride > 255) {
        // WebGL refuses a stride or offset that isn't a multiple of the type's size, and strides over 255 (GLES allows
        // both): the attribute repacked from the buffer's copy, every element the buffer holds, 4-byte aligned.
        const n = Math.max(0, Math.floor((r.shadow.length - at - vf.bytes) / stride) + 1);
        const st = Math.ceil(vf.bytes / 4) * 4;
        const packed = new Uint8Array(Math.max(4, n * st));
        for (let i = 0; i < n; i++) packed.set(r.shadow.subarray(at + i * stride, at + i * stride + vf.bytes), i * st);
        buf = this.scratchVb[k] ??= gl.createBuffer();
        gl.bindBuffer(E.ARRAY_BUFFER, buf);
        gl.bufferData(E.ARRAY_BUFFER, packed, E.STREAM_DRAW);
        stride = st;
        at = 0;
      }
      const was = va?.ptr,
        p = k * 6;
      const int = vf.int ? 1 : 0,
        norm = vf.normalized ? 1 : 0;
      if (
        !va ||
        !was ||
        va.buf[k] !== buf ||
        was[p] !== vf.size ||
        was[p + 1] !== vf.type ||
        was[p + 2] !== norm ||
        was[p + 3] !== stride ||
        was[p + 4] !== at ||
        was[p + 5] !== int
      ) {
        gl.bindBuffer(E.ARRAY_BUFFER, buf);
        if (vf.int) gl.vertexAttribIPointer(k, vf.size, vf.type, stride, at);
        else gl.vertexAttribPointer(k, vf.size, vf.type, vf.normalized, stride, at);
        if (va) {
          va.buf[k] = buf;
          was![p] = vf.size;
          was![p + 1] = vf.type;
          was![p + 2] = norm;
          was![p + 3] = stride;
          was![p + 4] = at;
          was![p + 5] = int;
        }
      }
      if (va?.divisor[k] !== e.divisor) {
        gl.vertexAttribDivisor(k, e.divisor);
        if (va) va.divisor[k] = e.divisor;
      }
    }
    const prim = PRIM[mode];
    this.stats.draws++;
    this.countQueries(c.sub);
    if (this.debug) {
      const s = c.sub,
        rt = s.blend?.rt[0];
      const fmt = (res: number, f: number) => `${res}:${FORMATS.get(f)?.name ?? f}`;
      this.debug(
        `draw ctx ${c.id} into [${s.fb.cbufs.map((cb) => (cb ? fmt(cb.res, cb.format) : '-')).join(' ')}]${s.fb.zs ? ` zs ${fmt(s.fb.zs.res, s.fb.zs.format)}` : ''} vp ${s.viewport.scale[1] < 0 ? '-y' : '+y'} ${s.rs ? `ccw ${+s.rs.frontCcw} cull ${s.rs.cullFace}` : ''}${s.dsa?.stencil[0].enabled ? ` stencil ${JSON.stringify(s.dsa.stencil)}` : ''} blend ${rt?.enable ? `${rt.rgbSrc},${rt.rgbDst},${rt.aSrc},${rt.aDst} mask ${rt.mask}` : 'off'} sampling [${s.views.fs.map((v) => (v ? `${fmt(v.res, v.format)}/${v.swizzle.join('')}` : '-')).join(' ')}] samplers [${s.samplers.fs.map((x) => (x ? `${x.compare ? `cmp ${x.compareFunc}` : 'nocmp'} min ${x.minImg}/${x.minMip} mag ${x.magImg}` : '-')).join(' ')}]`,
      );
    }
    const inst = Math.max(1, instances);
    let drawCount = count,
      drawInstances = instances,
      emitted = 0;
    let capture: { plan: SoPlan; vertices: number } | undefined;
    if (so) {
      // WebGL2 (GLES 3.0) captures unindexed point, line and triangle lists only, and refuses a draw that would overflow
      // a buffer: Gallium stops writing at the end instead, so the draw is cut to the primitives that fit (and what it
      // draws with them: a draw that overflows its targets is rare and draws partly).
      const vpp = mode === 0 ? 1 : mode === 1 ? 2 : mode === 4 ? 3 : 0;
      if (!vpp || indexed)
        this.error(
          `stream output from ${indexed ? 'an indexed draw' : `primitive ${mode}`}: WebGL2 captures unindexed lists only`,
        );
      else {
        const fit = Math.min(
          ...so.plan.targets.map((b) => Math.floor(Math.max(0, b.t.size - b.t.filled) / (b.stride * 4 * vpp))),
        );
        const per = Math.floor(count / vpp);
        if (inst === 1) emitted = Math.min(per, fit);
        else {
          drawInstances = per ? Math.min(inst, Math.floor(fit / per)) : inst;
          emitted = drawInstances * per;
        }
        if (emitted > 0) {
          if (inst === 1) drawCount = emitted * vpp;
          capture = { plan: so.plan, vertices: emitted * vpp };
        } else drawInstances = instances;
      }
    }
    if (so && this.debug) {
      // The first vertex's attributes, from the buffers' copies (as words).
      const attrs = (s.ve ?? []).map((e, k) => {
        const vb = s.vbs[e.vb],
          r = vb && this.resources.get(vb.res);
        if (!r?.shadow) return `${k}:-`;
        const at = vb.offset + e.offset + start * vb.stride;
        const dv = new DataView(r.shadow.buffer, r.shadow.byteOffset);
        return `${k}:res ${vb.res} @${at} stride ${vb.stride} fmt ${e.format} = ${[0, 1, 2, 3].map((q) => (at + 4 * q + 4 <= r.shadow!.length ? dv.getUint32(at + 4 * q, true).toString(16) : '?')).join(' ')}`;
      });
      this.debug(`stream output draw start ${start}: ${attrs.join('; ')}`);
    }
    if (so)
      this.debug?.(
        `stream output: mode ${mode} count ${count} x${inst}${indexed ? ' indexed' : ''}: ${emitted} primitives captured; targets ${so.plan.targets.map((t) => `${t.t.res}@${t.t.offset}+${t.t.size} filled ${t.t.filled} stride ${t.stride}`).join(', ')}; outputs ${so.outputs.map((o) => `${o.buffer}:${o.offset}+${o.comps}`).join(' ')}`,
      );
    for (const [q, ctx] of this.counting)
      if (ctx === c.id) q.result += q.type === Q_GENERATED ? primitives(mode, count) * inst : emitted;
    if (capture) this.beginCapture(s, capture.plan, capture.vertices, prim);
    if (indexed) {
      const ib = s.ib;
      const r = ib && this.resources.get(ib.res);
      if (!ib || !r?.shadow) return this.error('an indexed draw without an index buffer');
      let size = ib.size || 2;
      // Mesa folds the draw's start into the index buffer's offset (vrend reads only the offset).
      let offset = ib.offset;
      // Indices of a size GL has, aligned and in the buffer (WebGL refuses the others too); the rebasing below reads
      // them on the CPU, so a guest's count can't size its work past the buffer (tests/virgl-fuzz.ts).
      if ((size !== 1 && size !== 2 && size !== 4) || offset % size || offset + count * size > r.shadow.length)
        return this.error(`an indexed draw past index buffer ${r.id} (${count} of size ${size} at ${offset})`);
      // The element-array twin: made whole once, then only what was written since (Mesa streams small index
      // arrays into one large upload buffer between draws).
      if (!r.ibuf) {
        r.ibuf = gl.createBuffer();
        gl.bindBuffer(E.ELEMENT_ARRAY_BUFFER, r.ibuf);
        gl.bufferData(E.ELEMENT_ARRAY_BUFFER, r.shadow, E.DYNAMIC_DRAW);
        r.ilo = r.ihi = 0;
        r.imax = undefined;
      } else if (r.ihi) {
        const lo = r.ilo!;
        gl.bindBuffer(E.ELEMENT_ARRAY_BUFFER, r.ibuf);
        gl.bufferSubData(E.ELEMENT_ARRAY_BUFFER, lo, r.shadow, lo, r.ihi - lo);
        r.ilo = r.ihi = 0;
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
        const inp =
          size === 1 ? src : size === 2 ? new Uint16Array(src.slice().buffer) : new Uint32Array(src.slice().buffer);
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
    } else if (drawInstances > 1)
      this.byFace(faces, () => gl.drawArraysInstanced(prim, start, drawCount, drawInstances));
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
      if (f.cull !== undefined) {
        gl.enable(E.CULL_FACE);
        gl.cullFace(f.cull);
      }
      draw();
    }
  }

  /**
   * The outputs a shader's program captures: all it declares, whatever targets are bound (with none bound too), so a
   * shader draws through one program with transform feedback on and off, as GL's one program does. Two programs
   * computed the position differently on ANGLE's Metal (its compiler's fast math), and dEQP compares the two
   * drawings exactly (lines moved by a pixel). Only past WebGL2's 64 words are the bound targets' outputs alone kept.
   */
  private soOutputs(so: NonNullable<Shader['so']>, targets?: (SoTarget | undefined)[]) {
    const all = so.outputs.slice().sort((a, b) => a.buffer - b.buffer || a.offset - b.offset);
    if (all.reduce((n, o) => n + o.comps, 0) <= 64 || !targets) return all;
    return all.filter((o) => targets[o.buffer]);
  }

  /** A draw's program key's stream output when nothing is captured (`soOutputs`). */
  private soKey(so: NonNullable<Shader['so']>): { so?: ProgramKey['so'] } {
    const all = this.soOutputs(so);
    return all.length && all.reduce((n, o) => n + o.comps, 0) <= 64
      ? { so: all.map(({ reg, start, comps }) => ({ reg, start, comps })) }
      : {};
  }

  /** How a vertex shader's stream outputs (to the targets bound) are captured (`SoPlan`). */
  private soPlan(
    so: NonNullable<Shader['so']>,
    targets: (SoTarget | undefined)[],
  ): { plan: SoPlan; outputs: SoOutput[] } | undefined {
    if (!so.outputs.some((o) => targets[o.buffer])) return undefined;
    const outputs = this.soOutputs(so, targets);
    if (!outputs.length) return undefined;
    const plan: SoPlan = { outputs, total: outputs.reduce((n, o) => n + o.comps, 0), targets: [] };
    if (plan.total > 64) {
      this.error(`stream output of ${plan.total} words a vertex (WebGL2 captures 64)`);
      return undefined;
    }
    for (const buffer of new Set(outputs.map((o) => o.buffer).filter((b) => targets[b]))) {
      const t = targets[buffer]!,
        r = this.resources.get(t.res);
      if (!r?.buf || !r.shadow) {
        this.error(`stream output to resource ${t.res}, not a buffer`);
        return undefined;
      }
      if ((t.offset & 3) !== 0) {
        this.error(`stream output at offset ${t.offset} (not a multiple of 4)`);
        return undefined;
      }
      const stride =
        so.strides[buffer] || Math.max(...outputs.filter((o) => o.buffer === buffer).map((o) => o.offset + o.comps));
      plan.targets.push({ buffer, t, r, stride });
    }
    return { plan, outputs };
  }

  private beginCapture(s: Sub, plan: SoPlan, vertices: number, prim: number) {
    const gl = this.gl;
    s.so.tf ??= gl.createTransformFeedback();
    this.soScratch ??= gl.createBuffer();
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
            for (let c = 0; c < o.comps; c++)
              dv.setUint32(base + (v * tg.stride + o.offset + c) * 4, words[v * plan.total + at + c], true);
          }
        }
        at += o.comps;
      }
      const n = vertices * tg.stride * 4;
      gl.bindBuffer(E.COPY_WRITE_BUFFER, tg.r.buf!);
      gl.bufferSubData(E.COPY_WRITE_BUFFER, base, tg.r.shadow!, base, n);
      indexWritten(tg.r, base, base + n);
      tg.t.filled += n;
    }
    gl.bindBuffer(E.COPY_WRITE_BUFFER, null);
  }

  private bindNullFramebuffer() {
    const gl = this.gl;
    if (!this.nullFbo) {
      this.nullFbo = gl.createFramebuffer()!;
      const rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(E.RENDERBUFFER, rb);
      gl.renderbufferStorage(E.RENDERBUFFER, E.RGBA8, 1, 1);
      this.bindFb(E.DRAW_FRAMEBUFFER, this.nullFbo);
      gl.framebufferRenderbuffer(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0, E.RENDERBUFFER, rb);
    }
    this.bindFb(E.DRAW_FRAMEBUFFER, this.nullFbo);
    this.setDrawBuffers(COLOR0_ONLY);
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
    this.scratch ??= gl.createBuffer();
    gl.bindBuffer(E.ELEMENT_ARRAY_BUFFER, this.scratch);
    gl.bufferData(E.ELEMENT_ARRAY_BUFFER, data, E.STREAM_DRAW);
    return this.scratch;
  }

  private constantAttrib(
    k: number,
    vf: { size: number; type: number; normalized: boolean; int?: 'i' | 'u' },
    shadow: Uint8Array,
    at: number,
  ) {
    const gl = this.gl;
    const dv = new DataView(shadow.buffer, shadow.byteOffset, shadow.length);
    const get = (i: number): number => {
      const o =
        at +
        i *
          (vf.type === E.FLOAT || vf.type === E.INT || vf.type === E.UNSIGNED_INT
            ? 4
            : vf.type === E.SHORT || vf.type === E.UNSIGNED_SHORT || vf.type === E.HALF_FLOAT
              ? 2
              : 1);
      if (o + 4 > shadow.length && vf.type === E.FLOAT) return 0;
      switch (vf.type) {
        case E.FLOAT:
          return dv.getFloat32(o, true);
        case E.UNSIGNED_BYTE:
          return vf.normalized ? dv.getUint8(o) / 255 : dv.getUint8(o);
        case E.BYTE:
          return vf.normalized ? Math.max(-1, dv.getInt8(o) / 127) : dv.getInt8(o);
        case E.UNSIGNED_SHORT:
          return vf.normalized ? dv.getUint16(o, true) / 65535 : dv.getUint16(o, true);
        case E.SHORT:
          return vf.normalized ? Math.max(-1, dv.getInt16(o, true) / 32767) : dv.getInt16(o, true);
        case E.UNSIGNED_INT:
          return dv.getUint32(o, true);
        case E.INT:
          return dv.getInt32(o, true);
        default:
          return 0;
      }
    };
    const v = [0, 0, 0, 1].map((d, i) => (i < vf.size ? get(i) : d)) as [number, number, number, number];
    if (vf.int === 'u') gl.vertexAttribI4ui(k, ...v);
    else if (vf.int === 'i') gl.vertexAttribI4i(k, ...v);
    else gl.vertexAttrib4f(k, ...v);
  }

  private glSampler(st: SamplerState | undefined, _r: Res): WebGLSampler | null {
    if (!st) return null;
    const gl = this.gl;
    if (st.sampler) return st.sampler;
    const sm = gl.createSampler();
    gl.samplerParameteri(sm, E.TEXTURE_WRAP_S, WRAP[st.wrap[0]]);
    gl.samplerParameteri(sm, E.TEXTURE_WRAP_T, WRAP[st.wrap[1]]);
    gl.samplerParameteri(sm, E.TEXTURE_WRAP_R, WRAP[st.wrap[2]]);
    const mag = st.magImg ? E.LINEAR : E.NEAREST;
    const min =
      st.minMip === 2
        ? st.minImg
          ? E.LINEAR
          : E.NEAREST
        : st.minImg
          ? st.minMip
            ? E.LINEAR_MIPMAP_LINEAR
            : E.LINEAR_MIPMAP_NEAREST
          : st.minMip
            ? E.NEAREST_MIPMAP_LINEAR
            : E.NEAREST_MIPMAP_NEAREST;
    gl.samplerParameteri(sm, E.TEXTURE_MAG_FILTER, mag);
    gl.samplerParameteri(sm, E.TEXTURE_MIN_FILTER, min);
    gl.samplerParameterf(sm, E.TEXTURE_MIN_LOD, st.minLod);
    // The guest's range even without mipmaps (vrend's way): GLES picks the magnifying filter where the LOD after this
    // clamp is at most 0, so a MAX_LOD of 0 magnifies everywhere on a backend that takes it as it is (ANGLE's D3D11:
    // dEQP-GLES2 texture.filtering's nearest_linear and linear_nearest); the level is the base one either way.
    gl.samplerParameterf(sm, E.TEXTURE_MAX_LOD, st.maxLod);
    if (st.compare) {
      gl.samplerParameteri(sm, E.TEXTURE_COMPARE_MODE, E.COMPARE_REF_TO_TEXTURE);
      gl.samplerParameteri(sm, E.TEXTURE_COMPARE_FUNC, COMPARE[st.compareFunc]);
    }
    if (st.maxAniso > 1 && this.anisotropy) gl.samplerParameterf(sm, E.TEXTURE_MAX_ANISOTROPY, st.maxAniso);
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
    q.active = true;
    // Occlusion counters and predicates: counted in spans of the sub-context's draws (`countQueries`), each WebGL2's
    // "any samples passed" (a counter reads 0 or 1). Begun again before its result came: that result is dropped.
    if (OCCLUSION.has(q.type)) {
      if (this.counter?.sub === c.sub) this.pauseQueries();
      if (q.pending) {
        q.pending = false;
        this.queries = this.queries.filter((x) => x !== q);
        this.queryChanges++;
      }
      this.dropSpans(q);
      q.spans = [];
      q.passed = false;
      c.sub.occlusion.add(q);
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
    q.active = false;
    this.counting.delete(q);
    if (c.sub.occlusion.delete(q)) {
      if (this.counter?.sub === c.sub) this.pauseQueries();
      // Spans have their results after the task that ended them (`pollQueries`); without one (no draw, or every
      // span already read: `passed`), the query is done.
      if (q.spans?.length) {
        q.pending = true;
        this.queries.push(q);
        this.queryChanges++;
      } else {
        q.result = q.passed ? 1 : 0;
        q.spans = undefined;
      }
    }
    this.queryState(c, q, q.pending ? 0 : 1);
  }

  /**
   * Before a draw of sub-context `s`: a span counts it for the occlusion queries active in `s`, the one running if it
   * is `s`'s, or a new one (another's ended first). What draws outside a sub-context's commands (another context, a
   * blit, an upload, the screen) pauses it first (`pauseQueries`), so no query counts another's samples.
   */
  private countQueries(s: Sub) {
    if (this.counter?.sub === s) return;
    this.pauseQueries();
    if (!s.occlusion.size) return;
    // The spans read so far folded in; queries that already passed need no more.
    const counted = [...s.occlusion].filter((q) => (this.foldSpans(q), !q.passed));
    if (!counted.length) return;
    const span: Span = {
      q: this.spareQueries.pop() ?? this.gl.createQuery(),
      done: false,
      passed: false,
      users: counted.length,
    };
    this.gl.beginQuery(E.ANY_SAMPLES_PASSED, span.q);
    for (const q of counted) q.spans!.push(span);
    this.counter = { span, sub: s };
  }

  /**
   * Reads a span's result if WebGL has it; whether it's done. A span WebGL answers null for (a lost context, a query
   * it refused) never will: it counts as passed, said once, since a query pending for good would hold every later
   * fence (`FenceGate`) and the guest's control queue would fill.
   */
  private readSpan(span: Span) {
    if (span.done) return true;
    if (this.counter?.span === span) return false;
    const gl = this.gl;
    const available = gl.getQueryParameter(span.q, E.QUERY_RESULT_AVAILABLE) as boolean | null;
    if (available === false) return false;
    span.done = true;
    if (available === null) {
      span.passed = span.lost = true;
      if (!this.lostQueries++) this.error('an occlusion query has no result (taken as samples passed)');
    } else span.passed = !!gl.getQueryParameter(span.q, E.QUERY_RESULT);
    return true;
  }

  /** Folds a query's spans that have their results into `passed`, and lets them go. */
  private foldSpans(q: Query) {
    const spans = q.spans;
    if (!spans?.length) return;
    // Compacted in place (each query's own array): a poll folds each pending query's.
    let n = 0;
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      if (!this.readSpan(span)) {
        spans[n++] = span;
        continue;
      }
      q.passed ||= span.passed;
      this.releaseSpan(span);
    }
    spans.length = n;
  }

  /** Lets go of a query's spans unread (begun again, destroyed). */
  private dropSpans(q: Query) {
    if (this.counter && q.spans?.includes(this.counter.span)) this.pauseQueries();
    for (const span of q.spans ?? []) this.releaseSpan(span);
    q.spans = undefined;
  }

  /** One query fewer uses `span`: the last one gives its WebGL query back (read) or deletes it. */
  private releaseSpan(span: Span) {
    if (--span.users) return;
    if (span.done && !span.lost) this.spareQueries.push(span.q);
    else this.gl.deleteQuery(span.q);
  }

  /** Ends the span counting draws, if one is. */
  private pauseQueries() {
    if (!this.counter) return;
    this.gl.endQuery(E.ANY_SAMPLES_PASSED);
    this.counter = undefined;
  }

  private getQueryResult(c: Ctx, h: number) {
    const q = this.query(c, h);
    if (q && !q.pending) this.queryState(c, q, 1);
  }

  /** Writes a query's state for the guest (struct virgl_host_query_state: state, result size, u64 result). */
  private queryState(c: Ctx | undefined, q: Query, state: number) {
    const r = this.resources.get(q.res);
    if (!r) return;
    const b = new Uint8Array(16);
    const v = new DataView(b.buffer);
    v.setUint32(0, state ? 1 : 2, true); // DONE, or WAIT_HOST
    v.setUint32(4, 8, true);
    v.setBigUint64(8, BigInt(q.result), true);
    this.writeBacking(r, q.offset, b);
    // And the buffer's CPU copy, which a transfer from the host reads back (Mesa's `get_query_result` maps the buffer
    // that way in a loop until it reads DONE: from a copy without the state, it never did).
    if (r.shadow && q.offset + 16 <= r.shadow.length) r.shadow.set(b, q.offset);
  }

  /** Whether the occlusion queries ended so far have their results, as they become available (`FenceGate`). */
  queriesSettled(): () => boolean {
    const waiting = this.queries.filter((q) => q.pending);
    return () => waiting.every((q) => !q.pending);
  }

  /** Polls pending queries (the GPU worker calls it between tasks: WebGL results arrive after the task ends). */
  pollQueries() {
    // Compacted in place: a poll runs each task while queries are pending.
    const qs = this.queries;
    let n = 0;
    for (let i = 0; i < qs.length; i++) {
      const q = qs[i];
      this.foldSpans(q);
      if (q.spans?.length) {
        qs[n++] = q;
        continue;
      }
      q.result = q.passed ? 1 : 0;
      q.spans = undefined;
      q.pending = false;
      this.queryState(undefined, q, 1);
      this.queryChanges++;
    }
    qs.length = n;
    return n;
  }

  // --- for the screen --------------------------------------------------------------------------------------------

  /** A resource's texture and format, for the screen to show. */
  scanoutSource(id: number) {
    const r = this.resources.get(id);
    if (!r?.tex || !r.fmt || r.glTarget !== E.TEXTURE_2D) return undefined;
    return { tex: r.tex, fmt: r.fmt, width: r.width, height: r.height };
  }

  // --- snapshots -------------------------------------------------------------------------------------------------

  /**
   * Why the renderer's state can't be saved now, or undefined: a context with video codecs or buffers (WebCodecs'
   * decoders keep their reference pictures to themselves).
   */
  snapshotRefusal(): Msg | undefined {
    for (const c of this.contexts.values()) {
      if (c.video && (c.video.codecs.size || c.video.buffers.size))
        return msg('display:virgl-renderer.unsaveable.video');
    }
    return undefined;
  }

  /**
   * What the guest made, for a snapshot (docs/graphics.md "Snapshots with 3D in use"): every resource (its description, backing, and
   * contents read back level by level) and every context (its sub-contexts' objects and bound state, as data). The
   * GL objects are made again from it by `load` in a fresh renderer. Call it with the calls before it run and the
   * queries settled (the GPU worker's `save`); `snapshotRefusal` first.
   */
  save(): RendererSnapshot {
    const resources = [...this.resources.values()].map((r) => this.saveResource(r));
    const contexts = [...this.contexts.values()].map((c) => ({
      id: c.id,
      sub: c.sub.id,
      attached: [...c.attached],
      subs: [...c.subs.values()].map((s) => this.saveSub(c, s)),
    }));
    this.resetAfterSnapshot();
    return { version: 1, resources, contexts };
  }

  /** A snapshot's state into this renderer: what it had is gone (a virtio reset), then the resources and contexts are made again. */
  load(s: RendererSnapshot) {
    if (s?.version !== 1 || !Array.isArray(s.resources) || !Array.isArray(s.contexts))
      throw new Error('the 3D state is not one this page reads');
    this.reset();
    for (const sr of s.resources) {
      this.createResource(sr.desc);
      const r = this.resources.get(sr.desc.id);
      if (!r) continue;
      if (sr.backing) this.attachBacking(r.id, sr.backing);
      for (const l of sr.levels) this.loadLevel(r, l);
    }
    for (const sc of s.contexts) {
      this.createContext(sc.id);
      const c = this.contexts.get(sc.id)!;
      c.subs.clear();
      for (const ss of sc.subs) c.subs.set(ss.id, this.loadSub(ss, c));
      c.sub = c.subs.get(sc.sub) ?? c.subs.get(0) ?? this.newSub(0);
      if (!c.subs.has(c.sub.id)) c.subs.set(c.sub.id, c.sub);
      for (const id of sc.attached) this.attach(c.id, id);
    }
    this.resetAfterSnapshot();
  }

  /** The bytes a snapshot of `desc` holds (before compression): a buffer's, each level's texels or blocks, 5 a depth-stencil texel. */
  static snapshotBytes(
    desc: Pick<ResourceDesc, 'target' | 'format' | 'width' | 'height' | 'depth' | 'arraySize' | 'lastLevel' | 'bind'>,
  ) {
    if (desc.target === PIPE_BUFFER) return desc.bind & BIND_STAGING ? 0 : desc.width;
    const f = FORMATS.get(desc.format);
    if (!f) return 0;
    const zs = f.kind === 'depth' || f.kind === 'depthstencil' || f.kind === 'stencil';
    let n = 0;
    for (let level = 0; level <= desc.lastLevel; level++) {
      const w = Math.max(1, desc.width >> level),
        h =
          desc.target === PIPE_TEXTURE_1D || desc.target === PIPE_TEXTURE_1D_ARRAY
            ? 1
            : Math.max(1, desc.height >> level);
      const d = desc.target === PIPE_TEXTURE_3D ? Math.max(1, desc.depth >> level) : Math.max(1, desc.arraySize);
      n += zs
        ? w * h * d * ((f.kind === 'stencil' ? 0 : 4) + (f.kind === 'depth' ? 0 : 1))
        : Math.ceil(w / f.block) * Math.ceil(h / f.block) * d * f.bpp;
    }
    return n;
  }

  /** The bytes a snapshot of every resource holds (`snapshotBytes` of each). */
  snapshotBytes() {
    let n = 0;
    for (const r of this.resources.values()) n += VirglRenderer.snapshotBytes(r);
    return n;
  }

  private saveResource(r: Res): SavedResource {
    const desc: ResourceDesc = {
      id: r.id,
      target: r.target,
      format: r.format,
      bind: r.bind,
      width: r.width,
      height: r.height,
      depth: r.depth,
      arraySize: r.arraySize,
      lastLevel: r.lastLevel,
      samples: r.samples,
      flags: r.flags,
    };
    const out: SavedResource = { desc, backing: r.backing?.map((b) => ({ ...b })) ?? null, levels: [] };
    if (r.target === PIPE_BUFFER) {
      if (r.shadow) out.levels.push({ level: 0, how: 'bytes', data: r.shadow.slice() });
      return out;
    }
    if (!r.fmt || (!r.tex && !r.rb)) return out;
    for (let level = 0; level <= (r.rb ? 0 : r.lastLevel); level++) {
      const l = this.saveLevel(r, level);
      if (typeof l === 'string') {
        out.lost = l;
        this.error(`snapshot: resource ${r.id} (${r.fmt.name}) level ${level}: ${l}`);
      } else if (l) out.levels.push(l);
    }
    return out;
  }

  /** A level's contents (every layer), what's lost instead, or null where there's nothing to keep (blocks never uploaded). */
  private saveLevel(r: Res, level: number): SavedLevel | string | null {
    const f = r.fmt!,
      { w, h, d } = this.levelSize(r, level);
    if (f.kind === 'depth' || f.kind === 'depthstencil' || f.kind === 'stencil') return this.readZs(r, level, w, h, d);
    if (f.block > 1) {
      const b = r.blocks?.get(level);
      return b ? { level, how: 'bytes', data: b.slice() } : null;
    }
    if (!f.write) {
      const t = r.texels?.get(level);
      return t ? { level, how: 'bytes', data: t.slice() } : null;
    }
    let src = r,
      temp: WebGLTexture | undefined;
    if (r.rb) {
      // Multisampled: its samples resolved into a texture of its format (what a load gives every sample back).
      if (f.kind === 'uint' || f.kind === 'sint') return "a multisampled integer format isn't kept";
      temp = this.tempTexture(f, w, h);
      this.blitLayer(r, 0, 0, this.asTexture(r, temp), E.COLOR_ATTACHMENT0, E.COLOR_BUFFER_BIT, w, h);
      src = this.asTexture(r, temp);
    }
    const data = this.readback(
      src,
      level,
      { x: 0, y: 0, z: 0, w, h, d },
      0,
      0,
      readbackOf(f, this.colorBufferFloat) ?? snapshotReader(f, this.colorBufferFloat),
    );
    if (temp) this.gl.deleteTexture(temp);
    return data ? { level, how: 'bytes', data } : `${f.name} can't be read back`;
  }

  private loadLevel(r: Res, l: SavedLevel) {
    const f = r.fmt;
    if (r.target === PIPE_BUFFER)
      return this.upload(r, 0, { x: 0, y: 0, z: 0, w: Math.min(l.data.length, r.width), h: 1, d: 1 }, l.data, 0, 0);
    if (!f || l.level > r.lastLevel) return;
    const { w, h, d } = this.levelSize(r, l.level);
    if (l.how === 'zs') {
      const n = w * h,
        hasD = f.kind !== 'stencil',
        hasS = f.kind !== 'depth';
      if (l.data.length < (hasD ? 4 * n * d : 0) + (hasS ? n * d : 0))
        return this.error(`snapshot: resource ${r.id} level ${l.level} is short`);
      const depths = hasD ? new Float32Array(l.data.slice(0, 4 * n * d).buffer) : null;
      // A 16-bit depth goes a quarter step up: a GL that truncates its conversion (SwiftShader's) keeps the value.
      if (depths && f.internal === GL.DEPTH_COMPONENT16)
        for (let k = 0; k < depths.length; k++) depths[k] = Math.min(1, (Math.round(depths[k] * 65535) + 0.25) / 65535);
      const stens = hasS ? l.data.subarray(hasD ? 4 * n * d : 0) : null;
      return this.drawZs(r, l.level, { x: 0, y: 0, z: 0, w, h, d }, (z, depth, sten) => {
        if (depths) depth.set(depths.subarray(z * n, (z + 1) * n));
        if (stens) sten.set(stens.subarray(z * n, (z + 1) * n));
      });
    }
    if (r.rb) {
      // Multisampled: the resolved texels up as a texture, drawn into every sample.
      const temp = this.tempTexture(f, w, h);
      this.upload(this.asTexture(r, temp), 0, { x: 0, y: 0, z: 0, w, h, d: 1 }, l.data, 0, 0);
      this.drawTexture(temp, r, w, h);
      this.gl.deleteTexture(temp);
      return;
    }
    // A 1D array's layers are its box's rows (`upload`).
    const box =
      r.target === PIPE_TEXTURE_1D_ARRAY ? { x: 0, y: 0, z: 0, w, h: d, d: 1 } : { x: 0, y: 0, z: 0, w, h, d };
    this.upload(r, l.level, box, l.data, 0, 0);
  }

  /** A 2D texture of `f`, `w`×`h`, one level. */
  private tempTexture(f: Format, w: number, h: number) {
    const gl = this.gl,
      t = gl.createTexture();
    gl.bindTexture(E.TEXTURE_2D, t);
    gl.texStorage2D(E.TEXTURE_2D, 1, f.internal, w, h);
    return t;
  }

  /** `r` as if it were the 2D texture `tex` (or the renderbuffer `rb`) of its format, with no samples: what readback, upload and attachTo take. */
  private asTexture(r: Res, tex: WebGLTexture | undefined, rb?: WebGLRenderbuffer): Res {
    return {
      ...r,
      target: PIPE_TEXTURE_2D,
      samples: 0,
      lastLevel: 0,
      depth: 1,
      arraySize: 1,
      rb,
      tex,
      glTarget: tex ? E.TEXTURE_2D : undefined,
      texels: undefined,
      blocks: undefined,
      refs: new Set(),
    };
  }

  /** The snapshot's framebuffers (read, draw), kept apart from the draws' `fbo` and `readFbo`: not in `attached`, their attachments and draw buffers are always set. */
  private snapFbos?: [WebGLFramebuffer, WebGLFramebuffer];
  private nearest?: WebGLSampler;

  /** Binds the snapshot's framebuffers with nothing attached. */
  private snapFramebuffers() {
    const gl = this.gl;
    this.snapFbos ??= [gl.createFramebuffer(), gl.createFramebuffer()];
    const [read, draw] = this.snapFbos;
    this.bindFb(E.READ_FRAMEBUFFER, read);
    this.bindFb(E.DRAW_FRAMEBUFFER, draw);
    for (const t of [E.READ_FRAMEBUFFER, E.DRAW_FRAMEBUFFER]) {
      this.attachTo(t, E.COLOR_ATTACHMENT0, undefined, 0, 0);
      this.attachTo(t, E.DEPTH_STENCIL_ATTACHMENT, undefined, 0, 0);
    }
  }

  /** Copies `src`'s level and layer to `dst`'s level 0 through attachment `point` (resolving samples), `w`×`h`. */
  private blitLayer(
    src: Res,
    level: number,
    layer: number,
    dst: Res,
    point: number,
    mask: number,
    w: number,
    h: number,
  ) {
    const gl = this.gl;
    this.snapFramebuffers();
    this.attachTo(E.READ_FRAMEBUFFER, point, src, level, layer);
    this.attachTo(E.DRAW_FRAMEBUFFER, point, dst, 0, 0);
    const color = point === E.COLOR_ATTACHMENT0;
    gl.readBuffer(color ? E.COLOR_ATTACHMENT0 : E.NONE);
    this.setDrawBuffers(color ? COLOR0_ONLY : NO_COLOR);
    gl.disable(E.SCISSOR_TEST);
    gl.colorMask(true, true, true, true); // the write masks, as `copyRegion`'s blit
    gl.depthMask(true);
    gl.stencilMask(0xff);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, mask, E.NEAREST);
    this.attachTo(E.READ_FRAMEBUFFER, point, undefined, 0, 0);
    this.attachTo(E.DRAW_FRAMEBUFFER, point, undefined, 0, 0);
    gl.readBuffer(E.COLOR_ATTACHMENT0);
  }

  private snapProgs: Partial<
    Record<'depth' | 'mark' | 'copy', { prog: WebGLProgram; loc: Map<string, WebGLUniformLocation | null> }>
  > = {};

  /** One of the snapshot's programs: a triangle over the viewport and `fs`, its uniforms' locations. */
  private snapProgram(name: 'depth' | 'mark' | 'copy') {
    const got = this.snapProgs[name];
    if (got) return got;
    const fs = {
      // A depth texture's values as their float bits.
      depth:
        'uniform highp sampler2D u_t;\nout highp uvec4 o;\nvoid main() { o = uvec4(floatBitsToUint(texelFetch(u_t, ivec2(gl_FragCoord.xy), 0).r)); }',
      // A constant (a stencil bit's weight, added up by blending).
      mark: 'uniform highp float u_v;\nout highp vec4 o;\nvoid main() { o = vec4(u_v); }',
      // A texture's texels as they are.
      copy: 'uniform highp sampler2D u_t;\nout highp vec4 o;\nvoid main() { o = texelFetch(u_t, ivec2(gl_FragCoord.xy), 0); }',
    }[name];
    const prog = this.link(
      '#version 300 es\nvoid main() { vec2 p = vec2(gl_VertexID & 1, gl_VertexID >> 1); gl_Position = vec4(p * 4.0 - 1.0, 0.0, 1.0); }',
      `#version 300 es\nprecision highp float;\n${fs}`,
    );
    if (!prog) throw new Error(`the snapshot's ${name} program doesn't compile`);
    const loc = new Map<string, WebGLUniformLocation | null>();
    for (const n of ['u_t', 'u_v']) loc.set(n, this.gl.getUniformLocation(prog, n));
    return (this.snapProgs[name] = { prog, loc });
  }

  /** State for the snapshot's draws: nothing tested or blended, the whole `w`×`h`. */
  private snapDrawState(w: number, h: number) {
    const gl = this.gl;
    for (const e of [
      E.BLEND,
      E.CULL_FACE,
      E.SCISSOR_TEST,
      E.POLYGON_OFFSET_FILL,
      E.RASTERIZER_DISCARD,
      E.SAMPLE_COVERAGE,
      E.SAMPLE_ALPHA_TO_COVERAGE,
      E.DEPTH_TEST,
      E.STENCIL_TEST,
    ])
      gl.disable(e);
    gl.colorMask(true, true, true, true);
    gl.depthMask(false);
    gl.stencilMask(0);
    gl.viewport(0, 0, w, h);
    gl.bindVertexArray(null);
  }

  /** Binds `tex` on unit 0 with nearest filtering (a depth texture sampled with a linear filter is incomplete). */
  private bindNearest(tex: WebGLTexture) {
    const gl = this.gl;
    if (!this.nearest) {
      this.nearest = gl.createSampler()!;
      gl.samplerParameteri(this.nearest, E.TEXTURE_MIN_FILTER, E.NEAREST);
      gl.samplerParameteri(this.nearest, E.TEXTURE_MAG_FILTER, E.NEAREST);
    }
    gl.activeTexture(E.TEXTURE0);
    gl.bindTexture(E.TEXTURE_2D, tex);
    gl.bindSampler(0, this.nearest);
  }

  /** Draws `tex`'s texels into `r` (a multisampled renderbuffer: every sample takes its pixel's value). */
  private drawTexture(tex: WebGLTexture, r: Res, w: number, h: number) {
    const gl = this.gl,
      p = this.snapProgram('copy');
    this.snapFramebuffers();
    this.attachTo(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0, r, 0, 0);
    this.setDrawBuffers(COLOR0_ONLY);
    this.snapDrawState(w, h);
    gl.useProgram(p.prog);
    gl.uniform1i(p.loc.get('u_t')!, 0);
    this.bindNearest(tex);
    gl.drawArrays(E.TRIANGLES, 0, 3);
    this.attachTo(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0, undefined, 0, 0);
  }

  /**
   * A depth, stencil or depth-stencil level read back (WebGL2 reads none with readPixels): each layer is copied to a
   * 2D texture of its format (a renderbuffer for stencil only; the copy resolves samples); its depths are drawn as
   * float bits into an R32UI texture and read, and its stencil a bit at a time: where a stencil test of the bit passes,
   * the bit's weight is added into an RGBA8 texture. The level: every depth (floats), then every stencil byte.
   */
  private readZs(r: Res, level: number, w: number, h: number, d: number): SavedLevel {
    const gl = this.gl,
      f = r.fmt!;
    const n = w * h,
      hasD = f.kind !== 'stencil',
      hasS = f.kind !== 'depth';
    const out = new Uint8Array((hasD ? 4 * n * d : 0) + (hasS ? n * d : 0));
    const point =
      f.kind === 'depth'
        ? E.DEPTH_ATTACHMENT
        : f.kind === 'stencil'
          ? E.STENCIL_ATTACHMENT
          : E.DEPTH_STENCIL_ATTACHMENT;
    const mask = (hasD ? E.DEPTH_BUFFER_BIT : 0) | (hasS ? E.STENCIL_BUFFER_BIT : 0);
    gl.bindBuffer(E.PIXEL_PACK_BUFFER, null);
    for (let z = 0; z < d; z++) {
      // The layer, alone and single-sampled.
      let copy: Res;
      if (f.kind === 'stencil') {
        const rb = gl.createRenderbuffer();
        gl.bindRenderbuffer(E.RENDERBUFFER, rb);
        gl.renderbufferStorage(E.RENDERBUFFER, f.internal, w, h);
        copy = this.asTexture(r, undefined, rb);
      } else copy = this.asTexture(r, this.tempTexture(f, w, h));
      this.blitLayer(r, level, z, copy, point, mask, w, h);
      if (hasD) {
        const target = gl.createTexture();
        gl.bindTexture(E.TEXTURE_2D, target);
        gl.texStorage2D(E.TEXTURE_2D, 1, GL.R32UI, w, h);
        this.snapFramebuffers();
        gl.framebufferTexture2D(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0, E.TEXTURE_2D, target, 0);
        this.setDrawBuffers(COLOR0_ONLY);
        this.snapDrawState(w, h);
        const p = this.snapProgram('depth');
        gl.useProgram(p.prog);
        gl.uniform1i(p.loc.get('u_t')!, 0);
        this.bindNearest(copy.tex!);
        gl.drawArrays(E.TRIANGLES, 0, 3);
        this.bindFb(E.READ_FRAMEBUFFER, this.snapFbos![1]);
        gl.readBuffer(E.COLOR_ATTACHMENT0);
        const px = new Uint32Array(n * 4);
        gl.readPixels(0, 0, w, h, E.RGBA_INTEGER, E.UNSIGNED_INT, px);
        const bits = new Uint32Array(out.buffer, 4 * n * z, n);
        for (let k = 0; k < n; k++) bits[k] = px[4 * k];
        gl.deleteTexture(target);
      }
      if (hasS) {
        const target = gl.createTexture();
        gl.bindTexture(E.TEXTURE_2D, target);
        gl.texStorage2D(E.TEXTURE_2D, 1, E.RGBA8, w, h);
        this.snapFramebuffers();
        gl.framebufferTexture2D(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0, E.TEXTURE_2D, target, 0);
        this.attachTo(E.DRAW_FRAMEBUFFER, point, copy, 0, 0);
        this.setDrawBuffers(COLOR0_ONLY);
        this.snapDrawState(w, h);
        gl.clearBufferfv(E.COLOR, 0, [0, 0, 0, 0]);
        gl.enable(E.BLEND);
        gl.blendEquation(E.FUNC_ADD);
        gl.blendFunc(E.ONE, E.ONE);
        gl.enable(E.STENCIL_TEST);
        gl.stencilOp(E.KEEP, E.KEEP, E.KEEP);
        const p = this.snapProgram('mark');
        gl.useProgram(p.prog);
        for (let b = 0; b < 8; b++) {
          gl.stencilFunc(E.EQUAL, 1 << b, 1 << b);
          gl.uniform1f(p.loc.get('u_v')!, (1 << b) / 255);
          gl.drawArrays(E.TRIANGLES, 0, 3);
        }
        this.bindFb(E.READ_FRAMEBUFFER, this.snapFbos![1]);
        gl.readBuffer(E.COLOR_ATTACHMENT0);
        const px = new Uint8Array(n * 4);
        gl.readPixels(0, 0, w, h, E.RGBA, E.UNSIGNED_BYTE, px);
        const at = (hasD ? 4 * n * d : 0) + n * z;
        for (let k = 0; k < n; k++) out[at + k] = px[4 * k];
        this.attachTo(E.DRAW_FRAMEBUFFER, point, undefined, 0, 0);
        gl.deleteTexture(target);
      }
      if (copy.rb) gl.deleteRenderbuffer(copy.rb);
      if (copy.tex) gl.deleteTexture(copy.tex);
    }
    return { level, how: 'zs', data: out };
  }

  /** The GL state the snapshot's passes changed, back to what the draws expect of it. */
  private resetAfterSnapshot() {
    const gl = this.gl;
    this.bindFb(E.FRAMEBUFFER, null);
    gl.disable(E.BLEND);
    gl.disable(E.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    gl.stencilMask(0xff);
    gl.activeTexture(E.TEXTURE0);
    gl.bindSampler(0, null);
  }

  /** A sub-context as data: its objects (their values; bound state names them by their place in the list). */
  private saveSub(c: Ctx, s: Sub): SavedSub {
    const objects: SavedObject[] = [];
    const index = new Map<unknown, number>();
    const add = (handle: number, o: Obj) => {
      const at = index.get(o.v);
      if (at !== undefined) return at;
      index.set(o.v, objects.length);
      objects.push({ handle, kind: o.kind, v: this.saveValue(o, c) });
      return objects.length - 1;
    };
    for (const [h, o] of s.objects) add(h, o);
    // A bound value no handle names any more (its object deleted or made again): kept unnamed.
    const ref = <K extends Obj['kind']>(kind: K, v: Extract<Obj, { kind: K }>['v'] | undefined) =>
      v ? add(0, { kind, v } as Obj) : null;
    return {
      id: s.id,
      objects,
      shaders: { vs: ref('shader', s.shaders.vs), fs: ref('shader', s.shaders.fs) },
      blend: ref('blend', s.blend),
      dsa: ref('dsa', s.dsa),
      rs: ref('rs', s.rs),
      ve: ref('ve', s.ve),
      vbs: s.vbs.map((b) => ({ ...b })),
      ib: s.ib && { ...s.ib },
      consts: { vs: [...s.consts.vs], fs: [...s.consts.fs] },
      ubos: { vs: [...s.ubos.vs].map(([k, u]) => [k, { ...u }]), fs: [...s.ubos.fs].map(([k, u]) => [k, { ...u }]) },
      views: { vs: Array.from(s.views.vs, (v) => ref('view', v)), fs: Array.from(s.views.fs, (v) => ref('view', v)) },
      samplers: {
        vs: Array.from(s.samplers.vs, (v) => ref('sampler', v)),
        fs: Array.from(s.samplers.fs, (v) => ref('sampler', v)),
      },
      fb: { cbufs: Array.from(s.fb.cbufs, (v) => ref('surface', v)), zs: ref('surface', s.fb.zs) },
      viewport: structuredClone(s.viewport),
      scissor: { ...s.scissor },
      stencilRef: [...s.stencilRef],
      blendColor: [...s.blendColor],
      stipple: [...s.stipple],
      sampleMask: s.sampleMask,
      so: { targets: Array.from(s.so.targets, (v) => ref('so', v)), seen: [...s.so.seen] },
      longShader: [...s.longShader].map(([type, l]) => [type, { handle: l.handle, shader: ref('shader', l.shader)! }]),
    };
  }

  /** An object's value as data (no GL objects). */
  private saveValue(o: Obj, c: Ctx): unknown {
    switch (o.kind) {
      case 'shader':
        return {
          type: o.v.type,
          text: o.v.text,
          expected: o.v.expected,
          so: o.v.so,
          done: o.v.tgsi !== undefined || o.v.error !== undefined,
        };
      case 'sampler': {
        const { sampler, ...v } = o.v;
        return structuredClone(v);
      }
      case 'query':
        return {
          type: o.v.type,
          index: o.v.index,
          res: o.v.res,
          offset: o.v.offset,
          result: o.v.result,
          active: !!o.v.active,
          counting: this.counting.get(o.v) === c.id,
        };
      default:
        return structuredClone(o.v);
    }
  }

  private loadSub(ss: SavedSub, c: Ctx): Sub {
    const s = this.newSub(ss.id);
    const values: Obj[] = ss.objects.map((so) => this.loadValue(so, c));
    ss.objects.forEach((so, k) => {
      if (so.handle) s.objects.set(so.handle, values[k]);
    });
    for (const o of values) if (o.kind === 'query' && o.v.spans) s.occlusion.add(o.v);
    const v = <K extends Obj['kind']>(k: number | null, kind: K) => {
      const o = k === null ? undefined : values[k];
      return o?.kind === kind ? (o.v as Extract<Obj, { kind: K }>['v']) : undefined;
    };
    s.shaders = { vs: v(ss.shaders.vs, 'shader'), fs: v(ss.shaders.fs, 'shader') };
    [s.blend, s.dsa, s.rs, s.ve] = [v(ss.blend, 'blend'), v(ss.dsa, 'dsa'), v(ss.rs, 'rs'), v(ss.ve, 've')];
    s.vbs = ss.vbs;
    s.ib = ss.ib;
    s.consts = { vs: Uint32Array.from(ss.consts.vs), fs: Uint32Array.from(ss.consts.fs) };
    s.ubos = { vs: new Map(ss.ubos.vs), fs: new Map(ss.ubos.fs) };
    s.views = { vs: ss.views.vs.map((k) => v(k, 'view')), fs: ss.views.fs.map((k) => v(k, 'view')) };
    s.samplers = { vs: ss.samplers.vs.map((k) => v(k, 'sampler')), fs: ss.samplers.fs.map((k) => v(k, 'sampler')) };
    s.fb = { cbufs: ss.fb.cbufs.map((k) => v(k, 'surface')), zs: v(ss.fb.zs, 'surface') };
    s.viewport = ss.viewport;
    s.scissor = ss.scissor;
    s.stencilRef = ss.stencilRef;
    s.blendColor = ss.blendColor;
    s.stipple = Uint32Array.from(ss.stipple);
    s.sampleMask = ss.sampleMask;
    s.so = { targets: ss.so.targets.map((k) => v(k, 'so')), seen: new Set(ss.so.seen) };
    s.longShader = new Map(
      ss.longShader.map(([type, l]) => [type, { handle: l.handle, shader: v(l.shader, 'shader')! }]),
    );
    return s;
  }

  private loadValue(so: SavedObject, c: Ctx): Obj {
    const v = so.v as Record<string, unknown>;
    switch (so.kind) {
      case 'shader': {
        const sh: Shader = {
          serial: ++this.serial,
          type: v.type as number,
          text: v.text as string,
          expected: v.expected as number,
          so: v.so as Shader['so'],
        };
        if (v.done) this.finishShader(sh);
        return { kind: 'shader', v: sh };
      }
      case 'query': {
        const q: Query = {
          type: v.type as number,
          index: v.index as number,
          res: v.res as number,
          offset: v.offset as number,
          result: v.result as number,
        };
        if (v.counting) this.counting.set(q, c.id);
        // Active, an occlusion query counts what its sub-context draws from here on (`loadSub` adds it there; its count
        // before the snapshot is a draw's "any samples passed").
        if (v.active && OCCLUSION.has(q.type)) q.spans = [];
        q.active = !!v.active;
        return { kind: 'query', v: q };
      }
      default:
        return { kind: so.kind, v: structuredClone(so.v) } as Obj;
    }
  }

  /** Reads a 2D resource's RGBA as stored (rows top first), for tests and screenshots. */
  /** A resource's format (virgl's) and size, if it exists. */
  resourceInfo(id: number): { format: number; width: number; height: number } | undefined {
    const r = this.resources.get(id);
    return r && { format: r.format, width: r.width, height: r.height };
  }

  readResource(id: number): Uint8Array | null {
    const r = this.resources.get(id);
    if (!r) return null;
    return this.readback(r, 0, { x: 0, y: 0, z: 0, w: r.width, h: r.height, d: 1 }, 0, 0, this.hostReader(r));
  }

  /** How the host reads a resource for itself: also the formats the guest isn't told it can read back. */
  private hostReader(r: Res) {
    return r.fmt && (readbackOf(r.fmt, this.colorBufferFloat) ?? snapshotReader(r.fmt, this.colorBufferFloat));
  }
}

/**
 * Whether ANGLE's D3D11 backend gave up on a program's HLSL, from the program's log. Its compiler tries each shader
 * with default flags, then skipping validation, then skipping optimization; each failure logs the compiler's errors
 * and "Warning: D3D shader compilation failed with <flags> flags. (<profile>)", then " Retrying with <next>" while one
 * is left. A series that ends in a failure (no retry after it) gave up; one whose retry compiled (fxc's internal
 * errors on dEQP-GLES3's mediump atan2, whose program then draws right) didn't. Errors without that series: given up.
 */
export function d3dRefused(log: string): boolean {
  const failures = [
    ...log.matchAll(/Warning: D3D shader compilation failed with [^\n]*? flags\. \([^)\n]*\)(\n Retrying with )?/g),
  ];
  if (!failures.length) return /\berror X\d{4}/.test(log);
  return failures.some((m) => !m[1]);
}
