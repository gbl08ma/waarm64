// The WGSL the Venus worker generates around the translator's (web/venus-gpu.ts): vertex pulling from storage
// bindings, the fetch of transform feedback's and a storing stage's pre-pass, and the blits' filters.
import type { Json } from './venus-gpu.ts';
/** A vertex stage's fetch of its inputs (`fn wgx_fetch(vid, iid) -> In`, from `wgx_ld`'s bytes) as its render
 * pipeline's buffers describe them, each binding's first byte in `wgx_in` the parameter `<params>.vbd<slot>`
 * (transform feedback's and a storing stage's pre-pass); the slots read, and whether the stage takes inputs. */
export function vertexFetch(
  code: string,
  buffers: (Json | null)[],
  params: string,
): { code: string; slots: number[]; inputs: boolean } {
  const base: Record<number, string> = {};
  for (const m of code.matchAll(/@location\((\d+)\) a\d+: vec4<(f32|i32|u32)>/g)) base[Number(m[1])] = m[2];
  const inputs = code.includes('fn wg_vs(vid: u32, iid: u32, i: In)');
  const slots: number[] = [];
  let fetch = 'fn wgx_fetch(vid: u32, iid: u32) -> In {\n  var i: In;\n';
  buffers.forEach((b, slot) => {
    if (!b?.attributes?.length) return;
    slots.push(slot);
    for (const a of b.attributes as Json[]) {
      const at = `(${params}.vbd${slot} + ${recordIndex(b as { stepMode: string; divisor?: number }, `${params}.firstInstance`)} * ${b.arrayStride}u + ${a.offset}u)`;
      const T = base[a.shaderLocation];
      const v = T && vertexDecode(a.format as string, (k: number) => `wgx_ld(${at} + ${k}u)`, T);
      if (v) fetch += `  i.a${a.shaderLocation} = ${v};\n`;
    }
  });
  fetch += '  return i;\n}';
  return { code: fetch, slots, inputs };
}

/** Vertex bindings a pipeline may pull (wg_private.h `WG_VERTEX_BINDINGS`); past them, the bytes each starts past its offset. */
export const PULL_SLOTS = 16;

/** A render pipeline's vertex buffer as its JSON gives it (`pull`: read from a storage binding). */
export type PulledBuffer = {
  pull?: boolean;
  arrayStride: number;
  stepMode: string;
  divisor?: number;
  attributes: { format: string; offset: number; shaderLocation: number }[];
};

/** Where the push buffer's place holds a draw's parameters (wgsl.h `WGSL_DRAW_PARAMS`: base vertex, first instance, draw index). */
export const PULL_DRAW_PARAMS = 256;

/** The record a binding's attributes are read from: the vertex's, or the instance's (`iid`, which counts from the draw's
 * first instance `first`), past a divisor (VK4 T44: Vulkan's `first + (iid - first) / divisor`, 0 the first's for all). */
function recordIndex(b: { stepMode: string; divisor?: number }, first: string): string {
  if (b.stepMode !== 'instance') return 'vid';
  if (b.divisor === undefined || b.divisor === 1) return 'iid';
  return b.divisor === 0 ? first : `(${first} + (iid - ${first}) / ${b.divisor}u)`;
}

/** What a vertex stage's entry point starts with where it takes vertex inputs (wgsl_print.c). */
export const PULLED_ENTRY = 'iid: u32, i: In) -> Out {\n  wg_vs(vid, iid, i);';

/** A vertex stage's WGSL with the bindings marked `pull` (the render pipeline's JSON, by slot) read from storage
 * bindings of `group` (`pullBind`) instead of vertex buffers: its other attributes come in as before, in a struct of
 * their own (`In` no longer the entry point's, its @location attributes ignored), and `wg_vs` is given both. The
 * bindings from `first` on (a program's group 3: VK4 T44); the places and the first instance read-only storage with
 * `storage` (the stage's uniform buffers full: wg_shader.c `storage_params`). */
