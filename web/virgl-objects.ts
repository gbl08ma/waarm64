// The virgl renderer's state model (web/virgl-renderer.ts): resources and their guest backing, the objects a
// sub-context owns (shaders, blend, depth-stencil-alpha and rasterizer states, vertex elements, sampler views and states,
// surfaces, queries, stream-output targets), contexts, and the shapes a snapshot saves them as.
import type { Segment } from './ram.ts';
import type { Format } from './virgl-formats.ts';
import type { ProgramKey, ProgramLayout, Tgsi } from './virgl-tgsi.ts';
import type { VideoContext } from './virgl-video.ts';

/** A resource's guest pages: offsets into guest RAM and lengths. */
/** A resource's guest pages: segments of guest RAM (memory, offset, length; web/devices.ts `Segment`). */
export type Backing = Segment[];

export type ResourceDesc = {
  id: number;
  target: number;
  format: number;
  bind: number;
  width: number;
  height: number;
  depth: number;
  arraySize: number;
  lastLevel: number;
  samples: number;
  flags: number;
};

export type Box = { x: number; y: number; z: number; w: number; h: number; d: number };

export type Res = ResourceDesc & {
  fmt?: Format;
  backing: Backing | null;
  /** A buffer: its GL buffer (ARRAY_BUFFER and the like), its CPU copy, and an element-array twin made on demand. */
  buf?: WebGLBuffer;
  shadow?: Uint8Array;
  ibuf?: WebGLBuffer;
  /** The bytes `[ilo, ihi)` of `shadow` written since `ibuf` last had them (none: `ihi` 0); `ibuf` holds the rest. */
  ilo?: number;
  ihi?: number;
  /** Whether ranges of an index buffer hold the type's largest index (`holdsMax`), by offset, count and size. */
  imax?: Map<string, boolean>;
  /** A texture (or a renderbuffer, multisampled or stencil-only). */
  tex?: WebGLTexture;
  glTarget?: number;
  rb?: WebGLRenderbuffer;
  /** A multisampled resource sampled: its resolved texture, made again at each draw that samples it. */
  msResolved?: Res;
  /** A texture sampled by a draw into it: the copy it is sampled from, made again at each such draw (`feedbackCopies`). */
  feedback?: Res;
  /**
   * A video plane whose decoded picture is smaller than it (the plane is whole blocks: 864 wide for an 854-wide video):
   * the picture alone, what draws sample. A player imports the plane at the picture's size, and virgl's import doesn't
   * reach the host, so sampling the whole plane showed its padding at the edge. Dropped when anything else writes the
   * plane (`writePicture`).
   */
  picture?: Res;
  /** A format WebGL can't render to (so no framebuffer reads it): its uploaded texels by level, for copies from it. */
  texels?: Map<number, Uint8Array>;
  /** A compressed format (nothing reads it back): its uploaded blocks by level, every layer, for a snapshot. */
  blocks?: Map<number, Uint8Array>;
  /** Contexts holding it (unref'd by the guest while attached somewhere: the GL objects live until the last goes). */
  refs: Set<number>;
  dead?: boolean;
  /** Another renderer's blob, typed by the guest (`ExternalResource`): its texture holds that renderer's bytes. */
  external?: true;
  /** An external resource's first plane's stride, as the guest typed it. */
  stride?: number;
};

/**
 * A blob resource of another renderer (Venus's: a Vulkan program's WSI image, docs/devices.md "Venus") that the guest's
 * compositor imported (a dma-buf) and typed (PIPE_RESOURCE_SET_TYPE): a texture of the format and size the guest said,
 * whose bytes the other renderer writes (`ExternalSource`, `VirglRenderer.writeExternal`).
 */
/** `stride`: the bytes between rows of the guest's import (its first plane's; 0 if it didn't say): a prime blit's buffer is read with it. */
export type ExternalResource = {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  readonly format: number;
  readonly stride?: number;
  readonly dead?: boolean;
};

/** Where external resources' bytes come from (web/venus-share.ts). */
export type ExternalSource = {
  /** Whether `id` is one of its blobs (the guest may type it). */
  has(id: number): boolean;
  /** At the start of a submit of a context it is attached to: its bytes written again if they changed. */
  refresh(r: ExternalResource): void;
};

