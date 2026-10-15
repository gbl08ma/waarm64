// V1's check in Chromium (docs/plans/video.md): a capture's pictures (bench/video/pictures.ts) as the host will hand
// them to WebCodecs, one chunk per picture (AV1: per temporal unit, web/video-av1.ts), each output frame copied out (I420, the visible width) and hashed as
// ffmpeg's framemd5 does (md5 of the planes' rows), against the original file's frames (`<name>.md5`: ffmpeg's
// framemd5 hashes, one a line). Prints how many frames came out, in what order, how many match, and how long the
// guest would have waited for each picture (chunk in to its frame out).
// `lag` is how many later chunks had gone in when a frame came out (0: every picture out before the next went in).
//   node bench/video/replay.ts <capture.vglt> <codec index> <orig.md5> [visible width] [hw|sw]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { chromiumEnv } from '../../tools/nosme.ts';
import { Av1Stream } from '../../web/video-av1.ts';
import { H264Stream, codecString, type H264Reorder } from '../../web/video-h264.ts';
import { CODECS, PROFILE } from '../../web/virgl-video.ts';
import { pictures } from './pictures.ts';

const [path, index, md5Path, visible, hw] = process.argv.slice(2);
if (!path || !index || !md5Path) throw new Error('usage: node bench/video/replay.ts <capture.vglt> <codec index> <orig.md5> [visible width] [hw|sw]');
const c = pictures(new Uint8Array(readFileSync(path)))[Number(index)];
const vp9 = c.profile === PROFILE.VP9_PROFILE0, av1 = c.profile === PROFILE.AV1_MAIN;
// The SPS for the decoder: reorder 0 for hardware, the stream's for software (web/video-h264.ts H264Stream); REORDER overrides.
// REORDER: none, learn, stream or a depth.
const reorder = process.env.REORDER && /^\d+$/.test(process.env.REORDER) ? Number(process.env.REORDER) : process.env.REORDER as H264Reorder | undefined;
const stream = new H264Stream(c.width, c.height, c.level, reorder ?? (hw === 'hw' ? 'none' : 'stream'));
const av1Stream = new Av1Stream();
const chunks = c.pictures.flatMap((p) => {
  if (vp9) return { data: Buffer.from(p.bits).toString('base64'), key: !(p.desc[332] & 4) };
  if (av1) return av1Stream.chunks(p.desc, p.bits, p.target, 0).map((x) => ({ data: Buffer.from(x.data).toString('base64'), key: x.key }));
  const x = stream.chunk(p.desc, p.bits);
  return { data: Buffer.from(x.data).toString('base64'), key: x.key };
});
if (av1) chunks.push(...av1Stream.flush().map((x) => ({ data: Buffer.from(x.data).toString('base64'), key: x.key })));
const codec = vp9 ? 'vp09.00.31.08' : av1 ? CODECS.find((x) => x.profile === c.profile)!.codec : codecString(c.profile, c.level);
const width = Number(visible || c.width);
const orig = readFileSync(md5Path, 'utf8').trim().split('\n').map((l) => l.trim());

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: process.env.CHROMIUM_ARGS?.split(' ').filter(Boolean), env: chromiumEnv() });
const page = await browser.newPage();
page.on('console', (m) => { if (process.env.VERBOSE) console.log('page:', m.text()); });
page.on('crash', () => console.log('page crashed'));
// A blank page on localhost (a secure context, as WebCodecs needs), answered by Playwright.
await page.route('http://127.0.0.1:9/blank', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>replay</title>' }));
await page.goto('http://127.0.0.1:9/blank');
const out = await page.evaluate(async ({ chunks, codec, width, height, hw }) => {
  const frames: { ts: number; planes: string; format: string | null; coded: string; ms: number }[] = [];
  const sent: number[] = [];
  const errors: string[] = [];
  const b64 = (u: Uint8Array) => { let s = ''; for (let k = 0; k < u.length; k += 8192) s += String.fromCharCode(...u.subarray(k, k + 8192)); return btoa(s); };
  const copies: Promise<void>[] = [];
  const outOrder: number[] = [];
  const lags: number[] = [];
  let outputs = 0;
  let visible = '';
  const dec = new VideoDecoder({
    output: (f) => {
      outputs++;
      outOrder.push(f.timestamp);
      lags.push(sent.length - 1 - f.timestamp);
      if (outputs <= 2) console.log(`output ${f.timestamp} ${f.format} ${f.codedWidth}x${f.codedHeight}`);
      visible = `${f.visibleRect!.x},${f.visibleRect!.y} ${f.visibleRect!.width}x${f.visibleRect!.height} display ${f.displayWidth}x${f.displayHeight}`;
      copies.push((async () => {
        try {
          const ts = f.timestamp;
          const ms = performance.now() - sent[ts];
          // The visible rect in the frame's own format (a `rect` or a format conversion crashed the renderer), then
          // its planes packed as I420 for the hash.
          const raw = new Uint8Array(f.allocationSize());
          const layout = await f.copyTo(raw);
          const w = Math.min(width, f.visibleRect!.width), h = Math.min(height, f.visibleRect!.height);
          const cw = (w + 1) >> 1, ch = (h + 1) >> 1;
          const buf = new Uint8Array(w * h + 2 * cw * ch);
          let at = 0;
          const rows = (plane: number, pw: number, ph: number, step: number, off: number) => {
            for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) buf[at++] = raw[layout[plane].offset + y * layout[plane].stride + x * step + off];
          };
          rows(0, w, h, 1, 0);
          if (f.format === 'NV12') { rows(1, cw, ch, 2, 0); rows(1, cw, ch, 2, 1); } else { rows(1, cw, ch, 1, 0); rows(2, cw, ch, 1, 0); }
          frames.push({ ts, planes: b64(buf), format: f.format, coded: `${f.codedWidth}x${f.codedHeight}`, ms });
        } catch (e) {
          errors.push(`output: ${e}`);
        } finally {
          f.close();
        }
      })());
    },
    error: (e) => errors.push(String(e)),
  });
  dec.configure({ codec, optimizeForLatency: true, hardwareAcceleration: hw === 'hw' ? 'prefer-hardware' : hw === 'sw' ? 'prefer-software' : 'no-preference' });
  // Each chunk in turn, as the guest would: the next after the previous one's frame (or 50 ms: a hidden or held one).
  for (const [k, c] of chunks.entries()) {
    const data = Uint8Array.from(atob(c.data), (x) => x.charCodeAt(0));
    sent[k] = performance.now();
    if (k < 3 || k % 20 === 0) console.log(`chunk ${k} (${c.key ? 'key' : 'delta'}, ${data.length} bytes); outputs ${outputs}, state ${dec.state}`);
    const before = outputs;
    dec.decode(new EncodedVideoChunk({ type: c.key ? 'key' : 'delta', timestamp: k, data }));
    for (let t = 0; t < 50 && outputs === before && !errors.length; t++) await new Promise((r) => setTimeout(r, 1));
  }
  const early = outputs;
  await dec.flush().catch((e) => errors.push(`flush: ${e}`));
  await Promise.all(copies);
  return { frames, errors, early, outputs, outOrder, visible, lags };
}, { chunks, codec, width, height: c.height, hw: hw ?? '' });
await browser.close();

