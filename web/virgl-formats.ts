// virgl's formats (virgl_hw.h `enum virgl_formats`, Gallium's) on WebGL2: what each is stored as, how it is sampled
// and written, and what it needs from the browser. The table follows virglrenderer's vrend_formats.c on a GLES host
// (MIT, THIRD_PARTY.json), with WebGL2's own rules: no BGRA formats and no texture swizzle, so a format whose bytes
// aren't RGBA order is stored as its bytes are (an RGBA8 texture holding B, G, R, A) and the generated shaders
// swizzle, on sampling and on rendering (docs/graphics.md "Resources and formats"). Gallium names 8-bit formats in memory order:
// B8G8R8A8's first byte is B.

/** WebGL2's enums (no WebGL2RenderingContext in Node). */
export const GL = {
  BYTE: 0x1400,
  UNSIGNED_BYTE: 0x1401,
  SHORT: 0x1402,
  UNSIGNED_SHORT: 0x1403,
  INT: 0x1404,
  UNSIGNED_INT: 0x1405,
  FLOAT: 0x1406,
  HALF_FLOAT: 0x140b,
  DEPTH_COMPONENT: 0x1902,
  RED: 0x1903,
  ALPHA: 0x1906,
  RGB: 0x1907,
  RGBA: 0x1908,
  UNSIGNED_SHORT_4_4_4_4: 0x8033,
  UNSIGNED_SHORT_5_5_5_1: 0x8034,
  UNSIGNED_SHORT_5_6_5: 0x8363,
  UNSIGNED_INT_2_10_10_10_REV: 0x8368,
  UNSIGNED_INT_24_8: 0x84fa,
  UNSIGNED_INT_10F_11F_11F_REV: 0x8c3b,
  UNSIGNED_INT_5_9_9_9_REV: 0x8c3e,
  FLOAT_32_UNSIGNED_INT_24_8_REV: 0x8dad,
  RG: 0x8227,
  RG_INTEGER: 0x8228,
  RED_INTEGER: 0x8d94,
  RGB_INTEGER: 0x8d98,
  RGBA_INTEGER: 0x8d99,
  DEPTH_STENCIL: 0x84f9,
  RGB8: 0x8051,
  RGBA4: 0x8056,
  RGB5_A1: 0x8057,
  RGBA8: 0x8058,
  RGB10_A2: 0x8059,
  RGB565: 0x8d62,
  SRGB8_ALPHA8: 0x8c43,
  R8: 0x8229,
  RG8: 0x822b,
  R16F: 0x822d,
  R32F: 0x822e,
  RG16F: 0x822f,
  RG32F: 0x8230,
  RGBA32F: 0x8814,
  RGB32F: 0x8815,
  RGBA16F: 0x881a,
  R8I: 0x8231,
  R8UI: 0x8232,
  R16I: 0x8233,
  R16UI: 0x8234,
  R32I: 0x8235,
  R32UI: 0x8236,
  RG8I: 0x8237,
  RG8UI: 0x8238,
  RG16I: 0x8239,
  RG16UI: 0x823a,
  RG32I: 0x823b,
  RG32UI: 0x823c,
  RGBA32UI: 0x8d70,
  RGB32UI: 0x8d71,
  RGBA16UI: 0x8d76,
  RGBA8UI: 0x8d7c,
  RGBA32I: 0x8d82,
  RGB32I: 0x8d83,
  RGBA16I: 0x8d88,
  RGBA8I: 0x8d8e,
  RGB10_A2UI: 0x906f,
  R8_SNORM: 0x8f94,
  RG8_SNORM: 0x8f95,
  RGBA8_SNORM: 0x8f97,
  R11F_G11F_B10F: 0x8c3a,
  RGB9_E5: 0x8c3d,
  R16_EXT: 0x822a,
  RG16_EXT: 0x822c,
  RGBA16_EXT: 0x805b,
  R16_SNORM_EXT: 0x8f98,
  RG16_SNORM_EXT: 0x8f99,
  RGBA16_SNORM_EXT: 0x8f9b,
  DEPTH_COMPONENT16: 0x81a5,
  DEPTH_COMPONENT24: 0x81a6,
  DEPTH_COMPONENT32F: 0x8cac,
  DEPTH24_STENCIL8: 0x88f0,
  DEPTH32F_STENCIL8: 0x8cad,
  STENCIL_INDEX8: 0x8d48,
  COMPRESSED_RGB_S3TC_DXT1: 0x83f0,
  COMPRESSED_RGBA_S3TC_DXT1: 0x83f1,
  COMPRESSED_RGBA_S3TC_DXT3: 0x83f2,
  COMPRESSED_RGBA_S3TC_DXT5: 0x83f3,
  COMPRESSED_SRGB_S3TC_DXT1: 0x8c4c,
  COMPRESSED_SRGB_ALPHA_S3TC_DXT1: 0x8c4d,
  COMPRESSED_SRGB_ALPHA_S3TC_DXT3: 0x8c4e,
  COMPRESSED_SRGB_ALPHA_S3TC_DXT5: 0x8c4f,
  COMPRESSED_R11_EAC: 0x9270,
  COMPRESSED_SIGNED_R11_EAC: 0x9271,
  COMPRESSED_RG11_EAC: 0x9272,
  COMPRESSED_SIGNED_RG11_EAC: 0x9273,
  COMPRESSED_RGB8_ETC2: 0x9274,
  COMPRESSED_SRGB8_ETC2: 0x9275,
  COMPRESSED_RGB8_PUNCHTHROUGH_ALPHA1_ETC2: 0x9276,
  COMPRESSED_SRGB8_PUNCHTHROUGH_ALPHA1_ETC2: 0x9277,
  COMPRESSED_RGBA8_ETC2_EAC: 0x9278,
  COMPRESSED_SRGB8_ALPHA8_ETC2_EAC: 0x9279,
  COMPRESSED_RED_RGTC1: 0x8dbb,
  COMPRESSED_SIGNED_RED_RGTC1: 0x8dbc,
  COMPRESSED_RG_RGTC2: 0x8dbd,
  COMPRESSED_SIGNED_RG_RGTC2: 0x8dbe,
  COMPRESSED_RGBA_BPTC_UNORM: 0x8e8c,
  COMPRESSED_SRGB_ALPHA_BPTC_UNORM: 0x8e8d,
  COMPRESSED_RGB_BPTC_SIGNED_FLOAT: 0x8e8e,
  COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT: 0x8e8f,
} as const;

