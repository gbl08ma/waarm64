// AV1's stream for WebCodecs from the guest's stateless decode (web/video-av1.ts; docs/graphics.md "Video"): the bit
// writer's codes read back by readers written to the spec (AV1 §4.10, §5.9.26-28), and the reference slots this side
// keeps (Mesa's desc has no refresh_frame_flags), read back from the frame headers. The headers' exactness is the
// Chromium test's (tests/virgl-browser.test.ts: the guest's frames decoded through them, each FFmpeg's).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AV1_DESC_SIZE, Av1Stream, Av1Writer, FRAME, leb128, writeUnsignedSubexpWithRef } from '../web/video-av1.ts';

/** Reads bits as AV1 §4.10 does. */
class Reader {
  private at = 0;
  private b: Uint8Array;
  constructor(b: Uint8Array) { this.b = b; }
  f(n: number) {
    let v = 0;
    for (let k = 0; k < n; k++, this.at++) v = v * 2 + ((this.b[this.at >> 3] >> (7 - (this.at & 7))) & 1);
    return v;
  }
  ns(n: number) {
    const w = 32 - Math.clz32(n), m = (1 << w) - n;
    const v = this.f(w - 1);
    return v < m ? v : (v << 1) - m + this.f(1);
  }
  /** decode_unsigned_subexp_with_ref (§5.9.27, 28) */
  subexpRef(mx: number, r: number) {
    let i = 0, mk = 0, v: number;
    for (;;) {
      const b2 = i ? 3 + i - 1 : 3, a = 1 << b2;
      if (mx <= mk + 3 * a) { v = this.ns(mx - mk) + mk; break; }
      if (this.f(1)) { i++; mk += a; } else { v = this.f(b2) + mk; break; }
    }
    const inv = (r: number, v: number) => (v > 2 * r ? v : v & 1 ? r - ((v + 1) >> 1) : r + (v >> 1));
    return (r << 1) <= mx ? inv(r, v) : mx - 1 - inv(mx - 1 - r, v);
  }
}

test('AV1 writer: ns(n) and the sub-exponential code with a reference read back as the spec reads them', () => {
  for (let n = 1; n <= 40; n++) {
    for (let v = 0; v < n; v++) {
      const w = new Av1Writer();
      w.ns(n, v);
      w.f(7, 0x55); // what follows stays in step
      const r = new Reader(w.trailing());
      assert.equal(r.ns(n), v, `ns(${n}) of ${v}`);
      assert.equal(r.f(7), 0x55);
    }
  }
  // The global motion parameters' ranges: 2^13 + 1 values (alpha), 2^10 + 1 (translation only).
  for (const mx of [2, 7, 25, 2 * 512 + 1, 2 * 4096 + 1]) {
    for (const ref of [0, 1, mx >> 1, mx - 2, mx - 1]) {
      for (const x of [0, 1, 2, ref, mx >> 2, mx - 1].filter((x) => x >= 0 && x < mx)) {
        const w = new Av1Writer();
        writeUnsignedSubexpWithRef(w, mx, ref, x);
        w.f(5, 0b10110);
        const r = new Reader(w.trailing());
        assert.equal(r.subexpRef(mx, ref), x, `mx ${mx} ref ${ref} x ${x}`);
        assert.equal(r.f(5), 0b10110);
      }
    }
  }
  assert.deepEqual(leb128(0), [0]);
  assert.deepEqual(leb128(127), [127]);
  assert.deepEqual(leb128(128), [0x80, 1]);
  assert.deepEqual(leb128(300000), [0xe0, 0xa7, 0x12]);
});

