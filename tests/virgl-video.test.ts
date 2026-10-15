// Video over virgl in Node (docs/plans/video.md): the caps' video entries as Mesa reads them, a restore's check that the
// browser still has the decoders the guest was told of, the codec and buffer tables the video commands keep, the
// pictures through a fake decoder into their planes, and the GPU worker's queue holding what follows a picture.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeCaps } from '../web/virgl.ts';
import { capsBacked, capsFromGl, withVideo } from '../web/virgl-caps.ts';
import { CallQueue, type WorkerCall } from '../web/virgl-host.ts';
import { VirglRenderer } from '../web/virgl-renderer.ts';
import { decodeVideoCaps, encodeVideoCaps, FORMAT_NV12, PROFILE, probeVideo, VideoContext, type DecodedPicture, type DecoderConfig, type DecoderFactory, type VideoStats } from '../web/virgl-video.ts';
import { mockGl } from './virgl-mock-gl.ts';

const H264 = { profile: PROFILE.AVC_HIGH, maxLevel: 51, maxWidth: 4096, maxHeight: 2304 };
const VP9 = { profile: PROFILE.VP9_PROFILE0, maxLevel: 0, maxWidth: 4096, maxHeight: 2304 };

test('video caps: struct virgl_video_caps bit fields, in the v2 caps after num_video_caps', () => {
  const words = encodeVideoCaps([H264, VP9]);
  assert.equal(words.length, 8);
  // profile:8 entrypoint:8 max_level:8 stacked_frames:8 | max_width:16 max_height:16 | prefered_format:16
  // max_macroblocks:16 | npot_texture:1 supports_progressive:1 supports_interlaced:1 ...
  assert.equal(words[0], PROFILE.AVC_HIGH | (1 << 8) | (51 << 16));
  assert.equal(words[1], 4096 | (2304 << 16));
  assert.equal(words[2] & 0xffff, FORMAT_NV12);
  assert.equal(words[2] >>> 16, (4096 / 16) * (2304 / 16));
  assert.equal(words[3], 0b11);
  assert.deepEqual(decodeVideoCaps(words, 2), [H264, VP9]);

  const caps = withVideo(capsFromGl(mockGl({})), [H264, VP9]);
  const v = decodeCaps(caps);
  assert.equal(v.num_video_caps, 2);
  assert.deepEqual((v.video_caps as number[]).slice(0, 8), words);
  // Mesa's struct virgl_caps_v2: num_video_caps at dword 214, video_caps[32] (4 dwords each), then max_uniform_block_size.
  const dv = new DataView(caps.buffer, caps.byteOffset);
  assert.equal(dv.getUint32(214 * 4, true), 2);
  assert.equal(dv.getUint32(215 * 4, true), words[0]);
  assert.equal(dv.getUint32(343 * 4, true), v.max_uniform_block_size);
});

test('capsBacked: a restore needs every decoder the guest was told of', () => {
  const base = capsFromGl(mockGl({}));
  assert.equal(capsBacked(withVideo(base, [H264]), withVideo(base, [H264, VP9])), null);
  assert.equal(capsBacked(withVideo(base, []), withVideo(base, [VP9])), null);
  assert.match(capsBacked(withVideo(base, [H264, VP9]), withVideo(base, [H264]))!, /no video decoder for profile 24/);
  assert.match(capsBacked(withVideo(base, [H264]), withVideo(base, [{ ...H264, maxWidth: 1920 }]))!, /profile 11/);
});

test('probeVideo: what the browser decodes is offered, and what it decodes in hardware noted', async () => {
  const probe = async (hw: (codec: string) => boolean, o?: { software?: boolean }) => {
    const g = globalThis as { VideoDecoder?: unknown };
    g.VideoDecoder = { isConfigSupported: async (c: VideoDecoderConfig) => ({ supported: c.hardwareAcceleration !== 'prefer-hardware' || hw(c.codec) }) };
    try {
      const r = await probeVideo(o);
      return { caps: r.caps.map((c) => c.profile), hardware: r.hardware };
    } finally {
      delete g.VideoDecoder;
    }
  };
  const h264 = [PROFILE.AVC_CONSTRAINED_BASELINE, PROFILE.AVC_MAIN, PROFILE.AVC_HIGH];
  assert.deepEqual(await probe(() => false), { caps: [...h264, PROFILE.VP9_PROFILE0], hardware: [] });
  assert.deepEqual(await probe(() => true), { caps: [...h264, PROFILE.VP9_PROFILE0], hardware: [...h264, PROFILE.VP9_PROFILE0] });
  assert.deepEqual(await probe((c) => c.startsWith('avc1')), { caps: [...h264, PROFILE.VP9_PROFILE0], hardware: h264 });
  assert.deepEqual(await probe(() => true, { software: true }), { caps: [...h264, PROFILE.VP9_PROFILE0], hardware: [] });
});

