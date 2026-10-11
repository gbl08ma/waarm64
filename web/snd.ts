// virtio-snd backend (docs/devices.md "snd (ID 25)", docs/plans/audio.md), written from the virtio 1.2
// specification §5.14, with Linux's sound/virtio read for behavior and QEMU's virtio-sound-device as
// the oracle for what a guest sends (audio.md §12). core/tests/common/snd.rs is its native twin and
// must give the same answers and play the same bytes.
//
// An output stream (0) and an input stream (1), no jacks, no channel maps, no controls; queues controlq,
// eventq, txq, rxq. A transmit message's frames go to a sink (`SndSink`): the deterministic one here hashes
// them and completes the messages at the end of the DEVICE exit that posted them (so boots keep exact step
// counts); the realtime one (`ringSink`) writes them into the page's ring (web/audio-ring.ts) and completes
// them once the AudioWorklet played them. A receive message is filled by a source (`SndSource`): the
// deterministic one with a known waveform at the end of its exit, the realtime one at the stream's rate.
import { gather, scatter, type Ctx, type Request } from './devices.ts';
import { CAPACITY, EPOCH, GAP_FRAMES, LATENCY, QUANTA, RATE, READ, RUN, UNDERRUNS, UNTAKEN, WAKE, WRITE, newRing, ringViews } from './audio-ring.ts';

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
/** The streams: 0 the output, 1 the input (capture, audio S4). */
const STREAMS = 2;
export const OUT = 0;
export const IN = 1;

type State = 'none' | 'params' | 'prepared' | 'started' | 'stopped' | 'released';
type Stream = { state: State; params?: SndParams };
const STATES: State[] = ['none', 'params', 'prepared', 'started', 'stopped', 'released'];
export type SndParams = { bufferBytes: number; periodBytes: number; channels: number; format: number; rate: number };

/**
 * Where a playback stream's frames go. `play` gets a message's frames (raw, in the stream's format: `toF32`
 * converts) and calls `done(latencyBytes)` once they're played, which completes the message; frames come in
 * order. `start` (with the stream's parameters) and `stop` start and pause consumption; `release` drops whatever wasn't played (the device
 * returns those messages itself, and a later `done` for them does nothing). `tick` ends a DEVICE exit's
 * requests: a sink that completes at exits does it there.
 */
