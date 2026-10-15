// AV1 for WebCodecs from VA-API's stateless decode (docs/plans/video.md): the guest's FFmpeg parsed the OBUs and hands
// over, per frame, Mesa's `virgl_av1_picture_desc` (the sequence and frame header's fields, the reference map) and
// the frame's tiles (their offsets and sizes in the desc). `VideoDecoder` wants temporal units of OBUs, so the
// sequence header and each frame header are written again from the fields (AV1 §5.5, §5.9), in explicit forms where
// the original may have leaned on state (sizes, references, loop filter deltas, segmentation data, film grain: all
// written as updates; global motion delta-coded against the parameters this side tracks), and the tiles put in a tile
// group OBU of our own.
//
// The decoder's reference slots are this side's, not the guest's. Mesa's VA frontend doesn't pass refresh_frame_flags
// (it writes 1), but AV1 decoding depends only on what the slots hold, so each frame is stored in a slot that holds
// no picture the guest can still reference (one not in its reference map), and its references are written as the
// slots holding the pictures the guest's references name. If none is free (eight distinct pictures in the guest's
// map: libaom's streams, mostly), the frame waits for the next one, whose map says whether and where the guest
// stored it. If the guest waits on it instead (a player reading each picture back), `flush` sends it stored nowhere,
// and should a later frame reference it, it's decoded again, hidden, into a slot freed by then: the slots haven't
// changed in between, so it decodes the same.
//
// A hidden frame the guest may show later (show_existing_frame, which FFmpeg answers without a decode) is written
// shown, so the decoder outputs it for its surface; an inter frame decodes the same shown or not. A frame with no
// output (one the guest never shows, one decoded again) goes in the temporal unit of the next frame, as encoders put
// hidden frames before a shown one: a temporal unit without a shown frame is an error to Apple's hardware decoder.
// Layouts are Mesa 26.2's (src/virtio/virtio-gpu/virgl_video_hw.h; offsets from its compiler).

/** Writes bits (f(n), su(n), ns(n), le(n), leb128: AV1 §4.10). */
export class Av1Writer {
  private bytes: number[] = [];
  private cur = 0;
  private n = 0;

  /** f(n): `bits` bits of `v`, most significant first. */
  f(bits: number, v: number) {
    for (let k = bits - 1; k >= 0; k--) this.bit(Math.floor(v / 2 ** k) & 1);
  }

  flag(v: boolean | number) {
    this.bit(v ? 1 : 0);
  }

  /** su(n): `v` in `bits` bits, two's complement. */
  su(bits: number, v: number) {
    this.f(bits, v & ((1 << bits) - 1));
  }

  /** ns(n): `v` of `n` values, non-symmetric (shorter codes for the first ones). */
  ns(n: number, v: number) {
    const w = 32 - Math.clz32(n);
    const m = (1 << w) - n;
    if (v < m) return this.f(w - 1, v);
    const t = v + m;
    this.f(w - 1, t >> 1);
    this.f(1, t & 1);
  }

  /** Zero bits to the next byte. */
  align() {
    while (this.n) this.bit(0);
  }

  /** trailing_bits: a 1, then zeros to the byte. */
  trailing(): Uint8Array {
    this.bit(1);
    this.align();
    return this.done();
  }

  done(): Uint8Array {
    if (this.n) throw new Error('AV1: not byte-aligned');
    return new Uint8Array(this.bytes);
  }

  get bitPos() { return this.bytes.length * 8 + this.n; }

  private bit(b: number) {
    this.cur = (this.cur << 1) | b;
    if (++this.n === 8) {
      this.bytes.push(this.cur);
      this.cur = this.n = 0;
    }
  }
}

/** leb128 of `v` (an OBU's size). */
export function leb128(v: number): number[] {
  const out: number[] = [];
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}

export const OBU = { SEQUENCE_HEADER: 1, TEMPORAL_DELIMITER: 2, FRAME_HEADER: 3, TILE_GROUP: 4 } as const;

/** An OBU with its size field. */
export function obu(type: number, payload: Uint8Array): Uint8Array {
  const size = leb128(payload.length);
  const out = new Uint8Array(1 + size.length + payload.length);
  out[0] = (type << 3) | 2; // obu_has_size_field
  out.set(size, 1);
  out.set(payload, 1 + size.length);
  return out;
}

export const FRAME = { KEY: 0, INTER: 1, INTRA_ONLY: 2, SWITCH: 3 } as const;
const PRIMARY_REF_NONE = 7;
const GM = { IDENTITY: 0, TRANSLATION: 1, ROTZOOM: 2, AFFINE: 3 } as const;
const DEFAULT_GM = [0, 0, 1 << 16, 0, 0, 1 << 16];