export type Blend = {
  independent: boolean;
  logicop: boolean;
  alphaToCoverage: boolean;
  rt: {
    enable: boolean;
    rgbFunc: number;
    rgbSrc: number;
    rgbDst: number;
    aFunc: number;
    aSrc: number;
    aDst: number;
    mask: number;
  }[];
};

export type Dsa = {
  depth: { enabled: boolean; write: boolean; func: number };
  alpha: { enabled: boolean; func: number; ref: number };
  stencil: {
    enabled: boolean;
    func: number;
    fail: number;
    zpass: number;
    zfail: number;
    valueMask: number;
    writeMask: number;
  }[];
};

export type Rasterizer = {
  flatshade: boolean;
  depthClip: boolean;
  clipHalfz: boolean;
  discard: boolean;
  lightTwoSide: boolean;
  spriteUpperLeft: boolean;
  pointQuad: boolean;
  cullFace: number;
  scissor: boolean;
  frontCcw: boolean;
  clampFragmentColor: boolean;
  offsetTri: boolean;
  stipple: boolean;
  pointSizePerVertex: boolean;
  multisample: boolean;
  pointSize: number;
  spriteCoordEnable: number;
  lineWidth: number;
  offsetUnits: number;
  offsetScale: number;
};

export type Shader = {
  serial: number;
  type: number;
  tgsi?: Tgsi;
  error?: string;
  text: string;
  expected: number;
  so?: { strides: number[]; outputs: { reg: number; start: number; comps: number; buffer: number; offset: number }[] };
  /** As a draw's vertex shader: its programs, by fragment shader, then by the draw state's id (`DrawState`); null: one that failed. */
  programs?: Map<Shader, Map<number, Program | null>>;
  /** As a draw's fragment shader: the vertex shaders that have programs with it. */
  pairs?: Set<Shader>;
};

export type VertexElements = { offset: number; divisor: number; vb: number; format: number }[];

export type SamplerView = {
  res: number;
  format: number;
  target: number;
  first: number;
  last: number;
  firstLevel: number;
  lastLevel: number;
  swizzle: number[];
};

export type SamplerState = {
  wrap: number[];
  minImg: number;
  minMip: number;
  magImg: number;
  compare: boolean;
  compareFunc: number;
  maxAniso: number;
  lodBias: number;
  minLod: number;
  maxLod: number;
  sampler?: WebGLSampler;
};

export type Surface = { res: number; format: number; level: number; firstLayer: number; lastLayer: number };

export type Query = {
  type: number;
  index: number;
  res: number;
  offset: number;
  pending?: boolean;
  result: number;
  /** Begun and not ended. */ active?: boolean;
  /** An occlusion query's spans: the WebGL queries that counted its sub-context's draws while it was active (`countQueries`). */
  spans?: Span[];
  /** Whether a span already read passed (`foldSpans`: a query left active keeps few spans). */
  passed?: boolean;
};

/**
 * A WebGL query counting one sub-context's draws for the occlusion queries active in it then (`users` of them share
 * it); `lost`: WebGL will never answer it.
 */
export type Span = { q: WebGLQuery; done: boolean; passed: boolean; users: number; lost?: boolean };

/** A stream output target: a buffer's range, and the bytes written into it since it was last bound without append. */
export type SoTarget = { res: number; offset: number; size: number; filled: number };

export type SoOutput = NonNullable<Shader['so']>['outputs'][number];

/**
 * How a draw's stream output goes to WebGL2: every output captured interleaved, as bits, into one scratch buffer
 * (`total` words a vertex, in `outputs`' order), then scattered into its target at its offset (`targets`: each buffer
 * index used, its stride in words). GLES 3.0's own layouts (one buffer packed, or one output a buffer, a few words
 * each) can't express Gallium's (several outputs a buffer, several buffers, gaps).
 */
export type SoPlan = {
  outputs: SoOutput[];
  total: number;
  targets: { buffer: number; t: SoTarget; r: Res; stride: number }[];
};

