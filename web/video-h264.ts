// H.264 for WebCodecs from VA-API's stateless decode (docs/plans/video.md): the guest's FFmpeg parsed the stream's
// parameter sets and hands over, per picture, Mesa's `virgl_h264_picture_desc` (the SPS and PPS fields among the
// picture's) and the picture's slice NAL units (Annex B: Mesa's VA frontend adds a start code where the slice data
// lacks one). `VideoDecoder` wants the stream, so the parameter sets are rebuilt from the fields (ITU-T H.264
// §7.3.2.1, §7.3.2.2) and put before the slices whenever they change. What the fields don't carry is chosen so the
// decoding is the same: no cropping (the guest's surfaces are the coded size), the PPS's scaling lists the effective
// ones (VA has one set), and a VUI whose bitstream restriction says `max_num_reorder_frames = 0`, so every picture is
// output as soon as it's decoded (the guest reorders, and waits on surfaces in its own order: docs/plans/video.md §1).

import { PROFILE } from './virgl-video.ts';

/** Writes an RBSP bit by bit. */
export class BitWriter {
  private bytes: number[] = [];
  private cur = 0;
  private n = 0;

  u(bits: number, v: number) {
    for (let k = bits - 1; k >= 0; k--) this.bit((v >>> k) & 1);
  }

  flag(v: boolean | number) {
    this.bit(v ? 1 : 0);
  }

  /** Exp-Golomb, unsigned. */
  ue(v: number) {
    const x = v + 1;
    const len = 32 - Math.clz32(x);
    this.u(len - 1, 0);
    this.u(len, x);
  }

  /** Exp-Golomb, signed. */
  se(v: number) {
    this.ue(v <= 0 ? -2 * v : 2 * v - 1);
  }

  /** rbsp_trailing_bits, then the bytes. */
  finish(): Uint8Array {
    this.bit(1);
    while (this.n) this.bit(0);
    return new Uint8Array(this.bytes);
  }

  private bit(b: number) {
    this.cur = (this.cur << 1) | b;
    if (++this.n === 8) {
      this.bytes.push(this.cur);
      this.cur = this.n = 0;
    }
  }
}

/** Reads an RBSP (emulation prevention already removed: `unescape`). */
export class BitReader {
  private at = 0;
  private b: Uint8Array;

  constructor(b: Uint8Array) {
    this.b = b;
  }

  get left() { return this.b.length * 8 - this.at; }

  u(bits: number): number {
    let v = 0;
    for (let k = 0; k < bits; k++) {
      if (this.at >= this.b.length * 8) throw new Error('H.264: read past the end');
      v = v * 2 + ((this.b[this.at >> 3] >> (7 - (this.at & 7))) & 1);
      this.at++;
    }
    return v;
  }

  flag() { return this.u(1) === 1; }

  ue(): number {
    let zeros = 0;
    while (this.u(1) === 0) if (++zeros > 31) throw new Error('H.264: bad Exp-Golomb code');
    return 2 ** zeros - 1 + this.u(zeros);
  }

  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : k ? -k / 2 : 0;
  }
}

/** A NAL unit's payload with emulation prevention (00 00 03) removed. */
export function unescape(nal: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (const x of nal) {
    if (zeros >= 2 && x === 3) { zeros = 0; continue; }
    zeros = x === 0 ? zeros + 1 : 0;
    out.push(x);
  }
  return new Uint8Array(out);
}

/** An RBSP as an Annex B NAL unit: a start code, the header byte, emulation prevention added. */
export function nal(type: number, refIdc: number, rbsp: Uint8Array): Uint8Array {
  const out = [0, 0, 0, 1, (refIdc << 5) | type];
  let zeros = 0;
  for (const x of rbsp) {
    if (zeros >= 2 && x <= 3) { out.push(3); zeros = 0; }
    zeros = x === 0 ? zeros + 1 : 0;
    out.push(x);
  }
  return new Uint8Array(out);
}

/** The NAL units of an Annex B stream (the start codes dropped). */
export function splitAnnexB(b: Uint8Array): Uint8Array[] {
  const starts: number[] = [];
  for (let k = 0; k + 2 < b.length; k++) {
    if (b[k] === 0 && b[k + 1] === 0 && b[k + 2] === 1) {
      starts.push(k + 3);
      k += 2;
    }
  }
  return starts.map((s, i) => {
    let end = i + 1 < starts.length ? starts[i + 1] - 3 : b.length;
    while (end > s && b[end - 1] === 0) end--; // a 4-byte start code's leading zero, trailing zeros
    return b.subarray(s, end);
  });
}

