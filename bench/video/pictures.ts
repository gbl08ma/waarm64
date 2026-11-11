// The video pictures in a virgl capture (web/virgl-trace.ts; bench/video/v0.ts CAPTURE=1), and the streams the host
// makes of them for WebCodecs (docs/graphics.md "Video"): per codec, each picture's desc and bitstream as the guest sent
// them (BEGIN_FRAME to END_FRAME, its bitstream buffers joined). As a tool it writes each codec's stream (H.264 as
// Annex B with the rebuilt parameter sets, VP9 as IVF, AV1 as the OBUs Av1Stream makes: `ffmpeg -f obu`) so a
// software decoder can check it against the original file.
//   node bench/video/pictures.ts <capture.vglt> <outdir>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { walk } from '../../web/virgl.ts';
import { readTrace } from '../../web/virgl-trace.ts';
import { Av1Stream } from '../../web/video-av1.ts';
import { H264Stream } from '../../web/video-h264.ts';
import { PROFILE } from '../../web/virgl-video.ts';

const SUBMIT_3D = 0x207, HDR = 24;

export type Picture = { target: number; desc: Uint8Array; bits: Uint8Array };
export type CodecTrace = { ctx: number; handle: number; profile: number; level: number; width: number; height: number; pictures: Picture[] };

export function pictures(trace: Uint8Array): CodecTrace[] {
  const mem = new Map<number, Uint8Array>();
  const codecs: CodecTrace[] = [];
  const live = new Map<string, CodecTrace>();
  /** The picture being sent, per codec: its target, its desc and its bitstream buffers so far. */
  const open = new Map<string, { target: number; desc?: Uint8Array; bits: Uint8Array[] }>();
  for (const r of readTrace(trace)) {
    if (r.kind === 'data') {
      let b = mem.get(r.res);
      if (!b || b.length < r.offset + r.bytes.length) {
        const n = new Uint8Array(r.offset + r.bytes.length);
        if (b) n.set(b);
        mem.set(r.res, (b = n));
      }
      b.set(r.bytes, r.offset);
      continue;
    }
    if (r.kind !== 'command') continue;
    const v = new DataView(r.bytes.buffer, r.bytes.byteOffset, r.bytes.length);
    if (v.getUint32(0, true) !== SUBMIT_3D) continue;
    const ctx = v.getUint32(16, true), size = v.getUint32(HDR, true);
    const words = new Uint32Array(r.bytes.slice(HDR + 8, HDR + 8 + size).buffer);
    walk(words, (cmd, _obj, at, len) => {
      const p = words.subarray(at, at + len);
      if (cmd === 53) {
        const c = { ctx, handle: p[0], profile: p[1], level: p[4], width: p[5], height: p[6], pictures: [] };
        codecs.push(c);
        live.set(`${ctx}:${p[0]}`, c);
      } else if (cmd === 57) {
        open.set(`${ctx}:${p[0]}`, { target: p[1], bits: [] });
      } else if (cmd === 59) {
        const o = open.get(`${ctx}:${p[0]}`);
        const desc = mem.get(p[2]), bits = mem.get(p[3]);
        if (o && desc && bits) {
          o.desc = desc.slice();
          o.bits.push(bits.slice(0, p[4]));
        }
      } else if (cmd === 61) {
        const c = live.get(`${ctx}:${p[0]}`), o = open.get(`${ctx}:${p[0]}`);
        open.delete(`${ctx}:${p[0]}`);
        if (c && o?.desc) c.pictures.push({ target: o.target, desc: o.desc, bits: Buffer.concat(o.bits) });
      }
    });
  }
  return codecs;
}

/** An IVF file of VP9 frames (what ffmpeg reads a raw VP9 stream from). */
export function ivf(frames: Uint8Array[], w: number, h: number): Uint8Array {
  const out = new Uint8Array(32 + frames.reduce((n, f) => n + 12 + f.length, 0));
  const v = new DataView(out.buffer);
  out.set(new TextEncoder().encode('DKIF'), 0);
  v.setUint16(6, 32, true);
  out.set(new TextEncoder().encode('VP90'), 8);
  v.setUint16(12, w, true);
  v.setUint16(14, h, true);
  v.setUint32(16, 30, true);
  v.setUint32(20, 1, true);
  v.setUint32(24, frames.length, true);
  let at = 32;
  frames.forEach((f, k) => {
    v.setUint32(at, f.length, true);
    v.setBigUint64(at + 4, BigInt(k), true);
    out.set(f, at + 12);
    at += 12 + f.length;
  });
  return out;
}

if (import.meta.main) {
  const [path, out] = process.argv.slice(2);
  if (!path || !out) throw new Error('usage: node bench/video/pictures.ts <capture.vglt> <outdir>');
  mkdirSync(out, { recursive: true });
  for (const [k, c] of pictures(new Uint8Array(readFileSync(path))).entries()) {
    const name = `${out}/codec${k}-p${c.profile}-${c.width}x${c.height}`;
    console.log(`codec ${k}: ctx ${c.ctx} handle ${c.handle} profile ${c.profile} level ${c.level} ${c.width}x${c.height}: ${c.pictures.length} pictures, ${c.pictures.reduce((n, p) => n + p.bits.length, 0)} bytes`);
    if (c.profile === PROFILE.VP9_PROFILE0) {
      writeFileSync(`${name}.ivf`, ivf(c.pictures.map((p) => p.bits), c.width, c.height));
      const hidden = c.pictures.filter((p) => !(p.desc[332] & 8)).length;
      console.log(`  ${hidden} hidden (show_frame 0), ${c.pictures.filter((p) => !(p.desc[332] & 4)).length} key frames`);
    } else if (c.profile === PROFILE.AV1_MAIN) {
      const s = new Av1Stream();
      const chunks = [...c.pictures.flatMap((p, k) => s.chunks(p.desc, p.bits, p.target, k)), ...s.flush()];
      writeFileSync(`${name}.obu`, Buffer.concat(chunks.map((x) => x.data)));
      console.log(`  ${chunks.length} temporal units for ${c.pictures.length} frames, ${chunks.filter((x) => x.key).length} key`);
    } else {
      const s = new H264Stream(c.width, c.height, c.level);
      const chunks = c.pictures.map((p) => s.chunk(p.desc, p.bits));
      writeFileSync(`${name}.h264`, Buffer.concat(chunks.map((x) => x.data)));
      console.log(`  ${chunks.filter((x) => x.key).length} IDR pictures`);
    }
  }
}