/** What `virgl_av1_picture_desc` says of a frame (Mesa 26.2's layout). */
export type Av1Params = {
  ref: number[]; filmGrainTarget: number;
  profile: number; orderHintBits: number; bitDepthIdx: number;
  seq: { use128: boolean; filterIntra: boolean; intraEdge: boolean; interintra: boolean; masked: boolean; dualFilter: boolean; orderHint: boolean; jntComp: boolean; cdef: boolean; mono: boolean; refFrameMvs: boolean; filmGrain: boolean };
  width: number; height: number; maxWidth: number; maxHeight: number;
  refFrameIdx: number[]; primaryRefFrame: number; orderHint: number;
  seg: { enabled: boolean; updateMap: boolean; updateData: boolean; temporalUpdate: boolean; data: number[][]; mask: number[] };
  grain: {
    apply: boolean; csfl: boolean; scalingMinus8: number; arLag: number; arShiftMinus6: number; scaleShift: number; overlap: boolean; clip: boolean;
    seed: number; y: [number, number][]; cb: [number, number][]; cr: [number, number][]; arY: number[]; arCb: number[]; arCr: number[];
    cbMult: number; cbLumaMult: number; cbOffset: number; crMult: number; crLumaMult: number; crOffset: number;
  };
  tileCols: number; tileRows: number; widthInSbs: number[]; heightInSbs: number[]; contextUpdateTileId: number;
  pic: {
    frameType: number; show: boolean; showable: boolean; errorResilient: boolean; disableCdfUpdate: boolean; screenContent: boolean; forceIntegerMv: boolean;
    intrabc: boolean; superres: boolean; highPrecisionMv: boolean; motionModeSwitchable: boolean; refFrameMvs: boolean; disableFrameEndUpdateCdf: boolean;
    uniformTiles: boolean; warpedMotion: boolean; largeScaleTile: boolean;
  };
  superresDenom: number; interpFilter: number; filterLevel: [number, number]; filterLevelU: number; filterLevelV: number;
  sharpness: number; deltaEnabled: boolean; refDeltas: number[]; modeDeltas: number[];
  baseQIdx: number; dq: { yDc: number; uDc: number; uAc: number; vDc: number; vAc: number };
  qm: { using: boolean; y: number; u: number; v: number };
  deltaQPresent: boolean; deltaQRes: number; deltaLfPresent: boolean; deltaLfRes: number; deltaLfMulti: boolean; txMode: number; referenceSelect: boolean; reducedTxSet: boolean; skipModePresent: boolean;
  cdefDampingMinus3: number; cdefBits: number; cdefY: number[]; cdefUv: number[];
  /** Loop restoration: each plane's type, the luma unit's shift (its size 64 << shift) and chroma's (virgl doesn't copy the unit sizes). */
  lrType: number[]; lrUnitShift: number; lrUvShift: number;
  wm: { type: number; params: number[] }[];
  tiles: { size: number; offset: number; row: number; col: number }[];
};

export const AV1_DESC_SIZE = 5132;

export function parseAv1Desc(d: Uint8Array): Av1Params {
  if (d.length < AV1_DESC_SIZE) throw new Error(`AV1: a picture desc of ${d.length} bytes`);
  const v = new DataView(d.buffer, d.byteOffset, d.length);
  const u8 = (at: number) => d[at], i8 = (at: number) => v.getInt8(at), u16 = (at: number) => v.getUint16(at, true), i16 = (at: number) => v.getInt16(at, true);
  const u32 = (at: number) => v.getUint32(at, true), i32 = (at: number) => v.getInt32(at, true);
  const bit = (w: number, k: number) => !!((w >>> k) & 1), bits = (w: number, k: number, n: number) => (w >>> k) & ((1 << n) - 1);
  const seq = u32(336), seg = u32(364), fg = u32(504), pic = u32(1448), lf = u8(1458), qm = u16(1476), mode = u32(1480), lr = u16(1502);
  const points = (n: number, at: number, len: number) => Array.from({ length: Math.min(n, len) }, (_, k): [number, number] => [u8(at + k), u8(at + len + k)]);
  const tileCols = u8(664), tileRows = u8(665), count = u16(5128);
  return {
    ref: Array.from({ length: 8 }, (_, k) => u32(264 + 4 * k)), filmGrainTarget: u32(328),
    profile: u8(332), orderHintBits: u8(333) + 1, bitDepthIdx: u8(334),
    seq: {
      use128: bit(seq, 0), filterIntra: bit(seq, 1), intraEdge: bit(seq, 2), interintra: bit(seq, 3), masked: bit(seq, 4), dualFilter: bit(seq, 5),
      orderHint: bit(seq, 6), jntComp: bit(seq, 7), cdef: bit(seq, 8), mono: bit(seq, 9), refFrameMvs: bit(seq, 10), filmGrain: bit(seq, 11),
    },
    width: u16(344), height: u16(346), maxWidth: u16(348), maxHeight: u16(350),
    refFrameIdx: Array.from({ length: 7 }, (_, k) => u8(352 + k)), primaryRefFrame: u8(359), orderHint: u8(360),
    seg: {
      enabled: bit(seg, 0), updateMap: bit(seg, 1), updateData: bit(seg, 2), temporalUpdate: bit(seg, 3),
      data: Array.from({ length: 8 }, (_, s) => Array.from({ length: 8 }, (_, f) => i16(368 + 16 * s + 2 * f))),
      mask: Array.from({ length: 8 }, (_, s) => u8(496 + s)),
    },
    grain: {
      apply: bit(fg, 0), csfl: bit(fg, 1), scalingMinus8: bits(fg, 2, 2), arLag: bits(fg, 4, 2), arShiftMinus6: bits(fg, 6, 2), scaleShift: bits(fg, 8, 2),
      overlap: bit(fg, 10), clip: bit(fg, 11), seed: u16(508),
      y: points(u8(510), 511, 14), cb: points(u8(539), 540, 10), cr: points(u8(560), 561, 10),
      arY: Array.from({ length: 24 }, (_, k) => i8(581 + k)), arCb: Array.from({ length: 25 }, (_, k) => i8(605 + k)), arCr: Array.from({ length: 25 }, (_, k) => i8(630 + k)),
      cbMult: u8(655), cbLumaMult: u8(656), cbOffset: u16(658), crMult: u8(660), crLumaMult: u8(661), crOffset: u16(662),
    },
    tileCols, tileRows,
    widthInSbs: Array.from({ length: tileCols }, (_, k) => u16(1188 + 2 * k)), heightInSbs: Array.from({ length: tileRows }, (_, k) => u16(1316 + 2 * k)),
    contextUpdateTileId: u16(1444),
    pic: {
      frameType: bits(pic, 0, 2), show: bit(pic, 2), showable: bit(pic, 3), errorResilient: bit(pic, 4), disableCdfUpdate: bit(pic, 5), screenContent: bit(pic, 6),
      forceIntegerMv: bit(pic, 7), intrabc: bit(pic, 8), superres: bit(pic, 9), highPrecisionMv: bit(pic, 10), motionModeSwitchable: bit(pic, 11), refFrameMvs: bit(pic, 12),
      disableFrameEndUpdateCdf: bit(pic, 13), uniformTiles: bit(pic, 14), warpedMotion: bit(pic, 15), largeScaleTile: bit(pic, 16),
    },
    superresDenom: u8(1452), interpFilter: u8(1453), filterLevel: [u8(1454), u8(1455)], filterLevelU: u8(1456), filterLevelV: u8(1457),
    sharpness: bits(lf, 0, 3), deltaEnabled: bit(lf, 3),
    refDeltas: Array.from({ length: 8 }, (_, k) => i8(1459 + k)), modeDeltas: [i8(1467), i8(1468)],
    baseQIdx: u8(1469), dq: { yDc: i8(1470), uDc: i8(1471), uAc: i8(1472), vDc: i8(1473), vAc: i8(1474) },
    qm: { using: bit(qm, 0), y: bits(qm, 1, 4), u: bits(qm, 5, 4), v: bits(qm, 9, 4) },
    deltaQPresent: bit(mode, 0), deltaQRes: bits(mode, 1, 2), deltaLfPresent: bit(mode, 3), deltaLfRes: bits(mode, 4, 2), deltaLfMulti: bit(mode, 6),
    txMode: bits(mode, 7, 2), referenceSelect: bit(mode, 9), reducedTxSet: bit(mode, 10), skipModePresent: bit(mode, 11),
    cdefDampingMinus3: u8(1484), cdefBits: u8(1485), cdefY: Array.from({ length: 8 }, (_, k) => u8(1486 + k)), cdefUv: Array.from({ length: 8 }, (_, k) => u8(1494 + k)),
    lrType: [bits(lr, 0, 2), bits(lr, 2, 2), bits(lr, 4, 2)], lrUnitShift: bits(lr, 6, 2), lrUvShift: bits(lr, 8, 1),
    wm: Array.from({ length: 7 }, (_, k) => ({ type: u32(1512 + 40 * k), params: Array.from({ length: 6 }, (_, j) => i32(1512 + 40 * k + 8 + 4 * j)) })),
    tiles: Array.from({ length: Math.min(count, 256) }, (_, k) => ({ size: u32(1800 + 4 * k), offset: u32(2824 + 4 * k), row: u16(3848 + 2 * k), col: u16(4360 + 2 * k) })),
  };
}

