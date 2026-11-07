// The caps a 3D machine advertises, from the browser's WebGL2 (the G3 kickoff's decision 1; docs/devices.md
// "virgl"): never more than the renderer backs here. The base is `virglCaps` (web/virgl.ts: virglrenderer's caps on a
// GLES 3.0 host, less what WebGL2 lacks, at WebGL2's minimums); the limits come from the context, and the format
// masks from the format table (web/virgl-formats.ts) with the extensions this browser has.
import { E } from './gl-enums.ts';
import { CAPS_FIELDS, decodeCaps, encodeCaps, virglCaps, type CapsValue } from './virgl.ts';
import { FORMATS, VERTEX_FORMATS } from './virgl-formats.ts';
import { readbackFormats } from './virgl-renderer.ts';
import { decodeVideoCaps, encodeVideoCaps, type VideoCap } from './virgl-video.ts';

/**
 * The caps without the formats named (virgl's names, `FORMATS`' `name`: `Z24_UNORM_S8_UINT`…) in any of their masks:
 * `?gpu=capsno=` (a developer's A/B of what the guest's Mesa and its programs choose; docs/frontend.md). Unknown names
 * are returned, the caps without the known ones.
 */
export function withoutFormats(caps: Uint8Array, names: readonly string[]): { caps: Uint8Array; unknown: string[] } {
  const ids = new Map([...FORMATS].map(([id, f]) => [f.name, id]));
  const drop = new Set<number>(), unknown: string[] = [];
  for (const n of names) {
    const id = ids.get(n);
    if (id === undefined) unknown.push(n);
    else drop.add(id);
  }
  if (!drop.size) return { caps, unknown };
  // Each mask's bits cleared in a copy: everything else as it was.
  const out = caps.slice(), v = new DataView(out.buffer);
  for (const [name, at, n, kind] of CAPS_FIELDS) {
    if (kind !== 'm' || (at + n) * 4 > out.length) continue;
    void name;
    for (const id of drop) if (id < n * 32) v.setUint32((at + (id >>> 5)) * 4, v.getUint32((at + (id >>> 5)) * 4, true) & ~(1 << (id & 31)), true);
  }
  return { caps: out, unknown };
}

/** The capability bits `?gpu=capsyes=` can offer (virglrenderer's VIRGL_CAP_* and VIRGL_CAP_V2_* names, without the
 * prefix), those vrend offers and we don't (web/virgl.ts `virglCaps`' "Out:"): word 0 `capability_bits`, 1 `_v2`. */
const CAP_BITS: Record<string, [0 | 1, number]> = {
  COPY_IMAGE: [0, 3], TGSI_FBFETCH: [0, 10], SRGB_WRITE_CONTROL: [0, 15], '3D_ASTC': [0, 24], INDIRECT_INPUT_ADDR: [0, 25],
  CLIP_HALFZ: [0, 27], V2_BLEND_EQUATION: [1, 0], V2_TEXTURE_SHADOW_LOD: [1, 10], V2_MIRROR_CLAMP_TO_EDGE: [1, 16],
};

/**
 * The caps with capability bits set that the renderer doesn't back (`CAP_BITS`' names): `?gpu=capsyes=`, a developer's
 * A/B of the paths the guest's Mesa and its programs take when a host offers them (what needs them may then draw
 * wrong). Unknown names are returned.
 */
export function withBits(caps: Uint8Array, names: readonly string[]): { caps: Uint8Array; unknown: string[] } {
  const out = caps.slice(), v = new DataView(out.buffer), unknown: string[] = [];
  const at = (k: string) => CAPS_FIELDS.find(([n]) => n === k)![1] * 4;
  for (const n of names) {
    const b = CAP_BITS[n];
    if (!b) { unknown.push(n); continue; }
    const off = at(b[0] ? 'capability_bits_v2' : 'capability_bits');
    v.setUint32(off, (v.getUint32(off, true) | (1 << b[1])) >>> 0, true);
  }
  return { caps: names.length > unknown.length ? out : caps, unknown };
}

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

/** `caps` with the video decoders in `video` (web/virgl-video.ts `probeVideo`) advertised. */
export function withVideo(caps: Uint8Array, video: VideoCap[]): Uint8Array {
  const v = decodeCaps(caps);
  v.num_video_caps = Math.min(video.length, 32);
  v.video_caps = encodeVideoCaps(video);
  const out = encodeCaps(v);
  return out.subarray(0, caps.length);
}

/**
 * Whether caps the guest was given (`saved`) are backed by `now` (a snapshot restored in another browser): every
 * format and capability bit given is still there, and no limit given is above today's.
 */
export function capsBacked(saved: Uint8Array, now: Uint8Array): string | null {
  const a = decodeCaps(saved), b = decodeCaps(now);
  for (const [k, v] of Object.entries(a)) {
    const w = b[k];
    if (k === 'num_video_caps') continue;
    if (k === 'video_caps') {
      // Every decoder the guest was told of, at no larger a size.
      const now = decodeVideoCaps(w as number[], b.num_video_caps as number);
      for (const c of decodeVideoCaps(v as number[], a.num_video_caps as number)) {
        if (!now.some((d) => d.profile === c.profile && d.maxWidth >= c.maxWidth && d.maxHeight >= c.maxHeight && d.maxLevel >= c.maxLevel)) return `no video decoder for profile ${c.profile}`;
      }
      continue;
    }
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