/** What `virgl_h264_picture_desc` says of the SPS and PPS (Mesa 26.2's layout; the offsets are its compiler's). */
export type H264Params = {
  profile: number;
  sps: {
    levelIdc: number; chromaFormatIdc: number; separateColourPlane: boolean; bitDepthLumaMinus8: number; bitDepthChromaMinus8: number;
    log2MaxFrameNumMinus4: number; pocType: number; log2MaxPocLsbMinus4: number; deltaPicOrderAlwaysZero: boolean;
    offsetForNonRefPic: number; offsetForTopToBottomField: number; offsetForRefFrame: number[];
    maxNumRefFrames: number; frameMbsOnly: boolean; mbAdaptiveFrameField: boolean; direct8x8Inference: boolean;
  };
  pps: {
    entropyCodingMode: boolean; bottomFieldPicOrderInFramePresent: boolean; numSliceGroupsMinus1: number;
    numRefIdxL0DefaultActiveMinus1: number; numRefIdxL1DefaultActiveMinus1: number; weightedPred: boolean; weightedBipredIdc: number;
    picInitQpMinus26: number; picInitQsMinus26: number; chromaQpIndexOffset: number; deblockingFilterControlPresent: boolean;
    constrainedIntraPred: boolean; redundantPicCntPresent: boolean; transform8x8Mode: boolean;
    scaling4x4: number[][]; scaling8x8: number[][]; secondChromaQpIndexOffset: number;
  };
  fieldPic: boolean;
};

export const H264_DESC_SIZE = 2624;
const SPS = 264, PPS = SPS + 1532;

export function parseH264Desc(d: Uint8Array): H264Params {
  if (d.length < H264_DESC_SIZE) throw new Error(`H.264: a picture desc of ${d.length} bytes`);
  const v = new DataView(d.buffer, d.byteOffset, d.length);
  const u8 = (at: number) => d[at], i8 = (at: number) => v.getInt8(at), i32 = (at: number) => v.getInt32(at, true);
  const lists = (at: number, n: number, len: number) => Array.from({ length: n }, (_, k) => [...d.subarray(at + k * len, at + (k + 1) * len)]);
  const cycle = u8(SPS + 1524);
  return {
    profile: v.getUint16(0, true),
    sps: {
      levelIdc: u8(SPS), chromaFormatIdc: u8(SPS + 1), separateColourPlane: !!u8(SPS + 2), bitDepthLumaMinus8: u8(SPS + 3), bitDepthChromaMinus8: u8(SPS + 4),
      log2MaxFrameNumMinus4: u8(SPS + 486), pocType: u8(SPS + 487), log2MaxPocLsbMinus4: u8(SPS + 488), deltaPicOrderAlwaysZero: !!u8(SPS + 489),
      offsetForNonRefPic: i32(SPS + 492), offsetForTopToBottomField: i32(SPS + 496),
      offsetForRefFrame: Array.from({ length: cycle }, (_, k) => i32(SPS + 500 + 4 * k)),
      // Mesa's VA frontend leaves the SPS's max_num_ref_frames 0; VA's num_ref_frames is the picture's.
      maxNumRefFrames: u8(SPS + 1525) || u8(2621), frameMbsOnly: !!u8(SPS + 1526), mbAdaptiveFrameField: !!u8(SPS + 1527), direct8x8Inference: !!u8(SPS + 1528),
    },
    pps: {
      entropyCodingMode: !!u8(PPS), bottomFieldPicOrderInFramePresent: !!u8(PPS + 1), numSliceGroupsMinus1: u8(PPS + 2),
      numRefIdxL0DefaultActiveMinus1: u8(PPS + 5), numRefIdxL1DefaultActiveMinus1: u8(PPS + 6), weightedPred: !!u8(PPS + 7), weightedBipredIdc: u8(PPS + 8),
      picInitQpMinus26: i8(PPS + 9), picInitQsMinus26: i8(PPS + 10), chromaQpIndexOffset: i8(PPS + 11), deblockingFilterControlPresent: !!u8(PPS + 12),
      constrainedIntraPred: !!u8(PPS + 13), redundantPicCntPresent: !!u8(PPS + 14), transform8x8Mode: !!u8(PPS + 15),
      scaling4x4: lists(PPS + 16, 6, 16), scaling8x8: lists(PPS + 112, 6, 64), secondChromaQpIndexOffset: i8(PPS + 496),
    },
    fieldPic: !!u8(2300),
  };
}

