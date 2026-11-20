// Texture formats' layouts for the Venus worker (web/venus-gpu.ts): texels encoded on the CPU (clears of formats
// WebGPU can't render to), packed formats' layouts and swizzles, and the WGSL that carries a texel's bits between
// layouts.
/** A clear colour as one texel of a colour format WebGPU can't render to (the snorm8 ones, rgb9e5ufloat,
 * rg11b10ufloat), or undefined for another. */
export function encodeTexel(fmt: string, c: number[]): Uint8Array | undefined {
  const snorm = { r8snorm: 1, rg8snorm: 2, rgba8snorm: 4 }[fmt];
  if (snorm)
    return Uint8Array.from(c.slice(0, snorm), (v) => Math.round(Math.min(1, Math.max(-1, v || 0)) * 127) & 255);
  const out = new Uint8Array(4),
    dv = new DataView(out.buffer);
  if (fmt === 'rgb9e5ufloat') {
    // Vulkan's (and GL's) shared-exponent encoding: 9-bit mantissas, a 5-bit exponent biased by 15.
    const max = (511 / 512) * 2 ** 16;
    const [r, g, b] = c.slice(0, 3).map((v) => Math.min(max, Math.max(0, v || 0)));
    const m = Math.max(r, g, b);
    let e = Math.max(-16, Math.floor(Math.log2(m))) + 16;
    if (Math.floor(m / 2 ** (e - 24) + 0.5) === 512) e++;
    const q = (v: number) => Math.floor(v / 2 ** (e - 24) + 0.5);
    dv.setUint32(0, (q(r) | (q(g) << 9) | (q(b) << 18) | (e << 27)) >>> 0, true);
    return out;
  }
  if (fmt === 'rg11b10ufloat') {
    // Unsigned floats: a 5-bit exponent biased by 15 and `bits` of mantissa, rounded to nearest.
    const uf = (v: number, bits: number) => {
      if (Number.isNaN(v)) return (31 << bits) | 1;
      if (!(v > 0)) return 0;
      let e = Math.max(-14, Math.floor(Math.log2(v)));
      let m = Math.round((v / 2 ** e) * 2 ** bits);
      if (m >= 2 ** (bits + 1)) {
        e++;
        m = Math.round((v / 2 ** e) * 2 ** bits);
      }
      if (e > 15) return (30 << bits) | (2 ** bits - 1);
      return m < 2 ** bits ? m : ((e + 15) << bits) | (m - 2 ** bits);
    };
    dv.setUint32(0, (uf(c[0], 6) | (uf(c[1], 6) << 11) | (uf(c[2], 5) << 22)) >>> 0, true);
    return out;
  }
  if (fmt === 'rgb10a2uint') {
    // A scaled format's texture (VK4 T31): the integers clamped to their bits.
    const [r, g, b, a] = c.map((v, i) => Math.min(i < 3 ? 1023 : 3, Math.max(0, Math.trunc(v || 0))));
    dv.setUint32(0, (r | (g << 10) | (b << 20) | (a << 30)) >>> 0, true);
    return out;
  }
  // Float, unorm and integer formats WebGPU doesn't render to here (a scaled format's integer texture: VK4 T31).
  const m = /^(r|rg|rgba)(8|16|32)(unorm|float|uint|sint)$/.exec(fmt);
  if (m) {
    const n = m[1].length,
      bytes = Number(m[2]) / 8,
      t = new Uint8Array(n * bytes);
    const v = new DataView(t.buffer) as DataView & { setFloat16(at: number, x: number, le: boolean): void };
    for (let i = 0; i < n; i++) {
      const x = c[i] || 0,
        at = i * bytes;
      if (m[3] === 'float') {
        if (bytes === 2) v.setFloat16(at, x, true);
        else v.setFloat32(at, x, true);
      } else if (m[3] !== 'unorm') {
        const bits = 8 * bytes,
          signed = m[3] === 'sint';
        const q = Math.min(
          signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1,
          Math.max(signed ? -(2 ** (bits - 1)) : 0, Math.trunc(x)),
        );
        if (bytes === 1) v.setUint8(at, q & 0xff);
        else if (bytes === 2) v.setUint16(at, q & 0xffff, true);
        else v.setUint32(at, q >>> 0, true);
      } else {
        const q = Math.round(Math.min(1, Math.max(0, x)) * (2 ** (8 * bytes) - 1));
        if (bytes === 1) v.setUint8(at, q);
        else if (bytes === 2) v.setUint16(at, q, true);
        else v.setUint32(at, q, true);
      }
    }
    return t;
  }
  return undefined;
}