/** A desc (Mesa's `virgl_av1_picture_desc`) for a 64x64 frame with one tile of 4 bytes at offset 0. */
function desc(o: { type: number; show?: boolean; showable?: boolean; refs?: number[]; map?: number[]; orderHint?: number }) {
  const d = new Uint8Array(AV1_DESC_SIZE), v = new DataView(d.buffer);
  (o.map ?? []).forEach((s, k) => v.setUint32(264 + 4 * k, s, true));
  d[333] = 6; // order_hint_bits_minus_1
  v.setUint32(336, 1 << 6, true); // enable_order_hint
  v.setUint16(344, 64, true); v.setUint16(346, 64, true); v.setUint16(348, 64, true); v.setUint16(350, 64, true);
  (o.refs ?? [0, 0, 0, 0, 0, 0, 0]).forEach((r, k) => (d[352 + k] = r));
  d[359] = 7; // primary_ref_frame: none
  d[360] = o.orderHint ?? 0;
  d[664] = 1; d[665] = 1; // one tile
  v.setUint16(1188, 1, true); v.setUint16(1316, 1, true);
  v.setUint32(1448, o.type | ((o.show ?? true) ? 4 : 0) | (o.showable ? 8 : 0) | (1 << 14), true); // uniform tiles
  d[1469] = 100; // base_q_idx
  v.setUint32(1800, 4, true); // the tile: 4 bytes at 0
  v.setUint16(5128, 1, true);
  return d;
}

/** The first fields (§5.9.2: what the slots are about) of each frame header in a temporal unit. */
function headers(chunk: Uint8Array) {
  const out = [];
  for (let at = 0; at < chunk.length;) {
    const type = (chunk[at] >> 3) & 15, size = chunk[at + 1]; // sizes under 128 here
    if (type === 3) {
      const r = new Reader(chunk.subarray(at + 2, at + 2 + size));
      r.f(1); // show_existing_frame
      const type = r.f(2), show = !!r.f(1);
      const showable = show ? type !== FRAME.KEY : !!r.f(1);
      const er = type === FRAME.KEY && show ? true : !!r.f(1);
      r.f(1); // disable_cdf_update
      if (r.f(1)) r.f(1); // allow_screen_content_tools, force_integer_mv
      r.f(1); // frame_size_override_flag
      const orderHint = r.f(7);
      const intra = type === FRAME.KEY || type === FRAME.INTRA_ONLY;
      if (!intra && !er) r.f(3);
      const refresh = type === FRAME.KEY && show ? 0xff : r.f(8);
      let refs: number[] = [];
      if (!intra) {
        r.f(1); // frame_refs_short_signaling
        refs = Array.from({ length: 7 }, () => r.f(3));
      }
      out.push({ type, show, showable, orderHint, refresh, refs });
    }
    at += 2 + size;
  }
  return out;
}