/** profile_idc and the constraint flags for a pipe profile. */
function profileIdc(profile: number): [number, number] {
  switch (profile) {
    case PROFILE.AVC_CONSTRAINED_BASELINE: return [66, 0b0100_0000]; // constraint_set1
    case PROFILE.AVC_BASELINE: return [66, 0];
    case PROFILE.AVC_MAIN: return [77, 0];
    case PROFILE.AVC_EXTENDED: return [88, 0];
    case PROFILE.AVC_HIGH: return [100, 0];
    case PROFILE.AVC_HIGH10: return [110, 0];
    default: throw new Error(`H.264: profile ${profile}`);
  }
}

/** The WebCodecs codec string for a pipe profile and a level. */
export function codecString(profile: number, level: number) {
  const [idc, flags] = profileIdc(profile);
  const hex = (x: number) => x.toString(16).toUpperCase().padStart(2, '0');
  return `avc1.${hex(idc)}${hex(flags)}${hex(level || 51)}`;
}

/**
 * An SPS (id 0) for these parameters and a coded size in macroblocks. `level` is the codec's (Mesa's VA frontend
 * leaves the SPS's level_idc 0 and creates the codec with a level for the picture size).
 *
 * `reorder` is what the SPS says of output order (docs/plans/video.md §5). `'none'` (a hardware decoder: Chromium's
 * own H.264 decoder honors it) writes max_num_reorder_frames 0, so every picture comes out as soon as it's decoded.
 * `'learn'` (a software decoder: FFmpeg) writes no bitstream restriction: FFmpeg drops the pictures that come after
 * one it has shown in display order when told 0, and without the restriction it learns the reorder depth from the
 * POCs, as the guest's own FFmpeg does, so it holds a picture no longer than the guest waits for it.
 */
export function buildSps(p: H264Params, mbWidth: number, mbHeight: number, level = 0, reorder: H264Reorder = 'none'): Uint8Array {
  const s = p.sps;
  const [idc, flags] = profileIdc(p.profile);
  const w = new BitWriter();
  w.u(8, idc);
  w.u(8, flags);
  w.u(8, s.levelIdc || level || 51);
  w.ue(0); // seq_parameter_set_id
  if (idc >= 100) {
    w.ue(s.chromaFormatIdc);
    if (s.chromaFormatIdc === 3) w.flag(s.separateColourPlane);
    w.ue(s.bitDepthLumaMinus8);
    w.ue(s.bitDepthChromaMinus8);
    w.flag(0); // qpprime_y_zero_transform_bypass_flag (High 4:4:4 Predictive only)
    w.flag(0); // seq_scaling_matrix_present_flag: the PPS carries the effective lists
  }
  w.ue(s.log2MaxFrameNumMinus4);
  w.ue(s.pocType);
  if (s.pocType === 0) w.ue(s.log2MaxPocLsbMinus4);
  else if (s.pocType === 1) {
    w.flag(s.deltaPicOrderAlwaysZero);
    w.se(s.offsetForNonRefPic);
    w.se(s.offsetForTopToBottomField);
    w.ue(s.offsetForRefFrame.length);
    for (const o of s.offsetForRefFrame) w.se(o);
  }
  w.ue(s.maxNumRefFrames);
  w.flag(1); // gaps_in_frame_num_value_allowed_flag: not in the desc; a gap is then decoded, never an error
  w.ue(mbWidth - 1);
  w.ue((s.frameMbsOnly ? mbHeight : mbHeight / 2) - 1); // pic_height_in_map_units_minus1
  w.flag(s.frameMbsOnly);
  if (!s.frameMbsOnly) w.flag(s.mbAdaptiveFrameField);
  w.flag(s.direct8x8Inference);
  w.flag(0); // frame_cropping_flag
  w.flag(1); // vui_parameters_present_flag
  w.flag(0); // aspect_ratio_info_present_flag
  w.flag(0); // overscan_info_present_flag
  w.flag(0); // video_signal_type_present_flag
  w.flag(0); // chroma_loc_info_present_flag
  w.flag(0); // timing_info_present_flag
  w.flag(0); // nal_hrd_parameters_present_flag
  w.flag(0); // vcl_hrd_parameters_present_flag
  w.flag(0); // pic_struct_present_flag
  w.flag(reorder === 'none'); // bitstream_restriction_flag
  if (reorder === 'learn') return w.finish();
  w.flag(1); // motion_vectors_over_pic_boundaries_flag
  w.ue(2); // max_bytes_per_pic_denom
  w.ue(1); // max_bits_per_mb_denom
  w.ue(16); // log2_max_mv_length_horizontal
  w.ue(16); // log2_max_mv_length_vertical
  w.ue(0); // max_num_reorder_frames: output at once (the guest reorders)
  w.ue(Math.max(1, s.maxNumRefFrames)); // max_dec_frame_buffering
  return w.finish();
}