test('VideoContext: codecs, buffers and a picture\'s parameters and data, read from the staging buffers', () => {
  const stats: VideoStats = { codecs: 0, buffers: 0, frames: 0, decoded: 0, dropped: 0, bitstreamBytes: 0, errors: 0, latencyMs: 0, latencyMaxMs: 0, writeMs: 0 };
  const errors: string[] = [];
  const staging = new Map([[7, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], [8, new Uint8Array(32).fill(9)]]);
  const v = new VideoContext({
    read: (res, len) => staging.get(res)?.subarray(0, len) ?? null,
    size: (res) => staging.get(res)?.length ?? 0,
    error: (m) => errors.push(m),
  }, stats);
  const cmd = (c: number, ...p: number[]) => v.command(c, new Uint32Array(p));
  cmd(53, 100, PROFILE.AVC_HIGH, 1, 1, 41, 864, 480, 16); // CREATE_VIDEO_CODEC (864: Mesa aligns H.264 to macroblocks)
  cmd(55, 200, FORMAT_NV12, 864, 480, 31, 32); // CREATE_VIDEO_BUFFER: two planes
  assert.deepEqual(stats, { codecs: 1, buffers: 1, frames: 0, decoded: 0, dropped: 0, bitstreamBytes: 0, errors: 0, latencyMs: 0, latencyMaxMs: 0, writeMs: 0 });
  assert.deepEqual(v.buffers.get(200)?.planes, [31, 32]);
  cmd(57, 100, 200); // BEGIN_FRAME
  cmd(59, 100, 200, 8, 7, 5); // DECODE_BITSTREAM: desc in 8, data in 7 (5 bytes)
  cmd(61, 100, 200); // END_FRAME
  assert.equal(stats.frames, 1);
  assert.equal(stats.bitstreamBytes, 5);
  // Unknown handles are errors, and a picture on another target doesn't end.
  cmd(57, 101, 200);
  cmd(61, 100, 201);
  assert.equal(stats.frames, 1);
  assert.equal(stats.errors, 1);
  assert.deepEqual(errors, ['video: no codec 101']);
  cmd(60, 100, 200, 0, 0, 0);
  assert.match(errors[1], /encoding/);
  cmd(56, 200);
  cmd(54, 100);
  assert.deepEqual({ codecs: stats.codecs, buffers: stats.buffers }, { codecs: 0, buffers: 0 });
});

/** A decoder that keeps its chunks; the test outputs pictures (`out`) or fails it (`fail`). */
/** A fake decoder: what it was given; `out` outputs a picture, `fail` errs, `flushed` ends the last flush. */
type Fake = { config: DecoderConfig; chunks: { data: Uint8Array; key: boolean; ts: number }[]; flushes: number; closed: boolean; out(ts: number): void; fail(m: string): void; flushed?: () => void };
function fakeDecoders() {
  const made: Fake[] = [];
  const factory: DecoderFactory = (config, output, error) => {
    const f: Fake = { config, chunks: [], flushes: 0, closed: false, out: (ts) => output(ts, picture(ts)), fail: error };
    made.push(f);
    return {
      decode: (data, key, ts) => void f.chunks.push({ data: data.slice(), key, ts }),
      flush: () => {
        f.flushes++;
        return new Promise<void>((ok) => (f.flushed = ok));
      },
      close: () => void (f.closed = true),
    };
  };
  return { made, factory };
}
/** A 4×2 picture whose bytes say which one it is. */
const picture = (ts: number): DecodedPicture => ({ width: 4, height: 2, y: new Uint8Array(8).fill(ts), uv: new Uint8Array(4).fill(100 + ts) });

