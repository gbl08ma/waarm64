// virtio-snd backend (docs/devices.md "snd (ID 25)", docs/plans/audio.md), written from the virtio 1.2
// specification §5.14, with Linux's sound/virtio read for behavior and QEMU's virtio-sound-device as
// the oracle for what a guest sends (audio.md §12). core/tests/common/snd.rs is its native twin and
// must give the same answers and play the same bytes.
//
// One output stream, no jacks, no channel maps, no controls; queues controlq, eventq, txq, rxq. A
// transmit message's frames go to a sink (`SndSink`): the deterministic one here hashes them and
// completes the messages at the end of the DEVICE exit that posted them (so boots keep exact step
// counts); the page's AudioWorklet ring is S2's.
import { gather, scatter, type Ctx, type Request } from './devices.ts';

/** The queues, in order. */
export const CONTROLQ = 0;
export const EVENTQ = 1;
export const TXQ = 2;
export const RXQ = 3;

/** Request codes and statuses (virtio 1.2 §5.14.6). */
export const R_JACK_INFO = 1;
export const R_JACK_REMAP = 2;
export const R_PCM_INFO = 0x100;
export const R_PCM_SET_PARAMS = 0x101;
export const R_PCM_PREPARE = 0x102;
export const R_PCM_RELEASE = 0x103;
export const R_PCM_START = 0x104;
export const R_PCM_STOP = 0x105;
export const R_CHMAP_INFO = 0x200;
export const S_OK = 0x8000;
export const S_BAD_MSG = 0x8001;
export const S_NOT_SUPP = 0x8002;

/** Sample formats (`VIRTIO_SND_PCM_FMT_*`) offered, and their sample size in bytes. */
export const FMT_S16 = 5;
export const FMT_S32 = 17;
export const FMT_FLOAT = 19;
const SAMPLE_BYTES: Record<number, number> = { [FMT_S16]: 2, [FMT_S32]: 4, [FMT_FLOAT]: 4 };
const FORMAT_NAMES: Record<number, string> = { [FMT_S16]: 'S16', [FMT_S32]: 'S32', [FMT_FLOAT]: 'FLOAT' };

/** `VIRTIO_SND_PCM_RATE_*`: the rate of each bit. */
export const RATES = [5512, 8000, 11025, 16000, 22050, 32000, 44100, 48000, 64000, 88200, 96000, 176400, 192000, 384000];
/** Offered: 8 kHz to 192 kHz (bits 1-12), what every browser's AudioContext takes (Chromium takes 3-768 kHz, Firefox 8-192). */
export const RATE_BITS = 0x1ffe;
const CHANNELS_MAX = 2;
/** The size of a `virtio_snd_pcm_info`. */
const PCM_INFO_SIZE = 32;
/** One output stream (a capture stream is audio S4's). */
const STREAMS = 1;

type State = 'none' | 'params' | 'prepared' | 'started' | 'stopped' | 'released';
const STATES: State[] = ['none', 'params', 'prepared', 'started', 'stopped', 'released'];
export type SndParams = { bufferBytes: number; periodBytes: number; channels: number; format: number; rate: number };

/**
 * Where a playback stream's frames go. `play` gets a message's frames (raw, in the stream's format: `toF32`
 * converts) and calls `done(latencyBytes)` once they're played, which completes the message; frames come in
 * order. `start` and `stop` start and pause consumption; `release` drops whatever wasn't played (the device
 * returns those messages itself, and a later `done` for them does nothing). `tick` ends a DEVICE exit's
 * requests: a sink that completes at exits does it there.
 */
export type SndSink = {
  play(p: SndParams, frames: Uint8Array, done: (latencyBytes: number) => void): void;
  start?(): void;
  stop?(): void;
  release?(): void;
  tick?(): void;
  save?(): unknown;
  restore?(state: unknown): void;
};

const FNV_OFFSET = 0x811c9dc5;
const hex = (h: number) => h.toString(16).padStart(8, '0');