export type H264Reorder = 'none' | 'learn';

const flat = (l: number[]) => l.every((x) => x === 16);

/** A PPS (`id`, on SPS 0). */
export function buildPps(p: H264Params, id: number): Uint8Array {
  const q = p.pps;
  if (q.numSliceGroupsMinus1) throw new Error('H.264: slice groups (FMO) aren\'t supported');
  const w = new BitWriter();
  w.ue(id);
  w.ue(0); // seq_parameter_set_id
  w.flag(q.entropyCodingMode);
  w.flag(q.bottomFieldPicOrderInFramePresent);
  w.ue(0); // num_slice_groups_minus1
  w.ue(q.numRefIdxL0DefaultActiveMinus1);
  w.ue(q.numRefIdxL1DefaultActiveMinus1);
  w.flag(q.weightedPred);
  w.u(2, q.weightedBipredIdc);
  w.se(q.picInitQpMinus26);
  w.se(q.picInitQsMinus26);
  w.se(q.chromaQpIndexOffset);
  w.flag(q.deblockingFilterControlPresent);
  w.flag(q.constrainedIntraPred);
  w.flag(q.redundantPicCntPresent);
  const lists8 = q.transform8x8Mode ? (p.sps.chromaFormatIdc === 3 ? 6 : 2) : 0;
  const scaling = !q.scaling4x4.every(flat) || !q.scaling8x8.slice(0, lists8).every(flat);
  if (q.transform8x8Mode || scaling || q.secondChromaQpIndexOffset !== q.chromaQpIndexOffset) {
    w.flag(q.transform8x8Mode);
    w.flag(scaling); // pic_scaling_matrix_present_flag
    if (scaling) {
      for (const l of [...q.scaling4x4, ...q.scaling8x8.slice(0, lists8)]) {
        w.flag(1); // pic_scaling_list_present_flag: every list explicit, delta-coded in scan order
        let last = 8;
        for (const x of l) {
          let d = x - last;
          if (d > 127) d -= 256;
          if (d < -128) d += 256;
          w.se(d);
          last = x;
        }
      }
    }
    w.se(q.secondChromaQpIndexOffset);
  }
  return w.finish();
}

/** pic_parameter_set_id of a slice NAL unit (the header byte included). */
export function slicePpsId(sliceNal: Uint8Array): number {
  const r = new BitReader(unescape(sliceNal.subarray(1, 1 + 16)));
  r.ue(); // first_mb_in_slice
  r.ue(); // slice_type
  return r.ue();
}

/**
 * A slice header (§7.3.3) read as far as num_ref_idx_active_override_flag: its slice type (0 P, 1 B, 2 I, 3 SP,
 * 4 SI) and whether it sets its own reference counts (else the PPS's defaults apply).
 */