/** What a decoder's reference slot holds, as far as the headers depend on it. */
type Slot = { surface: number; frameType: number; orderHint: number; gm: number[][] };

/** The sequence header OBU's payload for a frame's parameters (§5.5). */
export function buildSequenceHeader(p: Av1Params, level = 13): Uint8Array {
  if (p.profile !== 0) throw new Error(`AV1: profile ${p.profile}`);
  if (p.bitDepthIdx !== 0) throw new Error('AV1: only 8-bit is supported');
  const w = new Av1Writer();
  w.f(3, p.profile);
  w.flag(0); // still_picture
  w.flag(0); // reduced_still_picture_header
  w.flag(0); // timing_info_present_flag
  w.flag(0); // initial_display_delay_present_flag
  w.f(5, 0); // operating_points_cnt_minus_1
  w.f(12, 0); // operating_point_idc[0]
  w.f(5, level); // seq_level_idx[0]
  if (level > 7) w.flag(0); // seq_tier[0]
  w.f(4, 15); // frame_width_bits_minus_1
  w.f(4, 15); // frame_height_bits_minus_1
  w.f(16, p.maxWidth - 1);
  w.f(16, p.maxHeight - 1);
  w.flag(0); // frame_id_numbers_present_flag
  const s = p.seq;
  w.flag(s.use128);
  w.flag(s.filterIntra);
  w.flag(s.intraEdge);
  w.flag(s.interintra);
  w.flag(s.masked);
  w.flag(1); // enable_warped_motion: each frame says (allow_warped_motion)
  w.flag(s.dualFilter);
  w.flag(s.orderHint);
  if (s.orderHint) {
    w.flag(s.jntComp);
    w.flag(1); // enable_ref_frame_mvs: each frame says (use_ref_frame_mvs; Mesa's desc has enable_order_hint here)
  }
  w.flag(1); // seq_choose_screen_content_tools: each frame says
  w.flag(1); // seq_choose_integer_mv: each frame says
  if (s.orderHint) w.f(3, p.orderHintBits - 1);
  w.flag(1); // enable_superres: each frame says
  w.flag(s.cdef);
  w.flag(1); // enable_restoration: each frame says
  // color_config: 8-bit, no colour description (it doesn't change the decoding), 4:2:0.
  w.flag(0); // high_bitdepth
  w.flag(s.mono);
  w.flag(0); // color_description_present_flag
  w.flag(0); // color_range
  if (!s.mono) {
    w.f(2, 0); // chroma_sample_position
    w.flag(1); // separate_uv_delta_q: U's and V's deltas written apart
  }
  w.flag(s.filmGrain);
  return w.trailing();
}