export type SndSink = {
  play(p: SndParams, frames: Uint8Array, done: (latencyBytes: number) => void): void;
  start?(p: SndParams): void;
  stop?(): void;
  release?(): void;
  tick?(): void;
  save?(): unknown;
  restore?(state: unknown): void;
  /** After a restore, once its held messages were given again (`bytes` of frames): see `completionBound`. */
  restored?(p: SndParams, bytes: number): void;
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

/** What the page hears from a realtime sink on its port (web/audio.ts). */
export type SndToPage =
  | { type: 'start'; rate: number }
  /** `ms`: the time since the stream's START (a stream that ran: what the ring paced, the gaps included). */
  | { type: 'stop'; ms?: number }
  /** Once a second with `stats`: the completions' timing (audio.md §13). */
  | { type: 'stats'; stats: SndStats };
/**
 * A second of a realtime sink: messages completed, the spread of the intervals between completions around a
 * period's length (ms: percentiles of |interval − period|), the pumps run, the ms they took, and how many of those
 * seconds' completions were on its own clock (no worklet playing).
 */
export type SndStats = { completions: number; jitterP50: number; jitterP99: number; jitterMax: number; pumps: number; busyMs: number; ownClock: number; capped: number };

/** How a realtime sink is woken to complete what was played: a timer, or the worklet's `WAKE` notify (with a timer's period as the wait's timeout). */
export type SndWake = 'timer' | 'worklet';

/** The pump's period, ms (the timer's, and the worklet wait's timeout). */
const PUMP_MS = 5;
/** The worklet counts as playing while its heartbeat moved this recently, ms. */
const LIVE_MS = 50;
const CAP_WAIT_MS = 10;
/** Two of a 100 Hz guest's ticks and a third for rounding: ALSA's check needs one tick past half the buffer's. */
const JIFFY_MARGIN_MS = 30;

/**
 * The bound on a realtime stream's completions (audio.md §12, §15, §16): at most a buffer less a period since the
 * guest's last message. Linux's driver adds each completion to its position modulo the buffer and reports progress
 * from a work item that one run serves for any number of completions, so a whole buffer completed before that work
 * runs reads as none; only ALSA's jiffies check takes it for a full wrap, when more than half a buffer of the guest's
 * time passed since its last look (more than half its buffer's jiffies and one). So the period that would make a
 * whole buffer since the last message (a stream's end: a drain posts nothing more) waits until half a buffer's time
 * and `JIFFY_MARGIN_MS` (at least `CAP_WAIT_MS`) after the core had taken the batch's first completion: the guest was
 * running by then (the core takes completions when a vCPU runs), so its clock ran that long between its last look
 * (before the batch) and this completion, and the check holds even if its work runs late (under load, a restored
 * machine whose vCPUs start late). A drain's last period comes about that late anyway with four periods or more.
 */
function completionBound(untaken?: () => number) {
  /** Bytes completed since the guest's last message. */
  let since = 0;
  /** When the core was first seen to have taken this batch's completions. */
  let takenAt: number | undefined;
  let held = false;
  return {
    /** The guest posted a message: it saw what completed before. */
    posted() {
      [since, takenAt, held] = [0, undefined, false];
    },
    /**
     * A restored machine's stream: its held messages were posted again (`bytes` of them), and completions the old
     * device made may be in the restored RAM, not yet seen by the guest (a snapshot is taken with every completion the
     * core had: audio.md §16). Counted as if the guest had had a whole buffer in flight.
     */
    restored(p: SndParams, bytes: number) {
      [since, takenAt, held] = [Math.max(0, p.bufferBytes - bytes), undefined, false];
    },
    /** A pump at `t`: notes when the core has taken the batch's completions. */
    look(t: number) {
      if (since > 0 && takenAt === undefined && (untaken?.() ?? 0) === 0) takenAt = t;
    },
    /** Whether a message of `bytes` may complete at `t`; true the first time it waits (for the stats). */
    allows(t: number, p: SndParams, bytes: number): [boolean, boolean] {
      if (since === 0 || since + bytes <= p.bufferBytes - p.periodBytes) return [true, false];
      const wait = Math.max(CAP_WAIT_MS, (500 * p.bufferBytes) / (p.channels * SAMPLE_BYTES[p.format] * p.rate) + JIFFY_MARGIN_MS);
      if (takenAt !== undefined && t - takenAt >= wait) {
        [since, takenAt, held] = [0, undefined, false]; // a new batch
        return [true, false];
      }
      const first = !held;
      held = true;
      return [false, first];
    },
    /** A message of `bytes` completed. */
    done(bytes: number) {
      since += bytes;
    },
  };
}

/**
 * The realtime sink (audio.md §3-§5): a message's frames go into the ring (as f32 stereo) as soon as there's
 * room, and the message completes once the ring's read index passed its last frame, with `latency_bytes` the
 * browser's output latency (Linux makes it ALSA's `delay`: what's still to be heard after a period completes,
 * which is what A/V sync reads). The read index is the worklet's while it plays; else this sink's own clock moves
 * it at the stream's rate (a machine without a page, a page whose context waits for a click), so a guest never
 * stalls for want of a listener. Completions are made by `pump`, which runs on a timer or when the worklet notifies
 * (`wake`), never more than a buffer less a period at once (audio.md §12): the rest waits for the guest's next
 * message (`completionBound`, counted across pumps, with `untaken` the core's completions not taken yet). `now` and
 * `schedule: false` are for tests (which call `pump` themselves).
 */
export function ringSink(o: { ring?: SharedArrayBuffer; port?: MessagePort; wake?: SndWake; stats?: boolean; now?: () => number; schedule?: boolean; untaken?: () => number } = {}) {
  const ring = o.ring ?? newRing();
  const { h, data } = ringViews(ring);
  const now = o.now ?? (() => performance.now());
  const post = (m: SndToPage) => o.port?.postMessage(m);
  /** A message: its frames as f32 stereo, how many are in the ring, and the ring position after its last (once all are). */
  type Item = { f32: Float32Array; frames: number; at: number; end?: number; bytes: number; done: (latencyBytes: number) => void };
  let items: Item[] = [];
  let p: SndParams | undefined;
  let running = false;
  /** The own clock: the read index it counts from, and when. */
  let base = { read: 0, t: 0 };
  let ownClock = true;
  /** When the stream started, and the read index then. */
  let startedAt = 0;
  let startRead = 0;
  /** On the own clock, when the ring ran dry: the clock waits for the guest, and that wait is an underrun once sound comes again. */
  let dryFrom: number | undefined;
  let lastQuanta = Atomics.load(h, QUANTA);
  let quantaAt = -Infinity;
  const bound = completionBound(o.untaken);
  // Stats (with `stats`): the second being counted.
  const st = { completions: 0, pumps: 0, busyMs: 0, ownClock: 0, capped: 0, dev: [] as number[], lastDone: -1 };
  let statsAt = now();
  let timer: ReturnType<typeof setInterval> | undefined;
  let waiting = false;

  const frameBytes = () => p!.channels * SAMPLE_BYTES[p!.format];
  /** Writes what fits of the messages not yet in the ring. */
  const fill = () => {
    let w = Atomics.load(h, WRITE) >>> 0;
    let room = CAPACITY - ((w - Atomics.load(h, READ)) >>> 0);
    for (const it of items) {
      if (it.end !== undefined) continue;
      const n = Math.min(room, it.frames - it.at);
      if (n === 0) break;
      const at = w % CAPACITY;
      const first = Math.min(n, CAPACITY - at);
      data.set(it.f32.subarray(2 * it.at, 2 * (it.at + first)), 2 * at);
      if (first < n) data.set(it.f32.subarray(2 * (it.at + first), 2 * (it.at + n)), 0);
      it.at += n;
      w = (w + n) >>> 0;
      room -= n;
      if (it.at === it.frames) it.end = w;
    }
    Atomics.store(h, WRITE, w | 0);
  };
  const pump = () => {
    const t = now();
    const t0 = performance.now();
    if (running && p) {
      const q = Atomics.load(h, QUANTA);
      if (q !== lastQuanta) [lastQuanta, quantaAt] = [q, t];
      const own = t - quantaAt >= LIVE_MS;
      const r = Atomics.load(h, READ);
      const avail = (Atomics.load(h, WRITE) - r) >>> 0;
      if (own) {
        // Taking over from the worklet: from its last quantum (or the start), so its silence since isn't lost time.
        if (!ownClock) base = { read: r >>> 0, t: Math.max(quantaAt, startedAt) };
        else if (avail === 0) {
          // Dry: the clock waits for the guest from where the ring ran out; counted as the worklet counts a gap.
          if (r !== startRead && dryFrom === undefined) dryFrom = Math.min(t, base.t + (((r - base.read) | 0) * 1000) / p.rate);
          base = { read: r >>> 0, t };
        }
        const adv = Math.min(avail, Math.max(0, ((base.read + Math.floor(((t - base.t) * p.rate) / 1000)) - r) | 0));
        if (adv > 0 && Atomics.compareExchange(h, READ, r, (r + adv) | 0) === r && dryFrom !== undefined) {
          Atomics.add(h, UNDERRUNS, 1);
          Atomics.add(h, GAP_FRAMES, Math.round(((base.t - dryFrom) * p.rate) / 1000));
          dryFrom = undefined;
        }
      } else dryFrom = undefined; // the worklet counts its own gaps
      ownClock = own;
      // Completions: what the read index passed, within the bound.
      bound.look(t);
      const read = Atomics.load(h, READ);
      const latency = own ? 0 : Atomics.load(h, LATENCY) * frameBytes();
      while (items.length && items[0].end !== undefined && ((read - items[0].end) | 0) >= 0) {
        const it = items[0];
        const [ok, first] = bound.allows(t, p, it.bytes);
        if (first) st.capped++;
        if (!ok) break;
        items.shift();
        bound.done(it.bytes);
        if (o.stats) {
          st.completions++;
          if (own) st.ownClock++;
          if (st.lastDone >= 0) st.dev.push(Math.abs(t - st.lastDone - (it.frames * 1000) / p.rate));
          st.lastDone = t;
        }
        it.done(latency);
      }
    }
    fill();
    if (o.untaken) Atomics.store(h, UNTAKEN, o.untaken());
    if (o.stats) {
      st.pumps++;
      st.busyMs += performance.now() - t0;
      if (t - statsAt >= 1000) {
        const d = st.dev.sort((a, b) => a - b);
        const pc = (f: number) => (d.length ? +d[Math.min(d.length - 1, Math.floor(f * d.length))].toFixed(2) : 0);
        post({ type: 'stats', stats: { completions: st.completions, jitterP50: pc(0.5), jitterP99: pc(0.99), jitterMax: d.length ? +d[d.length - 1].toFixed(2) : 0, pumps: st.pumps, busyMs: +st.busyMs.toFixed(2), ownClock: st.ownClock, capped: st.capped } });
        Object.assign(st, { completions: 0, pumps: 0, busyMs: 0, ownClock: 0, capped: 0, dev: [] });
        statsAt = t;
      }
    }
  };
  /** Pumps while the stream runs: every PUMP_MS, or at the worklet's notify (PUMP_MS at most apart). */
  const schedule = () => {
    if (o.schedule === false || !running) return;
    if ((o.wake ?? 'worklet') === 'timer') {
      timer ??= setInterval(pump, PUMP_MS);
      return;
    }
    if (waiting) return;
    waiting = true;
    void (async () => {
      while (running) {
        const w = Atomics.waitAsync(h, WAKE, Atomics.load(h, WAKE), PUMP_MS);
        if (w.async) await w.value;
        if (running) pump();
      }
      waiting = false;
    })();
  };
  /** Stops consuming; the time since START if the stream ran. */
  const halt = () => {
    const ms = running ? now() - startedAt : undefined;
    running = false;
    Atomics.store(h, RUN, 0);
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    st.lastDone = -1;
    return ms;
  };
  return {
    ring,
    pump,
    play(params: SndParams, frames: Uint8Array, done: (latencyBytes: number) => void) {
      p = params;
      let f32 = toF32(frames, params.format);
      if (params.channels === 1) {
        const st = new Float32Array(f32.length * 2);
        for (let k = 0; k < f32.length; k++) st[2 * k] = st[2 * k + 1] = f32[k];
        f32 = st;
      }
      items.push({ f32, frames: f32.length / 2, at: 0, bytes: frames.length, done });
      bound.posted();
      fill();
    },
    start(params: SndParams) {
      p = params;
      running = true;
      Atomics.store(h, RATE, params.rate);
      Atomics.add(h, EPOCH, 1);
      Atomics.store(h, RUN, 1);
      ownClock = false; // the next pump on its own clock starts it afresh, from now
      startedAt = now();
      startRead = Atomics.load(h, READ);
      dryFrom = undefined;
      post({ type: 'start', rate: params.rate });
      schedule();
    },
    stop() {
      post({ type: 'stop', ms: halt() });
    },
    release() {
      const ms = halt();
      items = [];
      bound.posted();
      Atomics.store(h, READ, Atomics.load(h, WRITE)); // what the ring held is dropped
      post({ type: 'stop', ms });
    },
    restored: (params: SndParams, bytes: number) => bound.restored(params, bytes),
    save: () => null,
  } satisfies SndSink & Record<string, unknown>;
}

/**
 * Where an input stream's frames come from. `record` asks for `bytes` of frames (a message's room, in the stream's
 * format) and calls `done(data, latencyBytes)` once they're recorded, which completes the message; asks come in
 * order. `start`, `stop`, `release`, `tick`, `save` and `restore` as for a sink.
 */
export type SndSource = {
  record(p: SndParams, bytes: number, done: (data: Uint8Array, latencyBytes: number) => void): void;
  start?(p: SndParams): void;
  stop?(): void;
  release?(): void;
  tick?(): void;
  save?(): unknown;
  restore?(state: unknown): void;
  /** As `SndSink.restored`. */
  restored?(p: SndParams, bytes: number): void;
};

/** A triangle wave of `period` frames between ±12000: integers, so every runner makes the same samples. */
const triangle = (n: number, period: number) => {
  const ph = n % period;
  const step = 48000 / period;
  return ph < period / 2 ? -12000 + step * ph : 36000 - step * ph;
};

/**
 * The deterministic source's waveform from frame `from` on, `bytes` of it in `p`'s format: a 1 kHz triangle on the
 * left (48 frames a cycle) and 1.5 kHz on the right (32), at 48 kHz; a mono stream gets the left. S32 is the S16
 * value shifted up, FLOAT the value over 32768 (exact). core/tests/common/snd.rs makes the same.
 */
export function pattern(p: SndParams, from: number, bytes: number) {
  const out = new Uint8Array(bytes);
  const v = new DataView(out.buffer);
  const size = SAMPLE_BYTES[p.format];
  const frames = bytes / (size * p.channels);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < p.channels; c++) {
      const x = triangle(from + f, c === 0 ? 48 : 32);
      const at = (f * p.channels + c) * size;
      if (p.format === FMT_S16) v.setInt16(at, x, true);
      else if (p.format === FMT_S32) v.setInt32(at, x * 65536, true);
      else v.setFloat32(at, x / 32768, true);
    }
  }
  return out;
}