/** FNV-1a (32-bit) of `b`, continuing from `h`. */
export function fnv1a(b: Uint8Array, h = FNV_OFFSET) {
  for (let k = 0; k < b.length; k++) h = Math.imul(h ^ b[k], 0x01000193);
  return h >>> 0;
}

/** What the deterministic sink played: frames, bytes, messages, and FNV-1a of the bytes (hex). */
export type Played = { frames: number; bytes: number; messages: number; fnv: string };

/**
 * The deterministic sink (tests, native runners, and for now every machine): the messages given during a
 * DEVICE exit are played (hashed, and completed) at its end (`tick`), so they complete at the exit that
 * posted them, or those held until START at START's. **At most a buffer less a period per exit:** Linux's
 * driver counts its position in completions modulo the buffer, so a whole buffer completed before it looks
 * again reads as nothing played and the stream stalls (the four periods a player queues before START did
 * exactly that: audio.md §12); what's left completes at the next exit, which the guest makes as soon as it
 * writes again. At most `keep` bytes of what was played are kept (`kept()`), for tests.
 */
export function checksumSink(keep = 0) {
  let played: Played = { frames: 0, bytes: 0, messages: 0, fnv: hex(FNV_OFFSET) };
  let queue: { p: SndParams; frames: Uint8Array; done: (latencyBytes: number) => void }[] = [];
  let running = false;
  const chunks: Uint8Array[] = [];
  let held = 0;
  return {
    played: () => ({ ...played }),
    kept: () => {
      const out = new Uint8Array(held);
      let at = 0;
      for (const c of chunks) out.set(c, at), at += c.length;
      return out;
    },
    play(p: SndParams, frames: Uint8Array, done: (latencyBytes: number) => void) {
      queue.push({ p, frames: frames.slice(), done });
    },
    start() { running = true; },
    stop() { running = false; },
    release() {
      running = false;
      queue = [];
    },
    tick() {
      let burst = 0;
      while (running && queue.length) {
        const { p, frames, done } = queue[0];
        if (burst > 0 && burst + frames.length > p.bufferBytes - p.periodBytes) break;
        queue.shift();
        burst += frames.length;
        played = {
          frames: played.frames + frames.length / (p.channels * SAMPLE_BYTES[p.format]),
          bytes: played.bytes + frames.length,
          messages: played.messages + 1,
          fnv: hex(fnv1a(frames, parseInt(played.fnv, 16))),
        };
        if (held < keep) {
          const c = frames.slice(0, keep - held);
          chunks.push(c);
          held += c.length;
        }
        done(0);
      }
    },
    save: (): Played => ({ ...played }),
    restore(state: unknown) {
      const s = state as Played;
      if (!(s && Number.isSafeInteger(s.frames) && Number.isSafeInteger(s.bytes) && Number.isSafeInteger(s.messages) && /^[0-9a-f]{8}$/.test(s.fnv))) throw new Error('the snapshot has no state for the sound device');
      played = { frames: s.frames, bytes: s.bytes, messages: s.messages, fnv: s.fnv };
    },
  } satisfies SndSink & Record<string, unknown>;
}

/** Samples of `frames` (raw, in `format`) as f32 in [-1, 1], interleaved as they come. */
export function toF32(frames: Uint8Array, format: number, out = new Float32Array(frames.length / SAMPLE_BYTES[format])) {
  const v = new DataView(frames.buffer, frames.byteOffset, frames.byteLength);
  const n = out.length;
  if (format === FMT_S16) for (let k = 0; k < n; k++) out[k] = v.getInt16(2 * k, true) / 32768;
  else if (format === FMT_S32) for (let k = 0; k < n; k++) out[k] = v.getInt32(4 * k, true) / 2147483648;
  else if (format === FMT_FLOAT) for (let k = 0; k < n; k++) out[k] = v.getFloat32(4 * k, true);
  else throw new Error(`no conversion from sample format ${format}`);
  return out;
}