/** The frame's geometry: its (downscaled) width and the superblock and tile counts. */
function geometry(p: Av1Params) {
  const denom = p.pic.superres ? p.superresDenom : 8;
  const frameWidth = Math.floor((p.width * 8 + (denom >> 1)) / denom);
  const miCols = 2 * ((frameWidth + 7) >> 3), miRows = 2 * ((p.height + 7) >> 3);
  const sbShift = p.seq.use128 ? 5 : 4, sbSize = sbShift + 2;
  const sbCols = (miCols + (1 << sbShift) - 1) >> sbShift, sbRows = (miRows + (1 << sbShift) - 1) >> sbShift;
  return { frameWidth, sbCols, sbRows, sbSize };
}

const tileLog2 = (blk: number, target: number) => {
  let k = 0;
  while ((blk << k) < target) k++;
  return k;
};

/** get_relative_dist (§7.12.3) for `bits` order hint bits (0: order hints off). */
function relDist(a: number, b: number, bits: number) {
  if (!bits) return 0;
  let diff = a - b;
  const m = 1 << (bits - 1);
  diff = (diff & (m - 1)) - (diff & m);
  return diff;
}

/** The frame header OBU's payload (§5.9) with this side's references and refresh. `hidden`: written not shown (a
 * frame decoded again to store it), `shown`: written shown (a hidden frame the guest may show later). */
