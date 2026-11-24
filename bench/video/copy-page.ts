// The page of bench/video/copy.ts: what a decoded picture costs between its VideoFrame and its planes' uploads, two
// ways. `before` is the path web/virgl-video.ts had until 2026-11-24, kept here as the reference arm: the frame copied
// whole (`copyTo`, its own layout), its rows copied into a luma and an interleaved chroma array of the picture's size,
// each widened to its plane (padPlane), and the chroma parted when the buffer has three planes. `after` is
// `copyPicture` with the planes' shape, whose arrays are uploaded as they are.
import { copyPicture, padPlane, type PictureScratch, type PictureShape } from '../../web/virgl-video.ts';

type Planes = { planes: Uint8Array[]; bytes: number };

/** The path before: its planes, and the bytes it allocated for them. */
async function before(f: VideoFrame, shape: PictureShape): Promise<Planes> {
  let bytes = 0;
  const alloc = (n: number) => { bytes += n; return new Uint8Array(n); };
  const raw = alloc(f.allocationSize());
  const layout = await f.copyTo(raw);
  const width = f.visibleRect!.width, height = f.visibleRect!.height;
  const cw = (width + 1) >> 1, ch = (height + 1) >> 1;
  const y = alloc(width * height), uv = alloc(cw * 2 * ch);
  const rows = (dst: Uint8Array, plane: PlaneLayout, w: number, h: number) => {
    for (let r = 0; r < h; r++) dst.set(raw.subarray(plane.offset + r * plane.stride, plane.offset + r * plane.stride + w), r * w);
  };
  rows(y, layout[0], width, height);
  if (f.format === 'NV12') rows(uv, layout[1], cw * 2, ch);
  else {
    const u = layout[1], v = layout[2];
    for (let r = 0; r < ch; r++) {
      const uo = u.offset + r * u.stride, vo = v.offset + r * v.stride, o = r * cw * 2;
      for (let x = 0; x < cw; x++) { uv[o + 2 * x] = raw[uo + x]; uv[o + 2 * x + 1] = raw[vo + x]; }
    }
  }
  const pad = (data: Uint8Array, w: number, h: number, bpp: number, tw: number, th: number) => {
    const p = padPlane(data, w, h, bpp, tw, th);
    if (p.data !== data) bytes += p.data.length;
    return p.data;
  };
  if (!shape.planar) return { planes: [pad(y, width, height, 1, shape.w, shape.h), pad(uv, cw, ch, 2, shape.cw, shape.ch)], bytes };
  const u = alloc(cw * ch), v = alloc(cw * ch);
  for (let k = 0; k < u.length; k++) { u[k] = uv[2 * k]; v[k] = uv[2 * k + 1]; }
  return { planes: [pad(y, width, height, 1, shape.w, shape.h), pad(u, cw, ch, 1, shape.cw, shape.ch), pad(v, cw, ch, 1, shape.cw, shape.ch)], bytes };
}

const scratch: PictureScratch = {};
/** The path now. */
async function after(f: VideoFrame, shape: PictureShape): Promise<Planes> {
  const p = await copyPicture(f, shape, scratch);
  const n = p.cstride! * p.crows!;
  return { planes: p.planar ? [p.y, p.uv.subarray(0, n), p.uv.subarray(n)] : [p.y, p.uv], bytes: p.y.buffer.byteLength };
}

const same = (a: Planes, b: Planes) => a.planes.length === b.planes.length && a.planes.every((p, k) => p.length === b.planes[k].length && p.every((x, i) => x === b.planes[k][i]));

/** Frames made from bytes (in memory, as a software decoder's are): `n` of them, `width`×`height` visible in whole 16×16 blocks. */
function made(format: 'I420' | 'NV12', width: number, height: number, n: number) {
  const W = (width + 15) & ~15, H = (height + 15) & ~15;
  const frames: VideoFrame[] = [];
  for (let k = 0; k < n; k++) {
    const data = new Uint8Array(W * H * 3 / 2);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + (i >> 9) * 7 + k * 53) & 0xff;
    frames.push(new VideoFrame(data, { format, codedWidth: W, codedHeight: H, timestamp: k, visibleRect: { x: 0, y: 0, width, height } }));
  }
  return frames;
}

/**
 * Frames out of a decoder: a drawn clip encoded here (H.264, else VP9) and decoded, in hardware where the browser has
 * it (`hardware`: 'prefer-hardware', which fails without) or in software; the last `n` kept.
 */