/**
 * Where a sampled channel comes from: a component of the stored texel (0–3), or the constants 0 and 1. A format's
 * `sample` gives R, G, B, A in this form; Gallium's sampler-view swizzles (PIPE_SWIZZLE_*) are the same numbers.
 */
export const SW_0 = 4,
  SW_1 = 5;

export type FormatKind = 'unorm' | 'snorm' | 'uint' | 'sint' | 'float' | 'depth' | 'stencil' | 'depthstencil';

export type Format = {
  id: number;
  name: string;
  /** Bytes per pixel, or per block for a compressed format (`block` > 1). */
  bpp: number;
  /** A compressed format's block size (4: 4×4 blocks). */
  block: number;
  internal: number;
  format: number;
  type: number;
  kind: FormatKind;
  /** R, G, B, A when sampled: stored components or SW_0/SW_1 (`[0, 1, 2, 3]` is plain RGBA). */
  sample: readonly number[];
  /**
   * What each stored component receives when rendered to: a logical channel (0–3) of the shader's output, or -1 for
   * none (the X in an X format: alpha written as it comes, sampled as 1). Undefined: the format isn't a render target.
   */
  write?: readonly number[];
  /** An X format: alpha is 1 whatever is stored (a blend reading the destination's alpha reads 1). */
  x?: boolean;
  srgb?: boolean;
  /** WebGL2 extensions needed to sample it (any one of them), to render to it, and to filter it linearly. */
  needs?: string[];
  renderNeeds?: string[];
  /** A float format, filtered linearly only with OES_texture_float_linear (32-bit). */
  float32?: boolean;
};

const ID = [0, 1, 2, 3] as const;
const RGB1 = [0, 1, 2, SW_1] as const;
const BGRA = [2, 1, 0, 3] as const;
const BGR1 = [2, 1, 0, SW_1] as const;
const ARGB = [1, 2, 3, 0] as const; // memory A, R, G, B: R is the second byte
const XRGB = [1, 2, 3, SW_1] as const;
const ABGR = [3, 2, 1, 0] as const;
const XBGR = [3, 2, 1, SW_1] as const;
const R001 = [0, SW_0, SW_0, SW_1] as const;
const RG01 = [0, 1, SW_0, SW_1] as const;
const RRR1 = [0, 0, 0, SW_1] as const;
const RRRR = [0, 0, 0, 0] as const;
const OOOR = [SW_0, SW_0, SW_0, 0] as const;
const RRRG = [0, 0, 0, 1] as const;

/**
 * For a stored component, the logical channel the shader writes to it: the inverse of `sample` (components no channel
 * lands in get -1). An X format's unused component gets the logical alpha: its bytes are don't-care (sampling reads 1),
 * but blending reads the fragment's own alpha, which a constant 1 there would replace (Firefox's menus, translucent at
 * their edges, blended onto sway's B8G8R8X8 output, came out with black borders).
 */
function writeOf(sample: readonly number[], comps: number) {
  const w = Array.from({ length: comps }, () => -1);
  sample.forEach((s, c) => {
    if (s < 4 && w[s] === -1 && !(c === 3 && sample[3] === SW_1)) w[s] = c;
  });
  // A luminance or intensity format replicated R: the stored R is the logical R.
  if (sample[3] === SW_1 && comps === 4 && !w.includes(3)) {
    const x = w.indexOf(-1);
    if (x >= 0) w[x] = 3;
  }
  return w;
}

type Row = [
  id: number,
  name: string,
  bpp: number,
  internal: number,
  format: number,
  type: number,
  kind: FormatKind,
  sample: readonly number[],
  extra?: Partial<Format> & { render?: boolean; comps?: number },
];

