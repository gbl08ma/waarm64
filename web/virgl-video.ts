// Video decoding over virgl (docs/plans/video.md): the guest's Mesa VA-API driver (`virtio_gpu_drv_video.so`) sends
// a codec, video buffers (a picture's planes as ordinary virgl textures: NV12 is an R8 luma and an RG8 chroma
// texture) and, per picture, BEGIN_FRAME, DECODE_BITSTREAM (the picture's parameters and its slice data, each in a
// staging buffer) and END_FRAME. The host decodes with WebCodecs and writes the picture into the planes, as
// virglrenderer's vrend_video.c does with a host VA-API (MIT, THIRD_PARTY.md). Layouts are Mesa 26.2's
// (src/virtio/virtio-gpu/virgl_video_hw.h, virgl_protocol.h, src/gallium/drivers/virgl/virgl_video.c).
import { av1Frame, Av1Stream } from './video-av1.ts';
import { codecString, H264Stream } from './video-h264.ts';

/**
 * `enum pipe_video_profile` as Mesa 26.2 numbers it: the wire carries Mesa's own enum, which isn't stable across
 * releases (virglrenderer's copy has two MPEG-4 profiles Mesa 26.2 dropped, shifting every later value). These are
 * the desktop guest's (Arch's mesa 26.2.4).
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

/** What the guest may ask for, and the WebCodecs configuration that must be supported for it (VP9's is also the one decoded with). */
export const CODECS: { profile: number; codec: string; maxLevel: number }[] = [
  { profile: PROFILE.AVC_CONSTRAINED_BASELINE, codec: 'avc1.42E033', maxLevel: 51 },
  { profile: PROFILE.AVC_MAIN, codec: 'avc1.4D4033', maxLevel: 51 },
  { profile: PROFILE.AVC_HIGH, codec: 'avc1.640033', maxLevel: 51 },
  { profile: PROFILE.VP9_PROFILE0, codec: 'vp09.00.51.08', maxLevel: 0 },
  // Main, level 5.1, 8-bit (10-bit isn't offered: the video buffers are NV12).
  { profile: PROFILE.AV1_MAIN, codec: 'av01.0.13M.08', maxLevel: 0 },
];
const MAX_W = 4096, MAX_H = 2304;

/** A profile's name for people ('H.264 High', 'VP9', 'AV1'; the number when it isn't one of these). */
export function profileName(profile: number) {
  const n: Record<number, string> = {
    [PROFILE.AVC_BASELINE]: 'H.264 Baseline', [PROFILE.AVC_CONSTRAINED_BASELINE]: 'H.264 Constrained Baseline', [PROFILE.AVC_MAIN]: 'H.264 Main',
    [PROFILE.AVC_EXTENDED]: 'H.264 Extended', [PROFILE.AVC_HIGH]: 'H.264 High', [PROFILE.AVC_HIGH10]: 'H.264 High 10',
    [PROFILE.HEVC_MAIN]: 'HEVC Main', [PROFILE.HEVC_MAIN_10]: 'HEVC Main 10', [PROFILE.VP9_PROFILE0]: 'VP9', [PROFILE.VP9_PROFILE2]: 'VP9 Profile 2',
    [PROFILE.AV1_MAIN]: 'AV1', [PROFILE.AV1_PROFILE2]: 'AV1 Profile 2',
  };
  return n[profile] ?? `profile ${profile}`;
}

/**
 * The caps entries for what this browser's `VideoDecoder` takes (an empty list without WebCodecs), and the profiles
 * it decodes in hardware (`prefer-hardware` supported): those are decoded there, the rest in software, and the
 * H.264 stream differs (web/video-h264.ts `H264Stream`: a software decoder holds pictures for the stream's reorder
 * depth, docs/plans/video.md §7). `software` decodes every codec in software (experiments on a host with hardware
 * decoders).
 */