/** A context with a fake decoder, one codec (handle 1) and 8 NV12 buffers (handles 2-9, planes 31 and 32, 33 and 34, …),
 * used in turn as the guest's surfaces are (a buffer is decoded into again once released). */
function video(profile: number, o: { hardware?: number[] } = {}) {
  const stats: VideoStats = { codecs: 0, buffers: 0, frames: 0, decoded: 0, dropped: 0, bitstreamBytes: 0, errors: 0, latencyMs: 0, latencyMaxMs: 0, writeMs: 0 };
  const errors: string[] = [], written: { planes: number[]; ts: number }[] = [];
  let settled = 0;
  const staging = new Map<number, Uint8Array>();
  const { made, factory } = fakeDecoders();
  const v = new VideoContext({
    read: (res, len) => staging.get(res)?.subarray(0, len) ?? null,
    size: (res) => staging.get(res)?.length ?? 0,
    error: (m) => errors.push(m),
    decoders: factory,
    hardware: o.hardware,
    write: (planes, pic) => written.push({ planes, ts: pic.y[0] }),
    settled: () => settled++,
  }, stats);
  const cmd = (c: number, ...p: number[]) => v.command(c, new Uint32Array(p));
  cmd(53, 1, profile, 1, 1, 30, 864, 480, 4);
  for (let k = 0; k < 8; k++) cmd(55, 2 + k, FORMAT_NV12, 864, 480, 31 + 2 * k, 32 + 2 * k);
  /** One picture into the next buffer (or `target`): its desc and data put in staging buffers 107 and 108, then
   * BEGIN_FRAME, DECODE_BITSTREAM, END_FRAME. */
  let next = 0;
  const frame = (desc: Uint8Array, bits: Uint8Array, target = 2 + (next++ % 8)) => {
    staging.set(107, desc);
    staging.set(108, bits);
    cmd(57, 1, target);
    cmd(59, 1, target, 107, 108, bits.length);
    cmd(61, 1, target);
  };
  return { v, stats, errors, written, made, frame, settledCount: () => settled };
}
/** A VP9 picture desc (Mesa's `virgl_vp9_picture_desc`): a key frame or not, shown or not (picture fields, byte 332). */
const vp9 = (key: boolean, shown = true) => {
  const d = new Uint8Array(400);
  d[332] = (key ? 0 : 4) | (shown ? 8 : 0);
  return d;
};

test('VideoContext: VP9 pictures through the decoder into their planes; a hidden frame waits for nothing', () => {
  const t = video(PROFILE.VP9_PROFILE0);
  t.frame(vp9(true), new Uint8Array([1, 2, 3]));
  t.frame(vp9(false, false), new Uint8Array([4]));
  t.frame(vp9(false), new Uint8Array([5, 6]));
  assert.equal(t.made.length, 1);
  assert.equal(t.made[0].config.codec, 'vp09.00.51.08');
  assert.equal(t.made[0].config.hardware, false);
  assert.deepEqual(t.made[0].chunks.map((c) => [c.ts, c.key, [...c.data]]), [[0, true, [1, 2, 3]], [1, false, [4]], [2, false, [5, 6]]]);
  // The hidden frame (1) gives no output and isn't waited for.
  assert.equal(t.v.waiting, 2);
  t.made[0].out(0);
  assert.equal(t.v.waiting, 1);
  t.made[0].out(2);
  assert.equal(t.v.waiting, 0);
  assert.deepEqual(t.written, [{ planes: [31, 32], ts: 0 }, { planes: [35, 36], ts: 2 }]);
  assert.equal(t.settledCount(), 2);
  assert.deepEqual({ frames: t.stats.frames, decoded: t.stats.decoded, dropped: t.stats.dropped, errors: t.stats.errors }, { frames: 3, decoded: 2, dropped: 0, errors: 0 });
  assert.ok(t.stats.latencyMaxMs <= t.stats.latencyMs && t.stats.writeMs <= t.stats.latencyMs, 'the pictures\' times: each within the total, the writes within the wait');
});