export function buildFrameHeader(p: Av1Params, o: { refs: number[]; refresh: number; slots: (Slot | undefined)[]; show: boolean; showable: boolean }): Uint8Array {
  const w = new Av1Writer();
  const t = p.pic.frameType;
  const intra = t === FRAME.KEY || t === FRAME.INTRA_ONLY;
  const bitsOh = p.seq.orderHint ? p.orderHintBits : 0;
  const numPlanes = p.seq.mono ? 1 : 3;
  w.flag(0); // show_existing_frame
  w.f(2, t);
  w.flag(o.show);
  if (!o.show) w.flag(o.showable);
  const implicitEr = t === FRAME.SWITCH || (t === FRAME.KEY && o.show);
  const errorResilient = implicitEr || p.pic.errorResilient;
  if (!implicitEr) w.flag(p.pic.errorResilient);
  w.flag(p.pic.disableCdfUpdate);
  w.flag(p.pic.screenContent); // seq_force_screen_content_tools is SELECT
  const forceIntegerMv = intra ? true : p.pic.screenContent && p.pic.forceIntegerMv;
  if (p.pic.screenContent) w.flag(p.pic.forceIntegerMv); // seq_force_integer_mv is SELECT
  if (t !== FRAME.SWITCH) w.flag(1); // frame_size_override_flag: sizes written
  if (bitsOh) w.f(bitsOh, p.orderHint);
  const primary = intra || errorResilient ? PRIMARY_REF_NONE : p.primaryRefFrame;
  if (!(intra || errorResilient)) w.f(3, p.primaryRefFrame);
  const allFrames = t === FRAME.SWITCH || (t === FRAME.KEY && o.show);
  if (!allFrames) w.f(8, o.refresh);
  if ((!intra || o.refresh !== 0xff) && errorResilient && p.seq.orderHint) {
    for (let k = 0; k < 8; k++) w.f(bitsOh, o.slots[k]?.orderHint ?? 0); // ref_order_hint[]
  }
  const { frameWidth, sbCols, sbRows, sbSize } = geometry(p);
  const frameSize = () => {
    w.f(16, p.width - 1);
    w.f(16, p.height - 1);
    w.flag(p.pic.superres); // use_superres (enable_superres is on)
    if (p.pic.superres) w.f(3, p.superresDenom - 9);
    w.flag(0); // render_and_frame_size_different
  };
  let intrabc = false, highPrecisionMv = false;
  if (intra) {
    frameSize();
    if (p.pic.screenContent && frameWidth === p.width) w.flag((intrabc = p.pic.intrabc));
  } else {
    if (p.seq.orderHint) w.flag(0); // frame_refs_short_signaling
    for (let k = 0; k < 7; k++) w.f(3, o.refs[k]);
    if (!errorResilient) for (let k = 0; k < 7; k++) w.flag(0); // frame_size_with_refs: found_ref
    frameSize();
    if (!forceIntegerMv) w.flag((highPrecisionMv = p.pic.highPrecisionMv));
    w.flag(p.interpFilter === 4); // is_filter_switchable
    if (p.interpFilter !== 4) w.f(2, p.interpFilter);
    w.flag(p.pic.motionModeSwitchable);
    if (!errorResilient && p.seq.orderHint) w.flag(p.pic.refFrameMvs); // enable_ref_frame_mvs is on where order hints are
  }
  if (!p.pic.disableCdfUpdate) w.flag(p.pic.disableFrameEndUpdateCdf);
  // tile_info (§5.9.15)
  const maxTileWidthSb = 4096 >> sbSize, maxTileAreaSb = (4096 * 2304) >> (2 * sbSize);
  const minLog2TileCols = tileLog2(maxTileWidthSb, sbCols), maxLog2TileCols = tileLog2(1, Math.min(sbCols, 64)), maxLog2TileRows = tileLog2(1, Math.min(sbRows, 64));
  const minLog2Tiles = Math.max(minLog2TileCols, tileLog2(maxTileAreaSb, sbRows * sbCols));
  w.flag(p.pic.uniformTiles);
  let colsLog2: number, rowsLog2: number;
  if (p.pic.uniformTiles) {
    colsLog2 = tileLog2(1, p.tileCols);
    for (let k = minLog2TileCols; k < maxLog2TileCols; k++) {
      w.flag(k < colsLog2); // increment_tile_cols_log2
      if (k >= colsLog2) break;
    }
    rowsLog2 = tileLog2(1, p.tileRows);
    const minLog2TileRows = Math.max(minLog2Tiles - colsLog2, 0);
    for (let k = minLog2TileRows; k < maxLog2TileRows; k++) {
      w.flag(k < rowsLog2); // increment_tile_rows_log2
      if (k >= rowsLog2) break;
    }
  } else {
    let widestTileSb = 0, start = 0;
    for (let k = 0; k < p.tileCols; k++) {
      const maxWidth = Math.min(sbCols - start, maxTileWidthSb);
      w.ns(maxWidth, p.widthInSbs[k] - 1);
      start += p.widthInSbs[k];
      widestTileSb = Math.max(widestTileSb, p.widthInSbs[k]);
    }
    colsLog2 = tileLog2(1, p.tileCols);
    const maxTileAreaSbHere = minLog2Tiles > 0 ? (sbRows * sbCols) >> (minLog2Tiles + 1) : sbRows * sbCols;
    const maxTileHeightSb = Math.max(Math.floor(maxTileAreaSbHere / widestTileSb), 1);
    start = 0;
    for (let k = 0; k < p.tileRows; k++) {
      const maxHeight = Math.min(sbRows - start, maxTileHeightSb);
      w.ns(maxHeight, p.heightInSbs[k] - 1);
      start += p.heightInSbs[k];
    }
    rowsLog2 = tileLog2(1, p.tileRows);
  }
  if (colsLog2 > 0 || rowsLog2 > 0) {
    w.f(rowsLog2 + colsLog2, p.contextUpdateTileId);
    w.f(2, 3); // tile_size_bytes_minus_1: 4-byte sizes in our tile group
  }
  // quantization_params (§5.9.12)
  w.f(8, p.baseQIdx);
  const deltaQ = (v: number) => {
    w.flag(v !== 0);
    if (v) w.su(7, v);
  };
  deltaQ(p.dq.yDc);
  if (numPlanes > 1) {
    const diffUv = p.dq.uDc !== p.dq.vDc || p.dq.uAc !== p.dq.vAc;
    w.flag(diffUv);
    deltaQ(p.dq.uDc);
    deltaQ(p.dq.uAc);
    if (diffUv) {
      deltaQ(p.dq.vDc);
      deltaQ(p.dq.vAc);
    }
  }
  w.flag(p.qm.using);
  if (p.qm.using) {
    w.f(4, p.qm.y);
    w.f(4, p.qm.u);
    if (!p.seq.mono) w.f(4, p.qm.v); // separate_uv_delta_q is on
  }
  // segmentation_params (§5.9.14): the data always written (the effective values: FFmpeg's CBS loads them from the
  // reference when a frame doesn't update them).
  const BITS = [8, 6, 6, 6, 6, 3, 0, 0], SIGNED = [1, 1, 1, 1, 1, 0, 0, 0], MAX = [255, 63, 63, 63, 63, 7, 0, 0];
  w.flag(p.seg.enabled);
  const segData = p.seg.data.map((f, s) => f.map((x, j) => (p.seg.enabled && (p.seg.mask[s] >> j) & 1 ? Math.max(-MAX[j], Math.min(MAX[j], x)) : 0)));
  if (p.seg.enabled) {
    if (primary !== PRIMARY_REF_NONE) {
      w.flag(p.seg.updateMap);
      if (p.seg.updateMap) w.flag(p.seg.temporalUpdate);
      w.flag(1); // segmentation_update_data
    }
    for (let s = 0; s < 8; s++) {
      for (let j = 0; j < 8; j++) {
        const on = !!((p.seg.mask[s] >> j) & 1);
        w.flag(on);
        if (!on) continue;
        if (SIGNED[j]) w.su(1 + BITS[j], segData[s][j]);
        else w.f(BITS[j], segData[s][j]);
      }
    }
  }
  // delta_q_params, delta_lf_params (§5.9.17, §5.9.18)
  const deltaQPresent = p.baseQIdx > 0 && p.deltaQPresent;
  if (p.baseQIdx > 0) w.flag(deltaQPresent);
  if (deltaQPresent) w.f(2, p.deltaQRes);
  if (deltaQPresent && !intrabc) {
    w.flag(p.deltaLfPresent);
    if (p.deltaLfPresent) {
      w.f(2, p.deltaLfRes);
      w.flag(p.deltaLfMulti);
    }
  }
  // CodedLossless (§5.9.2)
  let codedLossless = true;
  for (let s = 0; s < 8; s++) {
    let q = p.baseQIdx;
    if (p.seg.enabled && (p.seg.mask[s] & 1)) q = Math.max(0, Math.min(255, q + segData[s][0]));
    if (q || p.dq.yDc || p.dq.uDc || p.dq.uAc || p.dq.vDc || p.dq.vAc) codedLossless = false;
  }
  const allLossless = codedLossless && frameWidth === p.width;
  // loop_filter_params (§5.9.11): the deltas always written as updates (the effective values).
  if (!codedLossless && !intrabc) {
    w.f(6, p.filterLevel[0]);
    w.f(6, p.filterLevel[1]);
    if (numPlanes > 1 && (p.filterLevel[0] || p.filterLevel[1])) {
      w.f(6, p.filterLevelU);
      w.f(6, p.filterLevelV);
    }
    w.f(3, p.sharpness);
    w.flag(p.deltaEnabled);
    if (p.deltaEnabled) {
      w.flag(1); // loop_filter_delta_update
      for (const d of p.refDeltas) {
        w.flag(1);
        w.su(7, d);
      }
      for (const d of p.modeDeltas) {
        w.flag(1);
        w.su(7, d);
      }
    }
  }
  // cdef_params (§5.9.19): VA's strengths are primary << 2 | secondary.
  if (!codedLossless && !intrabc && p.seq.cdef) {
    w.f(2, p.cdefDampingMinus3);
    w.f(2, p.cdefBits);
    for (let k = 0; k < 1 << p.cdefBits; k++) {
      w.f(6, p.cdefY[k]);
      if (numPlanes > 1) w.f(6, p.cdefUv[k]);
    }
  }
  // lr_params (§5.9.20): VA's types are FrameRestorationType (NONE, WIENER, SGRPROJ, SWITCHABLE), coded as lr_type.
  if (!allLossless && !intrabc) {
    const coded = [0, 2, 3, 1];
    let usesLr = false, usesChromaLr = false;
    for (let k = 0; k < numPlanes; k++) {
      w.f(2, coded[p.lrType[k]]);
      if (p.lrType[k]) {
        usesLr = true;
        if (k) usesChromaLr = true;
      }
    }
    if (usesLr) {
      const shift = p.lrUnitShift;
      if (p.seq.use128) w.flag(shift - 1);
      else {
        w.flag(shift > 0);
        if (shift > 0) w.flag(shift - 1);
      }
      if (!p.seq.mono && usesChromaLr) w.flag(p.lrUvShift); // 4:2:0
    }
  }
  // read_tx_mode, frame_reference_mode (§5.9.21, §5.9.23)
  if (!codedLossless) w.flag(p.txMode === 2);
  if (!intra) w.flag(p.referenceSelect);
  // skip_mode_params (§5.9.22), from the slots' order hints.
  let skipModeAllowed = false;
  if (!intra && p.referenceSelect && bitsOh) {
    const hint = (k: number) => o.slots[o.refs[k]]?.orderHint ?? 0;
    let fwd = -1, bwd = -1, fwdHint = 0, bwdHint = 0;
    for (let k = 0; k < 7; k++) {
      const h = hint(k);
      if (relDist(h, p.orderHint, bitsOh) < 0) {
        if (fwd < 0 || relDist(h, fwdHint, bitsOh) > 0) [fwd, fwdHint] = [k, h];
      } else if (relDist(h, p.orderHint, bitsOh) > 0) {
        if (bwd < 0 || relDist(h, bwdHint, bitsOh) < 0) [bwd, bwdHint] = [k, h];
      }
    }
    if (fwd < 0) skipModeAllowed = false;
    else if (bwd >= 0) skipModeAllowed = true;
    else {
      let second = -1, secondHint = 0;
      for (let k = 0; k < 7; k++) {
        const h = hint(k);
        if (relDist(h, fwdHint, bitsOh) < 0 && (second < 0 || relDist(h, secondHint, bitsOh) > 0)) [second, secondHint] = [k, h];
      }
      skipModeAllowed = second >= 0;
    }
  }
  if (skipModeAllowed) w.flag(p.skipModePresent);
  if (!(intra || errorResilient)) w.flag(p.pic.warpedMotion); // enable_warped_motion is on
  w.flag(p.reducedTxSet);
  // global_motion_params (§5.9.24), delta-coded against the primary reference's.
  if (!intra) {
    const prev = primary === PRIMARY_REF_NONE ? undefined : o.slots[o.refs[primary]]?.gm;
    for (let r = 0; r < 7; r++) {
      const type = p.wm[r].type;
      w.flag(type !== GM.IDENTITY);
      if (type !== GM.IDENTITY) {
        w.flag(type === GM.ROTZOOM);
        if (type !== GM.ROTZOOM) w.flag(type === GM.TRANSLATION);
      }
      const prevParams = prev?.[r] ?? DEFAULT_GM;
      const param = (idx: number) => writeGlobalParam(w, type, idx, p.wm[r].params[idx], prevParams[idx], highPrecisionMv);
      if (type >= GM.ROTZOOM) {
        param(2);
        param(3);
        if (type === GM.AFFINE) {
          param(4);
          param(5);
        }
      }
      if (type >= GM.TRANSLATION) {
        param(0);
        param(1);
      }
    }
  }
  // film_grain_params (§5.9.30): written as an update.
  if (p.seq.filmGrain && (o.show || o.showable)) {
    const g = p.grain;
    w.flag(g.apply);
    if (g.apply) {
      w.f(16, g.seed);
      if (t === FRAME.INTER) w.flag(1); // update_grain
      w.f(4, g.y.length);
      for (const [x, s] of g.y) {
        w.f(8, x);
        w.f(8, s);
      }
      if (!p.seq.mono) w.flag(g.csfl);
      const chroma = !(p.seq.mono || g.csfl || g.y.length === 0);
      if (chroma) {
        w.f(4, g.cb.length);
        for (const [x, s] of g.cb) {
          w.f(8, x);
          w.f(8, s);
        }
        w.f(4, g.cr.length);
        for (const [x, s] of g.cr) {
          w.f(8, x);
          w.f(8, s);
        }
      }
      const cb = chroma ? g.cb.length : 0, cr = chroma ? g.cr.length : 0;
      w.f(2, g.scalingMinus8);
      w.f(2, g.arLag);
      const numPosLuma = 2 * g.arLag * (g.arLag + 1);
      const numPosChroma = g.y.length ? numPosLuma + 1 : numPosLuma;
      if (g.y.length) for (let k = 0; k < numPosLuma; k++) w.f(8, g.arY[k] + 128);
      if (g.csfl || cb) for (let k = 0; k < numPosChroma; k++) w.f(8, g.arCb[k] + 128);
      if (g.csfl || cr) for (let k = 0; k < numPosChroma; k++) w.f(8, g.arCr[k] + 128);
      w.f(2, g.arShiftMinus6);
      w.f(2, g.scaleShift);
      if (cb) {
        w.f(8, g.cbMult);
        w.f(8, g.cbLumaMult);
        w.f(9, g.cbOffset);
      }
      if (cr) {
        w.f(8, g.crMult);
        w.f(8, g.crLumaMult);
        w.f(9, g.crOffset);
      }
      w.flag(g.overlap);
      w.flag(g.clip);
    }
  }
  return w.trailing();
}