const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at, true);
const status = (s: number, more = 0) => {
  const b = new Uint8Array(4 + more);
  new DataView(b.buffer).setUint32(0, s, true);
  return b;
};
const NAMES: Record<number, string> = {
  [R_JACK_INFO]: 'JACK_INFO', [R_JACK_REMAP]: 'JACK_REMAP', [R_PCM_INFO]: 'PCM_INFO', [R_PCM_SET_PARAMS]: 'PCM_SET_PARAMS', [R_PCM_PREPARE]: 'PCM_PREPARE',
  [R_PCM_RELEASE]: 'PCM_RELEASE', [R_PCM_START]: 'PCM_START', [R_PCM_STOP]: 'PCM_STOP', [R_CHMAP_INFO]: 'CHMAP_INFO',
};
const STATUS_NAMES: Record<number, string> = { [S_OK]: 'OK', [S_BAD_MSG]: 'BAD_MSG', [S_NOT_SUPP]: 'NOT_SUPP' };
/** The control requests logged (`Snd.log`), the first this many. */
const LOG_MAX = 64;

/** What a control request does to the transmit messages: nothing, play them (START), pause (STOP), return them (RELEASE). */
export type Effect = 'none' | 'start' | 'stop' | 'release';

/**
 * The device's protocol without the queues: control requests answered, transmit messages checked, the
 * stream's state machine (virtio 1.2 §5.14.6.6.1; a request out of its order is BAD_MSG).
 */
export class Snd {
  state: State = 'none';
  params: SndParams | undefined;
  /** The control requests and their statuses, in order (the first LOG_MAX): what the guest tests and the oracle comparison read. */
  log: string[] = [];

  reset() {
    this.state = 'none';
    this.params = undefined;
  }

  /** A control request's reply (`room` bytes are writable: an info query's items must fit) and what it does to the messages. */
  control(cmd: Uint8Array, room: number): { reply: Uint8Array; effect: Effect } {
    const [reply, effect, detail] = this.answer(cmd, room);
    if (this.log.length < LOG_MAX && cmd.length >= 4) {
      const code = u32(cmd, 0);
      this.log.push(`${NAMES[code] ?? `0x${code.toString(16)}`}${detail} ${STATUS_NAMES[u32(reply, 0)]}`);
    }
    return { reply, effect };
  }

