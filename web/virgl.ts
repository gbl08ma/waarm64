// The virgl command stream (docs/plans/graphics.md §1, §19): what Mesa's virgl driver sends in a virtio-gpu
// SUBMIT_3D. The names and the header's layout are virglrenderer's src/virgl_protocol.h (MIT,
// THIRD_PARTY.md). G2's device runs a null renderer: the stream is walked and counted, never drawn.

/** VIRGL_CCMD_*, by number. */
export const CCMD = [
  'NOP', 'CREATE_OBJECT', 'BIND_OBJECT', 'DESTROY_OBJECT', 'SET_VIEWPORT_STATE', 'SET_FRAMEBUFFER_STATE',
  'SET_VERTEX_BUFFERS', 'CLEAR', 'DRAW_VBO', 'RESOURCE_INLINE_WRITE', 'SET_SAMPLER_VIEWS', 'SET_INDEX_BUFFER',
  'SET_CONSTANT_BUFFER', 'SET_STENCIL_REF', 'SET_BLEND_COLOR', 'SET_SCISSOR_STATE', 'BLIT', 'RESOURCE_COPY_REGION',
  'BIND_SAMPLER_STATES', 'BEGIN_QUERY', 'END_QUERY', 'GET_QUERY_RESULT', 'SET_POLYGON_STIPPLE', 'SET_CLIP_STATE',
  'SET_SAMPLE_MASK', 'SET_STREAMOUT_TARGETS', 'SET_RENDER_CONDITION', 'SET_UNIFORM_BUFFER', 'SET_SUB_CTX',
  'CREATE_SUB_CTX', 'DESTROY_SUB_CTX', 'BIND_SHADER', 'SET_TESS_STATE', 'SET_MIN_SAMPLES', 'SET_SHADER_BUFFERS',
  'SET_SHADER_IMAGES', 'MEMORY_BARRIER', 'LAUNCH_GRID', 'SET_FRAMEBUFFER_STATE_NO_ATTACH', 'TEXTURE_BARRIER',
  'SET_ATOMIC_BUFFERS', 'SET_DEBUG_FLAGS', 'GET_QUERY_RESULT_QBO', 'TRANSFER3D', 'END_TRANSFERS',
  'COPY_TRANSFER3D', 'SET_TWEAKS', 'CLEAR_TEXTURE', 'PIPE_RESOURCE_CREATE', 'PIPE_RESOURCE_SET_TYPE',
  'GET_MEMORY_INFO', 'SEND_STRING_MARKER', 'LINK_SHADER', 'CREATE_VIDEO_CODEC', 'DESTROY_VIDEO_CODEC',
  'CREATE_VIDEO_BUFFER', 'DESTROY_VIDEO_BUFFER', 'BEGIN_FRAME', 'DECODE_MACROBLOCK', 'DECODE_BITSTREAM',
  'ENCODE_BITSTREAM', 'END_FRAME', 'CLEAR_SURFACE', 'GET_PIPE_RESOURCE_LAYOUT', 'QUERY_GBM_FORMAT_MODIFIER',
] as const;

/** VIRGL_OBJECT_*, by number (CREATE/BIND/DESTROY_OBJECT's second byte). */
export const OBJECT = [
  'NULL', 'BLEND', 'RASTERIZER', 'DSA', 'SHADER', 'VERTEX_ELEMENTS', 'SAMPLER_VIEW', 'SAMPLER_STATE', 'SURFACE',
  'QUERY', 'STREAMOUT_TARGET', 'MSAA_SURFACE',
] as const;

/** A command's name: CCMD's, with the object type for the object commands. */
export function commandName(cmd: number, obj: number) {
  const c = CCMD[cmd] ?? `CCMD_${cmd}`;
  return cmd >= 1 && cmd <= 3 ? `${c}.${OBJECT[obj] ?? obj}` : c;
}

/**
 * Walks a command buffer: each command is a header dword (cmd: bits 0–7, object type: 8–15, length in dwords
 * after the header: 16–31) and its payload. Calls `visit` per command with the payload's offset in words.
 * Returns the number of commands, or -1 if a length runs past the buffer (virglrenderer stops there too).
 */
export function walk(words: Uint32Array, visit?: (cmd: number, obj: number, at: number, len: number) => void) {
  let n = 0;
  for (let at = 0; at < words.length;) {
    const h = words[at];
    const len = h >>> 16;
    if (at + 1 + len > words.length) return -1;
    visit?.(h & 0xff, (h >>> 8) & 0xff, at + 1, len);
    at += 1 + len;
    n++;
  }
  return n;
}