test('VideoContext: a decoder error loses its pictures, and a new decoder starts at the next key picture', () => {
  const t = video(PROFILE.VP9_PROFILE0);
  t.frame(vp9(false), new Uint8Array([9])); // no key yet: dropped, nothing sent
  assert.deepEqual(t.made[0].chunks, []);
  t.frame(vp9(true), new Uint8Array([1]));
  t.frame(vp9(false), new Uint8Array([2]));
  assert.equal(t.v.waiting, 2);
  t.made[0].fail('EncodingError: boom');
  assert.ok(t.made[0].closed);
  assert.equal(t.v.waiting, 0);
  assert.match(t.errors[0], /boom/);
  t.made[0].out(1); // a late output of the old decoder: ignored
  t.frame(vp9(false), new Uint8Array([3])); // a new decoder, but no key: dropped
  t.frame(vp9(true), new Uint8Array([4]));
  assert.equal(t.made.length, 2);
  assert.deepEqual(t.made[1].chunks.map((c) => [c.key, [...c.data]]), [[true, [4]]]);
  t.made[1].out(t.made[1].chunks[0].ts);
  assert.deepEqual(t.written.map((w) => w.ts), [t.made[1].chunks[0].ts]);
  assert.deepEqual({ decoded: t.stats.decoded, dropped: t.stats.dropped, errors: t.stats.errors }, { decoded: 1, dropped: 4, errors: 1 });
});

/** An H.264 desc (High, frame pictures only) and an IDR picture's one slice (I, first_mb 0, PPS 0). */
const h264Desc = () => {
  const d = new Uint8Array(2624);
  new DataView(d.buffer).setUint16(0, PROFILE.AVC_HIGH, true);
  d[264 + 1] = 1; // chroma_format_idc
  d[264 + 1526] = 1; // frame_mbs_only_flag
  return d;
};
const idr = new Uint8Array([0, 0, 0, 1, 0x65, 0x88, 0x84, ...new Array(24).fill(0xff)]);

test('VideoContext: H.264 in software is drained when it holds pictures, and decoded again from the IDR; in hardware it never is', async () => {
  /** A picture's desc (4 references) with its POC; a non-IDR picture's slice. */
  const at = (poc: number) => {
    const d = h264Desc();
    d[264 + 1525] = 4;
    new DataView(d.buffer).setInt32(2308, poc, true);
    new DataView(d.buffer).setInt32(2312, poc, true);
    return d;
  };
  const slice = new Uint8Array(idr);
  slice[4] = 0x41;
  const sw = video(PROFILE.AVC_HIGH);
  sw.frame(at(0), idr);
  const c = sw.made[0];
  assert.equal(c.config.codec, 'avc1.64001E');
  assert.equal(c.config.hardware, false);
  // The chunk: SPS, PPS, then the slice.
  assert.deepEqual([...c.chunks[0].data.subarray(0, 5)], [0, 0, 0, 1, 0x67]);
  assert.ok(c.chunks[0].key);
  // Three more; the decoder holds them all, and the guest waits for the first (POC 0).
  for (const poc of [6, 4, 2]) sw.frame(at(poc), slice);
  sw.v.drain();
  assert.equal(c.flushes, 1);
  // A new decoder takes the IDR period again, from the IDR (its parameter sets first).
  assert.equal(sw.made.length, 2);
  const d = sw.made[1];
  assert.deepEqual(d.chunks.map((x) => [x.ts, x.key]), [[0, true], [1, false], [2, false], [3, false]]);
  assert.deepEqual([...d.chunks[0].data.subarray(0, 5)], [0, 0, 0, 1, 0x67]);
  // The drained decoder's output still counts; the new one's of a picture already written doesn't; while both output,
  // nothing is passed over.
  c.out(0);
  c.out(3); // the drained decoder ahead of the new one
  d.out(0);
  d.out(1);
  assert.deepEqual(sw.written.map((w) => w.ts), [0, 3, 1]);
  assert.equal(sw.v.waiting, 1);
  c.flushed!();
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(c.closed);
  // The next picture goes to the new decoder; nothing was lost.
  sw.frame(at(8), slice);
  assert.deepEqual(d.chunks.at(-1)!.ts, 4);
  assert.equal(sw.stats.dropped, 0);

  const hw = video(PROFILE.AVC_HIGH, { hardware: [PROFILE.AVC_HIGH] });
  hw.frame(h264Desc(), idr);
  assert.equal(hw.made[0].config.hardware, true);
  hw.v.drain();
  assert.equal(hw.made[0].flushes, 0);
});

