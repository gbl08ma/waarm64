// The Chromium test's video fixtures (tests/virgl-browser.test.ts, docs/testing.md "Video over virgl"): a capture
// (bench/video/v0.ts CAPTURE=1) of FFmpeg decoding H.264 and then VP9 through VA-API, cut to one trace per codec: the
// decoding context's life up to (not including) its destruction, its first pictures, and only the resources it uses
// (the desktop's contexts are left out). And what to check them against: the original stream's first pictures (H.264,
// Annex B, for the browser's own decode: its software decoder may not be FFmpeg's) and FFmpeg's decode of the
// original files (SHA-256 of each frame's visible I420).
//   node bench/video/fixture.ts <capture.vglt> <ctx> <pictures> <out prefix> <h264 orig.h264> <h264 orig.yuv> <vp9 orig.yuv> <width> <height>
// writes <prefix>-h264.vglt.gz, <prefix>-vp9.vglt.gz, <prefix>-h264-orig.h264.gz and <prefix>.json.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { walk } from '../../web/virgl.ts';
import { encodeTrace, readTrace, type TraceRecord } from '../../web/virgl-trace.ts';
import { splitAnnexB } from '../../web/video-h264.ts';

const RESOURCE_UNREF = 0x102, ATTACH_BACKING = 0x106, DETACH_BACKING = 0x107;
const CTX_CREATE = 0x200, CTX_DESTROY = 0x201, CTX_ATTACH = 0x202, CTX_DETACH = 0x203, RESOURCE_CREATE_3D = 0x204, TRANSFER_TO_HOST_3D = 0x205, SUBMIT_3D = 0x207;

/** The capture cut to context `ctx`'s `segment`th life that makes a codec, and the codec's first `n` pictures. */
export function cutTrace(trace: Uint8Array, ctx: number, n: number, segment: number) {
  const id = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.length).getUint32(24, true);
  // Pass 1: the resources the context attaches.
  const mine = new Set<number>();
  for (const r of readTrace(trace)) {
    if (r.kind !== 'command') continue;
    const v = new DataView(r.bytes.buffer, r.bytes.byteOffset, r.bytes.length);
    if (v.getUint32(0, true) === CTX_ATTACH && v.getUint32(16, true) === ctx) mine.add(id(r.bytes));
  }
  // Pass 2: the context's lives (from each CTX_CREATE), each with its calls and the data they read, pictures past the
  // first n left out.
  const lives: { out: TraceRecord[]; codec: boolean }[] = [];
  let life: { out: TraceRecord[]; codec: boolean } | undefined, pictures = 0, cut = false;
  for (const r of readTrace(trace)) {
    if (r.kind === 'note') continue;
    if (r.kind === 'data') {
      if (mine.has(r.res) && !cut) life?.out.push(r);
      continue;
    }
    const v = new DataView(r.bytes.buffer, r.bytes.byteOffset, r.bytes.length);
    const type = v.getUint32(0, true), c = v.getUint32(16, true);
    if (type === RESOURCE_CREATE_3D || type === ATTACH_BACKING || type === DETACH_BACKING || type === RESOURCE_UNREF) {
      if (mine.has(id(r.bytes)) && !cut) life?.out.push(r);
      continue;
    }
    if (c !== ctx || ![CTX_CREATE, CTX_DESTROY, CTX_ATTACH, CTX_DETACH, TRANSFER_TO_HOST_3D, SUBMIT_3D].includes(type)) continue;
    if (type === CTX_CREATE) {
      lives.push((life = { out: [], codec: false }));
      pictures = 0;
      cut = false;
    }
    if (!life || type === CTX_DESTROY || cut) continue;
    if (type === SUBMIT_3D) {
      const words = new Uint32Array(r.bytes.slice(32, 32 + v.getUint32(24, true)).buffer);
      walk(words, (cmd) => {
        if (cmd === 53) life!.codec = true;
        if (cmd === 61 && ++pictures >= n) cut = true;
      });
    }
    life.out.push(r);
  }
  const keep = lives.filter((l) => l.codec)[segment];
  if (!keep) throw new Error(`no codec ${segment} in context ${ctx}`);
  return encodeTrace(keep.out);
}

/** The first `n` pictures of an Annex B stream (a picture starts at a slice whose first_mb_in_slice is 0). */
export function firstPictures(annexB: Uint8Array, n: number) {
  const parts: Uint8Array[] = [];
  let pictures = 0, seen = false;
  for (const nal of splitAnnexB(annexB)) {
    const t = nal[0] & 31;
    const slice = t === 1 || t === 5;
    if (slice && nal[1] & 0x80 && seen && ++pictures >= n) break;
    if (slice) seen = true;
    parts.push(new Uint8Array([0, 0, 0, 1]), nal);
  }
  return Buffer.concat(parts);
}

/** SHA-256 of each frame of a raw I420 file, cropped to `w`×`h` from frames `fw` wide. */
export function frameHashes(yuv: Uint8Array, fw: number, fh: number, w: number, h: number) {
  const size = fw * fh + 2 * ((fw + 1) >> 1) * ((fh + 1) >> 1);
  const out: string[] = [];
  for (let at = 0; at + size <= yuv.length; at += size) {
    const hash = createHash('sha256');
    const plane = (off: number, pw: number, cw: number, ch: number) => { for (let y = 0; y < ch; y++) hash.update(yuv.subarray(at + off + y * pw, at + off + y * pw + cw)); };
    plane(0, fw, w, h);
    const cfw = (fw + 1) >> 1, cfh = (fh + 1) >> 1;
    plane(fw * fh, cfw, (w + 1) >> 1, (h + 1) >> 1);
    plane(fw * fh + cfw * cfh, cfw, (w + 1) >> 1, (h + 1) >> 1);
    out.push(hash.digest('hex'));
  }
  return out;
}

if (import.meta.main) {
  const [capture, ctx, n, base, h264, h264Yuv, vp9Yuv, w, h] = process.argv.slice(2);
  if (!h) throw new Error('usage: node bench/video/fixture.ts <capture.vglt> <ctx> <pictures> <out prefix> <h264 orig.h264> <h264 orig.yuv> <vp9 orig.yuv> <width> <height>');
  const width = Number(w), height = Number(h), pictures = Number(n);
  const all = new Uint8Array(readFileSync(capture));
  for (const [k, codec] of ['h264', 'vp9'].entries()) {
    const trace = cutTrace(all, Number(ctx), pictures, k);
    writeFileSync(`${base}-${codec}.vglt.gz`, gzipSync(trace, { level: 9 }));
    console.log(`${base}-${codec}.vglt.gz: ${trace.length} bytes, gzipped ${readFileSync(`${base}-${codec}.vglt.gz`).length}`);
  }
  writeFileSync(`${base}-h264-orig.h264.gz`, gzipSync(firstPictures(new Uint8Array(readFileSync(h264)), pictures), { level: 9 }));
  // FFmpeg's frames are in display order, and more of them than the pictures kept: the test looks a picture up.
  writeFileSync(`${base}.json`, `${JSON.stringify({
    width, height, pictures,
    h264: frameHashes(new Uint8Array(readFileSync(h264Yuv)), width, height, width, height),
    vp9: frameHashes(new Uint8Array(readFileSync(vp9Yuv)), width, height, width, height),
  }, null, 1)}\n`);
}