export async function probeVideo(o: { software?: boolean } = {}): Promise<{ caps: VideoCap[]; hardware: number[] }> {
  if (typeof VideoDecoder === 'undefined') return { caps: [], hardware: [] };
  const caps: VideoCap[] = [], hardware: number[] = [];
  const supported = async (codec: string, hardwareAcceleration: HardwareAcceleration) => {
    try {
      return !!(await VideoDecoder.isConfigSupported({ codec, codedWidth: 1920, codedHeight: 1080, hardwareAcceleration })).supported;
    } catch {
      return false;
    }
  };
  for (const c of CODECS) {
    if (!await supported(c.codec, 'no-preference')) continue;
    const hw = !o.software && await supported(c.codec, 'prefer-hardware');
    caps.push({ profile: c.profile, maxLevel: c.maxLevel, maxWidth: MAX_W, maxHeight: MAX_H });
    if (hw) hardware.push(c.profile);
  }
  return { caps, hardware };
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

/**
 * `frames` the guest's pictures (END_FRAMEs), `decoded` those written into their buffers, `dropped` those never
 * written: before a key picture (at the start, after a decoder error or a drain) or given up (`VideoContext.giveUp`).
 */
/** The renderer's video totals; of the decoded pictures, the ms from END_FRAME to written (`latencyMs`, and the longest:
 * `latencyMaxMs`, reset by whoever reads it) and the ms spent writing them into the planes (`writeMs`). `codecs` and
 * `buffers` are the ones that exist now; `created` the codecs made since the start (a stream's `id`), `decoderErrors`
 * the errors the decoders reported (of `errors`, which also counts the guest's commands the host refused). */
export type VideoStats = { codecs: number; buffers: number; created: number; frames: number; decoded: number; dropped: number; bitstreamBytes: number; errors: number; decoderErrors: number; latencyMs: number; latencyMaxMs: number; writeMs: number };
export const videoStats = (): VideoStats => ({ codecs: 0, buffers: 0, created: 0, frames: 0, decoded: 0, dropped: 0, bitstreamBytes: 0, errors: 0, decoderErrors: 0, latencyMs: 0, latencyMaxMs: 0, writeMs: 0 });

/**
 * A codec the guest made (one VA-API decoding context): `id` is unique for the renderer's life (`VideoStats.created`),
 * `hardware` whether it is decoded with `prefer-hardware` (WebCodecs doesn't say what it got, but Chromium's
 * `prefer-hardware` never falls back to software: a decoder without hardware fails, `decoderErrors`), `open` whether
 * it has a decoder now (made at its first picture, again after an error), `decoded` its pictures written since it was made.
 */
export type VideoStream = { id: number; profile: string; codec: string; width: number; height: number; hardware: boolean; open: boolean; decoded: number };

/** A decoded picture as the host writes it: luma rows `width` bytes long, and chroma at half size with U and V interleaved (NV12's second plane). */
export type DecodedPicture = { width: number; height: number; y: Uint8Array; uv: Uint8Array };

/** One codec's decoder: WebCodecs' `VideoDecoder` in a browser (`webCodecsDecoder`), a fake in Node's tests. */
export type PictureDecoder = {
  /** Decodes a chunk; its picture comes out through the factory's `output`, with this timestamp (or never: a hidden VP9 frame). */
  decode(data: Uint8Array, key: boolean, timestamp: number): void;
  /** Outputs every picture it holds, resolving when it has; the next chunk must then be a key chunk. */
  flush(): Promise<void>;
  close(): void;
};
export type DecoderConfig = { codec: string; hardware: boolean; width: number; height: number };
export type DecoderFactory = (config: DecoderConfig, output: (timestamp: number, picture: DecodedPicture) => void, error: (m: string) => void) => PictureDecoder;

type Codec = {
  /** `VideoStream.id`, and its pictures written. */
  id: number; decoded: number;
  handle: number; profile: number; entrypoint: number; level: number; width: number; height: number; maxRefs: number; target?: number; desc?: Uint8Array; bits: Uint8Array[];
  /** The decoder, made at the first picture and again after an error; until a key chunk reaches it, pictures are dropped. */
  dec?: PictureDecoder; needKey?: boolean; hardware?: boolean; h264?: H264Stream; av1?: Av1Stream;
  /** IDR periods sent to the decoder (H.264), for the pictures' order. */
  epoch: number;
  /** Software H.264: the pictures since the last IDR (unless too many) and the decoders being drained (`drain`). */
  history?: { desc: Uint8Array; bits: Uint8Array; ts: number }[]; historyBytes?: number; retired?: Set<PictureDecoder>;
};
/** The most of an IDR period kept to decode again after a drain. */
const HISTORY_PICTURES = 600, HISTORY_BYTES = 32 << 20;
type Buffer = { handle: number; format: number; width: number; height: number; planes: number[] };
/** A picture sent to the decoder and not yet written: its codec, target buffer and its planes (as at END_FRAME), when it
 * was sent, the place in the guest's order of the call that sent it (`VideoEnv.order`); an H.264 picture's IDR period
 * and POC; once decoded, the picture while it waits to be written (`VideoEnv.mayWrite`). */
type Pending = { codec: Codec; target: number; planes: number[]; at: number; order: number; epoch?: number; poc?: number; pic?: DecodedPicture };

const isH264 = (profile: number) => profile >= PROFILE.AVC_BASELINE && profile <= PROFILE.AVC_HIGH10;
const isVp9 = (profile: number) => profile === PROFILE.VP9_PROFILE0;
const isAv1 = (profile: number) => profile === PROFILE.AV1_MAIN;
/** `virgl_vp9_picture_desc`'s picture fields (Mesa 26.2): bit 2 frame_type (0: key), bit 3 show_frame. */
const VP9_PIC_FIELDS = 332;

/** How the video commands reach the rest of the renderer. */
export type VideoEnv = {
  /** `len` bytes at the start of a resource's backing (a staging buffer the guest filled), or null. */
  read(res: number, len: number): Uint8Array | null;
  /** The size of a resource's backing (0 if none). */
  size(res: number): number;
  error(m: string): void;
  /** Every exception a picture's parsing caught (`VirglRenderer.onCaught`). */
  caught?: (e: unknown) => void;
  debug?: (m: string) => void;
  /** Decoders for the codecs; without them pictures are only counted (a null decoder, V0's). */
  decoders?: DecoderFactory;
  /** The profiles decoded in hardware (`probeVideo`). */
  hardware?: readonly number[];
  /**
   * Writes a picture into a video buffer's planes (`planes`: its plane resources; two for NV12, three for I420) while
   * they exist, attached to the context or not: the guest may have let go of them since END_FRAME (Firefox's decoder
   * process does, at a seek), and they live on where they were exported to (the compositor's context).
   */
  write?(planes: number[], picture: DecodedPicture): void;
  /** A picture was written or given up: what waits for the pictures may go on. */
  settled?(): void;
  /** The place in the guest's order of the call running now (the GPU worker's `CallQueue`); without it, 0. */
  order?(): number;
  /**
   * Whether a picture sent at `order` may be written into these planes now: not while a call before it that could see
   * them still waits (the queue ran the decode ahead of it). One that may not stays pending, decoded, until `land`.
   */
  mayWrite?(planes: readonly number[], order: number): boolean;
};

/**
 * A context's codecs and video buffers (virglrenderer keeps them per context; their handles are the guest's object
 * handles). At END_FRAME a picture goes to its codec's decoder as a chunk (H.264 with its parameter sets rebuilt,
 * web/video-h264.ts; VP9 as sent) and is pending until its decoded planes are written into the target buffer: the
 * guest expects a picture decoded when END_FRAME has run (virglrenderer decodes synchronously; WebCodecs doesn't), so
 * the GPU worker holds what follows while pictures are pending (web/virgl-host.ts `CallQueue`).
 */
export class VideoContext {
  readonly codecs = new Map<number, Codec>();
  readonly buffers = new Map<number, Buffer>();
  /** Pictures sent and not yet written, by timestamp (one sequence for the context's codecs). */
  private pending = new Map<number, Pending>();
  /** The picture (timestamp) last written into each set of planes, by its first plane. */
  private written = new Map<number, number>();
  private seq = 0;
  private closed = false;

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
        this.codecs.set(p[0], { id: ++this.stats.created, decoded: 0, handle: p[0], profile: p[1], entrypoint: p[2], level: p[4], width: p[5], height: p[6], maxRefs: p[7] ?? 0, bits: [], epoch: 0 });
        this.stats.codecs++;
        this.env.debug?.(`video: codec ${p[0]} profile ${p[1]} entrypoint ${p[2]} level ${p[4]} ${p[5]}x${p[6]} refs ${p[7] ?? '-'}`);
        return;
      }
      case 54: { // DESTROY_VIDEO_CODEC
        const c = this.codecs.get(p[0]);
        if (!c) return;
        this.retire(c);
        this.codecs.delete(p[0]);
        this.stats.codecs--;
        return;
      }
      case 55: { // CREATE_VIDEO_BUFFER: handle, format, width, height, plane resources
        if (p.length < 5) return this.env.error('short CREATE_VIDEO_BUFFER');
        if (this.buffers.has(p[0])) return;
        this.buffers.set(p[0], { handle: p[0], format: p[1], width: p[2], height: p[3], planes: [...p.subarray(4)] });
        this.stats.buffers++;
        this.env.debug?.(`video: buffer ${p[0]} format ${p[1]} ${p[2]}x${p[3]} planes ${[...p.subarray(4)].join(',')}`);
        return;
      }
      case 56: // DESTROY_VIDEO_BUFFER: a picture still pending for it stays (its planes may be shown elsewhere: `write`)
        if (!this.buffers.delete(p[0])) return;
        this.stats.buffers--;
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
        if (this.env.decoders && c.desc) this.decode(c, p[1], c.desc);
        return;
      }
    }
  }

  /** The codecs as `VideoStream`s, into `out` (read once a second: the GPU worker's `stats`). */
  streams(out: VideoStream[]) {
    for (const c of this.codecs.values()) {
      const known = isH264(c.profile) || CODECS.some((x) => x.profile === c.profile);
      const codec = !known ? '' : isH264(c.profile) ? codecString(c.profile, c.level) : CODECS.find((x) => x.profile === c.profile)!.codec;
      out.push({ id: c.id, profile: profileName(c.profile), codec, width: c.width, height: c.height, hardware: !!this.env.hardware?.includes(c.profile), open: !!c.dec, decoded: c.decoded });
    }
    return out;
  }

  /** Pictures sent to a decoder and not yet written. */
  get waiting() { return this.pending.size; }

  /** The plane resources of the pending pictures' buffers, of those sent by calls before `before`. */
  pendingPlanes(before = Infinity): number[] {
    const out: number[] = [];
    for (const q of this.pending.values()) if (q.order < before) out.push(...q.planes);
    return out;
  }

  /** Writes the decoded pictures that waited for earlier calls (`VideoEnv.mayWrite`), in order, as far as they now may. */
  land() {
    for (const [ts, q] of this.pending) if (q.pic && (this.env.mayWrite?.(q.planes, q.order) ?? true)) this.put(ts, q, q.pic);
  }

  /**
   * Has the decoders that hold pictures for reordering (software H.264) output them: the guest waits for one the
   * decoder holds until later pictures come, and none are coming (docs/plans/video.md §7). A flushed decoder wants a
   * key chunk next, so a new one takes the IDR period from its start again (its outputs written only where still
   * pending). Without the period (too long), the next IDR.
   */
  drain() {
    this.nudge();
    const codecs = new Set([...this.pending.values()].filter((q) => !q.pic).map((q) => q.codec));
    for (const c of codecs) {
      if (!c.dec || !c.h264 || c.hardware) continue;
      const old = c.dec;
      (c.retired ??= new Set()).add(old);
      void old.flush().finally(() => {
        c.retired?.delete(old);
        old.close();
      });
      c.dec = undefined;
      const history = c.history;
      this.env.debug?.(`video: codec ${c.handle}: drained; ${history ? `${history.length} picture(s) again` : 'from the next IDR'}`);
      if (!history) continue;
      this.open(c);
      for (const h of history) {
        const { data, key } = c.h264!.chunk(h.desc, h.bits);
        c.needKey = false;
        c.dec!.decode(data, key, h.ts);
      }
    }
  }

  /** Gives up the pending pictures sent before `before` (performance.now()): the guest sees their buffers' old planes. */
  giveUp(before = Infinity) {
    const n = this.drop((q) => q.at < before);
    if (n) this.env.error(`video: ${n} picture(s) never came out of the decoder: given up`);
  }

  destroy() {
    for (const c of this.codecs.values()) this.closeCodec(c);
    this.closed = true;
    this.stats.codecs -= this.codecs.size;
    this.stats.buffers -= this.buffers.size;
    this.codecs.clear();
    this.buffers.clear();
  }

  /** A picture to its codec's decoder (made now if it has none), pending until written unless the guest never shows it. */
  private decode(c: Codec, target: number, desc: Uint8Array) {
    if (!isH264(c.profile) && !isVp9(c.profile) && !isAv1(c.profile)) return this.err(`video: codec ${c.handle}: profile ${c.profile} isn't decoded`);
    if (!c.dec) this.open(c);
    const bits = c.bits.length === 1 ? c.bits[0] : concat(c.bits);
    if (c.av1) return this.decodeAv1(c, target, desc, bits);
    let data = bits, key: boolean, shown = true, poc: number | undefined;
    try {
      if (c.h264) ({ data, key, poc } = c.h264.chunk(desc, bits));
      else {
        if (desc.length <= VP9_PIC_FIELDS) throw new Error(`a picture desc of ${desc.length} bytes`);
        key = !(desc[VP9_PIC_FIELDS] & 4);
        // A frame the guest doesn't show (a reference only) gives no output: nothing waits for it.
        shown = !!(desc[VP9_PIC_FIELDS] & 8);
      }
    } catch (e) {
      this.env.caught?.(e);
      this.stats.dropped++;
      return this.err(`video: codec ${c.handle}: ${e instanceof Error ? e.message : e}`);
    }
    if (c.needKey && !key) {
      this.stats.dropped++;
      return;
    }
    c.needKey = false;
    if (key) c.epoch++;
    const ts = this.seq++;
    if (c.h264 && !c.hardware) this.remember(c, desc, bits, key, ts);
    // Decoded (a later picture may refer to it) but written nowhere if the guest destroyed its buffer after BEGIN_FRAME.
    const planes = this.buffers.get(target)?.planes;
    if (shown && planes) this.pending.set(ts, { codec: c, target, planes, at: performance.now(), order: this.env.order?.() ?? 0, epoch: c.epoch, poc });
    c.dec!.decode(data, key, ts);
  }

  /** An AV1 frame: its temporal units (web/video-av1.ts), the one the decoder outputs for it pending. */
  private decodeAv1(c: Codec, target: number, desc: Uint8Array, bits: Uint8Array) {
    let f, chunks;
    const ts = this.seq++;
    try {
      f = av1Frame(desc, target);
      if (c.needKey && !f.key) {
        this.stats.dropped++;
        return;
      }
      c.needKey = false;
      // Pending from END_FRAME, whenever its temporal unit goes (it may wait for the next frame: web/video-av1.ts).
      const planes = f.output ? this.buffers.get(f.shown)?.planes : undefined;
      if (f.output && !planes) this.env.debug?.(`video: codec ${c.handle}: no buffer ${f.shown} for a frame's output`);
      if (planes) this.pending.set(ts, { codec: c, target: f.shown, planes, at: performance.now(), order: this.env.order?.() ?? 0 });
      chunks = c.av1!.chunks(desc, bits, target, ts);
    } catch (e) {
      this.env.caught?.(e);
      this.pending.delete(ts);
      this.stats.dropped++;
      return this.err(`video: codec ${c.handle}: ${e instanceof Error ? e.message : e}`);
    }
    for (const k of chunks) c.dec!.decode(k.data, k.key, k.ts);
  }

  /** The AV1 frames waiting for the next one's map (web/video-av1.ts `Av1Stream`) to the decoder now: the guest waits on
   * one (`CallQueue`'s nudge, before a drain). */
  nudge() {
    for (const c of this.codecs.values()) {
      if (!c.av1?.holding || !c.dec) continue;
      for (const k of c.av1.flush()) c.dec.decode(k.data, k.key, k.ts);
    }
  }

  /** A software H.264 picture into its IDR period's history (`drain`). */
  private remember(c: Codec, desc: Uint8Array, bits: Uint8Array, key: boolean, ts: number) {
    if (key) {
      c.history = [];
      c.historyBytes = 0;
    }
    if (!c.history) return;
    c.history.push({ desc: desc.slice(), bits: bits.slice(), ts });
    c.historyBytes! += desc.length + bits.length;
    if (c.history.length > HISTORY_PICTURES || c.historyBytes! > HISTORY_BYTES) c.history = undefined;
  }

  private open(c: Codec) {
    const h264 = isH264(c.profile);
    c.hardware = !!this.env.hardware?.includes(c.profile);
    // A new decoder takes the parameter sets again (H264Stream sends them at a key picture; Av1Stream its sequence
    // header at a key frame, its reference slots empty).
    c.h264 = h264 ? new H264Stream(c.width, c.height, c.level, c.hardware ? 'none' : 'stream', c.h264?.depth) : undefined;
    c.av1 = isAv1(c.profile) ? new Av1Stream() : undefined;
    const codec = h264 ? codecString(c.profile, c.level) : CODECS.find((x) => x.profile === c.profile)!.codec;
    c.needKey = true;
    const dec: PictureDecoder = this.env.decoders!({ codec, hardware: c.hardware, width: c.width, height: c.height }, (ts, pic) => {
      // A drained decoder's pictures still count (`drain`).
      if (this.closed || (c.dec !== dec && !c.retired?.has(dec))) return;
      const q = this.pending.get(ts);
      if (!q || q.pic) return; // given up, or its buffer is gone; or out already (a drained decoder's successor)
      // A software H.264 decoder outputs in display order: an earlier picture still pending (a lesser POC in this IDR
      // period, or one of an earlier period) never will come (dropped by it), so it's given up now, alone. Not while a
      // drained decoder and its successor both output.
      if (!c.hardware && q.poc !== undefined && !c.retired?.size) {
        const over = (x: Pending) => x !== q && !x.pic && x.codec === c && x.poc !== undefined && (x.epoch! < q.epoch! || (x.epoch === q.epoch && x.poc < q.poc!));
        if (this.env.debug) for (const [t, x] of this.pending) if (over(x)) this.env.debug(`video: codec ${c.handle}: picture ${t} (period ${x.epoch}, POC ${x.poc}) passed over by ${ts} (period ${q.epoch}, POC ${q.poc})`);
        this.drop(over);
      }
      if (this.env.mayWrite?.(q.planes, q.order) ?? true) this.put(ts, q, pic);
      else q.pic = pic;
    }, (m) => {
      if (this.closed || c.dec !== dec) return;
      this.stats.decoderErrors++;
      this.err(`video: codec ${c.handle}: ${m}`);
      // The pictures it had are lost; a new decoder starts at the next key picture.
      this.closeCodec(c);
    });
    c.dec = dec;
    this.env.debug?.(`video: codec ${c.handle}: decoder ${codec} ${c.width}x${c.height} ${c.hardware ? 'hardware' : 'software'}`);
  }

  /** A decoded picture into its planes (`VideoEnv.write`), no longer pending. */
  private put(ts: number, q: Pending, pic: DecodedPicture) {
    this.pending.delete(ts);
    // Never over a later picture (the guest used the buffer again): a drained decoder and its successor, or a
    // retired one, may output out of order.
    const last = this.written.get(q.planes[0]);
    if (last !== undefined && last > ts) {
      this.env.debug?.(`video: codec ${q.codec.handle}: picture ${ts} is older than ${last}, in its planes already`);
      this.stats.dropped++;
    } else {
      this.written.set(q.planes[0], ts);
      const t0 = performance.now();
      this.env.write?.(q.planes, pic);
      const t1 = performance.now();
      this.stats.decoded++;
      q.codec.decoded++;
      this.stats.writeMs += t1 - t0;
      this.stats.latencyMs += t1 - q.at;
      this.stats.latencyMaxMs = Math.max(this.stats.latencyMaxMs, t1 - q.at);
    }
    this.env.settled?.();
  }

  /**
   * A codec the guest destroyed: what its decoder holds still comes out (the guest took those pictures as decoded at
   * END_FRAME and may show them still: Firefox destroys its decoder at a seek), then the rest is dropped.
   */
  private retire(c: Codec) {
    const dec = c.dec;
    if (!dec || ![...this.pending.values()].some((q) => q.codec === c)) return this.closeCodec(c);
    // An AV1 frame waiting for the next one's map goes first (it won't come).
    if (c.av1?.holding) for (const k of c.av1.flush()) dec.decode(k.data, k.key, k.ts);
    c.dec = undefined;
    c.history = undefined;
    (c.retired ??= new Set()).add(dec);
    this.env.debug?.(`video: codec ${c.handle}: destroyed with pictures pending: flushed`);
    void dec.flush().finally(() => {
      c.retired?.delete(dec);
      dec.close();
      if (!this.closed) this.drop((q) => q.codec === c && !q.pic);
    });
  }

  private closeCodec(c: Codec) {
    const dec = c.dec;
    c.dec = undefined;
    dec?.close();
    for (const r of c.retired ?? []) r.close();
    c.retired?.clear();
    c.history = undefined;
    this.drop((q) => q.codec === c);
  }

  /** Drops the pending pictures `which` picks (counted, and the waiters told); returns how many. */
  private drop(which: (q: Pending) => boolean) {
    let n = 0;
    for (const [ts, q] of this.pending) {
      if (!which(q)) continue;
      this.pending.delete(ts);
      n++;
    }
    if (n) {
      this.stats.dropped += n;
      this.env.settled?.();
    }
    return n;
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

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of parts) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