test('VideoContext: a picture a software H.264 decoder passes over is given up when a later one comes out', () => {
  /** A picture's desc with its POC; a non-IDR picture's slice. */
  const at = (poc: number) => {
    const d = h264Desc();
    new DataView(d.buffer).setInt32(2308, poc, true);
    new DataView(d.buffer).setInt32(2312, poc, true);
    return d;
  };
  const slice = new Uint8Array(idr);
  slice[4] = 0x41;
  for (const hardware of [false, true]) {
    const t = video(PROFILE.AVC_HIGH, { hardware: hardware ? [PROFILE.AVC_HIGH] : [] });
    t.frame(at(0), idr);
    t.frame(at(6), slice);
    t.frame(at(4), slice);
    t.frame(at(2), slice);
    const c = t.made[0];
    assert.deepEqual(c.chunks.map((x) => x.ts), [0, 1, 2, 3]);
    c.out(0);
    c.out(3); // POC 2: nothing before it pending
    assert.equal(t.v.waiting, 2);
    c.out(1); // POC 6 with POC 4 still pending: in software, 4 never comes (in hardware, output is decode order)
    assert.equal(t.v.waiting, hardware ? 1 : 0);
    assert.equal(t.stats.dropped, hardware ? 0 : 1);
    assert.deepEqual(t.written.map((w) => w.ts), [0, 3, 1]);
  }
});

test('VideoContext: pending pictures given up; a destroyed buffer\'s still written, a destroyed codec\'s flushed out', async () => {
  const t = video(PROFILE.VP9_PROFILE0);
  t.frame(vp9(true), new Uint8Array([1]));
  t.v.giveUp();
  assert.equal(t.v.waiting, 0);
  assert.match(t.errors[0], /1 picture\(s\) never came out/);
  t.made[0].out(0); // too late: not written
  assert.equal(t.written.length, 0);
  // The guest took a picture as decoded at END_FRAME and may show it after letting go of its buffer (Firefox's
  // decoder process at a seek; the planes live on in the compositor's context): still written, into its planes.
  t.frame(vp9(false), new Uint8Array([2]));
  t.v.command(56, new Uint32Array([3])); // DESTROY_VIDEO_BUFFER
  assert.equal(t.v.waiting, 1);
  t.made[0].out(1);
  assert.deepEqual(t.written, [{ planes: [33, 34], ts: 1 }]);
  // A destroyed codec: its decoder is flushed and what it holds still written; what never came out is dropped.
  t.frame(vp9(false), new Uint8Array([3]));
  t.frame(vp9(false), new Uint8Array([4]));
  t.v.command(54, new Uint32Array([1])); // DESTROY_VIDEO_CODEC
  assert.equal(t.made[0].flushes, 1);
  assert.equal(t.made[0].closed, false);
  t.made[0].out(2);
  assert.deepEqual(t.written.map((w) => w.ts), [1, 2]);
  t.made[0].flushed!();
  await new Promise((ok) => setTimeout(ok, 0));
  assert.ok(t.made[0].closed);
  assert.equal(t.v.waiting, 0);
  assert.deepEqual({ decoded: t.stats.decoded, dropped: t.stats.dropped }, { decoded: 2, dropped: 2 });
});

test('VideoContext: a picture is never written over a later one in the same planes', () => {
  // Possible when two decoders output (a drained one and its successor, or a destroyed codec's): the guest decoded into
  // the buffer again, and the older picture's content is gone for it.
  const t = video(PROFILE.VP9_PROFILE0);
  t.frame(vp9(true), new Uint8Array([1]), 2);
  t.frame(vp9(false), new Uint8Array([2]), 2);
  t.made[0].out(1);
  t.made[0].out(0);
  assert.deepEqual(t.written, [{ planes: [31, 32], ts: 1 }]);
  assert.equal(t.v.waiting, 0);
  assert.deepEqual({ decoded: t.stats.decoded, dropped: t.stats.dropped }, { decoded: 1, dropped: 1 });
});