/** What the deterministic source recorded: frames, bytes, messages, and FNV-1a of the bytes (hex). */
export type Recorded = Played;

/**
 * The deterministic source (tests, native runners): the messages asked for during a DEVICE exit are filled with
 * `pattern` at its end (`tick`), at most a buffer less a period per exit (as `checksumSink`: Linux counts a
 * capture's position in completions modulo the buffer too).
 */
export function patternSource() {
  let rec: Recorded = { frames: 0, bytes: 0, messages: 0, fnv: hex(FNV_OFFSET) };
  let queue: { p: SndParams; bytes: number; done: (data: Uint8Array, latencyBytes: number) => void }[] = [];
  let running = false;
  return {
    recorded: () => ({ ...rec }),
    record(p: SndParams, bytes: number, done: (data: Uint8Array, latencyBytes: number) => void) {
      queue.push({ p, bytes, done });
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
        const { p, bytes, done } = queue[0];
        if (burst > 0 && burst + bytes > p.bufferBytes - p.periodBytes) break;
        queue.shift();
        burst += bytes;
        const data = pattern(p, rec.frames, bytes);
        rec = {
          frames: rec.frames + bytes / (p.channels * SAMPLE_BYTES[p.format]),
          bytes: rec.bytes + bytes,
          messages: rec.messages + 1,
          fnv: hex(fnv1a(data, parseInt(rec.fnv, 16))),
        };
        done(data, 0);
      }
    },
    save: (): Recorded => ({ ...rec }),
    restore(state: unknown) {
      const s = state as Recorded;
      if (!(s && Number.isSafeInteger(s.frames) && Number.isSafeInteger(s.bytes) && Number.isSafeInteger(s.messages) && /^[0-9a-f]{8}$/.test(s.fnv))) throw new Error('the snapshot has no state for the sound device');
      rec = { frames: s.frames, bytes: s.bytes, messages: s.messages, fnv: s.fnv };
    },
  } satisfies SndSource & Record<string, unknown>;
}