// ffmpeg's framemd5 of yuv420p: the md5 of the Y rows, then U, then V (I420 is that layout, packed).
const hashes = out.frames.map((f) => createHash('md5').update(Buffer.from(f.planes, 'base64')).digest('hex'));
const origSet = new Set(orig);
// HASHES=<file>: the frames' hashes in output order, one a line; RAW=<file>: their planes (I420, packed).
if (process.env.RAW) writeFileSync(process.env.RAW, Buffer.concat(out.outOrder.map((t) => Buffer.from(out.frames.find((f) => f.ts === t)!.planes, 'base64'))));
if (process.env.HASHES) writeFileSync(process.env.HASHES, out.outOrder.map((t) => hashes[out.frames.findIndex((f) => f.ts === t)]).join('\n') + '\n');
const matched = hashes.filter((h) => origSet.has(h)).length;
const order = out.outOrder;
const inOrder = order.every((t, k) => k === 0 || t > order[k - 1]);
const ms = out.frames.map((f) => f.ms).sort((a, b) => a - b);
console.log(JSON.stringify({
  codec, pictures: chunks.length, outputs: out.outputs, frames: out.frames.length, beforeFlush: out.early, matched, distinct: new Set(hashes).size,
  decodeOrder: inOrder, format: out.frames[0]?.format, coded: out.frames[0]?.coded, errors: out.errors.slice(0, 3),
  waitMs: { p50: ms[ms.length >> 1]?.toFixed(1), p90: ms[Math.floor(ms.length * 0.9)]?.toFixed(1), max: ms.at(-1)?.toFixed(1) },
  // In display order (a decoder that reorders), the least lag possible: each frame out once every frame shown before
  // it has been decoded.
  leastLag: inOrder ? 0 : Math.max(...order.map((t, k) => Math.max(...order.slice(0, k + 1)) - t)),
  lag: { max: Math.max(...out.lags), histogram: out.lags.reduce((h: Record<number, number>, l) => ({ ...h, [l]: (h[l] ?? 0) + 1 }), {}) },
  firstOrder: order.slice(0, 20).join(' '),
  unmatched: out.frames.filter((f, k) => !origSet.has(hashes[k])).map((f) => f.ts).sort((a, b) => a - b).join(' '),
  visible: out.visible,
}, null, 1));