const ROWS: Row[] = [
  // 8-bit RGBA family, stored as their bytes are (no BGRA in WebGL2), swizzled in the shaders.
  [67, 'R8G8B8A8_UNORM', 4, GL.RGBA8, GL.RGBA, GL.UNSIGNED_BYTE, 'unorm', ID, { render: true }],
  [134, 'R8G8B8X8_UNORM', 4, GL.RGBA8, GL.RGBA, GL.UNSIGNED_BYTE, 'unorm', RGB1, { render: true, x: true }],
  [1, 'B8G8R8A8_UNORM', 4, GL.RGBA8, GL.RGBA, GL.UNSIGNED_BYTE, 'unorm', BGRA, { render: true }],
  [2, 'B8G8R8X8_UNORM', 4, GL.RGBA8, GL.RGBA, GL.UNSIGNED_BYTE, 'unorm', BGR1, { render: true, x: true }],
  [3, 'A8R8G8B8_UNORM', 4, GL.RGBA8, GL.RGBA, GL.UNSIGNED_BYTE, 'unorm', ARGB, { render: true }],
  [4, 'X8R8G8B8_UNORM', 4, GL.RGBA8, GL.RGBA, GL.UNSIGNED_BYTE, 'unorm', XRGB, { render: true, x: true }],
  [121, 'A8B8G8R8_UNORM', 4, GL.RGBA8, GL.RGBA, GL.UNSIGNED_BYTE, 'unorm', ABGR, { render: true }],
  [68, 'X8B8G8R8_UNORM', 4, GL.RGBA8, GL.RGBA, GL.UNSIGNED_BYTE, 'unorm', XBGR, { render: true, x: true }],
  [104, 'R8G8B8A8_SRGB', 4, GL.SRGB8_ALPHA8, GL.RGBA, GL.UNSIGNED_BYTE, 'unorm', ID, { render: true, srgb: true }],
  [
    230,
    'R8G8B8X8_SRGB',
    4,
    GL.SRGB8_ALPHA8,
    GL.RGBA,
    GL.UNSIGNED_BYTE,
    'unorm',
    RGB1,
    { render: true, srgb: true, x: true },
  ],
  [100, 'B8G8R8A8_SRGB', 4, GL.SRGB8_ALPHA8, GL.RGBA, GL.UNSIGNED_BYTE, 'unorm', BGRA, { render: true, srgb: true }],
  [
    101,
    'B8G8R8X8_SRGB',
    4,
    GL.SRGB8_ALPHA8,
    GL.RGBA,
    GL.UNSIGNED_BYTE,
    'unorm',
    BGR1,
    { render: true, srgb: true, x: true },
  ],
  [77, 'R8G8B8A8_SNORM', 4, GL.RGBA8_SNORM, GL.RGBA, GL.BYTE, 'snorm', ID],
  [229, 'R8G8B8X8_SNORM', 4, GL.RGBA8_SNORM, GL.RGBA, GL.BYTE, 'snorm', RGB1, { x: true }],
  [180, 'R8G8B8A8_UINT', 4, GL.RGBA8UI, GL.RGBA_INTEGER, GL.UNSIGNED_BYTE, 'uint', ID, { render: true }],
  [184, 'R8G8B8A8_SINT', 4, GL.RGBA8I, GL.RGBA_INTEGER, GL.BYTE, 'sint', ID, { render: true }],
  [231, 'R8G8B8X8_UINT', 4, GL.RGBA8UI, GL.RGBA_INTEGER, GL.UNSIGNED_BYTE, 'uint', RGB1, { render: true, x: true }],
  [232, 'R8G8B8X8_SINT', 4, GL.RGBA8I, GL.RGBA_INTEGER, GL.BYTE, 'sint', RGB1, { render: true, x: true }],
  // One and two channels.
  [64, 'R8_UNORM', 1, GL.R8, GL.RED, GL.UNSIGNED_BYTE, 'unorm', R001, { render: true, comps: 1 }],
  [65, 'R8G8_UNORM', 2, GL.RG8, GL.RG, GL.UNSIGNED_BYTE, 'unorm', RG01, { render: true, comps: 2 }],
  [74, 'R8_SNORM', 1, GL.R8_SNORM, GL.RED, GL.BYTE, 'snorm', R001, { comps: 1 }],
  [75, 'R8G8_SNORM', 2, GL.RG8_SNORM, GL.RG, GL.BYTE, 'snorm', RG01, { comps: 2 }],
  [9, 'L8_UNORM', 1, GL.R8, GL.RED, GL.UNSIGNED_BYTE, 'unorm', RRR1, { render: true, comps: 1 }],
  [10, 'A8_UNORM', 1, GL.R8, GL.RED, GL.UNSIGNED_BYTE, 'unorm', OOOR, { render: true, comps: 1 }],
  [11, 'I8_UNORM', 1, GL.R8, GL.RED, GL.UNSIGNED_BYTE, 'unorm', RRRR, { render: true, comps: 1 }],
  [12, 'L8A8_UNORM', 2, GL.RG8, GL.RG, GL.UNSIGNED_BYTE, 'unorm', RRRG, { render: true, comps: 2 }],
  [148, 'L8_SNORM', 1, GL.R8_SNORM, GL.RED, GL.BYTE, 'snorm', RRR1, { comps: 1 }],
  [177, 'R8_UINT', 1, GL.R8UI, GL.RED_INTEGER, GL.UNSIGNED_BYTE, 'uint', R001, { render: true, comps: 1 }],
  [178, 'R8G8_UINT', 2, GL.RG8UI, GL.RG_INTEGER, GL.UNSIGNED_BYTE, 'uint', RG01, { render: true, comps: 2 }],
  [181, 'R8_SINT', 1, GL.R8I, GL.RED_INTEGER, GL.BYTE, 'sint', R001, { render: true, comps: 1 }],
  [182, 'R8G8_SINT', 2, GL.RG8I, GL.RG_INTEGER, GL.BYTE, 'sint', RG01, { render: true, comps: 2 }],
  [185, 'R16_UINT', 2, GL.R16UI, GL.RED_INTEGER, GL.UNSIGNED_SHORT, 'uint', R001, { render: true, comps: 1 }],
  [186, 'R16G16_UINT', 4, GL.RG16UI, GL.RG_INTEGER, GL.UNSIGNED_SHORT, 'uint', RG01, { render: true, comps: 2 }],
  [188, 'R16G16B16A16_UINT', 8, GL.RGBA16UI, GL.RGBA_INTEGER, GL.UNSIGNED_SHORT, 'uint', ID, { render: true }],
  [189, 'R16_SINT', 2, GL.R16I, GL.RED_INTEGER, GL.SHORT, 'sint', R001, { render: true, comps: 1 }],
  [190, 'R16G16_SINT', 4, GL.RG16I, GL.RG_INTEGER, GL.SHORT, 'sint', RG01, { render: true, comps: 2 }],
  [192, 'R16G16B16A16_SINT', 8, GL.RGBA16I, GL.RGBA_INTEGER, GL.SHORT, 'sint', ID, { render: true }],
  [193, 'R32_UINT', 4, GL.R32UI, GL.RED_INTEGER, GL.UNSIGNED_INT, 'uint', R001, { render: true, comps: 1 }],
  [194, 'R32G32_UINT', 8, GL.RG32UI, GL.RG_INTEGER, GL.UNSIGNED_INT, 'uint', RG01, { render: true, comps: 2 }],
  [195, 'R32G32B32_UINT', 12, GL.RGB32UI, GL.RGB_INTEGER, GL.UNSIGNED_INT, 'uint', RGB1, { comps: 3 }],
  [196, 'R32G32B32A32_UINT', 16, GL.RGBA32UI, GL.RGBA_INTEGER, GL.UNSIGNED_INT, 'uint', ID, { render: true }],
  [197, 'R32_SINT', 4, GL.R32I, GL.RED_INTEGER, GL.INT, 'sint', R001, { render: true, comps: 1 }],
  [198, 'R32G32_SINT', 8, GL.RG32I, GL.RG_INTEGER, GL.INT, 'sint', RG01, { render: true, comps: 2 }],
  [199, 'R32G32B32_SINT', 12, GL.RGB32I, GL.RGB_INTEGER, GL.INT, 'sint', RGB1, { comps: 3 }],
  [200, 'R32G32B32A32_SINT', 16, GL.RGBA32I, GL.RGBA_INTEGER, GL.INT, 'sint', ID, { render: true }],
  [203, 'L8_UINT', 1, GL.R8UI, GL.RED_INTEGER, GL.UNSIGNED_BYTE, 'uint', RRR1, { comps: 1 }],
  [207, 'L8_SINT', 1, GL.R8I, GL.RED_INTEGER, GL.BYTE, 'sint', RRR1, { comps: 1 }],
  [201, 'A8_UINT', 1, GL.R8UI, GL.RED_INTEGER, GL.UNSIGNED_BYTE, 'uint', OOOR, { comps: 1 }],
  [205, 'A8_SINT', 1, GL.R8I, GL.RED_INTEGER, GL.BYTE, 'sint', OOOR, { comps: 1 }],
  // 16-bit normalized: an extension in WebGL2.
  [
    48,
    'R16_UNORM',
    2,
    GL.R16_EXT,
    GL.RED,
    GL.UNSIGNED_SHORT,
    'unorm',
    R001,
    { comps: 1, needs: ['EXT_texture_norm16'], render: true },
  ],
  [
    49,
    'R16G16_UNORM',
    4,
    GL.RG16_EXT,
    GL.RG,
    GL.UNSIGNED_SHORT,
    'unorm',
    RG01,
    { comps: 2, needs: ['EXT_texture_norm16'], render: true },
  ],
  [
    51,
    'R16G16B16A16_UNORM',
    8,
    GL.RGBA16_EXT,
    GL.RGBA,
    GL.UNSIGNED_SHORT,
    'unorm',
    ID,
    { needs: ['EXT_texture_norm16'], render: true },
  ],
  [
    234,
    'R16G16B16X16_UNORM',
    8,
    GL.RGBA16_EXT,
    GL.RGBA,
    GL.UNSIGNED_SHORT,
    'unorm',
    RGB1,
    { needs: ['EXT_texture_norm16'], render: true, x: true },
  ],
  [
    13,
    'L16_UNORM',
    2,
    GL.R16_EXT,
    GL.RED,
    GL.UNSIGNED_SHORT,
    'unorm',
    RRR1,
    { comps: 1, needs: ['EXT_texture_norm16'] },
  ],
  [
    141,
    'A16_UNORM',
    2,
    GL.R16_EXT,
    GL.RED,
    GL.UNSIGNED_SHORT,
    'unorm',
    OOOR,
    { comps: 1, needs: ['EXT_texture_norm16'] },
  ],
  [56, 'R16_SNORM', 2, GL.R16_SNORM_EXT, GL.RED, GL.SHORT, 'snorm', R001, { comps: 1, needs: ['EXT_texture_norm16'] }],
  [
    57,
    'R16G16_SNORM',
    4,
    GL.RG16_SNORM_EXT,
    GL.RG,
    GL.SHORT,
    'snorm',
    RG01,
    { comps: 2, needs: ['EXT_texture_norm16'] },
  ],
  [59, 'R16G16B16A16_SNORM', 8, GL.RGBA16_SNORM_EXT, GL.RGBA, GL.SHORT, 'snorm', ID, { needs: ['EXT_texture_norm16'] }],
  // Packed.
  [7, 'B5G6R5_UNORM', 2, GL.RGB565, GL.RGB, GL.UNSIGNED_SHORT_5_6_5, 'unorm', RGB1, { render: true, comps: 3 }],
  [311, 'A4B4G4R4_UNORM', 2, GL.RGBA4, GL.RGBA, GL.UNSIGNED_SHORT_4_4_4_4, 'unorm', ID, { render: true }],
  [8, 'R10G10B10A2_UNORM', 4, GL.RGB10_A2, GL.RGBA, GL.UNSIGNED_INT_2_10_10_10_REV, 'unorm', ID, { render: true }],
  [
    308,
    'R10G10B10X2_UNORM',
    4,
    GL.RGB10_A2,
    GL.RGBA,
    GL.UNSIGNED_INT_2_10_10_10_REV,
    'unorm',
    RGB1,
    { render: true, x: true },
  ],
  [131, 'B10G10R10A2_UNORM', 4, GL.RGB10_A2, GL.RGBA, GL.UNSIGNED_INT_2_10_10_10_REV, 'unorm', BGRA, { render: true }],
  [
    233,
    'B10G10R10X2_UNORM',
    4,
    GL.RGB10_A2,
    GL.RGBA,
    GL.UNSIGNED_INT_2_10_10_10_REV,
    'unorm',
    BGR1,
    { render: true, x: true },
  ],
  [
    253,
    'R10G10B10A2_UINT',
    4,
    GL.RGB10_A2UI,
    GL.RGBA_INTEGER,
    GL.UNSIGNED_INT_2_10_10_10_REV,
    'uint',
    ID,
    { render: true },
  ],
  [
    124,
    'R11G11B10_FLOAT',
    4,
    GL.R11F_G11F_B10F,
    GL.RGB,
    GL.UNSIGNED_INT_10F_11F_11F_REV,
    'float',
    RGB1,
    { comps: 3, renderNeeds: ['EXT_color_buffer_float'], render: true },
  ],
  [125, 'R9G9B9E5_FLOAT', 4, GL.RGB9_E5, GL.RGB, GL.UNSIGNED_INT_5_9_9_9_REV, 'float', RGB1, { comps: 3 }],
  // Float.
  [
    91,
    'R16_FLOAT',
    2,
    GL.R16F,
    GL.RED,
    GL.HALF_FLOAT,
    'float',
    R001,
    { comps: 1, renderNeeds: ['EXT_color_buffer_float', 'EXT_color_buffer_half_float'], render: true },
  ],
  [
    92,
    'R16G16_FLOAT',
    4,
    GL.RG16F,
    GL.RG,
    GL.HALF_FLOAT,
    'float',
    RG01,
    { comps: 2, renderNeeds: ['EXT_color_buffer_float', 'EXT_color_buffer_half_float'], render: true },
  ],
  [
    94,
    'R16G16B16A16_FLOAT',
    8,
    GL.RGBA16F,
    GL.RGBA,
    GL.HALF_FLOAT,
    'float',
    ID,
    { renderNeeds: ['EXT_color_buffer_float', 'EXT_color_buffer_half_float'], render: true },
  ],
  [
    236,
    'R16G16B16X16_FLOAT',
    8,
    GL.RGBA16F,
    GL.RGBA,
    GL.HALF_FLOAT,
    'float',
    RGB1,
    { renderNeeds: ['EXT_color_buffer_float', 'EXT_color_buffer_half_float'], render: true, x: true },
  ],
  [156, 'L16_FLOAT', 2, GL.R16F, GL.RED, GL.HALF_FLOAT, 'float', RRR1, { comps: 1 }],
  [
    28,
    'R32_FLOAT',
    4,
    GL.R32F,
    GL.RED,
    GL.FLOAT,
    'float',
    R001,
    { comps: 1, renderNeeds: ['EXT_color_buffer_float'], render: true, float32: true },
  ],
  [
    29,
    'R32G32_FLOAT',
    8,
    GL.RG32F,
    GL.RG,
    GL.FLOAT,
    'float',
    RG01,
    { comps: 2, renderNeeds: ['EXT_color_buffer_float'], render: true, float32: true },
  ],
  [30, 'R32G32B32_FLOAT', 12, GL.RGB32F, GL.RGB, GL.FLOAT, 'float', RGB1, { comps: 3, float32: true }],
  [
    31,
    'R32G32B32A32_FLOAT',
    16,
    GL.RGBA32F,
    GL.RGBA,
    GL.FLOAT,
    'float',
    ID,
    { renderNeeds: ['EXT_color_buffer_float'], render: true, float32: true },
  ],
  [160, 'L32_FLOAT', 4, GL.R32F, GL.RED, GL.FLOAT, 'float', RRR1, { comps: 1, float32: true }],
  // Depth and stencil.
  [16, 'Z16_UNORM', 2, GL.DEPTH_COMPONENT16, GL.DEPTH_COMPONENT, GL.UNSIGNED_SHORT, 'depth', R001, { comps: 1 }],
  [21, 'Z24X8_UNORM', 4, GL.DEPTH_COMPONENT24, GL.DEPTH_COMPONENT, GL.UNSIGNED_INT, 'depth', R001, { comps: 1 }],
  [17, 'Z32_UNORM', 4, GL.DEPTH_COMPONENT24, GL.DEPTH_COMPONENT, GL.UNSIGNED_INT, 'depth', R001, { comps: 1 }],
  [18, 'Z32_FLOAT', 4, GL.DEPTH_COMPONENT32F, GL.DEPTH_COMPONENT, GL.FLOAT, 'depth', R001, { comps: 1 }],
  [
    20,
    'S8_UINT_Z24_UNORM',
    4,
    GL.DEPTH24_STENCIL8,
    GL.DEPTH_STENCIL,
    GL.UNSIGNED_INT_24_8,
    'depthstencil',
    R001,
    { comps: 1 },
  ],
  [
    19,
    'Z24_UNORM_S8_UINT',
    4,
    GL.DEPTH24_STENCIL8,
    GL.DEPTH_STENCIL,
    GL.UNSIGNED_INT_24_8,
    'depthstencil',
    R001,
    { comps: 1 },
  ],
  [
    126,
    'Z32_FLOAT_S8X24_UINT',
    8,
    GL.DEPTH32F_STENCIL8,
    GL.DEPTH_STENCIL,
    GL.FLOAT_32_UNSIGNED_INT_24_8_REV,
    'depthstencil',
    R001,
    { comps: 1 },
  ],
  [23, 'S8_UINT', 1, GL.STENCIL_INDEX8, 0, 0, 'stencil', R001, { comps: 1 }],
  // Compressed: sampled only, where the browser decodes them.
  [
    105,
    'DXT1_RGB',
    8,
    GL.COMPRESSED_RGB_S3TC_DXT1,
    0,
    0,
    'unorm',
    RGB1,
    { block: 4, needs: ['WEBGL_compressed_texture_s3tc'] },
  ],
  [
    106,
    'DXT1_RGBA',
    8,
    GL.COMPRESSED_RGBA_S3TC_DXT1,
    0,
    0,
    'unorm',
    ID,
    { block: 4, needs: ['WEBGL_compressed_texture_s3tc'] },
  ],
  [
    107,
    'DXT3_RGBA',
    16,
    GL.COMPRESSED_RGBA_S3TC_DXT3,
    0,
    0,
    'unorm',
    ID,
    { block: 4, needs: ['WEBGL_compressed_texture_s3tc'] },
  ],
  [
    108,
    'DXT5_RGBA',
    16,
    GL.COMPRESSED_RGBA_S3TC_DXT5,
    0,
    0,
    'unorm',
    ID,
    { block: 4, needs: ['WEBGL_compressed_texture_s3tc'] },
  ],
  [
    109,
    'DXT1_SRGB',
    8,
    GL.COMPRESSED_SRGB_S3TC_DXT1,
    0,
    0,
    'unorm',
    RGB1,
    { block: 4, srgb: true, needs: ['WEBGL_compressed_texture_s3tc_srgb'] },
  ],
  [
    110,
    'DXT1_SRGBA',
    8,
    GL.COMPRESSED_SRGB_ALPHA_S3TC_DXT1,
    0,
    0,
    'unorm',
    ID,
    { block: 4, srgb: true, needs: ['WEBGL_compressed_texture_s3tc_srgb'] },
  ],
  [
    111,
    'DXT3_SRGBA',
    16,
    GL.COMPRESSED_SRGB_ALPHA_S3TC_DXT3,
    0,
    0,
    'unorm',
    ID,
    { block: 4, srgb: true, needs: ['WEBGL_compressed_texture_s3tc_srgb'] },
  ],
  [
    112,
    'DXT5_SRGBA',
    16,
    GL.COMPRESSED_SRGB_ALPHA_S3TC_DXT5,
    0,
    0,
    'unorm',
    ID,
    { block: 4, srgb: true, needs: ['WEBGL_compressed_texture_s3tc_srgb'] },
  ],
  [
    113,
    'RGTC1_UNORM',
    8,
    GL.COMPRESSED_RED_RGTC1,
    0,
    0,
    'unorm',
    R001,
    { block: 4, needs: ['EXT_texture_compression_rgtc'] },
  ],
  [
    114,
    'RGTC1_SNORM',
    8,
    GL.COMPRESSED_SIGNED_RED_RGTC1,
    0,
    0,
    'snorm',
    R001,
    { block: 4, needs: ['EXT_texture_compression_rgtc'] },
  ],
  [
    115,
    'RGTC2_UNORM',
    16,
    GL.COMPRESSED_RG_RGTC2,
    0,
    0,
    'unorm',
    RG01,
    { block: 4, needs: ['EXT_texture_compression_rgtc'] },
  ],
  [
    116,
    'RGTC2_SNORM',
    16,
    GL.COMPRESSED_SIGNED_RG_RGTC2,
    0,
    0,
    'snorm',
    RG01,
    { block: 4, needs: ['EXT_texture_compression_rgtc'] },
  ],
  [
    255,
    'BPTC_RGBA_UNORM',
    16,
    GL.COMPRESSED_RGBA_BPTC_UNORM,
    0,
    0,
    'unorm',
    ID,
    { block: 4, needs: ['EXT_texture_compression_bptc'] },
  ],
  [
    256,
    'BPTC_SRGBA',
    16,
    GL.COMPRESSED_SRGB_ALPHA_BPTC_UNORM,
    0,
    0,
    'unorm',
    ID,
    { block: 4, srgb: true, needs: ['EXT_texture_compression_bptc'] },
  ],
  [
    257,
    'BPTC_RGB_FLOAT',
    16,
    GL.COMPRESSED_RGB_BPTC_SIGNED_FLOAT,
    0,
    0,
    'float',
    RGB1,
    { block: 4, needs: ['EXT_texture_compression_bptc'] },
  ],
  [
    258,
    'BPTC_RGB_UFLOAT',
    16,
    GL.COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT,
    0,
    0,
    'float',
    RGB1,
    { block: 4, needs: ['EXT_texture_compression_bptc'] },
  ],
  [
    269,
    'ETC2_RGB8',
    8,
    GL.COMPRESSED_RGB8_ETC2,
    0,
    0,
    'unorm',
    RGB1,
    { block: 4, needs: ['WEBGL_compressed_texture_etc'] },
  ],
  [
    270,
    'ETC2_SRGB8',
    8,
    GL.COMPRESSED_SRGB8_ETC2,
    0,
    0,
    'unorm',
    RGB1,
    { block: 4, srgb: true, needs: ['WEBGL_compressed_texture_etc'] },
  ],
  [
    271,
    'ETC2_RGB8A1',
    8,
    GL.COMPRESSED_RGB8_PUNCHTHROUGH_ALPHA1_ETC2,
    0,
    0,
    'unorm',
    ID,
    { block: 4, needs: ['WEBGL_compressed_texture_etc'] },
  ],
  [
    272,
    'ETC2_SRGB8A1',
    8,
    GL.COMPRESSED_SRGB8_PUNCHTHROUGH_ALPHA1_ETC2,
    0,
    0,
    'unorm',
    ID,
    { block: 4, srgb: true, needs: ['WEBGL_compressed_texture_etc'] },
  ],
  [
    273,
    'ETC2_RGBA8',
    16,
    GL.COMPRESSED_RGBA8_ETC2_EAC,
    0,
    0,
    'unorm',
    ID,
    { block: 4, needs: ['WEBGL_compressed_texture_etc'] },
  ],
  [
    274,
    'ETC2_SRGBA8',
    16,
    GL.COMPRESSED_SRGB8_ALPHA8_ETC2_EAC,
    0,
    0,
    'unorm',
    ID,
    { block: 4, srgb: true, needs: ['WEBGL_compressed_texture_etc'] },
  ],
  [
    275,
    'ETC2_R11_UNORM',
    8,
    GL.COMPRESSED_R11_EAC,
    0,
    0,
    'unorm',
    R001,
    { block: 4, needs: ['WEBGL_compressed_texture_etc'] },
  ],
  [
    276,
    'ETC2_R11_SNORM',
    8,
    GL.COMPRESSED_SIGNED_R11_EAC,
    0,
    0,
    'snorm',
    R001,
    { block: 4, needs: ['WEBGL_compressed_texture_etc'] },
  ],
  [
    277,
    'ETC2_RG11_UNORM',
    16,
    GL.COMPRESSED_RG11_EAC,
    0,
    0,
    'unorm',
    RG01,
    { block: 4, needs: ['WEBGL_compressed_texture_etc'] },
  ],
  [
    278,
    'ETC2_RG11_SNORM',
    16,
    GL.COMPRESSED_SIGNED_RG11_EAC,
    0,
    0,
    'snorm',
    RG01,
    { block: 4, needs: ['WEBGL_compressed_texture_etc'] },
  ],
];

