// H.264 for WebCodecs from VA-API's pictures (docs/plans/video.md; web/video-h264.ts), in Node: Exp-Golomb and
// emulation prevention, the parameter sets rebuilt from Mesa's picture desc read back field by field with a parser
// written to the standard's syntax (§7.3.2.1, §7.3.2.2), and the chunks a picture makes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BitReader, BitWriter, buildPps, buildSps, codecString, H264_DESC_SIZE, H264Stream, nal, parseH264Desc, slicePpsId, splitAnnexB, unescape, type H264Params } from '../web/video-h264.ts';
import { PROFILE } from '../web/virgl-video.ts';

/** The SPS's syntax, as the standard writes it (the fields the rebuilt SPS sets). */
export function parseSps(rbsp: Uint8Array) {
  const r = new BitReader(rbsp);
  const s: Record<string, unknown> = { profileIdc: r.u(8), constraints: r.u(8), levelIdc: r.u(8), id: r.ue() };
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(s.profileIdc as number)) {
    s.chromaFormatIdc = r.ue();
    if (s.chromaFormatIdc === 3) s.separateColourPlane = r.flag();
    s.bitDepthLumaMinus8 = r.ue();
    s.bitDepthChromaMinus8 = r.ue();
    s.qpprimeBypass = r.flag();
    s.seqScaling = r.flag();
    if (s.seqScaling) throw new Error('test parser: sequence scaling lists');
  }
  s.log2MaxFrameNumMinus4 = r.ue();
  s.pocType = r.ue();
  if (s.pocType === 0) s.log2MaxPocLsbMinus4 = r.ue();
  else if (s.pocType === 1) {
    s.deltaPicOrderAlwaysZero = r.flag();
    s.offsetForNonRefPic = r.se();
    s.offsetForTopToBottomField = r.se();
    s.offsetForRefFrame = Array.from({ length: r.ue() }, () => r.se());
  }
  s.maxNumRefFrames = r.ue();
  s.gaps = r.flag();
  s.mbWidth = r.ue() + 1;
  s.mapUnitsHeight = r.ue() + 1;
  s.frameMbsOnly = r.flag();
  if (!s.frameMbsOnly) s.mbAdaptiveFrameField = r.flag();
  s.direct8x8Inference = r.flag();
  s.cropping = r.flag();
  if (s.cropping) s.crop = [r.ue(), r.ue(), r.ue(), r.ue()];
  s.vui = r.flag();
  if (s.vui) {
    for (const f of ['aspect', 'overscan', 'signal', 'chromaLoc', 'timing', 'nalHrd', 'vclHrd', 'picStruct']) {
      if (r.flag()) throw new Error(`test parser: VUI ${f}`);
    }
    s.restriction = r.flag();
    if (s.restriction) s.reorder = { mvOver: r.flag(), bytesDenom: r.ue(), bitsDenom: r.ue(), mvH: r.ue(), mvV: r.ue(), maxNumReorderFrames: r.ue(), maxDecFrameBuffering: r.ue() };
  }
  assert.equal(r.u(1), 1, 'rbsp_stop_one_bit');
  assert.ok(r.left < 8, 'nothing after the trailing bits');
  return s;
}

export function parsePps(rbsp: Uint8Array, chroma444 = false) {
  const r = new BitReader(rbsp);
  const p: Record<string, unknown> = {
    id: r.ue(), spsId: r.ue(), entropyCodingMode: r.flag(), bottomFieldPicOrderInFramePresent: r.flag(), numSliceGroupsMinus1: r.ue(),
    numRefIdxL0DefaultActiveMinus1: r.ue(), numRefIdxL1DefaultActiveMinus1: r.ue(), weightedPred: r.flag(), weightedBipredIdc: r.u(2),
    picInitQpMinus26: r.se(), picInitQsMinus26: r.se(), chromaQpIndexOffset: r.se(), deblockingFilterControlPresent: r.flag(),
    constrainedIntraPred: r.flag(), redundantPicCntPresent: r.flag(),
  };
  p.transform8x8Mode = false;
  p.secondChromaQpIndexOffset = p.chromaQpIndexOffset;
  // more_rbsp_data(): anything before the trailing bits.
  if (r.left > 8 || (r.left > 0 && rbsp[rbsp.length - 1] !== 1 << (r.left - 1))) {
    p.transform8x8Mode = r.flag();
    const scaling = r.flag();
    if (scaling) {
      const n = 6 + (p.transform8x8Mode ? (chroma444 ? 6 : 2) : 0);
      p.lists = Array.from({ length: n }, (_, k) => {
        assert.equal(r.flag(), true, 'every list present');
        const size = k < 6 ? 16 : 64;
        let last = 8;
        return Array.from({ length: size }, () => (last = (last + r.se() + 256) % 256));
      });
    }
    p.secondChromaQpIndexOffset = r.se();
  }
  assert.equal(r.u(1), 1, 'rbsp_stop_one_bit');
  return p;
}

