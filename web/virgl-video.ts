// Video decoding over virgl (docs/plans/video.md): the guest's Mesa VA-API driver (`virtio_gpu_drv_video.so`) sends
// a codec, video buffers (a picture's planes as ordinary virgl textures: NV12 is an R8 luma and an RG8 chroma
// texture) and, per picture, BEGIN_FRAME, DECODE_BITSTREAM (the picture's parameters and its slice data, each in a
// staging buffer) and END_FRAME. The host decodes with WebCodecs and writes the picture into the planes, as
// virglrenderer's vrend_video.c does with a host VA-API (MIT, THIRD_PARTY.md). Layouts are Mesa 26.2's
// (src/virtio/virtio-gpu/virgl_video_hw.h, virgl_protocol.h, src/gallium/drivers/virgl/virgl_video.c).

/**
 * `enum pipe_video_profile` as Mesa 26.2 numbers it: the wire carries Mesa's own enum, which isn't stable across
 * releases (virglrenderer's copy has two MPEG-4 profiles Mesa 26.2 dropped, shifting every later value). These are
 * the desktop guest's (Arch Linux ARM's mesa 26.2.4).
 */
export const PROFILE = {
  AVC_BASELINE: 7, AVC_CONSTRAINED_BASELINE: 8, AVC_MAIN: 9, AVC_EXTENDED: 10, AVC_HIGH: 11, AVC_HIGH10: 12,
  HEVC_MAIN: 15, HEVC_MAIN_10: 16, VP9_PROFILE0: 24, VP9_PROFILE2: 25, AV1_MAIN: 26, AV1_PROFILE2: 27,
} as const;
/** PIPE_VIDEO_ENTRYPOINT_BITSTREAM: the guest hands over the coded data, the host decodes. */
export const ENTRYPOINT_BITSTREAM = 1;
/** VIRGL_FORMAT_NV12: the video buffers' format. */
export const FORMAT_NV12 = 166;

/** One `struct virgl_video_caps` (four words of bit fields). */
export type VideoCap = { profile: number; maxLevel: number; maxWidth: number; maxHeight: number };

/** What the guest may ask for, and the WebCodecs configuration that must be supported for it. */
export const CODECS: { profile: number; codec: string; maxLevel: number }[] = [
  { profile: PROFILE.AVC_CONSTRAINED_BASELINE, codec: 'avc1.42E033', maxLevel: 51 },
  { profile: PROFILE.AVC_MAIN, codec: 'avc1.4D4033', maxLevel: 51 },
  { profile: PROFILE.AVC_HIGH, codec: 'avc1.640033', maxLevel: 51 },
  { profile: PROFILE.VP9_PROFILE0, codec: 'vp09.00.51.08', maxLevel: 0 },
];
const MAX_W = 4096, MAX_H = 2304;

/** The caps entries for what this browser's `VideoDecoder` takes (an empty list without WebCodecs). */
export async function probeVideo(): Promise<VideoCap[]> {
  if (typeof VideoDecoder === 'undefined') return [];
  const out: VideoCap[] = [];
  for (const c of CODECS) {
    try {
      const r = await VideoDecoder.isConfigSupported({ codec: c.codec, codedWidth: 1920, codedHeight: 1080 });
      if (r.supported) out.push({ profile: c.profile, maxLevel: c.maxLevel, maxWidth: MAX_W, maxHeight: MAX_H });
    } catch {
      // not this one
    }
  }
  return out;
}

/** `video_caps[]` as caps words (`num_video_caps` is the entries' count). */
export function encodeVideoCaps(caps: VideoCap[]): number[] {
  const words: number[] = [];
  for (const c of caps.slice(0, 32)) {
    words.push(
      (c.profile | (ENTRYPOINT_BITSTREAM << 8) | (c.maxLevel << 16)) >>> 0, // stacked_frames 0
      (c.maxWidth | (c.maxHeight << 16)) >>> 0,
      (FORMAT_NV12 | (Math.min(0xffff, (c.maxWidth >> 4) * (c.maxHeight >> 4)) << 16)) >>> 0,
      0b11, // npot_texture, supports_progressive; no interlaced
    );
  }
  return words;
}

export function decodeVideoCaps(words: number[], n: number): VideoCap[] {
  return Array.from({ length: Math.min(n, 32, words.length >> 2) }, (_, k) => ({
    profile: words[4 * k] & 0xff, maxLevel: (words[4 * k] >>> 16) & 0xff,
    maxWidth: words[4 * k + 1] & 0xffff, maxHeight: words[4 * k + 1] >>> 16,
  }));
}

export type VideoStats = { codecs: number; buffers: number; frames: number; bitstreamBytes: number; errors: number };