/** The formats by id. */
export const FORMATS = new Map<number, Format>(
  ROWS.map(([id, name, bpp, internal, format, type, kind, sample, extra = {}]) => {
    const { render, comps = 4, ...rest } = extra;
    const f: Format = { id, name, bpp, block: 1, internal, format, type, kind, sample, ...rest };
    if (render) f.write = writeOf(sample, comps);
    return [id, f];
  }),
);

/** Bytes a box of a format takes, rows `stride` apart and layers `layerStride` apart (0: packed). */
export function boxBytes(f: Format | undefined, w: number, h: number, d: number, stride = 0, layerStride = 0) {
  const bpp = f?.bpp ?? 4,
    b = f?.block ?? 1;
  const [bw, bh] = [Math.ceil(w / b), Math.ceil(h / b)];
  const row = stride || bw * bpp;
  const layer = layerStride || row * bh;
  return w === 0 || h === 0 || d === 0 ? 0 : (d - 1) * layer + (bh - 1) * row + bw * bpp;
}

/** A packed row and layer stride for a box (what TRANSFER commands mean by 0). */
export function packedStride(f: Format | undefined, w: number, h: number) {
  const bpp = f?.bpp ?? 4,
    b = f?.block ?? 1;
  const row = Math.ceil(w / b) * bpp;
  return { row, layer: row * Math.ceil(h / b) };
}