export function sliceRefs(sliceNal: Uint8Array, p: H264Params): { type: number; ppsId: number; override: boolean } {
  const s = p.sps;
  const r = new BitReader(unescape(sliceNal.subarray(1, 1 + 64)));
  r.ue(); // first_mb_in_slice
  const type = r.ue() % 5;
  const ppsId = r.ue();
  if (s.separateColourPlane) r.u(2);
  r.u(s.log2MaxFrameNumMinus4 + 4); // frame_num
  let field = false;
  if (!s.frameMbsOnly && (field = r.flag())) r.flag(); // field_pic_flag, bottom_field_flag
  if ((sliceNal[0] & 0x1f) === 5) r.ue(); // idr_pic_id
  if (s.pocType === 0) {
    r.u(s.log2MaxPocLsbMinus4 + 4);
    if (p.pps.bottomFieldPicOrderInFramePresent && !field) r.se();
  } else if (s.pocType === 1 && !s.deltaPicOrderAlwaysZero) {
    r.se();
    if (p.pps.bottomFieldPicOrderInFramePresent && !field) r.se();
  }
  if (p.pps.redundantPicCntPresent) r.ue();
  if (type === 1) r.flag(); // direct_spatial_mv_pred_flag
  const override = type === 0 || type === 1 || type === 3 ? r.flag() : false;
  return { type, ppsId, override };
}

/**
 * A codec's stream as WebCodecs takes it: each picture's slices, after the parameter sets when they've changed (and
 * at every IDR picture, which starts a chunk the decoder can begin at).
 *
 * VA's picture parameters lack the PPS's num_ref_idx_l0/l1_default_active_minus1 (Mesa's desc has 0), which slices
 * without num_ref_idx_active_override_flag use: those slices' active counts (the picture's, in the desc) are the
 * defaults, so they're learned there, per PPS id, and the PPS is sent again if they change.
 */
export class H264Stream {
  private sps?: Uint8Array;
  private pps = new Map<number, Uint8Array>();
  private refDefaults = new Map<number, [number, number]>();
  private mbWidth: number;
  private mbHeight: number;
  private level: number;
  private reorder: H264Reorder;

  constructor(width: number, height: number, level = 0, reorder: H264Reorder = 'none') {
    this.mbWidth = Math.ceil(width / 16);
    this.mbHeight = Math.ceil(height / 16);
    this.level = level;
    this.reorder = reorder;
  }

  /** The chunk for one picture: its desc and its bitstream (Annex B slices). */
  chunk(desc: Uint8Array, bits: Uint8Array): { data: Uint8Array; key: boolean } {
    const p = parseH264Desc(desc);
    if (p.fieldPic || !p.sps.frameMbsOnly) throw new Error('H.264: interlaced pictures aren\'t supported');
    const nals = splitAnnexB(bits).filter((n) => n.length > 1);
    const slices = nals.filter((n) => (n[0] & 0x1f) === 1 || (n[0] & 0x1f) === 5);
    if (!slices.length) throw new Error('H.264: a picture without slices');
    const key = slices.some((n) => (n[0] & 0x1f) === 5);
    const out: Uint8Array[] = [];
    const sps = buildSps(p, this.mbWidth, this.mbHeight, this.level, this.reorder);
    const spsChanged = !this.sps || !same(this.sps, sps);
    if (spsChanged || key) {
      this.sps = sps;
      if (spsChanged) {
        this.pps.clear();
        this.refDefaults.clear();
      }
      out.push(nal(7, 3, sps));
    }
    const l0 = desc[2302], l1 = desc[2303];
    const ids = new Map<number, boolean>();
    for (const n of slices) {
      const h = sliceRefs(n, p);
      ids.set(h.ppsId, ids.get(h.ppsId) ?? false);
      if (h.override || h.type === 2 || h.type === 4) continue;
      const was = this.refDefaults.get(h.ppsId) ?? [0, 0];
      const now: [number, number] = [l0, h.type === 1 ? l1 : was[1]];
      if (now[0] !== was[0] || now[1] !== was[1]) this.refDefaults.set(h.ppsId, now);
    }
    for (const id of ids.keys()) {
      const [d0, d1] = this.refDefaults.get(id) ?? [0, 0];
      const pps = buildPps({ ...p, pps: { ...p.pps, numRefIdxL0DefaultActiveMinus1: d0, numRefIdxL1DefaultActiveMinus1: d1 } }, id);
      const was = this.pps.get(id);
      if (key || spsChanged || !was || !same(was, pps)) {
        this.pps.set(id, pps);
        out.push(nal(8, 3, pps));
      }
    }
    for (const n of nals) out.push(new Uint8Array([0, 0, 0, 1]), n);
    const data = new Uint8Array(out.reduce((k, b) => k + b.length, 0));
    let at = 0;
    for (const b of out) { data.set(b, at); at += b.length; }
    return { data, key };
  }
}

function same(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((x, k) => x === b[k]);
}