/**
 * Decoders from WebCodecs (the GPU worker's): `optimizeForLatency`, in hardware for the profiles `probeVideo` found
 * there (else in software, so the H.264 stream matches the decoder: `buildSps`). Each frame's visible rectangle is
 * copied out (`copyTo`, exact) as luma and interleaved chroma.
 */
export const webCodecsDecoder: DecoderFactory = (config, output, error) => {
  let closed = false;
  const d = new VideoDecoder({
    output: (f) => {
      const ts = f.timestamp;
      copyPicture(f).then((p) => { if (!closed) output(ts, p); }, (e) => { if (!closed) error(`a frame couldn't be read: ${e}`); }).finally(() => f.close());
    },
    error: (e) => { if (!closed) error(String(e)); },
  });
  d.configure({ codec: config.codec, codedWidth: config.width, codedHeight: config.height, optimizeForLatency: true, hardwareAcceleration: config.hardware ? 'prefer-hardware' : 'prefer-software' });
  return {
    decode(data, key, timestamp) {
      try {
        d.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp, data }));
      } catch (e) {
        if (!closed) error(String(e));
      }
    },
    flush() { return d.flush().catch(() => {}); },
    close() {
      closed = true;
      if (d.state !== 'closed') d.close();
    },
  };
};

/**
 * A plane's rows (`w` texels of `bpp` bytes, `h` of them) widened to at least `tw`×`th` texels, the last column and the
 * last row repeated. The planes are the coded size (whole blocks: 864×480 for an 854×480 video) and a picture is its
 * visible part; what the rest held would be zeros (luma and chroma 0: green) to whoever reads the whole plane. A hardware
 * decoder leaves the blocks' own pixels there. (Draws sample the picture alone: `VirglRenderer.writePicture`.)
 */