/**
 * A realtime source with no microphone: silence at the stream's rate by the clock (`now`), so a guest that records
 * gets its frames in real time. Messages complete once the stream has run long enough to fill them (paused while
 * stopped), and, as `ringSink`, at most a buffer less a period since the guest's last message, the rest after its next
 * one (`completionBound`). `now` and `schedule: false` are for tests.
 */
export function clockSource(o: { now?: () => number; schedule?: boolean; untaken?: () => number } = {}) {
  const now = o.now ?? (() => performance.now());
  let items: { bytes: number; frames: number; done: (data: Uint8Array, latencyBytes: number) => void }[] = [];
  let p: SndParams | undefined;
  let running = false;
  /** Frames the stream has run for before its last START, and when that was. */
  let before = 0;
  let startedAt = 0;
  /** Frames given to messages so far. */
  let given = 0;
  const bound = completionBound(o.untaken);
  let timer: ReturnType<typeof setInterval> | undefined;
  const ran = (t: number) => before + (running ? Math.floor(((t - startedAt) * p!.rate) / 1000) : 0);
  const pump = () => {
    if (!running || !p) return;
    const t = now();
    bound.look(t);
    while (items.length && given + items[0].frames <= ran(t)) {
      const it = items[0];
      if (!bound.allows(t, p, it.bytes)[0]) break;
      items.shift();
      given += it.frames;
      bound.done(it.bytes);
      it.done(new Uint8Array(it.bytes), 0);
    }
  };
  const halt = () => {
    if (running) before = ran(now());
    running = false;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  return {
    pump,
    record(params: SndParams, bytes: number, done: (data: Uint8Array, latencyBytes: number) => void) {
      p = params;
      items.push({ bytes, frames: bytes / (params.channels * SAMPLE_BYTES[params.format]), done });
      bound.posted();
    },
    start(params: SndParams) {
      p = params;
      running = true;
      startedAt = now();
      if (o.schedule !== false) timer ??= setInterval(pump, PUMP_MS);
    },
    stop: halt,
    restored: (params: SndParams, bytes: number) => bound.restored(params, bytes),
    release() {
      halt();
      items = [];
      [before, given] = [0, 0];
      bound.posted();
    },
  } satisfies SndSource & Record<string, unknown>;
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

/** What a control request does to a stream's messages: nothing, run them (START), pause (STOP), return them (RELEASE). */
export type Effect = 'none' | 'start' | 'stop' | 'release';

/**
 * The device's protocol without the queues: control requests answered, I/O messages checked, each stream's
 * state machine (virtio 1.2 §5.14.6.6.1; a request out of its order is BAD_MSG).
 */
export class Snd {
  streams: Stream[] = Array.from({ length: STREAMS }, () => ({ state: 'none' }));
  /** The control requests and their statuses, in order (the first LOG_MAX): what the guest tests and the oracle comparison read. A stream other than 0 is named (`#1`). */
  log: string[] = [];

  /** The output stream's state and parameters. */
  get state() { return this.streams[OUT].state; }
  get params() { return this.streams[OUT].params; }

  reset() {
    for (const st of this.streams) [st.state, st.params] = ['none', undefined];
  }

  /** A control request's reply (`room` bytes are writable: an info query's items must fit), what it does to the messages, and to which stream's. */
  control(cmd: Uint8Array, room: number): { reply: Uint8Array; effect: Effect; stream: number } {
    const [reply, effect, detail, stream] = this.answer(cmd, room);
    if (this.log.length < LOG_MAX && cmd.length >= 4) {
      const code = u32(cmd, 0);
      this.log.push(`${NAMES[code] ?? `0x${code.toString(16)}`}${stream > 0 ? `#${stream}` : ''}${detail} ${STATUS_NAMES[u32(reply, 0)]}`);
    }
    return { reply, effect, stream };
  }

  private answer(cmd: Uint8Array, room: number): [Uint8Array, Effect, string, number] {
    if (cmd.length < 4) return [status(S_BAD_MSG), 'none', '', 0];
    const code = u32(cmd, 0);
    switch (code) {
      case R_JACK_INFO: case R_CHMAP_INFO: case R_PCM_INFO: {
        // virtio_snd_query_info: start_id, count, size. No jacks or channel maps.
        if (cmd.length < 16) return [status(S_BAD_MSG), 'none', '', 0];
        const [start, count, size] = [u32(cmd, 4), u32(cmd, 8), u32(cmd, 12)];
        const n = code === R_PCM_INFO ? STREAMS : 0;
        const detail = ` ${start}+${count}`;
        if (start > n || count > n - start || (count > 0 && (size < PCM_INFO_SIZE || 4 + count * size > room))) return [status(S_BAD_MSG), 'none', detail, 0];
        const r = status(S_OK, count * size);
        const v = new DataView(r.buffer);
        for (let k = 0; k < count; k++) {
          // virtio_snd_pcm_info: hda_fn_nid 0, features 0, formats (u64), rates (u64), direction, channels_min, channels_max.
          const at = 4 + k * size;
          v.setUint32(at + 8, 1 << FMT_S16 | 1 << FMT_S32 | 1 << FMT_FLOAT, true); // the u64s' high words stay 0
          v.setUint32(at + 16, RATE_BITS, true);
          r[at + 24] = start + k === IN ? 1 : 0; // VIRTIO_SND_D_INPUT, VIRTIO_SND_D_OUTPUT
          r[at + 25] = 1;
          r[at + 26] = CHANNELS_MAX;
        }
        return [r, 'none', detail, 0];
      }
      case R_JACK_REMAP: return [status(S_BAD_MSG), 'none', '', 0]; // no jack to remap
      case R_PCM_SET_PARAMS: case R_PCM_PREPARE: case R_PCM_RELEASE: case R_PCM_START: case R_PCM_STOP: {
        if (cmd.length < (code === R_PCM_SET_PARAMS ? 24 : 8) || u32(cmd, 4) >= STREAMS) return [status(S_BAD_MSG), 'none', '', 0];
        const sid = u32(cmd, 4);
        const st = this.streams[sid];
        const s = st.state;
        const to = (ok: boolean, next: State, effect: Effect = 'none'): [Uint8Array, Effect, string, number] => {
          if (!ok) return [status(S_BAD_MSG), 'none', '', sid];
          st.state = next;
          return [status(S_OK), effect, '', sid];
        };
        if (code === R_PCM_SET_PARAMS) {
          // virtio_snd_pcm_set_params: buffer_bytes, period_bytes, features, channels, format, rate.
          const p: SndParams = { bufferBytes: u32(cmd, 8), periodBytes: u32(cmd, 12), channels: cmd[20], format: cmd[21], rate: RATES[cmd[22]] ?? 0 };
          const detail = ` ${p.channels}ch ${FORMAT_NAMES[p.format] ?? `fmt${cmd[21]}`} ${p.rate || `rate${cmd[22]}`} ${p.bufferBytes}/${p.periodBytes}`;
          if (!(s === 'none' || s === 'params' || s === 'prepared' || s === 'released')) return [status(S_BAD_MSG), 'none', detail, sid];
          if (u32(cmd, 16) !== 0 || !SAMPLE_BYTES[p.format] || cmd[22] > 31 || !(RATE_BITS >> cmd[22] & 1) || p.channels < 1 || p.channels > CHANNELS_MAX) return [status(S_NOT_SUPP), 'none', detail, sid];
          const frame = p.channels * SAMPLE_BYTES[p.format];
          if (p.periodBytes === 0 || p.periodBytes % frame !== 0 || p.bufferBytes === 0 || p.bufferBytes % p.periodBytes !== 0) return [status(S_BAD_MSG), 'none', detail, sid];
          [st.params, st.state] = [p, 'params'];
          return [status(S_OK), 'none', detail, sid];
        }
        if (code === R_PCM_PREPARE) return to(s === 'params' || s === 'prepared' || s === 'released', 'prepared');
        if (code === R_PCM_START) return to(s === 'prepared' || s === 'stopped', 'started', 'start');
        if (code === R_PCM_STOP) return to(s === 'started', 'stopped', 'stop');
        return to(s === 'prepared' || s === 'stopped', 'released', 'release');
      }
      default: return [status(S_NOT_SUPP), 'none', '', 0];
    }
  }

  /**
   * What to do with an I/O message on stream `sid` (the output's on txq, the input's on rxq; `head`: its first
   * readable bytes, the stream id; `frameBytes`: the bytes of frames it carries or has room for): run it
   * (started), hold it (prepared or stopped), or answer with a status.
   */
  io(sid: number, head: Uint8Array, frameBytes: number): 'run' | 'hold' | number {
    if (head.length < 4 || u32(head, 0) !== sid) return S_BAD_MSG;
    const { state, params } = this.streams[sid];
    if (!params || frameBytes < 0 || (sid === IN && frameBytes === 0) || frameBytes % (params.channels * SAMPLE_BYTES[params.format]) !== 0) return S_BAD_MSG;
    return state === 'started' ? 'run' : state === 'prepared' || state === 'stopped' ? 'hold' : S_BAD_MSG;
  }

  save() {
    return { streams: this.streams.map((st) => ({ state: st.state, params: st.params ?? null })), log: [...this.log] };
  }

  /** A saved state; one from before the input stream (`state`, `params` of the output) still loads. */
  restore(state: unknown) {
    const old = state as { state?: State; params?: SndParams | null; streams?: { state: State; params: SndParams | null }[]; log: unknown[] };
    const streams = old?.streams ?? (old?.state ? [{ state: old.state, params: old.params ?? null }] : undefined);
    if (!streams || streams.length > STREAMS || !Array.isArray(old.log) || streams.some((st) => !STATES.includes(st.state) || (st.state !== 'none' && !st.params))) throw new Error('the snapshot has no state for the sound device');
    this.streams = Array.from({ length: STREAMS }, (_, k) => ({ state: streams[k]?.state ?? 'none', params: streams[k]?.params ?? undefined }));
    this.log = old.log.map(String);
  }
}

/** A sound device's state (`Backend.save`): the streams, the control requests taken, what the sink played (the deterministic sink's `Played`) and what the source recorded (`Recorded`). */
export type SndState = ReturnType<Snd['save']> & { sink: unknown; source?: unknown };

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
 * The backend over the queues: control requests answered at once; event buffers held (no events yet). Output
 * messages (txq) are held until their stream's START, then given to `sink`; input messages (rxq) likewise to
 * `source`, which fills them; both are returned at RELEASE (STOP pauses: Linux sends it for a pause too, and
 * resumes with START without posting the held messages again).
 */
export function sndBackend(ctx: Ctx, sink: SndSink = checksumSink(), source: SndSource = patternSource()) {
  const snd = new Snd();
  /** I/O messages not completed, per stream: waiting for START, or given to the sink or source and not done yet. */
  type Msg = { r: Request; live: boolean };
  const waiting: Msg[][] = [[], []];
  const running: Msg[][] = [[], []];
  const events: Request[] = [];
  const room = (r: Request) => r.write.reduce((n, s) => n + s.len, 0);
  /** Completes a message with a `virtio_snd_pcm_status` (status, latency_bytes) in its last writable bytes, after `data` (a capture's frames). */
  const finish = (r: Request, st: number, latency = 0, data?: Uint8Array) => {
    if (room(r) < 8) return ctx.complete(r.w0, 0); // no room for a status: nothing to say
    if (data) scatter(ctx.ram(), r.write, data);
    const b = new Uint8Array(8);
    new DataView(b.buffer).setUint32(0, st, true);
    new DataView(b.buffer).setUint32(4, latency, true);
    writeTail(ctx.ram(), r.write, b);
    ctx.complete(r.w0, (data?.length ?? 0) + 8);
  };
  const done = (sid: number, m: Msg) => {
    if (!m.live) return false;
    m.live = false;
    running[sid] = running[sid].filter((x) => x !== m);
    return true;
  };
  const run = (sid: number, m: Msg) => {
    running[sid].push(m);
    const p = snd.streams[sid].params!;
    if (reposted) reposted[sid] += sid === OUT ? m.r.read.reduce((n, s) => n + s.len, 0) - 4 : room(m.r) - 8;
    if (sid === OUT) {
      const len = m.r.read.reduce((n, s) => n + s.len, 0);
      sink.play(p, gather(ctx.ram(), m.r.read, len).subarray(4), (latency) => { if (done(sid, m)) finish(m.r, S_OK, latency); });
    } else {
      source.record(p, room(m.r) - 8, (data, latency) => { if (done(sid, m)) finish(m.r, S_OK, latency, data); });
    }
  };
  const drop = (sid: number) => {
    const back = [...running[sid], ...waiting[sid]];
    for (const m of back) m.live = false;
    [running[sid], waiting[sid]] = [[], []];
    return back;
  };
  const side = (sid: number) => (sid === OUT ? sink : source);
  /** After a restore, until its first poll ends: the bytes of held messages given again to the sink and the source. */
  let reposted: number[] | undefined;
  return {
    snd,
    sink,
    source,
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
        const { reply, effect, stream: sid } = snd.control(gather(ram, r.read, len), w);
        scatter(ram, r.write, reply);
        // The reply first: the stream's messages complete after the request that started or released it.
        ctx.complete(r.w0, reply.length);
        if (effect === 'start') {
          side(sid).start?.(snd.streams[sid].params!);
          const now = waiting[sid];
          waiting[sid] = [];
          for (const m of now) run(sid, m);
        } else if (effect === 'stop') {
          side(sid).stop?.();
        } else if (effect === 'release') {
          const back = drop(sid);
          side(sid).release?.();
          for (const m of back) finish(m.r, S_OK);
        }
        return undefined;
      }
      if (r.queue === TXQ || r.queue === RXQ) {
        const sid = r.queue === TXQ ? OUT : IN;
        const verdict = snd.io(sid, gather(ram, r.read, 4), sid === OUT ? len - 4 : room(r) - 8);
        if (verdict === 'run') run(sid, { r, live: true });
        else if (verdict === 'hold') waiting[sid].push({ r, live: true });
        else finish(r, verdict);
      }
      return undefined;
    },
    /** The end of a DEVICE exit's requests. */
    polled() {
      if (reposted) {
        // The restore's chains were posted again in this poll (web/vm.ts serves the doorbell once after a restore).
        for (const sid of [OUT, IN]) if (snd.streams[sid].state === 'started') side(sid).restored?.(snd.streams[sid].params!, reposted[sid]);
        reposted = undefined;
      }
      sink.tick?.();
      source.tick?.();
    },
    reset() {
      drop(OUT);
      drop(IN);
      events.length = 0;
      snd.reset();
      sink.release?.();
      source.release?.();
    },
    save: (): SndState => ({ ...snd.save(), sink: sink.save?.() ?? null, source: source.save?.() ?? null }),
    restore(state: unknown) {
      snd.restore(state);
      const s = state as { sink?: unknown; source?: unknown };
      if (s.sink !== null && s.sink !== undefined) sink.restore?.(s.sink);
      if (s.source !== null && s.source !== undefined) source.restore?.(s.source);
      if (snd.streams[OUT].state === 'started') sink.start?.(snd.streams[OUT].params!);
      if (snd.streams[IN].state === 'started') source.start?.(snd.streams[IN].params!);
      reposted = [0, 0];
    },
  };
}