async function decoded(width: number, height: number, n: number, hardware: boolean) {
  const canvas = new OffscreenCanvas(width, height), c = canvas.getContext('2d')!;
  const chunks: EncodedVideoChunk[] = [];
  let description: AllowSharedBufferSource | undefined;
  let codec = '';
  for (const cand of ['avc1.640028', 'vp09.00.40.08']) {
    const config: VideoEncoderConfig = { codec: cand, width, height, bitrate: 6_000_000, framerate: 30 };
    if ((await VideoEncoder.isConfigSupported(config)).supported) {
      const enc = new VideoEncoder({ output: (ch, meta) => { chunks.push(ch); description ??= meta?.decoderConfig?.description; }, error: (e) => { throw e; } });
      enc.configure(config);
      for (let k = 0; k < n + 6; k++) {
        const g = c.createLinearGradient(k * 40, 0, width, height);
        g.addColorStop(0, `hsl(${k * 23} 80% 50%)`);
        g.addColorStop(1, `hsl(${k * 23 + 140} 70% 40%)`);
        c.fillStyle = g;
        c.fillRect(0, 0, width, height);
        c.fillStyle = '#fff';
        c.font = '160px sans-serif';
        c.fillText(`picture ${k}`, 80 + 30 * k, height / 2);
        const f = new VideoFrame(canvas, { timestamp: k * 33_333 });
        enc.encode(f, { keyFrame: k === 0 });
        f.close();
      }
      await enc.flush();
      enc.close();
      codec = cand;
      break;
    }
  }
  if (!codec) throw new Error('no encoder for H.264 or VP9');
  const frames: VideoFrame[] = [];
  let error = '';
  const dec = new VideoDecoder({ output: (f) => { frames.push(f); if (frames.length > n) frames.shift()!.close(); }, error: (e) => { error = String(e); } });
  const config: VideoDecoderConfig = { codec, codedWidth: width, codedHeight: height, description, optimizeForLatency: true, hardwareAcceleration: hardware ? 'prefer-hardware' : 'prefer-software' };
  if (!(await VideoDecoder.isConfigSupported(config)).supported) return { codec, frames, error: 'not supported' };
  dec.configure(config);
  for (const ch of chunks) dec.decode(ch);
  await dec.flush().catch((e) => { error ||= String(e); });
  if (dec.state !== 'closed') dec.close();
  return { codec, frames, error };
}

export type Case = { name: string; format: string | null; coded: string; visible: string; planes: number; pictures: number; equal: boolean; bytes: { before: number; after: number }; ms: { before: number[]; after: number[] } };

/**
 * One source's frames through both paths into two planes and three, `rounds` rounds of `pictures` pictures an arm,
 * the arms alternated (which goes first too): the ms a picture of each round, the bytes a picture allocates, and
 * whether the two paths' planes are the same bytes (each frame, once).
 */
async function measure(name: string, frames: VideoFrame[], rounds: number, pictures: number): Promise<Case[]> {
  const out: Case[] = [];
  const f0 = frames[0];
  const W = (f0.visibleRect!.width + 15) & ~15, H = (f0.visibleRect!.height + 15) & ~15;
  for (const planar of [false, true]) {
    const shape: PictureShape = { w: W, h: H, cw: W / 2, ch: H / 2, planar };
    let equal = true;
    const bytes = { before: 0, after: 0 };
    for (const f of frames) {
      const a = await before(f, shape), b = await after(f, shape);
      equal &&= same(a, b);
      bytes.before = a.bytes;
      bytes.after = b.bytes;
    }
    const ms = { before: [] as number[], after: [] as number[] };
    const arm = async (which: 'before' | 'after') => {
      const run = which === 'before' ? before : after;
      let keep: Planes | undefined; // the last picture's planes stay alive, as the renderer's and Venus's import's do
      const t0 = performance.now();
      for (let k = 0; k < pictures; k++) keep = await run(frames[k % frames.length], shape);
      ms[which].push((performance.now() - t0) / pictures);
      return keep;
    };
    await arm('before');
    await arm('after');
    ms.before.length = ms.after.length = 0; // a warm-up of each
    for (let r = 0; r < rounds; r++) {
      if (r & 1) { await arm('after'); await arm('before'); }
      else { await arm('before'); await arm('after'); }
    }
    out.push({ name, format: f0.format, coded: `${f0.codedWidth}x${f0.codedHeight}`, visible: `${f0.visibleRect!.width}x${f0.visibleRect!.height}`, planes: planar ? 3 : 2, pictures, equal, bytes, ms });
  }
  return out;
}

export async function run(width: number, height: number, rounds: number, pictures: number) {
  const cases: Case[] = [];
  const notes: string[] = [];
  for (const format of ['I420', 'NV12'] as const) {
    const frames = made(format, width, height, 6);
    cases.push(...(await measure(`made ${format}`, frames, rounds, pictures)));
    for (const f of frames) f.close();
  }
  for (const hardware of [false, true]) {
    const name = `decoded in ${hardware ? 'hardware' : 'software'}`;
    try {
      const d = await decoded(width, height, 6, hardware);
      if (!d.frames.length) { notes.push(`${name}: no frames (${d.codec}: ${d.error || 'none came out'})`); continue; }
      cases.push(...(await measure(`${name} (${d.codec})`, d.frames, rounds, pictures)));
      for (const f of d.frames) f.close();
    } catch (e) {
      notes.push(`${name}: ${e}`);
    }
  }
  return { cases, notes };
}
