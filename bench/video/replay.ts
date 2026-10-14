// V1's check in Chromium (docs/plans/video.md): a capture's pictures (bench/video/pictures.ts) as the host will hand
// them to WebCodecs, one chunk per picture, each output frame copied out (I420, the visible width) and hashed as
// ffmpeg's framemd5 does (md5 of the planes' rows), against the original file's frames (`<name>.md5`: ffmpeg's
// framemd5 hashes, one a line). Prints how many frames came out, in what order, how many match, and how long the
// guest would have waited for each picture (chunk in to its frame out).
//   node bench/video/replay.ts <capture.vglt> <codec index> <orig.md5> [visible width] [hardware]
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { H264Stream, codecString } from '../../web/video-h264.ts';
import { PROFILE } from '../../web/virgl-video.ts';
import { pictures } from './pictures.ts';

const [path, index, md5Path, visible, hw] = process.argv.slice(2);
if (!path || !index || !md5Path) throw new Error('usage: node bench/video/replay.ts <capture.vglt> <codec index> <orig.md5> [visible width] [hardware]');
const c = pictures(new Uint8Array(readFileSync(path)))[Number(index)];
const vp9 = c.profile === PROFILE.VP9_PROFILE0;
const stream = new H264Stream(c.width, c.height, c.level);
const chunks = c.pictures.map((p) => {
  if (vp9) return { data: Buffer.from(p.bits).toString('base64'), key: !(p.desc[332] & 4) };
  const x = stream.chunk(p.desc, p.bits);
  return { data: Buffer.from(x.data).toString('base64'), key: x.key };
});
const codec = vp9 ? 'vp09.00.31.08' : codecString(c.profile, c.level);
const width = Number(visible || c.width);
const orig = readFileSync(md5Path, 'utf8').trim().split('\n');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: process.env.CHROMIUM_ARGS?.split(' ').filter(Boolean) });
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
  let outputs = 0;
  const dec = new VideoDecoder({
    output: (f) => {
      outputs++;
      if (outputs <= 2) console.log(`output ${f.timestamp} ${f.format} ${f.codedWidth}x${f.codedHeight}`);
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
  dec.configure({ codec, optimizeForLatency: true, hardwareAcceleration: hw ? 'prefer-hardware' : 'no-preference' });
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
  return { frames, errors, early, outputs };
}, { chunks, codec, width, height: c.height, hw: !!hw });
await browser.close();

// ffmpeg's framemd5 of yuv420p: the md5 of the Y rows, then U, then V (I420 is that layout, packed).
const hashes = out.frames.map((f) => createHash('md5').update(Buffer.from(f.planes, 'base64')).digest('hex'));
const origSet = new Set(orig);
const matched = hashes.filter((h) => origSet.has(h)).length;
const order = out.frames.map((f) => f.ts);
const inOrder = order.every((t, k) => k === 0 || t > order[k - 1]);
const ms = out.frames.map((f) => f.ms).sort((a, b) => a - b);
console.log(JSON.stringify({
  codec, pictures: chunks.length, outputs: out.outputs, frames: out.frames.length, beforeFlush: out.early, matched, distinct: new Set(hashes).size,
  decodeOrder: inOrder, format: out.frames[0]?.format, coded: out.frames[0]?.coded, errors: out.errors.slice(0, 3),
  waitMs: { p50: ms[ms.length >> 1]?.toFixed(1), p90: ms[Math.floor(ms.length * 0.9)]?.toFixed(1), max: ms.at(-1)?.toFixed(1) },
  firstOrder: order.slice(0, 20),
}, null, 1));