/** Counts of what a context sent, by command name: commands and their payload dwords. */
export class VirglStats {
  submits = 0;
  bytes = 0;
  bad = 0;
  readonly commands = new Map<string, { n: number; dwords: number }>();

  count(words: Uint32Array) {
    this.submits++;
    this.bytes += words.length * 4;
    const r = walk(words, (cmd, obj, _at, len) => {
      const name = commandName(cmd, obj);
      const c = this.commands.get(name) ?? { n: 0, dwords: 0 };
      c.n++;
      c.dwords += len;
      this.commands.set(name, c);
    });
    if (r < 0) this.bad++;
    return r;
  }

  json() {
    return { submits: this.submits, bytes: this.bytes, bad: this.bad, commands: Object.fromEntries([...this.commands].sort((a, b) => b[1].n - a[1].n)) };
  }
}

/**
 * The caps blob (virgl_hw.h `struct virgl_caps_v2`, 352 dwords) as fields: name, dword offset, count, kind ('u'
 * unsigned, 'i' signed, 'f' float, 's' a string of `count` dwords, 'm' a 16-dword format mask). The VIRGL capset
 * (id 1) is the same blob with `max_version` 1 and only v1's fields meaningful.
 */
export const CAPS_FIELDS: [string, number, number, 'u' | 'i' | 'f' | 's' | 'm'][] = [
  ['max_version', 0, 1, 'u'], ['sampler', 1, 16, 'm'], ['render', 17, 16, 'm'], ['depthstencil', 33, 16, 'm'],
  ['vertexbuffer', 49, 16, 'm'], ['bset', 65, 1, 'u'], ['glsl_level', 66, 1, 'u'], ['max_texture_array_layers', 67, 1, 'u'],
  ['max_streamout_buffers', 68, 1, 'u'], ['max_dual_source_render_targets', 69, 1, 'u'], ['max_render_targets', 70, 1, 'u'],
  ['max_samples', 71, 1, 'u'], ['prim_mask', 72, 1, 'u'], ['max_tbo_size', 73, 1, 'u'], ['max_uniform_blocks', 74, 1, 'u'],
  ['max_viewports', 75, 1, 'u'], ['max_texture_gather_components', 76, 1, 'u'],
  ['min_aliased_point_size', 77, 1, 'f'], ['max_aliased_point_size', 78, 1, 'f'], ['min_smooth_point_size', 79, 1, 'f'],
  ['max_smooth_point_size', 80, 1, 'f'], ['min_aliased_line_width', 81, 1, 'f'], ['max_aliased_line_width', 82, 1, 'f'],
  ['min_smooth_line_width', 83, 1, 'f'], ['max_smooth_line_width', 84, 1, 'f'], ['max_texture_lod_bias', 85, 1, 'f'],
  ['max_geom_output_vertices', 86, 1, 'u'], ['max_geom_total_output_components', 87, 1, 'u'], ['max_vertex_outputs', 88, 1, 'u'],
  ['max_vertex_attribs', 89, 1, 'u'], ['max_shader_patch_varyings', 90, 1, 'u'], ['min_texel_offset', 91, 1, 'i'],
  ['max_texel_offset', 92, 1, 'i'], ['min_texture_gather_offset', 93, 1, 'i'], ['max_texture_gather_offset', 94, 1, 'i'],
  ['texture_buffer_offset_alignment', 95, 1, 'u'], ['uniform_buffer_offset_alignment', 96, 1, 'u'],
  ['shader_buffer_offset_alignment', 97, 1, 'u'], ['capability_bits', 98, 1, 'u'], ['sample_locations', 99, 8, 'u'],
  ['max_vertex_attrib_stride', 107, 1, 'u'], ['max_shader_buffer_frag_compute', 108, 1, 'u'],
  ['max_shader_buffer_other_stages', 109, 1, 'u'], ['max_shader_image_frag_compute', 110, 1, 'u'],
  ['max_shader_image_other_stages', 111, 1, 'u'], ['max_image_samples', 112, 1, 'u'],
  ['max_compute_work_group_invocations', 113, 1, 'u'], ['max_compute_shared_memory_size', 114, 1, 'u'],
  ['max_compute_grid_size', 115, 3, 'u'], ['max_compute_block_size', 118, 3, 'u'], ['max_texture_2d_size', 121, 1, 'u'],
  ['max_texture_3d_size', 122, 1, 'u'], ['max_texture_cube_size', 123, 1, 'u'], ['max_combined_shader_buffers', 124, 1, 'u'],
  ['max_atomic_counters', 125, 6, 'u'], ['max_atomic_counter_buffers', 131, 6, 'u'], ['max_combined_atomic_counters', 137, 1, 'u'],
  ['max_combined_atomic_counter_buffers', 138, 1, 'u'], ['host_feature_check_version', 139, 1, 'u'],
  ['supported_readback_formats', 140, 16, 'm'], ['scanout', 156, 16, 'm'], ['capability_bits_v2', 172, 1, 'u'],
  ['max_video_memory', 173, 1, 'u'], ['renderer', 174, 16, 's'], ['max_anisotropy', 190, 1, 'f'], ['max_texture_samplers', 191, 1, 'u'],
  ['supported_multisample_formats', 192, 16, 'm'], ['max_const_buffer_size', 208, 6, 'u'], ['num_video_caps', 214, 1, 'u'],
  ['video_caps', 215, 128, 'u'],
  ['max_uniform_block_size', 343, 1, 'u'], ['max_tcs_outputs', 344, 1, 'u'], ['max_tes_outputs', 345, 1, 'u'],
  ['max_shader_storage_blocks', 346, 6, 'u'],
];
export const CAPS_DWORDS = 352;