  private answer(cmd: Uint8Array, room: number): [Uint8Array, Effect, string] {
    if (cmd.length < 4) return [status(S_BAD_MSG), 'none', ''];
    const code = u32(cmd, 0);
    switch (code) {
      case R_JACK_INFO: case R_CHMAP_INFO: case R_PCM_INFO: {
        // virtio_snd_query_info: start_id, count, size. No jacks or channel maps.
        if (cmd.length < 16) return [status(S_BAD_MSG), 'none', ''];
        const [start, count, size] = [u32(cmd, 4), u32(cmd, 8), u32(cmd, 12)];
        const n = code === R_PCM_INFO ? STREAMS : 0;
        const detail = ` ${start}+${count}`;
        if (start > n || count > n - start || (count > 0 && (size < PCM_INFO_SIZE || 4 + count * size > room))) return [status(S_BAD_MSG), 'none', detail];
        const r = status(S_OK, count * size);
        const v = new DataView(r.buffer);
        for (let k = 0; k < count; k++) {
          // virtio_snd_pcm_info: hda_fn_nid 0, features 0, formats (u64), rates (u64), direction, channels_min, channels_max.
          const at = 4 + k * size;
          v.setUint32(at + 8, 1 << FMT_S16 | 1 << FMT_S32 | 1 << FMT_FLOAT, true); // the u64s' high words stay 0
          v.setUint32(at + 16, RATE_BITS, true);
          r[at + 24] = 0; // VIRTIO_SND_D_OUTPUT
          r[at + 25] = 1;
          r[at + 26] = CHANNELS_MAX;
        }
        return [r, 'none', detail];
      }
      case R_JACK_REMAP: return [status(S_BAD_MSG), 'none', '']; // no jack to remap
      case R_PCM_SET_PARAMS: case R_PCM_PREPARE: case R_PCM_RELEASE: case R_PCM_START: case R_PCM_STOP: {
        if (cmd.length < (code === R_PCM_SET_PARAMS ? 24 : 8) || u32(cmd, 4) >= STREAMS) return [status(S_BAD_MSG), 'none', ''];
        const s = this.state;
        const to = (ok: boolean, next: State, effect: Effect = 'none'): [Uint8Array, Effect, string] => {
          if (!ok) return [status(S_BAD_MSG), 'none', ''];
          this.state = next;
          return [status(S_OK), effect, ''];
        };
        if (code === R_PCM_SET_PARAMS) {
          // virtio_snd_pcm_set_params: buffer_bytes, period_bytes, features, channels, format, rate.
          const p: SndParams = { bufferBytes: u32(cmd, 8), periodBytes: u32(cmd, 12), channels: cmd[20], format: cmd[21], rate: RATES[cmd[22]] ?? 0 };
          const detail = ` ${p.channels}ch ${FORMAT_NAMES[p.format] ?? `fmt${cmd[21]}`} ${p.rate || `rate${cmd[22]}`} ${p.bufferBytes}/${p.periodBytes}`;
          if (!(s === 'none' || s === 'params' || s === 'prepared' || s === 'released')) return [status(S_BAD_MSG), 'none', detail];
          if (u32(cmd, 16) !== 0 || !SAMPLE_BYTES[p.format] || cmd[22] > 31 || !(RATE_BITS >> cmd[22] & 1) || p.channels < 1 || p.channels > CHANNELS_MAX) return [status(S_NOT_SUPP), 'none', detail];
          const frame = p.channels * SAMPLE_BYTES[p.format];
          if (p.periodBytes === 0 || p.periodBytes % frame !== 0 || p.bufferBytes === 0 || p.bufferBytes % p.periodBytes !== 0) return [status(S_BAD_MSG), 'none', detail];
          this.params = p;
          this.state = 'params';
          return [status(S_OK), 'none', detail];
        }
        if (code === R_PCM_PREPARE) return to(s === 'params' || s === 'prepared' || s === 'released', 'prepared');
        if (code === R_PCM_START) return to(s === 'prepared' || s === 'stopped', 'started', 'start');
        if (code === R_PCM_STOP) return to(s === 'started', 'stopped', 'stop');
        return to(s === 'prepared' || s === 'stopped', 'released', 'release');
      }
      default: return [status(S_NOT_SUPP), 'none', ''];
    }
  }

  /**
   * What to do with a transmit message (`head`: its first readable bytes, the stream id; `len`: all of them,
   * the id and the frames): play it (started), hold it (prepared or stopped), or answer with a status.
   */
  tx(head: Uint8Array, len: number): 'play' | 'hold' | number {
    if (len < 4 || head.length < 4 || u32(head, 0) >= STREAMS || !this.params) return S_BAD_MSG;
    if ((len - 4) % (this.params.channels * SAMPLE_BYTES[this.params.format]) !== 0) return S_BAD_MSG;
    return this.state === 'started' ? 'play' : this.state === 'prepared' || this.state === 'stopped' ? 'hold' : S_BAD_MSG;
  }

  save() {
    return { state: this.state, params: this.params ?? null, log: [...this.log] };
  }

  restore(state: unknown) {
    const s = state as ReturnType<Snd['save']>;
    if (!s || !STATES.includes(s.state) || !Array.isArray(s.log) || (s.state !== 'none' && !s.params)) throw new Error('the snapshot has no state for the sound device');
    this.state = s.state;
    this.params = s.params ?? undefined;
    this.log = s.log.map(String);
  }
}

/** A sound device's state (`Backend.save`): the stream, the control requests taken, and what the sink played (the deterministic sink's `Played`). */
export type SndState = ReturnType<Snd['save']> & { sink: unknown };