/** A packed format's texture's own layout (`[shift, bits]` of R, G, B, A, then a texel's bytes): what `packPass` unpacks
 * into and packs from. */
export function textureLayout(f: string) {
  if (f.startsWith('rgb10a2'))
    return [0, 10, 10, 10, 20, 10, 30, 2, 4, ...Array<number>(4).fill(f.endsWith('uint') ? 2 : 0)];
  const m = /^(r|rg|rgba)(8|16|32)(unorm|snorm|uint|sint|float)(-srgb)?$/.exec(f);
  if (!m) throw new Error(`a packed format in a ${f} texture`);
  const n = m[1].length,
    bits = Number(m[2]),
    kind = ['unorm', 'snorm', 'uint', 'sint', 'float'].indexOf(m[3]);
  const l = [0, 1, 2, 3].flatMap((c) => (c < n ? [c * bits, bits] : [0, 0]));
  return [...l, (n * bits) / 8, ...[0, 1, 2, 3].map((c) => (c < n ? kind : 0))];
}

/** The swizzle of a copy between packed layouts (`[shift, bits]` of R, G, B, A; their textures are RGBA8): each channel
 * of the destination takes the source's whose bits are where its are. Undefined: no such channels. */
export function packedSwizzle(from?: number[], to?: number[]) {
  if (!from || !to) return undefined;
  let s = '';
  for (let c = 0; c < 4; c++) {
    if (!to[2 * c + 1]) {
      s += 'rgba'[c];
      continue;
    }
    const k = [0, 1, 2, 3].find((i) => from[2 * i] === to[2 * c] && from[2 * i + 1] === to[2 * c + 1]);
    if (k === undefined) return undefined;
    s += 'rgba'[k];
  }
  return s;
}

/** A texel's channels as raw bits: each channel's place and width in the texel's bytes and how its value is one. */
export type TexelField = { c: number; at: number; n: number; kind: 'unorm' | 'uint' | 'sint' | 'float' };

/**
 * A texture format's texel as bit fields (the plain 8-, 16- and 32-bit ones, rgb10a2), or a packed format's from its key
 * (`packed`: each channel's shift and size, the texel's bytes, each channel's kind: wg_device.c `packed_key`, its
 * texture holding a channel's value). SNORM's aren't (VK4 T38's 10-bit orders mark their most negative code), nor are
 * formats of other layouts: undefined.
 */
export function texelFields(format: string, packed?: number[]): { bytes: number; fields: TexelField[] } | undefined {
  if (packed) {
    const fields: TexelField[] = [];
    for (let c = 0; c < 4; c++) {
      const n = packed[2 * c + 1];
      if (!n) continue;
      const kind = (['unorm', undefined, 'uint', 'sint', 'float'] as const)[packed[9 + c] ?? 0];
      if (!kind || (packed[2 * c] & 31) + n > 32) return undefined;
      fields.push({ c, at: packed[2 * c], n, kind });
    }
    return { bytes: packed[8], fields };
  }
  const ten = /^rgb10a2(unorm|uint)$/.exec(format);
  if (ten) {
    const kind = ten[1] as 'unorm' | 'uint';
    return { bytes: 4, fields: [0, 1, 2, 3].map((c) => ({ c, at: c * 10, n: c === 3 ? 2 : 10, kind })) };
  }
  const m = /^(bgra|rgba|rg|r)(8|16|32)(unorm|uint|sint|float)$/.exec(format);
  if (!m || (m[3] === 'float' && m[2] === '8')) return undefined;
  const n = Number(m[2]),
    order = m[1] === 'bgra' ? [2, 1, 0, 3] : [0, 1, 2, 3].slice(0, m[1].length);
  return {
    bytes: (n * order.length) / 8,
    fields: order.map((c, k) => ({ c, at: k * n, n, kind: m[3] as TexelField['kind'] })),
  };
}