test('VirglRenderer: a picture is written into its planes after the decoding context let go of them', () => {
  // Firefox's decoder process at a seek: END_FRAME, then its surfaces' resources detached (the compositor still shows
  // them), and only then does the decoder output the picture (a software one holds it).
  const gl = mockGl();
  gl.keepLog = true;
  const ram = new Uint8Array(4096), errors: string[] = [];
  const { made, factory } = fakeDecoders();
  const r = new VirglRenderer(gl, { ram: () => ram, log: (m) => errors.push(m), video: { decoders: factory, hardware: [] } });
  r.createContext(1);
  const res = (id: number, format: number, width: number, height: number, target = 2) => {
    r.createResource({ id, target, format, bind: target ? 0xa : 0x20000, width, height, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 });
    r.attach(1, id);
  };
  res(10, 64, 4, 2); // R8_UNORM luma
  res(11, 65, 2, 1); // R8G8_UNORM chroma
  res(7, 64, 400, 1, 0); // the picture's desc
  res(8, 64, 16, 1, 0); // its data
  r.attachBacking(7, [{ off: 0, len: 400 }]);
  r.attachBacking(8, [{ off: 1024, len: 16 }]);
  ram.set(vp9(true), 0);
  ram.set([1, 2, 3], 1024);
  const words: number[] = [];
  const cmd = (c: number, ...p: number[]) => words.push(c | p.length << 16, ...p);
  cmd(53, 1, PROFILE.VP9_PROFILE0, 1, 1, 0, 4, 2); // CREATE_VIDEO_CODEC
  cmd(55, 2, FORMAT_NV12, 4, 2, 10, 11); // CREATE_VIDEO_BUFFER
  cmd(57, 1, 2);
  cmd(59, 1, 2, 7, 8, 3);
  cmd(61, 1, 2);
  r.submit(1, new Uint32Array(words));
  assert.deepEqual([...made[0].chunks[0].data], [1, 2, 3]);
  r.detach(1, 10);
  r.detach(1, 11);
  const before = gl.log.filter(([n]) => n === 'texSubImage2D').length;
  made[0].out(0);
  assert.deepEqual(errors, []);
  assert.equal(gl.log.filter(([n]) => n === 'texSubImage2D').length - before, 2, 'both planes uploaded');
  assert.equal(r.videoStats.decoded, 1);
});

/** A submit of `ctx` with these commands (each with one parameter word). */
const submit = (ctx: number, ...cmds: number[]): WorkerCall => ({ t: 'submit', ctx, words: new Uint32Array(cmds.flatMap((c) => [(1 << 16) | c, 0])) });
const name = (m: WorkerCall) => m.t === 'submit' ? `${m.ctx}:${[...m.words].filter((_, k) => !(k & 1)).map((w) => w & 0xff).join(',')}` : m.t === 'fence' ? `fence${m.id}` : m.t;