/** A Mesa picture desc with these values (the rest zero). */
function desc(o: { profile?: number; sps?: Partial<H264Params['sps']>; pps?: Partial<H264Params['pps']> } = {}) {
  const d = new Uint8Array(H264_DESC_SIZE);
  const v = new DataView(d.buffer);
  const s = { levelIdc: 31, chromaFormatIdc: 1, log2MaxFrameNumMinus4: 0, pocType: 0, log2MaxPocLsbMinus4: 2, maxNumRefFrames: 4, frameMbsOnly: true, direct8x8Inference: true, offsetForRefFrame: [] as number[], ...o.sps };
  const q = { entropyCodingMode: true, numRefIdxL0DefaultActiveMinus1: 2, numRefIdxL1DefaultActiveMinus1: 0, weightedBipredIdc: 2, picInitQpMinus26: -3, chromaQpIndexOffset: -2, deblockingFilterControlPresent: true, transform8x8Mode: true, secondChromaQpIndexOffset: -2, ...o.pps };
  v.setUint16(0, o.profile ?? PROFILE.AVC_HIGH, true);
  const S = 264, P = 264 + 1532;
  d[S] = s.levelIdc; d[S + 1] = s.chromaFormatIdc; d[S + 486] = s.log2MaxFrameNumMinus4; d[S + 487] = s.pocType; d[S + 488] = s.log2MaxPocLsbMinus4;
  d[S + 489] = s.deltaPicOrderAlwaysZero ? 1 : 0;
  v.setInt32(S + 492, s.offsetForNonRefPic ?? 0, true);
  v.setInt32(S + 496, s.offsetForTopToBottomField ?? 0, true);
  s.offsetForRefFrame.forEach((x, k) => v.setInt32(S + 500 + 4 * k, x, true));
  d[S + 1524] = s.offsetForRefFrame.length;
  d[S + 1525] = s.maxNumRefFrames; d[S + 1526] = s.frameMbsOnly ? 1 : 0; d[S + 1528] = s.direct8x8Inference ? 1 : 0;
  d[P] = q.entropyCodingMode ? 1 : 0; d[P + 5] = q.numRefIdxL0DefaultActiveMinus1; d[P + 6] = q.numRefIdxL1DefaultActiveMinus1;
  d[P + 7] = q.weightedPred ? 1 : 0; d[P + 8] = q.weightedBipredIdc; v.setInt8(P + 9, q.picInitQpMinus26); v.setInt8(P + 11, q.chromaQpIndexOffset);
  d[P + 12] = q.deblockingFilterControlPresent ? 1 : 0; d[P + 15] = q.transform8x8Mode ? 1 : 0; v.setInt8(P + 496, q.secondChromaQpIndexOffset);
  const l4 = q.scaling4x4 ?? Array.from({ length: 6 }, () => Array(16).fill(16));
  const l8 = q.scaling8x8 ?? Array.from({ length: 6 }, () => Array(64).fill(16));
  l4.forEach((l, k) => d.set(l, P + 16 + 16 * k));
  l8.forEach((l, k) => d.set(l, P + 112 + 64 * k));
  return d;
}

test('Exp-Golomb and fixed-width fields round trip', () => {
  const w = new BitWriter();
  const ues = [0, 1, 2, 3, 7, 8, 254, 255, 65535, 2 ** 31 - 2];
  const ses = [0, 1, -1, 2, -2, 127, -128, 1000, -1000];
  for (const x of ues) w.ue(x);
  for (const x of ses) w.se(x);
  w.u(3, 5);
  const r = new BitReader(w.finish());
  assert.deepEqual(ues.map(() => r.ue()), ues);
  assert.deepEqual(ses.map(() => r.se()), ses);
  assert.equal(r.u(3), 5);
  assert.equal(r.u(1), 1);
  // ue(v) codes from the standard's table 9-2.
  const one = (x: number) => { const b = new BitWriter(); b.ue(x); return [...b.finish()]; };
  assert.deepEqual(one(0), [0b1100_0000]); // "1" then the stop bit
  assert.deepEqual(one(3), [0b0010_0100]); // "00100"
});

