// Video over virgl in Node (docs/plans/video.md): the caps' video entries as Mesa reads them, a restore's check that the
// browser still has the decoders the guest was told of, the codec and buffer tables the video commands keep, the
// pictures through a fake decoder into their planes, and the GPU worker's queue holding what follows a picture.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeCaps } from '../web/virgl.ts';
import { capsBacked, capsFromGl, withVideo } from '../web/virgl-caps.ts';
import { CallQueue, type WorkerCall } from '../web/virgl-host.ts';
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

test('probeVideo: H.264 offered only where the browser decodes it in hardware (software stalls the guest)', async () => {
  const probe = async (hw: (codec: string) => boolean, o?: { softwareH264?: boolean }) => {
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
  assert.deepEqual(await probe(() => false), { caps: [PROFILE.VP9_PROFILE0], hardware: [] });
  assert.deepEqual(await probe(() => true), { caps: [...h264, PROFILE.VP9_PROFILE0], hardware: [...h264, PROFILE.VP9_PROFILE0] });
  assert.deepEqual(await probe((c) => c.startsWith('avc1')), { caps: [...h264, PROFILE.VP9_PROFILE0], hardware: h264 });
  assert.deepEqual(await probe(() => false, { softwareH264: true }), { caps: [...h264, PROFILE.VP9_PROFILE0], hardware: [] });
});

test('VideoContext: codecs, buffers and a picture\'s parameters and data, read from the staging buffers', () => {
  const stats: VideoStats = { codecs: 0, buffers: 0, frames: 0, decoded: 0, dropped: 0, bitstreamBytes: 0, errors: 0 };
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
  assert.deepEqual(stats, { codecs: 1, buffers: 1, frames: 0, decoded: 0, dropped: 0, bitstreamBytes: 0, errors: 0 });
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
type Fake = { config: DecoderConfig; chunks: { data: Uint8Array; key: boolean; ts: number }[]; flushes: number; closed: boolean; out(ts: number): void; fail(m: string): void };
function fakeDecoders() {
  const made: Fake[] = [];
  const factory: DecoderFactory = (config, output, error) => {
    const f: Fake = { config, chunks: [], flushes: 0, closed: false, out: (ts) => output(ts, picture(ts)), fail: error };
    made.push(f);
    return { decode: (data, key, ts) => void f.chunks.push({ data: data.slice(), key, ts }), flush: () => void f.flushes++, close: () => void (f.closed = true) };
  };
  return { made, factory };
}
/** A 4×2 picture whose bytes say which one it is. */
const picture = (ts: number): DecodedPicture => ({ width: 4, height: 2, y: new Uint8Array(8).fill(ts), uv: new Uint8Array(4).fill(100 + ts) });

/** A context with a fake decoder, one codec (handle 1) and one NV12 buffer (handle 2, planes 31 and 32). */
function video(profile: number, o: { hardware?: number[] } = {}) {
  const stats: VideoStats = { codecs: 0, buffers: 0, frames: 0, decoded: 0, dropped: 0, bitstreamBytes: 0, errors: 0 };
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
  cmd(55, 2, FORMAT_NV12, 864, 480, 31, 32);
  /** One picture: its desc and data put in staging buffers 7 and 8, then BEGIN_FRAME, DECODE_BITSTREAM, END_FRAME. */
  const frame = (desc: Uint8Array, bits: Uint8Array) => {
    staging.set(7, desc);
    staging.set(8, bits);
    cmd(57, 1, 2);
    cmd(59, 1, 2, 7, 8, bits.length);
    cmd(61, 1, 2);
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
  assert.deepEqual(t.written, [{ planes: [31, 32], ts: 0 }, { planes: [31, 32], ts: 2 }]);
  assert.equal(t.settledCount(), 2);
  assert.deepEqual({ frames: t.stats.frames, decoded: t.stats.decoded, dropped: t.stats.dropped, errors: t.stats.errors }, { frames: 3, decoded: 2, dropped: 0, errors: 0 });
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

test('VideoContext: H.264 in software is drained when it holds pictures; in hardware it never is', () => {
  const sw = video(PROFILE.AVC_HIGH);
  sw.frame(h264Desc(), idr);
  const c = sw.made[0];
  assert.equal(c.config.codec, 'avc1.64001E');
  assert.equal(c.config.hardware, false);
  // The chunk: SPS, PPS, then the slice.
  assert.deepEqual([...c.chunks[0].data.subarray(0, 5)], [0, 0, 0, 1, 0x67]);
  assert.ok(c.chunks[0].key);
  sw.v.drain();
  assert.equal(c.flushes, 1);
  // After a drain the decoder wants a key picture.
  const p = new Uint8Array(idr);
  p[4] = 0x41; // a non-IDR slice
  sw.frame(h264Desc(), p);
  assert.equal(c.chunks.length, 1);
  assert.equal(sw.stats.dropped, 1);

  const hw = video(PROFILE.AVC_HIGH, { hardware: [PROFILE.AVC_HIGH] });
  hw.frame(h264Desc(), idr);
  assert.equal(hw.made[0].config.hardware, true);
  hw.v.drain();
  assert.equal(hw.made[0].flushes, 0);
});

test('VideoContext: pending pictures given up, and those of a destroyed buffer or codec dropped', () => {
  const t = video(PROFILE.VP9_PROFILE0);
  t.frame(vp9(true), new Uint8Array([1]));
  t.v.giveUp();
  assert.equal(t.v.waiting, 0);
  assert.match(t.errors[0], /1 picture\(s\) never came out/);
  t.made[0].out(0); // too late: not written
  assert.deepEqual(t.written, []);
  t.frame(vp9(false), new Uint8Array([2]));
  assert.equal(t.v.waiting, 1);
  t.v.command(56, new Uint32Array([2])); // DESTROY_VIDEO_BUFFER
  assert.equal(t.v.waiting, 0);
  t.v.command(54, new Uint32Array([1])); // DESTROY_VIDEO_CODEC
  assert.ok(t.made[0].closed);
  assert.equal(t.stats.dropped, 2);
});

/** A submit of `ctx` with these commands (each with one parameter word). */
const submit = (ctx: number, ...cmds: number[]): WorkerCall => ({ t: 'submit', ctx, words: new Uint32Array(cmds.flatMap((c) => [(1 << 16) | c, 0])) });
const name = (m: WorkerCall) => m.t === 'submit' ? `${m.ctx}:${[...m.words].filter((_, k) => !(k & 1)).map((w) => w & 0xff).join(',')}` : m.t === 'fence' ? `fence${m.id}` : m.t;

test('CallQueue: calls wait while a picture is pending; video submits run ahead of other contexts\' calls', () => {
  let waiting = 0;
  const ran: string[] = [];
  let drains = 0, giveUps = 0;
  const q = new CallQueue<WorkerCall>({ run: (m) => ran.push(name(m)), waiting: () => waiting, drain: () => drains++, giveUp: () => { giveUps++; waiting = 0; } });
  q.push(submit(1, 57, 59, 61), 0); // a picture: runs, and is pending
  waiting = 1;
  q.push(submit(2, 8), 0); // a draw (another context): waits
  q.push({ t: 'fence', id: 1, at: 0 }, 0);
  q.push(submit(1, 57, 59, 61), 0); // the next picture: runs ahead
  q.push(submit(2, 57, 59, 61), 1); // a video submit behind its own context's draw: waits
  q.push(submit(3, 8, 57), 2); // a draw and a picture: waits
  q.push(submit(4, 28, 43, 44, 59, 61), 2); // what Mesa's VA driver sends with a picture: runs ahead
  assert.deepEqual(ran, ['1:57,59,61', '1:57,59,61', '4:28,43,44,59,61']);
  assert.ok(q.stalled);
  assert.equal(q.ahead, 2);
  waiting = 0;
  q.progress(5);
  assert.deepEqual(ran.slice(3), ['2:8', 'fence1', '2:57,59,61', '3:8,57']);
  assert.ok(!q.stalled);
  assert.equal(q.maxWaitMs, 5);

  // A new resource, its backing and its attachment run ahead (a decoder's new surfaces and staging buffers); an
  // unref, or a resource a waiting call names, isn't passed.
  const res = (id: number): WorkerCall => ({ t: 'res', desc: { id, target: 0, format: 0, bind: 0, width: 1, height: 1, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 } });
  waiting = 1;
  q.push(submit(2, 8), 10);
  q.push(res(9), 10);
  q.push({ t: 'backing', id: 9, backing: [{ off: 0, len: 4 }] }, 10);
  q.push({ t: 'ctxres', ctx: 1, res: 9, attach: true }, 10);
  q.push(submit(1, 57, 59, 61), 10);
  assert.deepEqual(ran.slice(7), ['res', 'backing', 'ctxres', '1:57,59,61']);
  q.push({ t: 'transfer', ctx: 2, res: 10, level: 0, box: { x: 0, y: 0, z: 0, w: 1, h: 1, d: 1 }, offset: 0, stride: 0, layerStride: 0, toHost: false }, 10);
  q.push(res(10), 10); // named by the waiting transfer: not passed
  q.push({ t: 'unref', id: 9 }, 10);
  q.push(submit(1, 57, 59, 61), 10);
  assert.equal(ran.length, 11);
  // Nothing comes out: drained once at 200 ms, given up at 1 s.
  q.tick(209);
  assert.equal(drains, 0);
  q.tick(210);
  q.tick(250);
  assert.equal(drains, 1);
  assert.equal(giveUps, 0);
  q.tick(1010);
  assert.equal(giveUps, 1);
  assert.deepEqual(ran.slice(11), ['2:8', 'transfer', 'res', 'unref', '1:57,59,61']);
  assert.ok(!q.stalled);
});