export type CapsValue = number | number[] | string;

/** A caps blob as named values (format masks as the list of format numbers set). */
export function decodeCaps(blob: Uint8Array): Record<string, CapsValue> {
  const v = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const out: Record<string, CapsValue> = {};
  for (const [name, at, n, kind] of CAPS_FIELDS) {
    if ((at + n) * 4 > blob.length) break;
    const get = (k: number) => kind === 'f' ? v.getFloat32((at + k) * 4, true) : kind === 'i' ? v.getInt32((at + k) * 4, true) : v.getUint32((at + k) * 4, true);
    if (kind === 's') out[name] = new TextDecoder().decode(blob.subarray(at * 4, (at + n) * 4)).replace(/\0.*$/s, '');
    else if (kind === 'm') {
      const set: number[] = [];
      for (let k = 0; k < 512; k++) if (get(k >>> 5) & (1 << (k & 31))) set.push(k);
      out[name] = set;
    } else out[name] = n === 1 ? get(0) : Array.from({ length: n }, (_, k) => get(k));
  }
  return out;
}

/** The blob from named values (`decodeCaps`'s shape); fields not given are 0. */
export function encodeCaps(values: Record<string, CapsValue>): Uint8Array {
  const blob = new Uint8Array(CAPS_DWORDS * 4);
  const v = new DataView(blob.buffer);
  for (const [name, at, n, kind] of CAPS_FIELDS) {
    const x = values[name];
    if (x === undefined) continue;
    if (kind === 's') blob.set(new TextEncoder().encode(String(x)).subarray(0, n * 4 - 1), at * 4);
    else if (kind === 'm') for (const f of x as number[]) v.setUint32((at + (f >>> 5)) * 4, v.getUint32((at + (f >>> 5)) * 4, true) | (1 << (f & 31)), true);
    else {
      const xs = typeof x === 'number' ? [x] : x as number[];
      xs.forEach((e, k) => kind === 'f' ? v.setFloat32((at + k) * 4, e, true) : kind === 'i' ? v.setInt32((at + k) * 4, e, true) : v.setUint32((at + k) * 4, e >>> 0, true));
    }
  }
  return blob;
}

const bits = (...b: number[]) => b.reduce((m, k) => (m | (1 << k)) >>> 0, 0);

/**
 * What the device advertises (G2: a null renderer, so the guest takes the paths it will take on the WebGL2
 * renderer). The base is virglrenderer's own caps on a GLES 3.0 host (llvmpipe with
 * `MESA_GLES_VERSION_OVERRIDE=3.0`, graphics.md §19), which gives the guest GLES 3.0 and GL 2.1; then
 * everything WebGL2 lacks or has only as an extension is taken out, and the limits are WebGL2's
 * minimums where virglrenderer's were above them. G3 raises them per adapter (never past what it backs);
 * the format masks are virglrenderer's and are G3's to trim.
 */