/** Writes `bytes` over the last bytes of the segments (a status: the end of a request's writable bytes). */
function writeTail(ram: Uint8Array, segs: { off: number; len: number }[], bytes: Uint8Array) {
  let skip = segs.reduce((n, s) => n + s.len, 0) - bytes.length;
  let k = 0;
  for (const s of segs) {
    if (skip >= s.len) {
      skip -= s.len;
      continue;
    }
    const n = Math.min(s.len - skip, bytes.length - k);
    ram.set(bytes.subarray(k, k + n), s.off + skip);
    k += n;
    skip = 0;
  }
}

/**
 * The backend over the queues: control requests answered at once; event buffers held (no events yet);
 * transmit messages held until START, then given to `sink`, returned at RELEASE (STOP pauses: Linux sends it
 * for a pause too, and resumes with START without posting the held messages again); receive messages
 * BAD_MSG (no input stream).
 */
export function sndBackend(ctx: Ctx, sink: SndSink = checksumSink()) {
  const snd = new Snd();
  /** Transmit messages not completed: waiting for START, or given to the sink and not played yet. */
  type Msg = { r: Request; live: boolean };
  let waiting: Msg[] = [];
  let playing: Msg[] = [];
  const events: Request[] = [];
  const room = (r: Request) => r.write.reduce((n, s) => n + s.len, 0);
  /** Completes a message with a `virtio_snd_pcm_status` (status, latency_bytes) in its last writable bytes. */
  const finish = (r: Request, st: number, latency = 0) => {
    if (room(r) < 8) return ctx.complete(r.w0, 0); // no room for a status: nothing to say
    const b = new Uint8Array(8);
    new DataView(b.buffer).setUint32(0, st, true);
    new DataView(b.buffer).setUint32(4, latency, true);
    writeTail(ctx.ram(), r.write, b);
    ctx.complete(r.w0, 8);
  };
  const play = (m: Msg) => {
    playing.push(m);
    const len = m.r.read.reduce((n, s) => n + s.len, 0);
    sink.play(snd.params!, gather(ctx.ram(), m.r.read, len).subarray(4), (latency) => {
      if (!m.live) return;
      m.live = false;
      playing = playing.filter((x) => x !== m);
      finish(m.r, S_OK, latency);
    });
  };
  const drop = () => {
    for (const m of [...playing, ...waiting]) m.live = false;
    [playing, waiting] = [[], []];
  };
  return {
    snd,
    sink,
    request(r: Request): number | undefined {
      const ram = ctx.ram();
      if (r.queue === EVENTQ) {
        events.push(r);
        return undefined;
      }
      const len = r.read.reduce((n, s) => n + s.len, 0);
      if (r.queue === CONTROLQ) {
        const w = room(r);
        if (w < 4) return 0;
        const { reply, effect } = snd.control(gather(ram, r.read, len), w);
        scatter(ram, r.write, reply);
        // The reply first: the stream's messages complete after the request that started or released it.
        ctx.complete(r.w0, reply.length);
        if (effect === 'start') {
          sink.start?.();
          const now = waiting;
          waiting = [];
          for (const m of now) play(m);
        } else if (effect === 'stop') {
          sink.stop?.();
        } else if (effect === 'release') {
          const back = [...playing, ...waiting];
          drop();
          sink.release?.();
          for (const m of back) finish(m.r, S_OK);
        }
        return undefined;
      }
      if (r.queue === TXQ) {
        const verdict = snd.tx(gather(ram, r.read, 4), len);
        if (verdict === 'play') play({ r, live: true });
        else if (verdict === 'hold') waiting.push({ r, live: true });
        else finish(r, verdict);
        return undefined;
      }
      finish(r, S_BAD_MSG); // rxq
      return undefined;
    },
    /** The end of a DEVICE exit's requests. */
    polled: () => sink.tick?.(),
    reset() {
      drop();
      events.length = 0;
      snd.reset();
      sink.release?.();
    },
    save: (): SndState => ({ ...snd.save(), sink: sink.save?.() ?? null }),
    restore(state: unknown) {
      snd.restore(state);
      const s = (state as { sink?: unknown }).sink;
      if (s !== null && s !== undefined) sink.restore?.(s);
      if (snd.state === 'started') sink.start?.();
    },
  };
}