/**
 * A vertex element's format as WebGL2 reads it: components, the GL type, normalized, and a pure integer's kind. `bgra`:
 * stored blue first (GL's `GL_BGRA` arrays: EXT_vertex_array_bgra's colors, the 2_10_10_10 ones), which WebGL2 can't
 * fetch: read as its RGBA twin and swizzled back in the vertex shader (the program key's `bgra`). Mesa's virgl takes
 * every plain vertex format as supported (it checks the caps' bitmask only for R11G11B10), so the table needs them.
 */
export type VertexFormat = {
  size: number;
  type: number;
  normalized: boolean;
  int?: 'i' | 'u';
  bytes: number;
  bgra?: true;
};

const VTX = new Map<number, VertexFormat>();
{
  const T = { f32: 0x1406, u32: 0x1405, i32: 0x1404, u16: 0x1403, i16: 0x1402, u8: 0x1401, i8: 0x1400, f16: 0x140b };
  const add = (first: number, type: number, bytes: number, normalized: boolean, int?: 'i' | 'u') => {
    for (let n = 1; n <= 4; n++) VTX.set(first + n - 1, { size: n, type, normalized, int, bytes: bytes * n });
  };
  add(28, T.f32, 4, false); // R32…_FLOAT
  add(32, T.u32, 4, true);
  add(36, T.u32, 4, false);
  add(40, T.i32, 4, true);
  add(44, T.i32, 4, false); // UNORM, USCALED, SNORM, SSCALED
  add(48, T.u16, 2, true);
  add(52, T.u16, 2, false);
  add(56, T.i16, 2, true);
  add(60, T.i16, 2, false);
  add(64, T.u8, 1, true);
  add(69, T.u8, 1, false);
  add(74, T.i8, 1, true);
  add(82, T.i8, 1, false);
  add(91, T.f16, 2, false);
  add(177, T.u8, 1, false, 'u');
  add(181, T.i8, 1, false, 'i');
  add(185, T.u16, 2, false, 'u');
  add(189, T.i16, 2, false, 'i');
  add(193, T.u32, 4, false, 'u');
  add(197, T.i32, 4, false, 'i');
  VTX.set(8, { size: 4, type: 0x8368, normalized: true, bytes: 4 }); // R10G10B10A2_UNORM
  VTX.set(123, { size: 4, type: 0x8368, normalized: false, bytes: 4 }); // R10G10B10A2_USCALED
  VTX.set(173, { size: 4, type: 0x8d9f, normalized: true, bytes: 4 }); // R10G10B10A2_SNORM
  VTX.set(172, { size: 4, type: 0x8d9f, normalized: false, bytes: 4 }); // R10G10B10A2_SSCALED
  // Stored blue first: B8G8R8A8_UNORM, B10G10R10A2_UNORM, _USCALED, _SNORM, _SSCALED.
  VTX.set(1, { size: 4, type: T.u8, normalized: true, bytes: 4, bgra: true });
  VTX.set(131, { size: 4, type: 0x8368, normalized: true, bytes: 4, bgra: true });
  VTX.set(174, { size: 4, type: 0x8368, normalized: false, bytes: 4, bgra: true });
  VTX.set(176, { size: 4, type: 0x8d9f, normalized: true, bytes: 4, bgra: true });
  VTX.set(175, { size: 4, type: 0x8d9f, normalized: false, bytes: 4, bgra: true });
}
export const VERTEX_FORMATS: ReadonlyMap<number, VertexFormat> = VTX;