test('emulation prevention: 00 00 0x (x ≤ 3) gets a 03 in a NAL unit, and is taken out again', () => {
  const rbsp = new Uint8Array([0, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 9]);
  const n = nal(7, 3, rbsp);
  assert.deepEqual([...n.subarray(0, 5)], [0, 0, 0, 1, 0x67]);
  assert.deepEqual([...n.subarray(5)], [0, 0, 3, 0, 0, 3, 0, 1, 0, 0, 3, 2, 0, 0, 3, 3, 0, 0, 4, 9]);
  assert.deepEqual([...unescape(n.subarray(5))], [...rbsp]);
  const parts = splitAnnexB(new Uint8Array([0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 4]));
  assert.deepEqual(parts.map((p) => [...p]), [[0x67, 1, 2], [0x68, 3], [0x65, 4]]);
});

test('the rebuilt SPS: the desc\'s fields, no cropping, output without reordering', () => {
  const p = parseH264Desc(desc());
  const s = parseSps(buildSps(p, 54, 30));
  assert.deepEqual(s, {
    profileIdc: 100, constraints: 0, levelIdc: 31, id: 0, chromaFormatIdc: 1, bitDepthLumaMinus8: 0, bitDepthChromaMinus8: 0, qpprimeBypass: false,
    seqScaling: false, log2MaxFrameNumMinus4: 0, pocType: 0, log2MaxPocLsbMinus4: 2, maxNumRefFrames: 4, gaps: true, mbWidth: 54, mapUnitsHeight: 30,
    frameMbsOnly: true, direct8x8Inference: true, cropping: false, vui: true, restriction: true,
    reorder: { mvOver: true, bytesDenom: 2, bitsDenom: 1, mvH: 16, mvV: 16, maxNumReorderFrames: 0, maxDecFrameBuffering: 4 },
  });
  // POC type 1's cycle, and Constrained Baseline's flags.
  const p1 = parseH264Desc(desc({ profile: PROFILE.AVC_CONSTRAINED_BASELINE, sps: { pocType: 1, deltaPicOrderAlwaysZero: false, offsetForNonRefPic: -2, offsetForTopToBottomField: 1, offsetForRefFrame: [3, -4, 5] } }));
  const s1 = parseSps(buildSps(p1, 20, 15));
  assert.equal(s1.profileIdc, 66);
  assert.equal(s1.constraints, 0x40);
  assert.deepEqual([s1.offsetForNonRefPic, s1.offsetForTopToBottomField, s1.offsetForRefFrame], [-2, 1, [3, -4, 5]]);
  assert.equal(codecString(PROFILE.AVC_HIGH, 40), 'avc1.640028');
  assert.equal(codecString(PROFILE.AVC_CONSTRAINED_BASELINE, 30), 'avc1.42401E');
});

test('the rebuilt PPS: the desc\'s fields, its id, and the effective scaling lists when they aren\'t flat', () => {
  const p = parseH264Desc(desc());
  assert.deepEqual(parsePps(buildPps(p, 3)), {
    id: 3, spsId: 0, entropyCodingMode: true, bottomFieldPicOrderInFramePresent: false, numSliceGroupsMinus1: 0, numRefIdxL0DefaultActiveMinus1: 2,
    numRefIdxL1DefaultActiveMinus1: 0, weightedPred: false, weightedBipredIdc: 2, picInitQpMinus26: -3, picInitQsMinus26: 0, chromaQpIndexOffset: -2,
    deblockingFilterControlPresent: true, constrainedIntraPred: false, redundantPicCntPresent: false, transform8x8Mode: true, secondChromaQpIndexOffset: -2,
  });
  // Without transform_8x8 and with equal chroma offsets the PPS stops before the optional part.
  const plain = parsePps(buildPps(parseH264Desc(desc({ pps: { transform8x8Mode: false } })), 0));
  assert.equal(plain.transform8x8Mode, false);
  // Lists: 6 of 4×4, 2 of 8×8 with transform_8x8 (4:2:0).
  const l4 = Array.from({ length: 6 }, (_, k) => Array.from({ length: 16 }, (_, j) => 6 + k + j));
  const l8 = Array.from({ length: 6 }, (_, k) => Array.from({ length: 64 }, (_, j) => (k < 2 ? 200 - 3 * j : 16)));
  const q = parsePps(buildPps(parseH264Desc(desc({ pps: { scaling4x4: l4, scaling8x8: l8 } })), 1));
  assert.deepEqual(q.lists, [...l4, ...l8.slice(0, 2)]);
});