/**
 * A fragment shader's body that carries a texel's bits from one layout into another of its size (`v` the source's
 * value): a multisampled copy between formats (`copyMultisampled`), which a draw makes. '' for one format, undefined
 * where the layouts aren't both known (`texelFields`) or differ in size. A channel the destination has and the source
 * lacks gets the bits there are (zero); one the destination lacks is 0, alpha 1. Floats go through values, so a NaN or a
 * denormal of a float format may not keep its bits.
 */
export function bitsBetween(from: string, to: string, fromPacked?: number[], toPacked?: number[]) {
  if (from === to && fromPacked?.join() === toPacked?.join()) return '';
  const a = texelFields(from, fromPacked),
    b = texelFields(to, toPacked);
  if (!a || !b || a.bytes !== b.bytes || a.bytes > 8) return undefined;
  const mask = (n: number) => (n === 32 ? '0xffffffffu' : `${2 ** n - 1}u`);
  const raw = (f: TexelField) =>
    f.kind === 'unorm'
      ? `u32(round(v[${f.c}] * ${2 ** f.n - 1}.0))`
      : f.kind === 'float'
        ? f.n === 32
          ? `bitcast<u32>(v[${f.c}])`
          : `(pack2x16float(vec2<f32>(v[${f.c}], 0.0)) & 65535u)`
        : `(u32(v[${f.c}]) & ${mask(f.n)})`;
  const lines = ['var w = array<u32, 2>(0u, 0u);'];
  for (const f of a.fields) lines.push(`w[${f.at >> 5}] |= ${raw(f)} << ${f.at & 31}u;`);
  // The destination texture's kind: every field of a format is of one.
  const kinds = new Set(b.fields.map((f) => f.kind));
  if (kinds.size !== 1) return undefined;
  const bk = [...kinds][0];
  const kind = bk === 'unorm' || bk === 'float' ? 'f32' : bk === 'uint' ? 'u32' : 'i32';
  const out: string[] = ['0', '0', '0', '1'];
  for (const f of b.fields) {
    const bits = `((w[${f.at >> 5}] >> ${f.at & 31}u) & ${mask(f.n)})`;
    out[f.c] =
      f.kind === 'unorm'
        ? `f32(${bits}) / ${2 ** f.n - 1}.0`
        : f.kind === 'float'
          ? f.n === 32
            ? `bitcast<f32>(${bits})`
            : `unpack2x16float(${bits}).x`
          : f.kind === 'uint'
            ? bits
            : `(i32(${bits} << ${32 - f.n}u) >> ${32 - f.n}u)`;
  }
  lines.push(
    `return vec4<${kind}>(${out.map((x) => (/^[01]$/.test(x) ? (kind === 'f32' ? `${x}.0` : kind === 'u32' ? `${x}u` : x) : x)).join(', ')});`,
  );
  return lines.join('\n  ');
}

/** A narrower integer format's limits, as WGSL's vector arguments. */
export function integerRange(f: string): [string, string] | undefined {
  if (f === 'rgb10a2uint') return ['0', '1023, 1023, 1023, 3'];
  const m = /^r(?:g|gba)?(8|16)(u|s)int$/.exec(f);
  if (!m) return undefined;
  const bits = Number(m[1]);
  return m[2] === 'u' ? ['0', String(2 ** bits - 1)] : [String(-(2 ** (bits - 1))), String(2 ** (bits - 1) - 1)];
}

/** A depth or stencil format's texture (WebGPU's: depth16unorm, depth24plus…, depth32float…, stencil8). */
export function isDepthStencil(f: string) {
  return f.startsWith('depth') || f === 'stencil8';
}

/** A texture format's WGSL sample type. */
export function sampleKind(f: string): 'f32' | 'u32' | 'i32' {
  return f.endsWith('uint') ? 'u32' : f.endsWith('sint') ? 'i32' : 'f32';
}