export function virglCaps(capset: 1 | 2): Uint8Array {
  const caps: Record<string, CapsValue> = {
    max_version: capset,
    sampler: [1, 2, 7, 8, 9, 10, 16, 17, 18, 20, 21, 28, 29, 30, 31, 64, 65, 67, 74, 75, 77, 91, 92, 94, 95, 100, 101, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 124, 125, 126, 131, 134, 148, 156, 160, 177, 178, 180, 181, 182, 184, 185, 186, 188, 189, 190, 192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 203, 205, 207, 209, 211, 213, 215, 217, 219, 221, 223, 227, 229, 230, 231, 232, 233, 236, 237, 238, 253, 255, 256, 257, 258, 269, 270, 271, 272, 273, 274, 275, 276, 277, 278, 279, 280, 281, 282, 283, 284, 285, 286, 287, 288, 289, 290, 291, 292, 308, 311, 312, 313],
    render: [1, 2, 7, 8, 9, 28, 29, 31, 64, 65, 67, 74, 75, 77, 91, 92, 94, 100, 101, 104, 124, 131, 134, 148, 156, 160, 177, 178, 180, 181, 182, 184, 185, 186, 188, 189, 190, 192, 193, 194, 196, 197, 198, 200, 201, 203, 205, 207, 209, 211, 213, 215, 217, 219, 221, 223, 227, 229, 230, 231, 232, 233, 236, 237, 238, 253, 308, 311],
    // virgl_caps_bool_set1: primitive_restart (6), instanceid (8), seamless_cube_map (10), occlusion_query (11),
    // streamout_pause_resume (13). Out: independent blending, conditional render, start_instance, timer queries,
    // depth clamp, mirror clamp, textureQueryLod, sample shading, cull distance, polygon offset clamp.
    bset: bits(6, 8, 10, 11, 13),
    glsl_level: 130,
    max_texture_array_layers: 256,
    max_streamout_buffers: 4,
    max_render_targets: 4,
    max_samples: 4,
    prim_mask: 127,
    max_uniform_blocks: 12,
    max_viewports: 1,
    min_aliased_point_size: 1,
    max_aliased_point_size: 1,
    min_aliased_line_width: 1,
    max_aliased_line_width: 1,
    max_texture_lod_bias: 2,
    max_vertex_outputs: 16,
    max_vertex_attribs: 16,
    min_texel_offset: -8,
    max_texel_offset: 7,
    uniform_buffer_offset_alignment: 256,
    // VIRGL_CAP_*: TGSI_INVARIANT, SET_MIN_SAMPLES, TGSI_PRECISE, ROBUST_BUFFER_ACCESS, TGSI_COMPONENTS,
    // GUEST_MAY_INIT_LOG, TRANSFER, FBO_MIXED_COLOR_FORMATS, HOST_IS_GLES, COPY_TRANSFER, APP_TWEAK_SUPPORT. Out:
    // COPY_IMAGE, TGSI_FBFETCH, SRGB_WRITE_CONTROL, 3D_ASTC, INDIRECT_INPUT_ADDR, CLIP_HALFZ.
    capability_bits: bits(0, 2, 4, 9, 13, 14, 17, 18, 19, 26, 28),
    max_vertex_attrib_stride: 2048,
    max_texture_2d_size: 8192,
    max_texture_3d_size: 2048,
    max_texture_cube_size: 8192,
    host_feature_check_version: 23,
    supported_readback_formats: [1, 2, 7, 8, 9, 16, 17, 18, 20, 21, 28, 29, 31, 64, 65, 67, 74, 75, 77, 91, 92, 94, 100, 101, 104, 124, 126, 134, 148, 156, 160, 177, 178, 180, 181, 182, 184, 185, 186, 188, 189, 190, 192, 193, 194, 196, 197, 198, 200, 201, 203, 205, 207, 209, 211, 213, 215, 217, 219, 221, 223, 227, 229, 230, 231, 232, 236, 237, 238, 253, 308, 311],
    // VIRGL_CAP_V2_*: UNTYPED_RESOURCE, STRING_MARKER, COPY_TRANSFER_BOTH_DIRECTIONS. Out: BLEND_EQUATION
    // (advanced blending), TEXTURE_SHADOW_LOD, MIRROR_CLAMP_TO_EDGE.
    capability_bits_v2: bits(1, 4, 7),
    renderer: 'webpc',
    max_anisotropy: 16,
    max_texture_samplers: 16,
    max_const_buffer_size: [16384, 16384, 0, 0, 0, 0],
    max_uniform_block_size: 16384,
  };
  const blob = encodeCaps(caps);
  return capset === 1 ? blob.subarray(0, 77 * 4) : blob;
}