test('a picture\'s chunk: parameter sets at an IDR and when they change, the slices after', () => {
  // A slice header: first_mb_in_slice 0, slice_type 7 (I), pic_parameter_set_id 2.
  const header = (type: number, pps: number) => {
    const w = new BitWriter();
    w.ue(0);
    w.ue(type === 5 ? 7 : 5);
    w.ue(pps);
    w.u(8, 0xa5);
    return nal(type, 3, w.finish());
  };
  assert.equal(slicePpsId(header(5, 2).subarray(4)), 2);
  const st = new H264Stream(864, 480);
  const d = desc();
  const types = (b: Uint8Array) => splitAnnexB(b).map((n) => n[0] & 0x1f);
  const idr = st.chunk(d, header(5, 2));
  assert.equal(idr.key, true);
  assert.deepEqual(types(idr.data), [7, 8, 5]);
  const sps = parseSps(unescape(splitAnnexB(idr.data)[0].subarray(1)));
  assert.deepEqual([sps.mbWidth, sps.mapUnitsHeight], [54, 30]);
  assert.equal(parsePps(unescape(splitAnnexB(idr.data)[1].subarray(1))).id, 2);
  // A P picture with the same parameters: its slice alone. Two slices on another PPS: that PPS first.
  assert.deepEqual(types(st.chunk(d, header(1, 2)).data), [1]);
  const two = new Uint8Array([...header(1, 4), ...header(1, 4)]);
  const c = st.chunk(d, two);
  assert.equal(c.key, false);
  assert.deepEqual(types(c.data), [8, 1, 1]);
  // A changed PPS for id 2 comes again.
  assert.deepEqual(types(st.chunk(desc({ pps: { picInitQpMinus26: 4 } }), header(1, 2)).data), [8, 1]);
  assert.throws(() => st.chunk(desc({ sps: { frameMbsOnly: false } }), header(1, 2)), /interlaced/);
});

test('a software decoder\'s stream: the SPS says the stream\'s reorder depth, learned from the POCs, from an IDR on', () => {
  const slice = (type: number) => {
    const w = new BitWriter();
    w.ue(0);
    w.ue(type === 5 ? 7 : 5);
    w.ue(0);
    w.u(16, 0xa5a5); // the rest of the header, as far as the parser reads
    return nal(type, 3, w.finish());
  };
  /** A picture's desc with its POC (both fields) and the stream's reference count. */
  const at = (poc: number, refs = 1) => {
    const d = desc({ sps: { maxNumRefFrames: refs } });
    const v = new DataView(d.buffer);
    v.setInt32(2308, poc, true);
    v.setInt32(2312, poc, true);
    return d;
  };
  const said = (b: Uint8Array) => {
    const sps = splitAnnexB(b).find((n) => (n[0] & 0x1f) === 7);
    return sps && (parseSps(unescape(sps.subarray(1))).reorder as { maxNumReorderFrames?: number } | undefined)?.maxNumReorderFrames;
  };
  const st = new H264Stream(864, 480, 31, 'stream');
  // An IDR: nothing learned yet, so the reference count.
  const idr = st.chunk(at(0), slice(5));
  assert.deepEqual([said(idr.data), idr.poc], [1, 0]);
  // P 6, then B 4 (one picture before it comes after it) and b 2 (two): the SPS stays until the next IDR.
  for (const poc of [6, 4, 2]) {
    const c = st.chunk(at(poc), slice(1));
    assert.deepEqual([said(c.data), c.poc], [undefined, poc]);
  }
  assert.equal(said(st.chunk(at(0), slice(5)).data), 2);
  // More references than the depth: those.
  assert.equal(said(st.chunk(at(0, 4), slice(5)).data), 4);
  // What a stream learned carries to the next (a drained decoder's successor), and the SPS never says less within one.
  assert.equal(st.depth, 2);
  const next = new H264Stream(864, 480, 31, 'stream', st.depth);
  assert.equal(said(next.chunk(at(0), slice(5)).data), 2);
  for (const poc of [8, 6, 4, 2]) next.chunk(at(poc), slice(1));
  assert.equal(next.depth, 3);
  assert.equal(said(next.chunk(at(0), slice(5)).data), 3);
  // A hardware decoder's: 0, whatever the POCs.
  const hw = new H264Stream(864, 480, 31, 'none');
  hw.chunk(at(0), slice(5));
  hw.chunk(at(6), slice(1));
  hw.chunk(at(2), slice(1));
  assert.equal(said(hw.chunk(at(0), slice(5)).data), 0);
});