test('Av1Stream: frames go to slots holding nothing the guest can reference; one with none free waits for the next frame\'s map', () => {
  const s = new Av1Stream();
  const tile = new Uint8Array([1, 2, 3, 4]);
  /** One frame's temporal units (its timestamp: its target): the frame headers in each, its key flag and timestamp. */
  const one = (d: Uint8Array, target: number) => s.chunks(d, tile, target, target).map((c) => ({ frames: headers(c.data), key: c.key, ts: c.ts }));
  const flush = () => s.flush().map((c) => ({ frames: headers(c.data), key: c.key, ts: c.ts }));
  // A key frame (surface 10) fills every slot.
  assert.deepEqual(one(desc({ type: FRAME.KEY }), 10), [{ frames: [{ type: 0, show: true, showable: false, orderHint: 0, refresh: 0xff, refs: [] }], key: true, ts: 10 }]);
  // Inter frames 11..17: the guest stores each in a slot of its own (its map: the key frame and those so far); here
  // each goes to the first slot holding a copy of the key frame, and references it there.
  const map = [10, 10, 10, 10, 10, 10, 10, 10];
  for (let k = 1; k <= 7; k++) {
    const [{ frames: [f] }] = one(desc({ type: FRAME.INTER, map, refs: [0, 0, 0, 0, 0, 0, 0], orderHint: k }), 10 + k);
    assert.deepEqual([f.refresh, f.refs], [1 << k, [0, 0, 0, 0, 0, 0, 0]], `frame ${k}`);
    map[k] = 10 + k;
  }
  // The guest's map now holds eight pictures: a frame (20) referencing the newest has no slot free, and waits...
  assert.deepEqual(one(desc({ type: FRAME.INTER, map, refs: [7, 7, 7, 7, 7, 7, 7], orderHint: 8 }), 20), []);
  assert.equal(s.holding, true);
  // ... until the next frame's map says the guest stored it over the key frame's slot 0: written there, then.
  map[0] = 20;
  const [w] = one(desc({ type: FRAME.INTER, map, refs: [0, 1, 0, 0, 0, 0, 0], orderHint: 9 }), 21);
  assert.deepEqual([w.frames.length, w.frames[0].refresh, w.frames[0].refs, w.ts], [1, 1, [7, 7, 7, 7, 7, 7, 7], 20]);
  // That frame (21) waits too; the guest waits on it (a player reading it back): sent stored nowhere...
  assert.deepEqual(flush(), [{ frames: [{ type: 1, show: true, showable: true, orderHint: 9, refresh: 0, refs: [0, 1, 0, 0, 0, 0, 0] }], key: false, ts: 21 }]);
  assert.equal(s.holding, false);
  // ... and when a later map has it (stored over 11's slot), decoded again, hidden, into the slot that held 11, in the
  // temporal unit of the next frame with output (this one waits: the unit goes with the frame after).
  map[1] = 21;
  assert.deepEqual(one(desc({ type: FRAME.INTER, map, refs: [1, 1, 1, 1, 1, 1, 1], orderHint: 10 }), 22), []);
  const [x] = one(desc({ type: FRAME.INTER, map, refs: [0, 0, 0, 0, 0, 0, 0], orderHint: 11 }), 23);
  assert.deepEqual(x.frames.map((f) => [f.orderHint, f.show, f.refresh, f.refs[0]]), [[9, false, 2, 0], [10, true, 0, 1]]);
  assert.equal(x.ts, 22);
  // 22 was stored nowhere (the map didn't have it): 23 waits now, then goes out on a flush.
  assert.equal(flush()[0].ts, 23);
  // A hidden frame the guest may show later is written shown, for its output; one it never shows goes in the next
  // frame's temporal unit (every unit ends with a shown frame).
  map[2] = 30;
  map[3] = 31;
  const [arf] = [...one(desc({ type: FRAME.INTER, show: false, showable: true, map, orderHint: 16 }), 32), ...flush()];
  assert.deepEqual([arf.frames.at(-1)!.show, arf.ts], [true, 32]);
  assert.deepEqual([...one(desc({ type: FRAME.INTER, show: false, showable: false, map, orderHint: 17 }), 33), ...flush()], []);
  const [after] = [...one(desc({ type: FRAME.INTER, map, orderHint: 12 }), 34), ...flush()];
  assert.deepEqual([after.frames.map((f) => [f.orderHint, f.show]), after.ts], [[[17, false], [12, true]], 34]);
  // A reference that's in no slot is an error (the codec's pictures then wait for a key frame).
  assert.throws(() => one(desc({ type: FRAME.INTER, map: [99, 99, 99, 99, 99, 99, 99, 99] }), 35), /reference 99 isn't in a slot/);
});

test('Av1Stream: global motion is coded against the primary reference\'s parameters, as the decoder reads it', () => {
  // A 64x64 frame with few tools on, its header read through to global_motion_params (§5.9.24): the reader decodes
  // each parameter against the previous frame's, as a decoder does with primary_ref_frame's saved parameters.
  const ROTZOOM = 2;
  const frame = (orderHint: number, map: number[], params: number[], primary: number) => {
    const d = desc({ type: FRAME.INTER, map, orderHint });
    const v = new DataView(d.buffer);
    d[359] = primary;
    v.setUint32(1512 + 40 * 0, ROTZOOM, true); // LAST_FRAME's
    params.forEach((x, j) => v.setInt32(1512 + 8 + 4 * j, x, true));
    return d;
  };
  const read = (chunk: Uint8Array, prev: number[]) => {
    let at = 0;
    while (((chunk[at] >> 3) & 15) !== 3) at += 2 + chunk[at + 1];
    const r = new Reader(chunk.subarray(at + 2, at + 2 + chunk[at + 1]));
    r.f(1); r.f(2); r.f(1); r.f(1); r.f(1); // show_existing, frame_type, show_frame, error_resilient, disable_cdf_update
    if (r.f(1)) r.f(1); // allow_screen_content_tools
    r.f(1); r.f(7); r.f(3); r.f(8); // size override, order hint, primary_ref_frame, refresh
    r.f(1); for (let k = 0; k < 7; k++) r.f(3); // short signaling, refs
    for (let k = 0; k < 7; k++) r.f(1); // found_ref
    r.f(16); r.f(16); r.f(1); r.f(1); // frame size, use_superres, render_and_frame_size_different
    r.f(1); // allow_high_precision_mv
    if (!r.f(1)) r.f(2); // is_filter_switchable
    r.f(1); r.f(1); r.f(1); // is_motion_mode_switchable, use_ref_frame_mvs, disable_frame_end_update_cdf
    r.f(1); // uniform_tile_spacing_flag (one superblock: no increments)
    r.f(8); r.f(1); r.f(1); r.f(1); r.f(1); r.f(1); // base_q_idx, delta y dc, diff_uv_delta, u dc, u ac, using_qmatrix
    r.f(1); r.f(1); // segmentation_enabled, delta_q_present
    const l0 = r.f(6), l1 = r.f(6);
    if (l0 || l1) { r.f(6); r.f(6); }
    r.f(3); r.f(1); // sharpness, delta enabled
    r.f(2); r.f(2); r.f(2); // lr_type (cdef is off in the sequence)
    r.f(1); r.f(1); r.f(1); r.f(1); // tx_mode_select, reference_select, allow_warped_motion, reduced_tx_set
    assert.equal(r.f(1), 1, 'is_global');
    assert.equal(r.f(1), 1, 'is_rot_zoom');
    // read_global_param for 2, 3 (then 4 = -3, 5 = 2), 0, 1
    const param = (idx: number) => {
      const absBits = idx < 2 ? 12 : 12, precBits = idx < 2 ? 6 : 15, precDiff = 16 - precBits;
      const round = idx % 3 === 2 ? 1 << 16 : 0, sub = idx % 3 === 2 ? 1 << precBits : 0, mx = 1 << absBits;
      const ref = (prev[idx] >> precDiff) - sub;
      return ((r.subexpRef(2 * mx + 1, ref + mx) - mx) << precDiff) + round;
    };
    const p2 = param(2), p3 = param(3), p0 = param(0), p1 = param(1);
    return [p0, p1, p2, p3];
  };
  const s = new Av1Stream();
  const tile = new Uint8Array([1, 2, 3, 4]);
  s.chunks(desc({ type: FRAME.KEY }), tile, 10, 10);
  const map = [10, 10, 10, 10, 10, 10, 10, 10];
  const a = [3 << 10, -5 << 10, (1 << 16) + (7 << 1), -9 << 1, 9 << 1, (1 << 16) + (7 << 1)];
  const [ca] = s.chunks(frame(1, map, a, 7), tile, 11, 11); // no primary reference: against the defaults
  assert.deepEqual(read(ca.data, [0, 0, 1 << 16, 0, 0, 1 << 16]), a.slice(0, 4));
  map[1] = 11;
  const b = [-2 << 10, 4 << 10, (1 << 16) - (3 << 1), 11 << 1, -11 << 1, (1 << 16) - (3 << 1)];
  // Primary reference 0: LAST_FRAME, guest slot 1, the frame before (in a slot of ours, its parameters saved).
  const d = frame(2, map, b, 0);
  d[352] = 1;
  const [cb] = s.chunks(d, tile, 12, 12);
  assert.deepEqual(read(cb.data, a), b.slice(0, 4));
});