export type Obj =
  | { kind: 'blend'; v: Blend }
  | { kind: 'dsa'; v: Dsa }
  | { kind: 'rs'; v: Rasterizer }
  | { kind: 'shader'; v: Shader }
  | { kind: 've'; v: VertexElements }
  | { kind: 'view'; v: SamplerView }
  | { kind: 'sampler'; v: SamplerState }
  | { kind: 'surface'; v: Surface }
  | { kind: 'query'; v: Query }
  | { kind: 'so'; v: SoTarget };

export type Stage = 'vs' | 'fs';

export type Sub = {
  id: number;
  objects: Map<number, Obj>;
  shaders: { vs?: Shader; fs?: Shader };
  blend?: Blend;
  dsa?: Dsa;
  rs?: Rasterizer;
  ve?: VertexElements;
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
  /** What `vao` has (the draws set it, and nothing else does): the attributes enabled, as bits, and each one's pointer
   * (its buffer, then six numbers at 6k of `ptr`: size, type, normalized, stride, offset and integer-ness; NaN: never
   * set) and divisor, as the last draw left them. */
  vaoState?: { on: number; buf: (WebGLBuffer | null)[]; ptr: Float64Array; divisor: number[] };
  /** A long shader arriving in pieces (VIRGL_OBJ_SHADER_OFFSET_CONT), by stage. */
  longShader: Map<number, { handle: number; shader: Shader }>;
  /** The occlusion queries begun and not ended. */
  occlusion: Set<Query>;
};

export type Ctx = { id: number; subs: Map<number, Sub>; sub: Sub; attached: Set<number>; video?: VideoContext };

/** A resource's level in a snapshot: bytes as an upload takes them (every layer), or every depth (floats) then every stencil byte (`zs`). */
export type SavedLevel = { level: number; how: 'bytes' | 'zs'; data: Uint8Array };

/** A resource in a snapshot; `lost`: what of its contents couldn't be read back (they load as zeros). */
export type SavedResource = { desc: ResourceDesc; backing: Backing | null; levels: SavedLevel[]; lost?: string };

export type SavedObject = { handle: number; kind: Obj['kind']; v: unknown };

/** A sub-context in a snapshot: its objects, and its bound state naming them by their place in `objects` (null: none). */
export type SavedSub = {
  id: number;
  objects: SavedObject[];
  shaders: { vs: number | null; fs: number | null };
  blend: number | null;
  dsa: number | null;
  rs: number | null;
  ve: number | null;
  vbs: Sub['vbs'];
  ib: Sub['ib'];
  consts: Record<Stage, number[]>;
  ubos: Record<Stage, [number, { res: number; offset: number; length: number }][]>;
  views: Record<Stage, (number | null)[]>;
  samplers: Record<Stage, (number | null)[]>;
  fb: { cbufs: (number | null)[]; zs: number | null };
  viewport: Sub['viewport'];
  scissor: Sub['scissor'];
  stencilRef: [number, number];
  blendColor: number[];
  stipple: number[];
  sampleMask: number;
  so: { targets: (number | null)[]; seen: string[] };
  longShader: [number, { handle: number; shader: number }][];
};

/** A context in a snapshot: its sub-contexts, the current one, the resources attached. */
export type SavedContext = { id: number; sub: number; attached: number[]; subs: SavedSub[] };

/** What `VirglRenderer.save` gives and `load` takes: JSON, but for the contents (`SavedLevel.data`). */
export type RendererSnapshot = { version: 1; resources: SavedResource[]; contexts: SavedContext[] };

/**
 * What a draw's program is chosen by, besides its shaders: the signature (the ids of the key's parts, as
 * `VirglRenderer.signature` lays them out), the key made from it, and an id (equal signatures have one state).
 */
export type DrawState = { id: number; sig: Int32Array; key: ProgramKey };

export type Program = {
  prog: WebGLProgram;
  layout: ProgramLayout;
  loc: Map<string, WebGLUniformLocation | null>;
  /** The values the draws gave its uniforms, by name (only the draws set them; arrays as their words' bits): a value already set isn't set again. */
  set?: Map<string, number | Uint32Array>;
};
