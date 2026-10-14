// Video over virgl in Node (docs/plans/video.md): the caps' video entries as Mesa reads them, a restore's check that the
// browser still has the decoders the guest was told of, and the codec and buffer tables the video commands keep.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeCaps } from '../web/virgl.ts';
import { capsBacked, capsFromGl, withVideo } from '../web/virgl-caps.ts';
import { decodeVideoCaps, encodeVideoCaps, FORMAT_NV12, PROFILE, VideoContext, type VideoStats } from '../web/virgl-video.ts';
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

test('VideoContext: codecs, buffers and a picture\'s parameters and data, read from the staging buffers', () => {
  const stats: VideoStats = { codecs: 0, buffers: 0, frames: 0, bitstreamBytes: 0, errors: 0 };
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
  assert.deepEqual(stats, { codecs: 1, buffers: 1, frames: 0, bitstreamBytes: 0, errors: 0 });
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
