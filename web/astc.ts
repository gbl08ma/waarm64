/*-------------------------------------------------------------------------
 * Ported from the drawElements Quality Program Tester Core's ASTC utilities (VK-GL-CTS
 * `framework/common/tcuAstcUtil.cpp`, `vulkan-cts-1.4.7.0`):
 *
 * Copyright 2016 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Changes (webpc, VK4 T35; THIRD_PARTY.json `cts-astc-decoder`): the block decompression rewritten in WGSL, an
 * invocation a block, for the GPU worker's decode of 3D ASTC images (vk/README.md "3D ASTC"); the trit and quint
 * decodings computed from the ASTC specification's procedure instead of tables; texels written as the worker's
 * temporary buffer's rows (8-bit sRGB, or half floats), not to a pixel access.
 *-------------------------------------------------------------------------*/

/** The decode's parameters (`ASTC_WGSL`'s uniform `p`): the block's size, the mode (0 LDR to half floats, 1 sRGB to
 * 8 bits, 2 HDR to half floats), the level's size in texels, the first block slab of the dispatch, and the output's
 * row pitch in words and rows an image. */
export const ASTC_PARAM_WORDS = 12;

/** One invocation a block of a level of the blocks' texture (`blocks`: rgba32uint, a block a texel, its 128 bits
 * little-endian), its texels into `out`. */