export function padPlane(data: Uint8Array, w: number, h: number, bpp: number, tw: number, th: number): { data: Uint8Array; w: number; h: number } {
  if (!w || !h || (tw <= w && th <= h)) return { data, w, h };
  const W = Math.max(w, tw), H = Math.max(h, th), out = new Uint8Array(W * H * bpp);
  for (let r = 0; r < h; r++) {
    const o = r * W * bpp;
    out.set(data.subarray(r * w * bpp, (r + 1) * w * bpp), o);
    for (let x = w; x < W; x++) out.copyWithin(o + x * bpp, o + (w - 1) * bpp, o + w * bpp);
  }
  for (let r = h; r < H; r++) out.copyWithin(r * W * bpp, (h - 1) * W * bpp, h * W * bpp);
  return { data: out, w: W, h: H };
}

/** A frame's visible rectangle as luma and interleaved chroma (from I420 or NV12, the formats the decoders give). */
export async function copyPicture(f: VideoFrame): Promise<DecodedPicture> {
  if (f.format !== 'I420' && f.format !== 'NV12') throw new Error(`frame format ${f.format}`);
  const raw = new Uint8Array(f.allocationSize());
  const layout = await f.copyTo(raw);
  const width = f.visibleRect!.width, height = f.visibleRect!.height;
  const cw = (width + 1) >> 1, ch = (height + 1) >> 1;
  const y = new Uint8Array(width * height), uv = new Uint8Array(cw * 2 * ch);
  const rows = (dst: Uint8Array, plane: PlaneLayout, w: number, h: number) => {
    for (let r = 0; r < h; r++) dst.set(raw.subarray(plane.offset + r * plane.stride, plane.offset + r * plane.stride + w), r * w);
  };
  rows(y, layout[0], width, height);
  if (f.format === 'NV12') rows(uv, layout[1], cw * 2, ch);
  else {
    const u = layout[1], v = layout[2];
    for (let r = 0; r < ch; r++) {
      const uo = u.offset + r * u.stride, vo = v.offset + r * v.stride, o = r * cw * 2;
      for (let x = 0; x < cw; x++) {
        uv[o + 2 * x] = raw[uo + x];
        uv[o + 2 * x + 1] = raw[vo + x];
      }
    }
  }
  return { width, height, y, uv };
}