test('CallQueue: a call waits only if it could see a pending picture; the rest runs, in order', () => {
  // The renderer as the queue sees it: the pending pictures' planes, and what each context has attached (as calls ran).
  const pending = new Set<number>(), attached = new Map<number, Set<number>>();
  const ran: string[] = [];
  let drains = 0, giveUps = 0;
  const run = (m: WorkerCall) => {
    if (m.t === 'ctxres') {
      const a = attached.get(m.ctx) ?? new Set<number>();
      if (m.attach) a.add(m.res);
      else a.delete(m.res);
      attached.set(m.ctx, a);
    }
    ran.push(m.t === 'ctxres' ? `${m.attach ? 'attach' : 'detach'}${m.ctx}:${m.res}` : m.t === 'transfer' || m.t === 'read' ? `${m.t}${m.res}` : name(m));
  };
  const q = new CallQueue<WorkerCall>({
    run,
    pending: { ctx: (id) => [...attached.get(id) ?? []].some((r) => pending.has(r)), res: (id) => pending.has(id) },
    drain: () => drains++,
    giveUp: () => { giveUps++; pending.clear(); },
  });
  const attach = (ctx: number, res: number, on = true): WorkerCall => ({ t: 'ctxres', ctx, res, attach: on });
  // The decoder's context (1) has a buffer's planes (31, 32) attached; a picture goes into them and is pending.
  q.push(attach(1, 31), 0);
  q.push(attach(1, 32), 0);
  q.push(submit(1, 57, 59, 61), 0);
  pending.add(31).add(32);
  q.push(submit(2, 8), 0); // a draw of a context without the planes: runs
  q.push({ t: 'fence', id: 1, at: 0 }, 0); // nothing waits before it: runs
  q.push(submit(1, 57, 59, 61), 0); // the next picture: runs
  q.push(submit(1, 8), 1); // the decoder's context reads its planes (a blit): waits
  q.push(submit(1, 57, 59, 61), 1); // a picture behind its own context's waiting draw: waits
  assert.deepEqual(ran, ['attach1:31', 'attach1:32', '1:57,59,61', '2:8', 'fence1', '1:57,59,61']);
  // The compositor (2) attaches a plane to show it: its draws wait from there on; another context's run ahead.
  q.push(attach(2, 31), 2);
  q.push(submit(2, 8), 2);
  q.push(submit(3, 8), 2);
  q.push({ t: 'fence', id: 2, at: 2 }, 2); // after waiting calls: waits, and doesn't hold back what follows
  q.push(submit(3, 9), 2);
  q.push({ t: 'transfer', ctx: 3, res: 31, level: 0, box: { x: 0, y: 0, z: 0, w: 1, h: 1, d: 1 }, offset: 0, stride: 0, layerStride: 0, toHost: false }, 2); // names a plane: waits
  q.push({ t: 'transfer', ctx: 4, res: 40, level: 0, box: { x: 0, y: 0, z: 0, w: 1, h: 1, d: 1 }, offset: 0, stride: 0, layerStride: 0, toHost: true }, 2); // another resource: runs
  q.push(submit(3, 10), 2); // behind its context's waiting transfer: waits
  q.push({ t: 'read', id: 3, res: 40 }, 2); // a read waits for every waiting call, and nothing passes it
  q.push(submit(4, 8), 2);
  assert.deepEqual(ran.slice(6), ['attach2:31', '3:8', '3:9', 'transfer40']);
  assert.ok(q.stalled);
  assert.equal(q.ahead, 4);
  // The picture comes out: the rest in order.
  pending.clear();
  q.progress(7);
  assert.deepEqual(ran.slice(10), ['1:8', '1:57,59,61', '2:8', 'fence2', 'transfer31', '3:10', 'read40', '4:8']);
  assert.ok(!q.stalled);
  assert.equal(q.maxWaitMs, 6);

  // The compositor lets the plane go (detach): its draws run again while a new picture is pending.
  q.push(attach(2, 31, false), 10);
  q.push(submit(1, 57, 59, 61), 10);
  pending.add(31).add(32);
  q.push(submit(2, 8), 10);
  assert.deepEqual(ran.slice(18), ['detach2:31', '1:57,59,61', '2:8']);
  // A new resource, its backing and its attachment run ahead of a waiting call; an unref waits and holds back all after it.
  const res = (id: number): WorkerCall => ({ t: 'res', desc: { id, target: 0, format: 0, bind: 0, width: 1, height: 1, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 } });
  q.push(submit(1, 8), 10);
  q.push(res(9), 10);
  q.push({ t: 'backing', id: 9, backing: [{ off: 0, len: 4 }] }, 10);
  q.push(attach(5, 9), 10);
  q.push({ t: 'unref', id: 9 }, 10);
  q.push(submit(5, 8), 10);
  assert.deepEqual(ran.slice(21), ['res', 'backing', 'attach5:9']);
  // Nothing comes out: drained once at 200 ms, given up at 1 s.
  q.tick(209);
  assert.equal(drains, 0);
  q.tick(210);
  q.tick(250);
  assert.equal(drains, 1);
  assert.equal(giveUps, 0);
  q.tick(1010);
  assert.equal(giveUps, 1);
  assert.deepEqual(ran.slice(24), ['1:8', 'unref', '5:8']);
  assert.ok(!q.stalled);
});