export const ASTC_WGSL = /* wgsl */ `
struct P { bw: u32, bh: u32, bd: u32, mode: u32, w: u32, h: u32, d: u32, z0: u32, row: u32, rows: u32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var blocks: texture_3d<u32>;
@group(0) @binding(1) var<storage, read_write> out: array<u32>;
@group(0) @binding(2) var<uniform> p: P;

var<private> blk: array<u32, 4>;

// Bits [low, low + n) of the block (n <= 32; bits past 128 read 0).
fn bits(low: i32, n: i32) -> u32 {
  if (n <= 0 || low >= 128) { return 0u; }
  let w = u32(low) >> 5u;
  let o = u32(low) & 31u;
  var v = blk[w] >> o;
  if (o != 0u && w < 3u) { v = v | (blk[w + 1u] << (32u - o)); }
  if (n < 32) { v = v & ((1u << u32(n)) - 1u); }
  return v;
}
fn bit(i: i32) -> u32 { return bits(i, 1); }
fn reverse_bits(v: u32, n: i32) -> u32 {
  if (n <= 0) { return 0u; }
  return reverseBits(v) >> (32u - u32(n));
}
fn gb(v: u32, low: u32, high: u32) -> u32 { return extractBits(v, low, high - low + 1u); }
fn sign_extend(v: i32, n: u32) -> i32 { return (v << (32u - n)) >> (32u - n); }

// BitAccessStream.
var<private> s_start: i32;
var<private> s_len: i32;
var<private> s_fwd: bool;
var<private> s_ndx: i32;
fn stream(start: i32, len: i32, fwd: bool) { s_start = start; s_len = len; s_fwd = fwd; s_ndx = 0; }
fn take(num: i32) -> u32 {
  if (num == 0 || s_ndx >= s_len) { s_ndx = s_ndx + num; return 0u; }
  let n = max(0, min(s_len, s_ndx + num) - s_ndx);
  let low = s_ndx;
  let high = s_ndx + n - 1;
  s_ndx = s_ndx + num;
  if (s_fwd) { return bits(s_start + low, n); }
  return reverse_bits(bits(s_start - high, n), n);
}

// The ISE's decoded values: m (bits), tq (trit or quint), v.
var<private> ise_m: array<u32, 64>;
var<private> ise_tq: array<u32, 64>;
var<private> ise_v: array<u32, 64>;

// The specification's trit and quint decodings: T's five trits (3 bits each), Q's three quints.
fn trits(T: u32) -> u32 {
  var C: u32; var t4: u32; var t3: u32;
  if (gb(T, 2u, 4u) == 7u) { C = (gb(T, 5u, 7u) << 2u) | gb(T, 0u, 1u); t4 = 2u; t3 = 2u; }
  else {
    C = gb(T, 0u, 4u);
    if (gb(T, 5u, 6u) == 3u) { t4 = 2u; t3 = gb(T, 7u, 7u); } else { t4 = gb(T, 7u, 7u); t3 = gb(T, 5u, 6u); }
  }
  var t2: u32; var t1: u32; var t0: u32;
  if (gb(C, 0u, 1u) == 3u) { t2 = 2u; t1 = gb(C, 4u, 4u); t0 = (gb(C, 3u, 3u) << 1u) | (gb(C, 2u, 2u) & ~gb(C, 3u, 3u) & 1u); }
  else if (gb(C, 2u, 3u) == 3u) { t2 = 2u; t1 = 2u; t0 = gb(C, 0u, 1u); }
  else { t2 = gb(C, 4u, 4u); t1 = gb(C, 2u, 3u); t0 = (gb(C, 1u, 1u) << 1u) | (gb(C, 0u, 0u) & ~gb(C, 1u, 1u) & 1u); }
  return t0 | (t1 << 3u) | (t2 << 6u) | (t3 << 9u) | (t4 << 12u);
}
fn quints(Q: u32) -> u32 {
  var q0: u32; var q1: u32; var q2: u32;
  if (gb(Q, 1u, 2u) == 3u && gb(Q, 5u, 6u) == 0u) {
    let q0b = gb(Q, 0u, 0u);
    q2 = (q0b << 2u) | ((gb(Q, 4u, 4u) & ~q0b & 1u) << 1u) | (gb(Q, 3u, 3u) & ~q0b & 1u);
    q1 = 4u; q0 = 4u;
  } else {
    var C: u32;
    if (gb(Q, 1u, 2u) == 3u) { q2 = 4u; C = (gb(Q, 3u, 4u) << 3u) | ((~gb(Q, 5u, 6u) & 3u) << 1u) | gb(Q, 0u, 0u); }
    else { q2 = gb(Q, 5u, 6u); C = gb(Q, 0u, 4u); }
    if (gb(C, 0u, 2u) == 5u) { q1 = 4u; q0 = gb(C, 3u, 4u); } else { q1 = gb(C, 3u, 4u); q0 = gb(C, 0u, 2u); }
  }
  return q0 | (q1 << 3u) | (q2 << 6u);
}

// mode: 0 trits, 1 quints, 2 plain bits.
fn decode_ise(at: i32, count: i32, mode: u32, nb: i32) {
  if (mode == 0u) {
    for (var b = 0; b * 5 < count; b++) {
      let n = min(5, count - 5 * b);
      var m: array<u32, 5>;
      m[0] = take(nb); var T01 = take(2);
      m[1] = take(nb); var T23 = take(2);
      m[2] = take(nb); var T4 = take(1);
      m[3] = take(nb); var T56 = take(2);
      m[4] = take(nb); var T7 = take(1);
      if (n < 2) { T23 = 0u; }
      if (n < 3) { T4 = 0u; }
      if (n < 4) { T56 = 0u; }
      if (n < 5) { T7 = 0u; }
      let t = trits((T7 << 7u) | (T56 << 5u) | (T4 << 4u) | (T23 << 2u) | T01);
      for (var i = 0; i < n; i++) {
        let k = at + 5 * b + i;
        let tq = (t >> (3u * u32(i))) & 7u;
        ise_m[k] = m[i]; ise_tq[k] = tq; ise_v[k] = (tq << u32(nb)) + m[i];
      }
    }
  } else if (mode == 1u) {
    for (var b = 0; b * 3 < count; b++) {
      let n = min(3, count - 3 * b);
      var m: array<u32, 3>;
      m[0] = take(nb); let Q012 = take(3);
      m[1] = take(nb); var Q34 = take(2);
      m[2] = take(nb); var Q56 = take(2);
      if (n < 2) { Q34 = 0u; }
      if (n < 3) { Q56 = 0u; }
      let q = quints((Q56 << 5u) | (Q34 << 3u) | Q012);
      for (var i = 0; i < n; i++) {
        let k = at + 3 * b + i;
        let tq = (q >> (3u * u32(i))) & 7u;
        ise_m[k] = m[i]; ise_tq[k] = tq; ise_v[k] = (tq << u32(nb)) + m[i];
      }
    }
  } else {
    for (var i = 0; i < count; i++) {
      let v = take(nb);
      ise_m[at + i] = v; ise_tq[at + i] = 0u; ise_v[at + i] = v;
    }
  }
}

fn ise_bits(mode: u32, nb: i32, count: i32) -> i32 {
  if (mode == 0u) { return (count * 8 + 4) / 5 + count * nb; }
  if (mode == 1u) { return (count * 7 + 2) / 3 + count * nb; }
  return count * nb;
}

fn replicate(src: u32, ns: i32, nd: i32) -> u32 {
  if (ns <= 0) { return 0u; }
  var dst = 0u;
  for (var shift = nd - ns; shift > -ns; shift -= ns) {
    if (shift >= 0) { dst = dst | (src << u32(shift)); } else { dst = dst | (src >> u32(-shift)); }
  }
  return dst;
}

// The block mode (bits [0, 10]).
struct Mode { error: bool, void_extent: bool, dual: bool, gw: i32, gh: i32, gd: i32, ise: u32, nb: i32 }

fn weight_ise(r: u32, h: bool, md: ptr<function, Mode>) {
  (*md).ise = 2u; (*md).nb = 0;
  if (h) {
    switch (r) {
      case 2u: { (*md).ise = 1u; (*md).nb = 1; }
      case 3u: { (*md).ise = 0u; (*md).nb = 2; }
      case 4u: { (*md).nb = 4; }
      case 5u: { (*md).ise = 1u; (*md).nb = 2; }
      case 6u: { (*md).ise = 0u; (*md).nb = 3; }
      case 7u: { (*md).nb = 5; }
      default: {}
    }
  } else {
    switch (r) {
      case 2u: { (*md).nb = 1; }
      case 3u: { (*md).ise = 0u; }
      case 4u: { (*md).nb = 2; }
      case 5u: { (*md).ise = 1u; }
      case 6u: { (*md).ise = 0u; (*md).nb = 1; }
      case 7u: { (*md).nb = 3; }
      default: {}
    }
  }
}

fn block_mode_2d(d: u32) -> Mode {
  var md = Mode(true, gb(d, 0u, 8u) == 0x1fcu, true, -1, -1, 1, 3u, -1);
  if (md.void_extent) { md.error = false; return md; }
  if ((gb(d, 0u, 1u) == 0u && gb(d, 6u, 8u) == 7u) || gb(d, 0u, 3u) == 0u) { return md; }
  var r: u32;
  if (gb(d, 0u, 1u) == 0u) {
    r = (gb(d, 3u, 3u) << 2u) | (gb(d, 2u, 2u) << 1u) | gb(d, 4u, 4u);
    let i78 = gb(d, 7u, 8u);
    if (i78 == 3u) {
      let i5 = gb(d, 5u, 5u) != 0u;
      md.gw = select(6, 10, i5); md.gh = select(10, 6, i5);
    } else {
      let a = i32(gb(d, 5u, 6u));
      if (i78 == 0u) { md.gw = 12; md.gh = a + 2; }
      else if (i78 == 1u) { md.gw = a + 2; md.gh = 12; }
      else { md.gw = a + 6; md.gh = i32(gb(d, 9u, 10u)) + 6; }
    }
  } else {
    r = (gb(d, 1u, 1u) << 2u) | (gb(d, 0u, 0u) << 1u) | gb(d, 4u, 4u);
    let i23 = gb(d, 2u, 3u);
    let a = i32(gb(d, 5u, 6u));
    if (i23 == 3u) {
      let b = i32(gb(d, 7u, 7u));
      let i8 = gb(d, 8u, 8u) != 0u;
      md.gw = select(a + 2, b + 2, i8); md.gh = select(b + 6, a + 2, i8);
    } else {
      let b = i32(gb(d, 7u, 8u));
      if (i23 == 0u) { md.gw = b + 4; md.gh = a + 2; }
      else if (i23 == 1u) { md.gw = b + 8; md.gh = a + 2; }
      else { md.gw = a + 2; md.gh = b + 8; }
    }
  }
  let zero_dh = gb(d, 0u, 1u) == 0u && gb(d, 7u, 8u) == 2u;
  let h = !zero_dh && gb(d, 9u, 9u) != 0u;
  md.dual = !zero_dh && gb(d, 10u, 10u) != 0u;
  weight_ise(r, h, &md);
  md.error = false;
  return md;
}

fn block_mode_3d(d: u32) -> Mode {
  var md = Mode(true, gb(d, 0u, 8u) == 0x1fcu, true, -1, -1, -1, 3u, -1);
  if (md.void_extent) { md.error = false; return md; }
  if ((gb(d, 0u, 1u) == 0u && gb(d, 5u, 8u) == 7u) || gb(d, 0u, 3u) == 0u) { return md; }
  var r: u32;
  if (gb(d, 0u, 1u) == 0u) {
    r = (gb(d, 3u, 3u) << 2u) | (gb(d, 2u, 2u) << 1u) | gb(d, 4u, 4u);
    let i78 = gb(d, 7u, 8u);
    if (i78 == 3u) {
      let i5 = gb(d, 5u, 5u) != 0u;
      let i6 = gb(d, 6u, 6u) != 0u;
      md.gw = select(select(6, 2, i6), 2, i5);
      md.gh = select(2, 6, i5);
      md.gd = select(select(2, 6, i6), 2, i5);
    } else {
      let a = i32(gb(d, 9u, 10u));
      let b = i32(gb(d, 5u, 6u));
      if (i78 == 0u) { md.gw = 6; md.gh = a + 2; md.gd = b + 2; }
      else if (i78 == 1u) { md.gw = b + 2; md.gh = 6; md.gd = a + 2; }
      else { md.gw = b + 2; md.gh = a + 2; md.gd = 6; }
    }
  } else {
    r = (gb(d, 1u, 1u) << 2u) | (gb(d, 0u, 0u) << 1u) | gb(d, 4u, 4u);
    md.gw = i32(gb(d, 5u, 6u)) + 2;
    md.gh = i32(gb(d, 7u, 8u)) + 2;
    md.gd = i32(gb(d, 2u, 3u)) + 2;
  }
  let zero_dh = gb(d, 0u, 1u) == 0u && gb(d, 7u, 8u) != 3u;
  let h = !zero_dh && gb(d, 9u, 9u) != 0u;
  md.dual = !zero_dh && gb(d, 10u, 10u) != 0u;
  weight_ise(r, h, &md);
  md.error = false;
  return md;
}

// The texels' values: an sRGB byte each (packed), or half floats' bits (two a word).
var<private> texel_x: u32;
var<private> texel_y: u32;
var<private> texel_z: u32;

fn put(x: u32, y: u32, z: u32, c: vec4<u32>) {
  let gx = texel_x + x; let gy = texel_y + y; let gz = texel_z + z;
  if (gx >= p.w || gy >= p.h || gz >= p.d) { return; }
  let rz = gz - p.z0 * p.bd;
  if (p.mode == 1u) {
    out[(rz * p.rows + gy) * p.row + gx] = c.x | (c.y << 8u) | (c.z << 16u) | (c.w << 24u);
  } else {
    let at = (rz * p.rows + gy) * p.row + 2u * gx;
    out[at] = c.x | (c.y << 16u);
    out[at + 1u] = c.z | (c.w << 16u);
  }
}

fn to_half(f: f32) -> u32 { return pack2x16float(vec2<f32>(f, 0.0)) & 0xffffu; }
// An LDR channel's 16 bits as the reference's float (65535 is 1), to half.
fn ldr16(c: u32) -> u32 { return select(to_half(f32(c) / 65536.0), 0x3c00u, c == 65535u); }

fn error_block() {
  for (var z = 0u; z < p.bd; z++) { for (var y = 0u; y < p.bh; y++) { for (var x = 0u; x < p.bw; x++) {
    if (p.mode == 1u) { put(x, y, z, vec4<u32>(255u, 0u, 255u, 255u)); }
    else { put(x, y, z, vec4<u32>(0x3c00u, 0u, 0x3c00u, 0x3c00u)); }
  } } }
}

fn void_extent() {
  let min_s = bits(12, 13); let max_s = bits(25, 13); let min_t = bits(38, 13); let max_t = bits(51, 13);
  let all_ones = min_s == 0x1fffu && max_s == 0x1fffu && min_t == 0x1fffu && max_t == 0x1fffu;
  let hdr = bit(9) != 0u;
  if ((p.mode != 2u && hdr) || (!all_ones && (min_s >= max_s || min_t >= max_t))) { error_block(); return; }
  let rgba = vec4<u32>(bits(64, 16), bits(80, 16), bits(96, 16), bits(112, 16));
  var c: vec4<u32>;
  if (p.mode == 1u) { c = rgba >> vec4<u32>(8u); }
  else if (hdr) { c = rgba; }
  else { c = vec4<u32>(ldr16(rgba.x), ldr16(rgba.y), ldr16(rgba.z), ldr16(rgba.w)); }
  for (var z = 0u; z < p.bd; z++) { for (var y = 0u; y < p.bh; y++) { for (var x = 0u; x < p.bw; x++) { put(x, y, z, c); } } }
}

// Colour endpoints.
var<private> e0s: array<vec4<u32>, 4>;
var<private> e1s: array<vec4<u32>, 4>;
var<private> unq: array<u32, 18>;

fn unquantize_endpoints(count: i32, mode: u32, nb: i32) {
  if (mode == 2u) {
    for (var i = 0; i < count; i++) { unq[i] = replicate(ise_v[i], nb, 8); }
    return;
  }
  let range_case = nb * 2 - select(1, 2, mode == 0u);
  let Ca = array<u32, 11>(204u, 113u, 93u, 54u, 44u, 26u, 22u, 13u, 11u, 6u, 5u);
  let C = Ca[range_case];
  for (var i = 0; i < count; i++) {
    let m = ise_m[i];
    let a = gb(m, 0u, 0u); let b = gb(m, 1u, 1u); let c = gb(m, 2u, 2u);
    let d = gb(m, 3u, 3u); let e = gb(m, 4u, 4u); let f = gb(m, 5u, 5u);
    let A = select(0u, 511u, a != 0u);
    var B = 0u;
    switch (range_case) {
      case 2: { B = (b << 8u) | (b << 4u) | (b << 2u) | (b << 1u); }
      case 3: { B = (b << 8u) | (b << 3u) | (b << 2u); }
      case 4: { B = (c << 8u) | (b << 7u) | (c << 3u) | (b << 2u) | (c << 1u) | b; }
      case 5: { B = (c << 8u) | (b << 7u) | (c << 2u) | (b << 1u) | c; }
      case 6: { B = (d << 8u) | (c << 7u) | (b << 6u) | (d << 2u) | (c << 1u) | b; }
      case 7: { B = (d << 8u) | (c << 7u) | (b << 6u) | (d << 1u) | c; }
      case 8: { B = (e << 8u) | (d << 7u) | (c << 6u) | (b << 5u) | (e << 1u) | d; }
      case 9: { B = (e << 8u) | (d << 7u) | (c << 6u) | (b << 5u) | e; }
      case 10: { B = (f << 8u) | (e << 7u) | (d << 6u) | (c << 5u) | (b << 4u) | f; }
      default: {}
    }
    unq[i] = (((ise_tq[i] * C + B) ^ A) >> 2u) | (A & 0x80u);
  }
}

fn bit_transfer_signed(a: ptr<function, i32>, b: ptr<function, i32>) {
  *b = *b >> 1u;
  *b = *b | (*a & 0x80);
  *a = *a >> 1u;
  *a = *a & 0x3f;
  if ((*a & 0x20) != 0) { *a = *a - 0x40; }
}
fn clamped(v: vec4<i32>) -> vec4<u32> { return vec4<u32>(clamp(v, vec4<i32>(0), vec4<i32>(255))); }
fn blue_contract(r: i32, g: i32, b: i32, a: i32) -> vec4<i32> { return vec4<i32>((r + b) >> 1u, (g + b) >> 1u, b, a); }
fn is_hdr(mode: u32) -> bool { return mode == 2u || mode == 3u || mode == 7u || mode == 11u || mode == 14u || mode == 15u; }

fn hdr7(k: i32, v0: u32, v1: u32, v2: u32, v3: u32) {
  let m10 = gb(v1, 7u, 7u) | (gb(v2, 7u, 7u) << 1u);
  let m23 = gb(v0, 6u, 7u);
  let maj = select(select(0u, m23, m23 != 3u), m10, m10 != 3u);
  let mode = select(select(5u, 4u, m23 != 3u), m23, m10 != 3u);
  var R = i32(gb(v0, 0u, 5u)); var G = i32(gb(v1, 0u, 4u)); var B = i32(gb(v2, 0u, 4u)); var S = i32(gb(v3, 0u, 4u));
  let x0 = i32(gb(v1, 6u, 6u)); let x1 = i32(gb(v1, 5u, 5u)); let x2 = i32(gb(v2, 6u, 6u)); let x3 = i32(gb(v2, 5u, 5u));
  let x4 = i32(gb(v3, 7u, 7u)); let x5 = i32(gb(v3, 6u, 6u)); let x6 = i32(gb(v3, 5u, 5u));
  switch (mode) {
    case 0u: { R |= (x0 << 9u) | (x1 << 8u) | (x2 << 7u) | (x3 << 10u) | (x4 << 6u); S |= (x5 << 6u) | (x6 << 5u); }
    case 1u: { R |= (x0 << 8u) | (x2 << 7u) | (x4 << 6u) | (x5 << 10u) | (x6 << 9u); G |= x1 << 5u; B |= x3 << 5u; }
    case 2u: { R |= (x0 << 9u) | (x1 << 8u) | (x2 << 7u) | (x3 << 6u); S |= (x4 << 7u) | (x5 << 6u) | (x6 << 5u); }
    case 3u: { R |= (x0 << 8u) | (x2 << 7u) | (x4 << 6u); G |= x1 << 5u; B |= x3 << 5u; S |= (x5 << 6u) | (x6 << 5u); }
    case 4u: { G |= (x0 << 6u) | (x1 << 5u); B |= (x2 << 6u) | (x3 << 5u); R |= (x4 << 6u) | (x5 << 7u); S |= x6 << 5u; }
    default: { G |= (x0 << 6u) | (x1 << 5u); B |= (x2 << 6u) | (x3 << 5u); R |= x4 << 6u; S |= (x5 << 6u) | (x6 << 5u); }
  }
  let shifts = array<u32, 6>(1u, 1u, 2u, 3u, 4u, 5u);
  let sh = shifts[mode];
  R = R << sh; G = G << sh; B = B << sh; S = S << sh;
  if (mode != 5u) { G = R - G; B = R - B; }
  if (maj == 1u) { let t = R; R = G; G = t; } else if (maj == 2u) { let t = R; R = B; B = t; }
  e0s[k] = vec4<u32>(u32(clamp(R - S, 0, 0xfff)), u32(clamp(G - S, 0, 0xfff)), u32(clamp(B - S, 0, 0xfff)), 0x780u);
  e1s[k] = vec4<u32>(u32(clamp(R, 0, 0xfff)), u32(clamp(G, 0, 0xfff)), u32(clamp(B, 0, 0xfff)), 0x780u);
}

fn hdr11(k: i32, v0: u32, v1: u32, v2: u32, v3: u32, v4: u32, v5: u32) {
  let major = (gb(v5, 7u, 7u) << 1u) | gb(v4, 7u, 7u);
  if (major == 3u) {
    e0s[k] = vec4<u32>(v0 << 4u, v2 << 4u, gb(v4, 0u, 6u) << 5u, 0x780u);
    e1s[k] = vec4<u32>(v1 << 4u, v3 << 4u, gb(v5, 0u, 6u) << 5u, 0x780u);
    return;
  }
  let mode = (gb(v3, 7u, 7u) << 2u) | (gb(v2, 7u, 7u) << 1u) | gb(v1, 7u, 7u);
  var a = i32((gb(v1, 6u, 6u) << 8u) | v0);
  var c = i32(gb(v1, 0u, 5u));
  var b0 = i32(gb(v2, 0u, 5u)); var b1 = i32(gb(v3, 0u, 5u));
  var d0 = i32(gb(v4, 0u, 4u)); var d1 = i32(gb(v5, 0u, 4u));
  let x0 = i32(gb(v2, 6u, 6u)); let x1 = i32(gb(v3, 6u, 6u)); let x2 = i32(gb(v4, 6u, 6u));
  let x3 = i32(gb(v5, 6u, 6u)); let x4 = i32(gb(v4, 5u, 5u)); let x5 = i32(gb(v5, 5u, 5u));
  switch (mode) {
    case 0u: { b0 |= x0 << 6u; b1 |= x1 << 6u; d0 |= (x2 << 6u) | (x4 << 5u); d1 |= (x3 << 6u) | (x5 << 5u); }
    case 1u: { b0 |= (x0 << 6u) | (x2 << 7u); b1 |= (x1 << 6u) | (x3 << 7u); d0 |= x4 << 5u; d1 |= x5 << 5u; }
    case 2u: { a |= x0 << 9u; c |= x1 << 6u; d0 |= (x2 << 6u) | (x4 << 5u); d1 |= (x3 << 6u) | (x5 << 5u); }
    case 3u: { b0 |= x0 << 6u; b1 |= x1 << 6u; a |= x2 << 9u; c |= x3 << 6u; d0 |= x4 << 5u; d1 |= x5 << 5u; }
    case 4u: { b0 |= (x0 << 6u) | (x2 << 7u); b1 |= (x1 << 6u) | (x3 << 7u); a |= (x4 << 9u) | (x5 << 10u); }
    case 5u: { a |= (x0 << 9u) | (x1 << 10u); c |= (x2 << 7u) | (x3 << 6u); d0 |= x4 << 5u; d1 |= x5 << 5u; }
    case 6u: { b0 |= x0 << 6u; b1 |= x1 << 6u; a |= (x2 << 11u) | (x4 << 9u) | (x5 << 10u); c |= x3 << 6u; }
    default: { a |= (x0 << 9u) | (x1 << 10u) | (x2 << 11u); c |= x3 << 6u; d0 |= x4 << 5u; d1 |= x5 << 5u; }
  }
  let nd = array<u32, 8>(7u, 6u, 7u, 6u, 5u, 6u, 5u, 6u);
  d0 = sign_extend(d0, nd[mode]); d1 = sign_extend(d1, nd[mode]);
  let sh = (mode >> 1u) ^ 3u;
  a = a << sh; c = c << sh; b0 = b0 << sh; b1 = b1 << sh; d0 = d0 << sh; d1 = d1 << sh;
  var p0 = vec4<u32>(u32(clamp(a - c, 0, 0xfff)), u32(clamp(a - b0 - c - d0, 0, 0xfff)), u32(clamp(a - b1 - c - d1, 0, 0xfff)), 0x780u);
  var p1 = vec4<u32>(u32(clamp(a, 0, 0xfff)), u32(clamp(a - b0, 0, 0xfff)), u32(clamp(a - b1, 0, 0xfff)), 0x780u);
  if (major == 1u) { p0 = p0.yxzw; p1 = p1.yxzw; } else if (major == 2u) { p0 = p0.zyxw; p1 = p1.zyxw; }
  e0s[k] = p0; e1s[k] = p1;
}

fn hdr15(k: i32, v0: u32, v1: u32, v2: u32, v3: u32, v4: u32, v5: u32, v6i: u32, v7i: u32) {
  hdr11(k, v0, v1, v2, v3, v4, v5);
  let mode = (gb(v7i, 7u, 7u) << 1u) | gb(v6i, 7u, 7u);
  var v6 = i32(gb(v6i, 0u, 6u)); var v7 = i32(gb(v7i, 0u, 6u));
  if (mode == 3u) { e0s[k].w = u32(v6 << 5u); e1s[k].w = u32(v7 << 5u); return; }
  v6 |= (v7 << (mode + 1u)) & 0x780;
  v7 &= (0x3f >> mode);
  v7 ^= 0x20 >> mode;
  v7 -= 0x20 >> mode;
  v6 = v6 << (4u - mode);
  v7 = v7 << (4u - mode);
  v7 += v6;
  v7 = clamp(v7, 0, 0xfff);
  e0s[k].w = u32(v6); e1s[k].w = u32(v7);
}

fn decode_endpoints(modes: vec4<u32>, parts: i32) {
  var at = 0;
  for (var k = 0; k < parts; k++) {
    let mode = modes[k];
    let v0 = unq[at]; let v1 = unq[at + 1]; let v2 = unq[min(at + 2, 17)]; let v3 = unq[min(at + 3, 17)];
    let v4 = unq[min(at + 4, 17)]; let v5 = unq[min(at + 5, 17)]; let v6 = unq[min(at + 6, 17)]; let v7 = unq[min(at + 7, 17)];
    at += i32((mode / 4u + 1u) * 2u);
    switch (mode) {
      case 0u: { e0s[k] = vec4<u32>(v0, v0, v0, 0xffu); e1s[k] = vec4<u32>(v1, v1, v1, 0xffu); }
      case 1u: {
        let L0 = (v0 >> 2u) | (gb(v1, 6u, 7u) << 6u);
        let L1 = min(0xffu, L0 + gb(v1, 0u, 5u));
        e0s[k] = vec4<u32>(L0, L0, L0, 0xffu); e1s[k] = vec4<u32>(L1, L1, L1, 0xffu);
      }
      case 2u: {
        let gr = v1 >= v0;
        let y0 = select((v1 << 4u) + 8u, v0 << 4u, gr);
        let y1 = select((v0 << 4u) - 8u, v1 << 4u, gr);
        e0s[k] = vec4<u32>(y0, y0, y0, 0x780u); e1s[k] = vec4<u32>(y1, y1, y1, 0x780u);
      }
      case 3u: {
        let m = gb(v0, 7u, 7u) != 0u;
        let y0 = select((gb(v1, 4u, 7u) << 8u) | (gb(v0, 0u, 6u) << 1u), (gb(v1, 5u, 7u) << 9u) | (gb(v0, 0u, 6u) << 2u), m);
        let d = select(gb(v1, 0u, 3u) << 1u, gb(v1, 0u, 4u) << 2u, m);
        let y1 = min(0xfffu, y0 + d);
        e0s[k] = vec4<u32>(y0, y0, y0, 0x780u); e1s[k] = vec4<u32>(y1, y1, y1, 0x780u);
      }
      case 4u: { e0s[k] = vec4<u32>(v0, v0, v0, v2); e1s[k] = vec4<u32>(v1, v1, v1, v3); }
      case 5u: {
        var a0 = i32(v0); var a1 = i32(v1); var a2 = i32(v2); var a3 = i32(v3);
        bit_transfer_signed(&a1, &a0); bit_transfer_signed(&a3, &a2);
        e0s[k] = clamped(vec4<i32>(a0, a0, a0, a2)); e1s[k] = clamped(vec4<i32>(a0 + a1, a0 + a1, a0 + a1, a2 + a3));
      }
      case 6u: {
        e0s[k] = vec4<u32>((v0 * v3) >> 8u, (v1 * v3) >> 8u, (v2 * v3) >> 8u, 0xffu); e1s[k] = vec4<u32>(v0, v1, v2, 0xffu);
      }
      case 7u: { hdr7(k, v0, v1, v2, v3); }
      case 8u: {
        if (v1 + v3 + v5 >= v0 + v2 + v4) { e0s[k] = vec4<u32>(v0, v2, v4, 0xffu); e1s[k] = vec4<u32>(v1, v3, v5, 0xffu); }
        else {
          e0s[k] = vec4<u32>(blue_contract(i32(v1), i32(v3), i32(v5), 0xff));
          e1s[k] = vec4<u32>(blue_contract(i32(v0), i32(v2), i32(v4), 0xff));
        }
      }
      case 9u: {
        var a0 = i32(v0); var a1 = i32(v1); var a2 = i32(v2); var a3 = i32(v3); var a4 = i32(v4); var a5 = i32(v5);
        bit_transfer_signed(&a1, &a0); bit_transfer_signed(&a3, &a2); bit_transfer_signed(&a5, &a4);
        if (a1 + a3 + a5 >= 0) {
          e0s[k] = clamped(vec4<i32>(a0, a2, a4, 0xff)); e1s[k] = clamped(vec4<i32>(a0 + a1, a2 + a3, a4 + a5, 0xff));
        } else {
          e0s[k] = clamped(blue_contract(a0 + a1, a2 + a3, a4 + a5, 0xff)); e1s[k] = clamped(blue_contract(a0, a2, a4, 0xff));
        }
      }
      case 10u: {
        e0s[k] = vec4<u32>((v0 * v3) >> 8u, (v1 * v3) >> 8u, (v2 * v3) >> 8u, v4); e1s[k] = vec4<u32>(v0, v1, v2, v5);
      }
      case 11u: { hdr11(k, v0, v1, v2, v3, v4, v5); }
      case 12u: {
        if (v1 + v3 + v5 >= v0 + v2 + v4) { e0s[k] = vec4<u32>(v0, v2, v4, v6); e1s[k] = vec4<u32>(v1, v3, v5, v7); }
        else {
          e0s[k] = clamped(blue_contract(i32(v1), i32(v3), i32(v5), i32(v7)));
          e1s[k] = clamped(blue_contract(i32(v0), i32(v2), i32(v4), i32(v6)));
        }
      }
      case 13u: {
        var a0 = i32(v0); var a1 = i32(v1); var a2 = i32(v2); var a3 = i32(v3);
        var a4 = i32(v4); var a5 = i32(v5); var a6 = i32(v6); var a7 = i32(v7);
        bit_transfer_signed(&a1, &a0); bit_transfer_signed(&a3, &a2); bit_transfer_signed(&a5, &a4); bit_transfer_signed(&a7, &a6);
        if (a1 + a3 + a5 >= 0) {
          e0s[k] = clamped(vec4<i32>(a0, a2, a4, a6)); e1s[k] = clamped(vec4<i32>(a0 + a1, a2 + a3, a4 + a5, a6 + a7));
        } else {
          e0s[k] = clamped(blue_contract(a0 + a1, a2 + a3, a4 + a5, a6 + a7)); e1s[k] = clamped(blue_contract(a0, a2, a4, a6));
        }
      }
      case 14u: { hdr11(k, v0, v1, v2, v3, v4, v5); e0s[k].w = v6; e1s[k].w = v7; }
      default: { hdr15(k, v0, v1, v2, v3, v4, v5, v6, v7); }
    }
  }
}

// Weights.
var<private> uw: array<u32, 64>;

fn unquantize_weights(count: i32, mode: u32, nb: i32) {
  if (mode == 2u) {
    for (var i = 0; i < count; i++) { uw[i] = replicate(ise_v[i], nb, 6); }
  } else {
    let range_case = nb * 2 + select(0, 1, mode == 1u);
    if (range_case == 0 || range_case == 1) {
      let map0 = array<u32, 3>(0u, 32u, 63u);
      let map1 = array<u32, 5>(0u, 16u, 32u, 47u, 63u);
      for (var i = 0; i < count; i++) {
        if (range_case == 0) { uw[i] = map0[min(ise_v[i], 2u)]; } else { uw[i] = map1[min(ise_v[i], 4u)]; }
      }
    } else {
      let Ca = array<u32, 5>(50u, 28u, 23u, 13u, 11u);
      let C = Ca[range_case - 2];
      for (var i = 0; i < count; i++) {
        let m = ise_m[i];
        let a = gb(m, 0u, 0u); let b = gb(m, 1u, 1u); let c = gb(m, 2u, 2u);
        let A = select(0u, 127u, a != 0u);
        var B = 0u;
        if (range_case == 4) { B = (b << 6u) | (b << 2u) | b; }
        else if (range_case == 5) { B = (b << 6u) | (b << 1u); }
        else if (range_case == 6) { B = (c << 6u) | (b << 5u) | (c << 1u) | b; }
        uw[i] = (((ise_tq[i] * C + B) ^ A) >> 2u) | (A & 0x20u);
      }
    }
  }
  for (var i = 0; i < count; i++) { if (uw[i] > 32u) { uw[i] = uw[i] + 1u; } }
  for (var i = count; i < 64; i++) { uw[i] = 0xffffffffu; }
}

// A texel's weight pair (plane 0, plane 1).
fn texel_weights(x: u32, y: u32, z: u32, md: Mode) -> vec2<u32> {
  let per = select(1u, 2u, md.dual);
  let sx = (1024u + p.bw / 2u) / (p.bw - 1u);
  let sy = (1024u + p.bh / 2u) / (p.bh - 1u);
  let gw = u32(md.gw); let gh = u32(md.gh); let gd = u32(md.gd);
  let gX = (sx * x * (gw - 1u) + 32u) >> 6u;
  let gY = (sy * y * (gh - 1u) + 32u) >> 6u;
  let jX = gX >> 4u; let jY = gY >> 4u; let fX = gX & 0xfu; let fY = gY & 0xfu;
  var out_w = vec2<u32>(0u);
  if (p.bd <= 1u) {
    let w11 = (fX * fY + 8u) >> 4u;
    let w10 = fY - w11;
    let w01 = fX - w11;
    let w00 = 16u - fX - fY + w11;
    let i00 = jY * gw + jX;
    let i01 = i00 + 1u;
    let i10 = i00 + gw;
    let i11 = i00 + gw + 1u;
    for (var t = 0u; t < per; t++) {
      let p00 = uw[(i00 * per + t) & 0x3fu]; let p01 = uw[(i01 * per + t) & 0x3fu];
      let p10 = uw[(i10 * per + t) & 0x3fu]; let p11 = uw[(i11 * per + t) & 0x3fu];
      out_w[t] = (p00 * w00 + p01 * w01 + p10 * w10 + p11 * w11 + 8u) >> 4u;
    }
    return out_w;
  }
  let sz = (1024u + p.bd / 2u) / (p.bd - 1u);
  let gZ = (sz * z * (gd - 1u) + 32u) >> 6u;
  let jZ = gZ >> 4u; let fZ = gZ & 0xfu;
  let q0 = (jZ * gh + jY) * gw + jX;
  let q3 = ((jZ + 1u) * gh + (jY + 1u)) * gw + (jX + 1u);
  let cas = (select(0u, 4u, fX > fY)) + (select(0u, 2u, fY > fZ)) + (select(0u, 1u, fX > fZ));
  let N = gw; let NM = gw * gh;
  var s1: u32; var s2: u32; var w0: u32; var w1: u32; var w2: u32; var w3: u32;
  switch (cas) {
    case 7u: { s1 = 1u; s2 = N; w0 = 16u - fX; w1 = fX - fY; w2 = fY - fZ; w3 = fZ; }
    case 3u: { s1 = N; s2 = 1u; w0 = 16u - fY; w1 = fY - fX; w2 = fX - fZ; w3 = fZ; }
    case 5u: { s1 = 1u; s2 = NM; w0 = 16u - fX; w1 = fX - fZ; w2 = fZ - fY; w3 = fY; }
    case 4u: { s1 = NM; s2 = 1u; w0 = 16u - fZ; w1 = fZ - fX; w2 = fX - fY; w3 = fY; }
    case 2u: { s1 = N; s2 = NM; w0 = 16u - fY; w1 = fY - fZ; w2 = fZ - fX; w3 = fX; }
    default: { s1 = NM; s2 = N; w0 = 16u - fZ; w1 = fZ - fY; w2 = fY - fX; w3 = fX; }
  }
  let q1 = q0 + s1;
  let q2 = q1 + s2;
  for (var t = 0u; t < per; t++) {
    let p00 = uw[(q0 * per + t) & 0x3fu]; let p01 = uw[(q1 * per + t) & 0x3fu];
    let p10 = uw[(q2 * per + t) & 0x3fu]; let p11 = uw[(q3 * per + t) & 0x3fu];
    out_w[t] = (p00 * w0 + p01 * w1 + p10 * w2 + p11 * w3 + 8u) >> 4u;
  }
  return out_w;
}

fn hash52(v: u32) -> u32 {
  var q = v;
  q ^= q >> 15u; q -= q << 17u; q += q << 7u; q += q << 4u; q ^= q >> 5u;
  q += q << 16u; q ^= q >> 7u; q ^= q >> 3u; q ^= q << 6u; q ^= q >> 17u;
  return q;
}

fn texel_partition(seed_in: u32, xi: u32, yi: u32, zi: u32, parts: u32, small: bool) -> u32 {
  let x = select(xi, xi << 1u, small); let y = select(yi, yi << 1u, small); let z = select(zi, zi << 1u, small);
  let seed = seed_in + 1024u * (parts - 1u);
  let rnum = hash52(seed);
  var s: array<u32, 12>;
  s[0] = rnum & 0xfu; s[1] = (rnum >> 4u) & 0xfu; s[2] = (rnum >> 8u) & 0xfu; s[3] = (rnum >> 12u) & 0xfu;
  s[4] = (rnum >> 16u) & 0xfu; s[5] = (rnum >> 20u) & 0xfu; s[6] = (rnum >> 24u) & 0xfu; s[7] = (rnum >> 28u) & 0xfu;
  s[8] = (rnum >> 18u) & 0xfu; s[9] = (rnum >> 22u) & 0xfu; s[10] = (rnum >> 26u) & 0xfu;
  s[11] = ((rnum >> 30u) | (rnum << 2u)) & 0xfu;
  for (var i = 0; i < 12; i++) { s[i] = (s[i] * s[i]) & 0xffu; }
  let shA = select(5u, 4u, (seed & 2u) != 0u);
  let shB = select(5u, 6u, parts == 3u);
  let sh1 = select(shB, shA, (seed & 1u) != 0u);
  let sh2 = select(shA, shB, (seed & 1u) != 0u);
  let sh3 = select(sh2, sh1, (seed & 0x10u) != 0u);
  s[0] >>= sh1; s[1] >>= sh2; s[2] >>= sh1; s[3] >>= sh2; s[4] >>= sh1; s[5] >>= sh2; s[6] >>= sh1; s[7] >>= sh2;
  s[8] >>= sh3; s[9] >>= sh3; s[10] >>= sh3; s[11] >>= sh3;
  let a = 0x3fu & (s[0] * x + s[1] * y + s[10] * z + (rnum >> 14u));
  let b = 0x3fu & (s[2] * x + s[3] * y + s[11] * z + (rnum >> 10u));
  let c = select(0u, 0x3fu & (s[4] * x + s[5] * y + s[8] * z + (rnum >> 6u)), parts >= 3u);
  let d = select(0u, 0x3fu & (s[6] * x + s[7] * y + s[9] * z + (rnum >> 2u)), parts >= 4u);
  if (a >= b && a >= c && a >= d) { return 0u; }
  if (b >= c && b >= d) { return 1u; }
  if (c >= d) { return 2u; }
  return 3u;
}

fn decompress() {
  var md: Mode;
  if (p.bd > 1u) { md = block_mode_3d(bits(0, 11)); } else { md = block_mode_2d(bits(0, 11)); }
  if (md.error) { error_block(); return; }
  if (md.void_extent) { void_extent(); return; }
  let num_weights = md.gw * md.gh * md.gd * select(1, 2, md.dual);
  let weight_bits = ise_bits(md.ise, md.nb, num_weights);
  let parts = i32(bits(11, 2)) + 1;
  if (num_weights > 64 || weight_bits > 96 || weight_bits < 24 || md.gw > i32(p.bw) || md.gd > i32(p.bd) ||
      md.gh > i32(p.bh) || (parts == 4 && md.dual)) { error_block(); return; }
  let single_cem = parts == 1 || bits(23, 2) == 0u;
  var config_bits = select(select(25 + 3 * parts, 29, single_cem), 17, parts == 1);
  if (md.dual) { config_bits += 2; }
  let endpoint_bits = 128 - weight_bits - config_bits;
  var extra_off = 0;
  if (single_cem) { extra_off = -1; } else if (parts == 4) { extra_off = 7; } else if (parts == 3) { extra_off = 4; }
  else if (parts == 2) { extra_off = 1; }
  let extra_start = 127 - weight_bits - extra_off;
  // The colour endpoint modes.
  var modes = vec4<u32>(0u);
  if (parts == 1) { modes.x = bits(13, 4); }
  else {
    let hi = bits(23, 2);
    if (hi == 0u) { let m = bits(25, 4); modes = vec4<u32>(m); }
    else {
      for (var k = 0; k < parts; k++) {
        let cls = hi - select(1u, 0u, bit(25 + k) != 0u);
        let l0 = parts + 2 * k;
        let l1 = parts + 2 * k + 1;
        let b0 = bit(select(extra_start + l0 - 4, 25 + l0, l0 < 4));
        let b1 = bit(select(extra_start + l1 - 4, 25 + l1, l1 < 4));
        modes[k] = (cls << 2u) | (b1 << 1u) | b0;
      }
    }
  }
  var num_values = 0;
  for (var k = 0; k < parts; k++) { num_values += i32((modes[k] / 4u + 1u) * 2u); }
  if (num_values > 18 || endpoint_bits < (13 * num_values + 4) / 5) { error_block(); return; }
  // The endpoints' ISE: the largest range that fits.
  var tb = 6; var qb = 5; var pb = 8;
  var e_mode = 2u; var e_nb = 0;
  loop {
    let tr = select(-1, (3 << u32(tb)) - 1, tb > 0);
    let qr = select(-1, (5 << u32(qb)) - 1, qb > 0);
    let pr = select(-1, (1 << u32(pb)) - 1, pb > 0);
    let mr = max(max(tr, qr), pr);
    if (mr == tr) {
      if (ise_bits(0u, tb, num_values) <= endpoint_bits) { e_mode = 0u; e_nb = tb; break; }
      tb--;
    } else if (mr == qr) {
      if (ise_bits(1u, qb, num_values) <= endpoint_bits) { e_mode = 1u; e_nb = qb; break; }
      qb--;
    } else {
      if (ise_bits(2u, pb, num_values) <= endpoint_bits || pb <= 0) { e_mode = 2u; e_nb = pb; break; }
      pb--;
    }
  }
  stream(select(29, 17, parts == 1), endpoint_bits, true);
  decode_ise(0, num_values, e_mode, e_nb);
  unquantize_endpoints(num_values, e_mode, e_nb);
  decode_endpoints(modes, parts);
  // The weights, from the block's top bit down.
  stream(127, weight_bits, false);
  decode_ise(0, num_weights, md.ise, md.nb);
  unquantize_weights(num_weights, md.ise, md.nb);
  let ccs = select(-1, i32(bits(extra_start - 2, 2)), md.dual);
  let seed = select(0xffffffffu, bits(13, 10), parts > 1);
  let small = p.bw * p.bh * p.bd < 31u;
  var hdr_part = vec4<bool>(false);
  for (var k = 0; k < parts; k++) { hdr_part[k] = is_hdr(modes[k]); }
  for (var z = 0u; z < p.bd; z++) { for (var y = 0u; y < p.bh; y++) { for (var x = 0u; x < p.bw; x++) {
    let k = select(texel_partition(seed, x, y, z, u32(parts), small), 0u, parts == 1);
    let e0 = e0s[k]; let e1 = e1s[k];
    let w = texel_weights(x, y, z, md);
    var c = vec4<u32>(0u);
    if (p.mode != 2u && hdr_part[k]) {
      if (p.mode == 1u) { c = vec4<u32>(255u, 0u, 255u, 255u); } else { c = vec4<u32>(0x3c00u, 0u, 0x3c00u, 0x3c00u); }
    } else {
      for (var ch = 0; ch < 4; ch++) {
        let wt = select(w.x, w.y, ccs == ch);
        if (!hdr_part[k] || (ch == 3 && modes[k] == 14u)) {
          let srgb = p.mode == 1u;
          let c0 = (e0[ch] << 8u) | select(e0[ch], 0x80u, srgb);
          let c1 = (e1[ch] << 8u) | select(e1[ch], 0x80u, srgb);
          let v = (c0 * (64u - wt) + c1 * wt + 32u) / 64u;
          if (srgb) { c[ch] = (v & 0xff00u) >> 8u; } else { c[ch] = ldr16(v); }
        } else {
          let c0 = e0[ch] << 4u;
          let c1 = e1[ch] << 4u;
          let v = (c0 * (64u - wt) + c1 * wt + 32u) / 64u;
          let e = gb(v, 11u, 15u);
          let m = gb(v, 0u, 10u);
          var mt: u32;
          if (m < 512u) { mt = 3u * m; } else if (m >= 1536u) { mt = 5u * m - 2048u; } else { mt = 4u * m - 512u; }
          let cf = ((e << 10u) + (mt >> 3u)) & 0xffffu;
          c[ch] = select(cf, 0x7bffu, gb(cf, 10u, 14u) == 31u);
        }
      }
    }
    put(x, y, z, c);
  } } }
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let size = textureDimensions(blocks);
  let bx = g.x; let by = g.y; let bz = g.z + p.z0;
  if (bx * p.bw >= p.w || by * p.bh >= p.h || bz * p.bd >= p.d || bx >= size.x || by >= size.y || bz >= size.z) { return; }
  let b = textureLoad(blocks, vec3<u32>(bx, by, bz), 0);
  blk[0] = b.x; blk[1] = b.y; blk[2] = b.z; blk[3] = b.w;
  texel_x = bx * p.bw; texel_y = by * p.bh; texel_z = bz * p.bd;
  decompress();
}
`;