export function pulledCode(
  code: string,
  buffers: (PulledBuffer | null)[],
  group: number,
  first = 0,
  storage = false,
): string {
  const declared = [...code.matchAll(/^ {2}@location\((\d+)\) a\d+: vec4<(f32|i32|u32)>,$/gm)];
  const base: Record<number, string> = {};
  for (const m of declared) base[Number(m[1])] = m[2];
  const pulled = new Set<number>();
  const space = storage ? 'storage, read' : 'uniform';
  const lines = [
    `@group(${group}) @binding(${first + PULL_SLOTS}) var<${space}> wgv_at: array<vec4<u32>, ${PULL_SLOTS / 4}>;`,
  ];
  if (buffers.some((b) => b?.pull && b.stepMode === 'instance' && b.divisor !== undefined && b.divisor !== 1))
    lines.push(
      `@group(${group}) @binding(${first + PULL_SLOTS + 1}) var<${space}> wgv_dp: array<vec4<u32>, ${PULL_DRAW_PARAMS / 16 + 1}>;`,
    );
  let fetch = '';
  buffers.forEach((b, slot) => {
    if (!b?.pull) return;
    lines.push(`@group(${group}) @binding(${first + slot}) var<storage, read> wgv_b${slot}: array<u32>;`);
    // Past the bound range (a draw reading past its buffer's end, which Vulkan's robust buffer access allows: VK4 T37), 0.
    lines.push(
      `fn wgv_ld${slot}(b: u32) -> u32 { let w = b >> 2u; let s = (b & 3u) * 8u; let n = arrayLength(&wgv_b${slot}); let lo = select(0u, wgv_b${slot}[w], w < n); if (s == 0u) { return lo; } return (lo >> s) | (select(0u, wgv_b${slot}[w + 1u], w + 1u < n) << (32u - s)); }`,
    );
    for (const a of b.attributes) {
      pulled.add(a.shaderLocation);
      const at = `(wgv_at[${slot >> 2}u][${slot & 3}u] + ${recordIndex(b, `wgv_dp[${PULL_DRAW_PARAMS / 16}u].y`)} * ${b.arrayStride}u + ${a.offset}u)`;
      fetch += `  i.a${a.shaderLocation} = ${vertexDecode(a.format, (k) => `wgv_ld${slot}(${at} + ${k}u)`, base[a.shaderLocation])};\n`;
    }
  });
  const kept = declared.filter((m) => !pulled.has(Number(m[1])));
  for (const m of kept) fetch += `  i.a${m[1]} = v.a${m[1]};\n`;
  if (kept.length) lines.push(`struct WgvIn {\n${kept.map((m) => m[0]).join('\n')}\n}`);
  lines.push(
    `fn wgv_fetch(vid: u32, iid: u32${kept.length ? ', v: WgvIn' : ''}) -> In {\n  var i: In;\n${fetch}  return i;\n}`,
  );
  const entry = `iid: u32${kept.length ? ', v: WgvIn' : ''}) -> Out {\n  wg_vs(vid, iid, wgv_fetch(vid, iid${kept.length ? ', v' : ''}));`;
  return `${code.replace(PULLED_ENTRY, entry)}\n${lines.join('\n')}\n`;
}

/** A WebGPU vertex format's value as WGSL `vec4<T>` from the words `word(byte)` reads (transform feedback's fetch, VK3
 * L7.4); `undefined` for one it doesn't know. */