type Codec = { handle: number; profile: number; entrypoint: number; level: number; width: number; height: number; maxRefs: number; target?: number; desc?: Uint8Array; bits: Uint8Array[] };
type Buffer = { handle: number; format: number; width: number; height: number; planes: number[] };

/** How the video commands reach the rest of the renderer. */
export type VideoEnv = {
  /** `len` bytes at the start of a resource's backing (a staging buffer the guest filled), or null. */
  read(res: number, len: number): Uint8Array | null;
  /** The size of a resource's backing (0 if none). */
  size(res: number): number;
  error(m: string): void;
  debug?: (m: string) => void;
};

/**
 * A context's codecs and video buffers (virglrenderer keeps them per context; their handles are the guest's object
 * handles). V0: a null decoder that keeps the tables, gathers each picture's parameters and data, and counts.
 */
export class VideoContext {
  readonly codecs = new Map<number, Codec>();
  readonly buffers = new Map<number, Buffer>();

  private env: VideoEnv;
  readonly stats: VideoStats;

  constructor(env: VideoEnv, stats: VideoStats) {
    this.env = env;
    this.stats = stats;
  }

  /** CCMD 53–61. */
  command(cmd: number, p: Uint32Array) {
    switch (cmd) {
      case 53: { // CREATE_VIDEO_CODEC: handle, profile, entrypoint, chroma format, level, width, height[, max refs]
        if (p.length < 7) return this.env.error('short CREATE_VIDEO_CODEC');
        if (this.codecs.has(p[0])) return;
        this.codecs.set(p[0], { handle: p[0], profile: p[1], entrypoint: p[2], level: p[4], width: p[5], height: p[6], maxRefs: p[7] ?? 0, bits: [] });
        this.stats.codecs++;
        this.env.debug?.(`video: codec ${p[0]} profile ${p[1]} entrypoint ${p[2]} level ${p[4]} ${p[5]}x${p[6]} refs ${p[7] ?? '-'}`);
        return;
      }
      case 54: // DESTROY_VIDEO_CODEC
        if (this.codecs.delete(p[0])) this.stats.codecs--;
        return;
      case 55: { // CREATE_VIDEO_BUFFER: handle, format, width, height, plane resources
        if (p.length < 5) return this.env.error('short CREATE_VIDEO_BUFFER');
        if (this.buffers.has(p[0])) return;
        this.buffers.set(p[0], { handle: p[0], format: p[1], width: p[2], height: p[3], planes: [...p.subarray(4)] });
        this.stats.buffers++;
        this.env.debug?.(`video: buffer ${p[0]} format ${p[1]} ${p[2]}x${p[3]} planes ${[...p.subarray(4)].join(',')}`);
        return;
      }
      case 56: // DESTROY_VIDEO_BUFFER
        if (this.buffers.delete(p[0])) this.stats.buffers--;
        return;
      case 57: { // BEGIN_FRAME: codec, target
        const c = this.codec(p[0]);
        if (!c || !this.buffer(p[1])) return;
        c.target = p[1];
        c.desc = undefined;
        c.bits = [];
        return;
      }
      case 58: return; // DECODE_MACROBLOCK: never sent by Mesa's virgl (bitstream only)
      case 59: { // DECODE_BITSTREAM: codec, target, picture desc resource, bitstream resource, bitstream bytes
        if (p.length < 5) return this.env.error('short DECODE_BITSTREAM');
        const c = this.codec(p[0]);
        if (!c || !this.buffer(p[1])) return;
        const desc = this.env.read(p[2], this.env.size(p[2]));
        const bits = this.env.read(p[3], p[4]);
        if (!desc || !bits) return this.env.error(`video: codec ${p[0]}: can't read the picture's parameters or data`);
        c.desc = desc.slice();
        c.bits.push(bits.slice());
        this.stats.bitstreamBytes += p[4];
        return;
      }
      case 60: return this.env.error('video: encoding isn\'t supported');
      case 61: { // END_FRAME: codec, target
        const c = this.codec(p[0]);
        if (!c || c.target !== p[1]) return;
        this.stats.frames++;
        c.target = undefined;
        return;
      }
    }
  }

  destroy() {
    this.stats.codecs -= this.codecs.size;
    this.stats.buffers -= this.buffers.size;
    this.codecs.clear();
    this.buffers.clear();
  }

  private codec(h: number) {
    const c = this.codecs.get(h);
    if (!c) this.err(`video: no codec ${h}`);
    return c;
  }

  private buffer(h: number) {
    const b = this.buffers.get(h);
    if (!b) this.err(`video: no buffer ${h}`);
    return b;
  }

  private err(m: string) {
    this.stats.errors++;
    this.env.error(m);
  }
}