/** A show_existing_frame header for a slot (§5.9.2). */
export function buildShowExisting(slot: number): Uint8Array {
  const w = new Av1Writer();
  w.flag(1);
  w.f(3, slot);
  return w.trailing();
}

/** One global motion parameter (§5.9.25 read_global_param, inverted): `v` coded against the previous frame's. */
function writeGlobalParam(w: Av1Writer, type: number, idx: number, v: number, prev: number, highPrecisionMv: boolean) {
  let absBits = 12, precBits = 15; // GM_ABS_ALPHA_BITS, GM_ALPHA_PREC_BITS
  if (idx < 2) {
    if (type === GM.TRANSLATION) {
      absBits = 9 - (highPrecisionMv ? 0 : 1);
      precBits = 3 - (highPrecisionMv ? 0 : 1);
    } else {
      absBits = 12;
      precBits = 6;
    }
  }
  const precDiff = 16 - precBits;
  const round = idx % 3 === 2 ? 1 << 16 : 0, sub = idx % 3 === 2 ? 1 << precBits : 0;
  const mx = 1 << absBits;
  const r = (prev >> precDiff) - sub;
  const x = (v - round) >> precDiff;
  // decode_signed_subexp_with_ref(-mx, mx + 1, r)
  const low = -mx, high = mx + 1;
  writeUnsignedSubexpWithRef(w, high - low, r - low, x - low);
}

