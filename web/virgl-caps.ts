// The caps a 3D machine advertises, from the browser's WebGL2 (the G3 kickoff's decision 1; docs/devices.md
// "virgl"): never more than the renderer backs here. The base is `virglCaps` (web/virgl.ts: virglrenderer's caps on a
// GLES 3.0 host, less what WebGL2 lacks, at WebGL2's minimums); the limits come from the context, and the format
// masks from the format table (web/virgl-formats.ts) with the extensions this browser has.
import { E } from './gl-enums.ts';
import { decodeCaps, encodeCaps, virglCaps, type CapsValue } from './virgl.ts';
import { FORMATS, VERTEX_FORMATS } from './virgl-formats.ts';
import { readbackFormats } from './virgl-renderer.ts';

/** The uniform vectors the generated shaders keep for themselves (u_adjy, u_fbh, u_alpharef, u_psize, u_stipple's 32 words). */
const SYS_VECTORS = 16;

export function capsFromGl(gl: WebGL2RenderingContext): Uint8Array {
  const p = (e: number) => gl.getParameter(e) as number;
  const ext = new Set(gl.getSupportedExtensions() ?? []);
  const has = (names?: string[]) => !names || names.some((n) => ext.has(n));
  const caps = decodeCaps(virglCaps(2)) as Record<string, CapsValue>;
  const formats = [...FORMATS.values()];
  // Sampled: anything whose extension (if any) is here; filtered 32-bit floats need OES_texture_float_linear, but a
  // format is sampleable without filtering, as GLES 3.0 has it.
  caps.sampler = formats.filter((f) => f.kind !== 'stencil' && has(f.needs)).map((f) => f.id);
  caps.render = formats.filter((f) => f.write && has(f.needs) && has(f.renderNeeds)).map((f) => f.id);
  caps.depthstencil = formats.filter((f) => f.kind === 'depth' || f.kind === 'depthstencil' || f.kind === 'stencil').map((f) => f.id);
  caps.vertexbuffer = [...VERTEX_FORMATS.keys()];
  caps.supported_readback_formats = readbackFormats(ext.has('EXT_color_buffer_float')).filter((id) => has(FORMATS.get(id)!.needs));
  caps.scanout = [1, 2, 67, 134].filter((id) => FORMATS.has(id));
  // Multisampled rendering is renderbuffers (WebGL2 samples no multisampled texture): color formats WebGL renders to
  // and depth formats. Mesa allows any sample count above 1 only with texture_multisample (below).
  caps.supported_multisample_formats = formats.filter((f) => (f.write && (f.kind === 'unorm' || f.kind === 'float') && has(f.needs) && has(f.renderNeeds)) || f.kind === 'depth' || f.kind === 'depthstencil').map((f) => f.id);
  const range = (e: number) => Array.from(gl.getParameter(e) as Float32Array);
  const [, pointMax] = range(E.ALIASED_POINT_SIZE_RANGE);
  const [, lineMax] = range(E.ALIASED_LINE_WIDTH_RANGE);
  const blocks = Math.min(p(E.MAX_VERTEX_UNIFORM_BLOCKS), p(E.MAX_FRAGMENT_UNIFORM_BLOCKS), Math.floor(p(E.MAX_UNIFORM_BUFFER_BINDINGS) / 2), 12);
  Object.assign(caps, {
    max_texture_2d_size: p(E.MAX_TEXTURE_SIZE),
    max_texture_3d_size: p(E.MAX_3D_TEXTURE_SIZE),
    max_texture_cube_size: p(E.MAX_CUBE_MAP_TEXTURE_SIZE),
    max_texture_array_layers: p(E.MAX_ARRAY_TEXTURE_LAYERS),
    max_render_targets: Math.min(p(E.MAX_DRAW_BUFFERS), p(E.MAX_COLOR_ATTACHMENTS), 8),
    max_samples: Math.min(p(E.MAX_SAMPLES), 8),
    // virgl_caps_bool_set1.texture_multisample (bit 14): what lets Mesa make multisampled renderbuffers at all, which
    // GLES 3.0 requires (4 samples).
    bset: (caps.bset as number) | (p(E.MAX_SAMPLES) > 1 ? 1 << 14 : 0),
    // Gallium counts constant buffer 0 (our uniforms) among the blocks.
    max_uniform_blocks: blocks + 1,
    max_uniform_block_size: p(E.MAX_UNIFORM_BLOCK_SIZE),
    uniform_buffer_offset_alignment: p(E.UNIFORM_BUFFER_OFFSET_ALIGNMENT),
    max_vertex_attribs: Math.min(p(E.MAX_VERTEX_ATTRIBS), 16),
    max_vertex_outputs: Math.min(p(E.MAX_VARYING_VECTORS), 32),
    min_texel_offset: p(E.MIN_PROGRAM_TEXEL_OFFSET),
    max_texel_offset: p(E.MAX_PROGRAM_TEXEL_OFFSET),
    max_texture_lod_bias: p(E.MAX_TEXTURE_LOD_BIAS),
    max_aliased_point_size: pointMax,
    max_smooth_point_size: pointMax,
    max_aliased_line_width: lineMax,
    max_smooth_line_width: lineMax,
    max_anisotropy: ext.has('EXT_texture_filter_anisotropic') ? p(E.MAX_TEXTURE_MAX_ANISOTROPY) : 1,
    max_texture_samplers: Math.min(p(E.MAX_TEXTURE_IMAGE_UNITS), p(E.MAX_VERTEX_TEXTURE_IMAGE_UNITS), 16),
    max_const_buffer_size: [Math.max(0, p(E.MAX_VERTEX_UNIFORM_VECTORS) - SYS_VECTORS) * 16, Math.max(0, p(E.MAX_FRAGMENT_UNIFORM_VECTORS) - SYS_VECTORS) * 16, 0, 0, 0, 0],
  });
  return encodeCaps(caps);
}

/**
 * Whether caps the guest was given (`saved`) are backed by `now` (a snapshot restored in another browser): every
 * format and capability bit given is still there, and no limit given is above today's.
 */
export function capsBacked(saved: Uint8Array, now: Uint8Array): string | null {
  const a = decodeCaps(saved), b = decodeCaps(now);
  for (const [k, v] of Object.entries(a)) {
    const w = b[k];
    if (Array.isArray(v) && Array.isArray(w)) {
      // Format masks (lists of set formats) and the per-stage limits.
      if (/^(sampler|render|depthstencil|vertexbuffer|supported_readback_formats|scanout|supported_multisample_formats)$/.test(k)) {
        const set = new Set(w);
        const missing = v.filter((f) => !set.has(f));
        if (missing.length) return `${k} lacks formats ${missing.join(', ')}`;
      } else if (v.some((x, i) => x > (w[i] ?? 0))) return `${k} is below ${v.join(', ')}`;
    } else if (typeof v === 'number' && typeof w === 'number') {
      if (k === 'capability_bits' || k === 'capability_bits_v2' || k === 'bset') {
        if ((v & ~w) !== 0) return `${k} lacks ${(v & ~w).toString(16)}`;
      } else if (k.startsWith('min_')) {
        if (v < w) return `${k} is above ${v}`;
      } else if (v > w) return `${k} is below ${v}`;
    }
  }
  return null;
}