export function vertexDecode(format: string, word: (byte: number) => string, T: string): string | undefined {
  const bgra = format.endsWith('-bgra');
  // A channel's value from its bits (`u` unsigned, `i` sign-extended) by kind; the scaled kinds and three channels of 8
  // or 16 bits are formats WebGPU's vertex buffers lack, always pulled (wg_format.c, VK4 T31).
  const value = (kind: string, bits: number, u: string, i: string) => {
    switch (kind) {
      case 'uint':
        return u;
      case 'sint':
        return i;
      case 'uscaled':
        return `f32(${u})`;
      case 'sscaled':
        return `f32(${i})`;
      case 'unorm':
        return `f32(${u}) / ${2 ** bits - 1}.0`;
      case 'snorm':
        return `max(f32(${i}) / ${2 ** (bits - 1) - 1}.0, -1.0)`;
      default:
        return bits === 32 ? `bitcast<f32>(${u})` : `unpack2x16float(${u}).x`;
    }
  };
  let comps: string[];
  // The format's own type: where the shader's input is of another (VK_EXT_legacy_vertex_attributes, VK4 T44), its bits.
  const own = (kind: string) => (kind === 'uint' ? 'u32' : kind === 'sint' ? 'i32' : 'f32');
  let natural: string;
  const packed = /^(uint|sint|unorm|snorm|uscaled|sscaled)10-10-10-2/.exec(format);
  if (packed) {
    natural = own(packed[1]);
    const w = word(0);
    comps = [0, 10, 20, 30].map((o) => {
      const bits = o === 30 ? 2 : 10;
      return value(
        packed[1],
        bits,
        `extractBits(${w}, ${o}u, ${bits}u)`,
        `extractBits(bitcast<i32>(${w}), ${o}u, ${bits}u)`,
      );
    });
  } else {
    const m = /^(uint|sint|unorm|snorm|uscaled|sscaled|float)(8|16|32)(?:x([234]))?/.exec(format);
    if (!m) return undefined;
    const kind = m[1],
      bits = Number(m[2]),
      n = Number(m[3] ?? 1);
    natural = own(kind);
    comps = Array.from({ length: n }, (_, k) => {
      const w = bits === 32 ? word(4 * k) : bits === 16 ? word(4 * (k >> 1)) : word(0);
      const off = bits === 32 ? 0 : bits === 16 ? 16 * (k & 1) : 8 * k;
      const u = bits === 32 ? w : `extractBits(${w}, ${off}u, ${bits}u)`;
      const i = bits === 32 ? `bitcast<i32>(${w})` : `extractBits(bitcast<i32>(${w}), ${off}u, ${bits}u)`;
      return value(kind, bits, u, i);
    });
  }
  if (bgra) [comps[0], comps[2]] = [comps[2], comps[0]];
  const one = T === 'f32' ? '1.0' : T === 'i32' ? '1i' : '1u',
    zero = T === 'f32' ? '0.0' : T === 'i32' ? '0i' : '0u';
  const cast = natural === T ? T : `bitcast<${T}>`;
  return `vec4<${T}>(${[0, 1, 2, 3].map((k) => (comps[k] ? `${cast}(${comps[k]})` : k === 3 ? one : zero)).join(', ')})`;
}

/** Linear filtering of a blit's source (`t`), clamped to its edges, for formats WebGPU doesn't filter. */
export const BLIT_FILTER_2D = `fn at(x: i32, y: i32) -> vec4<f32> {
  return textureLoad(t, clamp(vec2<i32>(x, y), vec2<i32>(0), vec2<i32>(textureDimensions(t)) - 1), 0);
}
fn blit(uv: vec2<f32>) -> vec4<f32> {
  let c = uv * vec2<f32>(textureDimensions(t)) - 0.5;
  let b = vec2<i32>(floor(c));
  let f = c - floor(c);
  return mix(mix(at(b.x, b.y), at(b.x + 1, b.y), f.x), mix(at(b.x, b.y + 1), at(b.x + 1, b.y + 1), f.x), f.y);
}`;

export const BLIT_FILTER_3D = `fn at(x: i32, y: i32, z: i32) -> vec4<f32> {
  return textureLoad(t, clamp(vec3<i32>(x, y, z), vec3<i32>(0), vec3<i32>(textureDimensions(t)) - 1), 0);
}
fn plane(b: vec3<i32>, f: vec2<f32>, z: i32) -> vec4<f32> {
  return mix(mix(at(b.x, b.y, z), at(b.x + 1, b.y, z), f.x), mix(at(b.x, b.y + 1, z), at(b.x + 1, b.y + 1, z), f.x), f.y);
}
fn blit(uv: vec2<f32>, w: f32) -> vec4<f32> {
  let c = vec3<f32>(uv, w) * vec3<f32>(textureDimensions(t)) - 0.5;
  let b = vec3<i32>(floor(c));
  let f = c - floor(c);
  return mix(plane(b, f.xy, b.z), plane(b, f.xy, b.z + 1), f.z);
}`;