function recenter(r: number, x: number) {
  if (x > 2 * r) return x;
  if (x >= r) return (x - r) << 1;
  return ((r - x) << 1) - 1;
}

/** The unsigned sub-exponential code with a reference (§5.9.27-28, inverted): `x` of `mx` values near `r`. */
export function writeUnsignedSubexpWithRef(w: Av1Writer, mx: number, r: number, x: number) {
  const v = (r << 1) <= mx ? recenter(r, x) : recenter(mx - 1 - r, mx - 1 - x);
  // decode_subexp(mx)
  let i = 0, mk = 0;
  const k = 3;
  for (;;) {
    const b2 = i ? k + i - 1 : k;
    const a = 1 << b2;
    if (mx <= mk + 3 * a) {
      w.ns(mx - mk, v - mk);
      return;
    }
    const more = v >= mk + a;
    w.flag(more);
    if (!more) {
      w.f(b2, v - mk);
      return;
    }
    i++;
    mk += a;
  }
}

/** A tile group OBU's payload: every tile, each but the last after its size (4 bytes, little-endian). */
export function buildTileGroup(tiles: Uint8Array[]): Uint8Array {
  const n = tiles.length;
  const head = n > 1 ? 1 : 0; // tile_start_and_end_present_flag 0, aligned
  const size = head + tiles.reduce((s, t, k) => s + t.length + (k < n - 1 ? 4 : 0), 0);
  const out = new Uint8Array(size);
  let at = head;
  tiles.forEach((t, k) => {
    if (k < n - 1) {
      new DataView(out.buffer).setUint32(at, t.length - 1, true);
      at += 4;
    }
    out.set(t, at);
    at += t.length;
  });
  return out;
}

/** A chunk for the decoder: a temporal unit, whether it starts a stream (a shown key frame), and the timestamp of the
 * frame the decoder outputs for it (every chunk has one shown frame, last). */
export type Av1Chunk = { data: Uint8Array; key: boolean; ts: number };
/** A frame's OBUs (no temporal delimiter), and its timestamp if the decoder outputs it. */
type Unit = { obus: Uint8Array[]; key: boolean; ts?: number };
/** A frame as the guest sent it, with what's needed to write it later. */
type Frame = { p: Av1Params; tiles: Uint8Array[]; surface: number; ts: number; refs: number[] };

/** What a frame is to the caller: a shown key frame (a decoder can start there), whether the decoder outputs a
 * picture for it, and the surface the guest shows it from (its target, or the film grain target Mesa may name). */
export function av1Frame(desc: Uint8Array, target: number) {
  const p = parseAv1Desc(desc);
  const t = p.pic.frameType;
  return {
    key: t === FRAME.KEY && p.pic.show,
    output: p.pic.show || (p.pic.showable && t !== FRAME.KEY),
    shown: p.seq.filmGrain && p.grain.apply && p.filmGrainTarget ? p.filmGrainTarget : target,
  };
}

/**
 * A codec's stream: per guest frame, the temporal units for the decoder (`chunks`), with this side's reference slots
 * (see the top of this file).
 */
export class Av1Stream {
  private slots: (Slot | undefined)[] = new Array(8).fill(undefined);
  /** A frame no slot was free for, until the next frame's map says where the guest stored it (or `flush`). */
  private waiting?: Frame;
  /** The last frame stored nowhere (flushed while waiting), to decode again if a later frame references it. */
  private unstored?: Frame;
  /** Frames with no output, for the next temporal unit. */
  private queued: Uint8Array[] = [];
  private level: number;

  constructor(level = 13) {
    this.level = level;
  }

  /** Whether a frame waits for the next one (`flush` writes it now). */
  get holding() { return !!this.waiting; }

  /**
   * The temporal units one frame makes (its desc, its bitstream: the tiles at the desc's offsets, its target surface,
   * the timestamp its output gets): none while it waits for a slot, or has no output (it goes in the next unit); the
   * frame before it if it waited.
   */
  chunks(desc: Uint8Array, bits: Uint8Array, target: number, ts: number): Av1Chunk[] {
    const p = parseAv1Desc(desc);
    if (p.pic.largeScaleTile) throw new Error('AV1: large scale tiles aren\'t supported');
    const t = p.pic.frameType;
    const tiles = [...p.tiles].sort((a, b) => a.row - b.row || a.col - b.col).map((x) => {
      if (x.offset + x.size > bits.length) throw new Error(`AV1: a tile at ${x.offset}+${x.size} past the data's ${bits.length} bytes`);
      return bits.subarray(x.offset, x.offset + x.size);
    });
    if (tiles.length !== p.tileCols * p.tileRows) throw new Error(`AV1: ${tiles.length} tiles of ${p.tileCols}x${p.tileRows}`);
    const out: Unit[] = [];
    const key = t === FRAME.KEY && p.pic.show;
    // The guest's reference map: the surfaces it may still reference. A slot holding none of them is free.
    const live = new Set(key ? [] : p.ref.filter((s) => s));
    // The frame that waited: where the guest stored it, if it did (a slot of ours is free now: the surface it
    // replaced in the guest's map, of eight distinct ones, is gone from it).
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = undefined;
      const free = live.has(w.surface) ? this.freeSlot(live) : -1;
      out.push(this.write(w, free >= 0 ? 1 << free : 0));
    }
    if (key) {
      this.slots.fill(undefined);
      this.unstored = undefined;
    }
    // A frame stored nowhere and referenceable now: decoded again, hidden, into a free slot.
    if (this.unstored && live.has(this.unstored.surface) && this.slotOf(this.unstored.surface) < 0) {
      const u = this.unstored;
      const free = this.freeSlot(live);
      if (free < 0) throw new Error('AV1: no reference slot free');
      out.push(this.unit(u.p, u.tiles, u.surface, 1 << free, false, true, undefined, u.refs));
    }
    this.unstored = undefined;
    // This frame's references: the slots holding the surfaces the guest's references name.
    const refs = p.refFrameIdx.map((k) => {
      if (t === FRAME.KEY || t === FRAME.INTRA_ONLY) return 0;
      const s = this.slotOf(p.ref[k]);
      if (s < 0) throw new Error(`AV1: reference ${p.ref[k]} isn't in a slot`);
      return s;
    });
    const f: Frame = { p, tiles, surface: target, ts, refs };
    // Where it goes: every slot for a shown key frame, else a free slot, else it waits.
    const free = this.freeSlot(live);
    if (key || free >= 0) out.push(this.write(f, key ? 0xff : 1 << free));
    else this.waiting = f;
    return this.pack(out);
  }

  /** The waiting frame's temporal unit now (stored nowhere: decoded again if a later frame references it). */
  flush(): Av1Chunk[] {
    const w = this.waiting;
    if (!w) return [];
    this.waiting = undefined;
    return this.pack([this.write(w, 0)]);
  }

  private slotOf(surface: number) {
    return this.slots.findIndex((s) => s?.surface === surface);
  }

  /** A slot that's empty, holds a picture the guest can't reference, or a second copy (a key frame fills them all). */
  private freeSlot(live: Set<number>) {
    return this.slots.findIndex((s, k) => !s || !live.has(s.surface) || this.slotOf(s.surface) < k);
  }

  /** A frame into these slots (none: remembered, to decode again). A hidden frame the guest may show later is written
   * shown (an inter or intra-only frame decodes the same); a hidden key frame isn't (shown, it would refresh every slot). */
  private write(f: Frame, refresh: number): Unit {
    const t = f.p.pic.frameType;
    const show = f.p.pic.show || (f.p.pic.showable && t !== FRAME.KEY);
    if (!refresh && t !== FRAME.KEY) this.unstored = f;
    return this.unit(f.p, f.tiles, f.surface, refresh, show, f.p.pic.showable, show ? f.ts : undefined, f.refs);
  }

  /** Units into temporal units, each ending with a frame that has output (those without wait for the next). */
  private pack(units: Unit[]): Av1Chunk[] {
    const chunks: Av1Chunk[] = [];
    for (const u of units) {
      if (u.key) this.queued = [];
      this.queued.push(...u.obus);
      if (u.ts === undefined) continue;
      chunks.push({ data: concat([obu(OBU.TEMPORAL_DELIMITER, new Uint8Array(0)), ...this.queued]), key: u.key, ts: u.ts });
      this.queued = [];
    }
    return chunks;
  }

  /** A frame's OBUs (the sequence header before a shown key frame), the slots updated. */
  private unit(p: Av1Params, tiles: Uint8Array[], surface: number, refresh: number, show: boolean, showable: boolean, ts: number | undefined, refs: number[]): Unit {
    const t = p.pic.frameType;
    const intra = t === FRAME.KEY || t === FRAME.INTRA_ONLY;
    const key = t === FRAME.KEY && show;
    const parts: Uint8Array[] = [];
    if (key) parts.push(obu(OBU.SEQUENCE_HEADER, buildSequenceHeader(p, this.level)));
    parts.push(obu(OBU.FRAME_HEADER, buildFrameHeader(p, { refs, refresh, slots: this.slots, show, showable })));
    parts.push(obu(OBU.TILE_GROUP, buildTileGroup(tiles)));
    // The frame's global motion as the decoder keeps it (identity where the type is).
    const gm = p.wm.map((m) => (intra || m.type === GM.IDENTITY ? DEFAULT_GM : m.params));
    const slot: Slot = { surface, frameType: t, orderHint: p.orderHint, gm };
    for (let k = 0; k < 8; k++) if (key || (refresh >> k) & 1) this.slots[k] = slot;
    return { obus: parts, key, ts };
  }
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of parts) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}
