// virtio-snd's realtime ends (web/snd.ts; docs/audio.md "How it fits together"): the sink that writes into the page's
// ring (web/audio-ring.ts) and completes once the AudioWorklet played, the source that fills from the microphone's
// ring, the bound on their completions (`completionBound`), the sample conversions, and what they say on the page's
// port.
import {
  CAPACITY,
  EPOCH,
  GAP_FRAMES,
  LATENCY,
  QUANTA,
  RATE,
  READ,
  RUN,
  UNDERRUNS,
  UNTAKEN,
  WAKE,
  WRITE,
  newRing,
  ringViews,
} from './audio-ring.ts';
import {
  FMT_FLOAT,
  FMT_S16,
  FMT_S32,
  SAMPLE_BYTES,
  type SndMixer,
  type SndParams,
  type SndSink,
  type SndSource,
} from './snd-proto.ts';

/** Samples of `frames` (raw, in `format`) as f32 in [-1, 1], interleaved as they come. */
export function toF32(
  frames: Uint8Array,
  format: number,
  out = new Float32Array(frames.length / SAMPLE_BYTES[format]),
) {
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
  /** The input stream started (the page opens the microphone at `rate`) or stopped (it closes it). */
  | { type: 'capture-start'; rate: number }
  | { type: 'capture-stop' }
  /** `ms`: the time since the stream's START (a stream that ran: what the ring paced, the gaps included). */
  | { type: 'stop'; ms?: number }
  /** Once a second with `stats`: the completions' timing (docs/audio.md "Measurements"). */
  | { type: 'stats'; stats: SndStats }
  /** The guest set its Master volume or switch (or a snapshot was loaded): the page's menu follows. */
  | ({ type: 'mixer' } & SndMixer);
/** What the device hears from the page on the same port: the Sound menu changed (the guest is told). */
export type SndFromPage = { type: 'mixer' } & SndMixer;
/**
 * A second of a realtime sink: messages completed, the spread of the intervals between completions around a
 * period's length (ms: percentiles of |interval − period|), the pumps run, the ms they took, and how many of those
 * seconds' completions were on its own clock (no worklet playing).
 */
export type SndStats = {
  completions: number;
  jitterP50: number;
  jitterP99: number;
  jitterMax: number;
  pumps: number;
  busyMs: number;
  ownClock: number;
  capped: number;
};

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
 * The bound on a realtime stream's completions (docs/audio.md "Linux driver behavior"): at most a buffer less a period since the
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
     * core had: docs/audio.md "Linux driver behavior"). Counted as if the guest had had a whole buffer in flight.
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
      const wait = Math.max(
        CAP_WAIT_MS,
        (500 * p.bufferBytes) / (p.channels * SAMPLE_BYTES[p.format] * p.rate) + JIFFY_MARGIN_MS,
      );
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
 * The realtime sink (docs/audio.md "How it fits together"): a message's frames go into the ring (as f32 stereo) as soon as there's
 * room, and the message completes once the ring's read index passed its last frame, with `latency_bytes` the
 * browser's output latency (Linux makes it ALSA's `delay`: what's still to be heard after a period completes,
 * which is what A/V sync reads). The read index is the worklet's while it plays; else this sink's own clock moves
 * it at the stream's rate (a machine without a page, a page whose context waits for a click), so a guest never
 * stalls for want of a listener. Completions are made by `pump`, which runs on a timer or when the worklet notifies
 * (`wake`), never more than a buffer less a period at once (docs/audio.md "Linux driver behavior"): the rest waits for the guest's next
 * message (`completionBound`, counted across pumps, with `untaken` the core's completions not taken yet). `now` and
 * `schedule: false` are for tests (which call `pump` themselves).
 */
export function ringSink(
  o: {
    ring?: SharedArrayBuffer;
    port?: MessagePort;
    wake?: SndWake;
    stats?: boolean;
    now?: () => number;
    schedule?: boolean;
    untaken?: () => number;
  } = {},
) {
  const ring = o.ring ?? newRing();
  const { h, data } = ringViews(ring);
  const now = o.now ?? (() => performance.now());
  const post = (m: SndToPage) => o.port?.postMessage(m);
  /** A message: its frames as f32 stereo, how many are in the ring, and the ring position after its last (once all are). */
  type Item = {
    f32: Float32Array;
    frames: number;
    at: number;
    end?: number;
    bytes: number;
    done: (latencyBytes: number) => void;
  };
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
          if (r !== startRead && dryFrom === undefined)
            dryFrom = Math.min(t, base.t + (((r - base.read) | 0) * 1000) / p.rate);
          base = { read: r >>> 0, t };
        }
        const adv = Math.min(avail, Math.max(0, (base.read + Math.floor(((t - base.t) * p.rate) / 1000) - r) | 0));
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
        post({
          type: 'stats',
          stats: {
            completions: st.completions,
            jitterP50: pc(0.5),
            jitterP99: pc(0.99),
            jitterMax: d.length ? +d[d.length - 1].toFixed(2) : 0,
            pumps: st.pumps,
            busyMs: +st.busyMs.toFixed(2),
            ownClock: st.ownClock,
            capped: st.capped,
          },
        });
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
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stop() clears it while the loop waits
      while (running) {
        const w = Atomics.waitAsync(h, WAKE, Atomics.load(h, WAKE), PUMP_MS);
        if (w.async) await w.value;
        if (running) pump(); // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- as above
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

/** Interleaved stereo f32 frames as `p`'s frames (a mono stream gets their mean), clamped to the format's range. */
export function fromF32(f32: Float32Array, p: SndParams) {
  const frames = f32.length / 2;
  const size = SAMPLE_BYTES[p.format];
  const out = new Uint8Array(frames * p.channels * size);
  const v = new DataView(out.buffer);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < p.channels; c++) {
      const x = Math.max(-1, Math.min(1, p.channels === 1 ? (f32[2 * f] + f32[2 * f + 1]) / 2 : f32[2 * f + c]));
      const at = (f * p.channels + c) * size;
      if (p.format === FMT_S16) v.setInt16(at, Math.round(x * 32767), true);
      else if (p.format === FMT_S32) v.setInt32(at, Math.round(x * 2147483647), true);
      else v.setFloat32(at, x, true);
    }
  }
  return out;
}

/**
 * The realtime source with the page's microphone (audio S4, docs/audio.md "How it fits together"): while the page's `waarm64-mic` worklet
 * fills the microphone's ring (its heartbeat moved in the last `LIVE_MS`), a message completes once the ring has its
 * frames, at most a buffer behind (older frames are skipped: latency, not a backlog, after a stall); otherwise (no
 * page, no permission yet or refused, the microphone turned off) silence at the stream's rate by the clock (paused
 * while stopped), the clock starting afresh at each switch and START so neither side makes a burst. Both under `completionBound`.
 * START and its stop are said on `port` (the page opens and closes the microphone). `now` and `schedule: false` are
 * for tests.
 */
export function micSource(
  o: {
    ring?: SharedArrayBuffer;
    port?: MessagePort;
    now?: () => number;
    schedule?: boolean;
    untaken?: () => number;
  } = {},
) {
  const ring = o.ring ?? newRing();
  const { h, data } = ringViews(ring);
  const now = o.now ?? (() => performance.now());
  const post = (m: SndToPage) => o.port?.postMessage(m);
  let items: { bytes: number; frames: number; done: (data: Uint8Array, latencyBytes: number) => void }[] = [];
  let p: SndParams | undefined;
  let running = false;
  /** The own clock: frames it had counted before `startedAt`, and those given to messages since START. */
  let before = 0;
  let startedAt = 0;
  let given = 0;
  let live = false;
  let lastQuanta = Atomics.load(h, QUANTA);
  let quantaAt = -Infinity;
  const bound = completionBound(o.untaken);
  let timer: ReturnType<typeof setInterval> | undefined;
  const ran = (t: number) => before + Math.floor(((t - startedAt) * p!.rate) / 1000);
  const pump = () => {
    if (!running || !p) return;
    const t = now();
    const q = Atomics.load(h, QUANTA);
    if (q !== lastQuanta) [lastQuanta, quantaAt] = [q, t];
    const nowLive = t - quantaAt < LIVE_MS;
    if (nowLive !== live) {
      [live, before, startedAt] = [nowLive, given, t]; // the clock goes on from what was given, from now
      if (live) Atomics.store(h, READ, Atomics.load(h, WRITE)); // what the ring held from before is stale
    }
    bound.look(t);
    const bufferFrames = p.bufferBytes / (p.channels * SAMPLE_BYTES[p.format]);
    if (live) {
      const w = Atomics.load(h, WRITE);
      let r = Atomics.load(h, READ);
      const behind = (w - r) >>> 0;
      if (behind > bufferFrames) r = (w - bufferFrames) | 0; // at most a buffer behind
      while (items.length && (w - r) >>> 0 >= items[0].frames) {
        const it = items[0];
        if (!bound.allows(t, p, it.bytes)[0]) break;
        items.shift();
        const f32 = new Float32Array(2 * it.frames);
        const at = (r >>> 0) % CAPACITY;
        const first = Math.min(it.frames, CAPACITY - at);
        f32.set(data.subarray(2 * at, 2 * (at + first)));
        if (first < it.frames) f32.set(data.subarray(0, 2 * (it.frames - first)), 2 * first);
        r = (r + it.frames) | 0;
        given += it.frames;
        bound.done(it.bytes);
        it.done(fromF32(f32, p), 0);
      }
      Atomics.store(h, READ, r);
    } else {
      while (items.length && given + items[0].frames <= ran(t)) {
        const it = items[0];
        if (!bound.allows(t, p, it.bytes)[0]) break;
        items.shift();
        given += it.frames;
        bound.done(it.bytes);
        it.done(new Uint8Array(it.bytes), 0);
      }
    }
  };
  const halt = () => {
    if (running) post({ type: 'capture-stop' });
    running = false;
    Atomics.store(h, RUN, 0);
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  return {
    ring,
    pump,
    record(params: SndParams, bytes: number, done: (data: Uint8Array, latencyBytes: number) => void) {
      p = params;
      items.push({ bytes, frames: bytes / (params.channels * SAMPLE_BYTES[params.format]), done });
      bound.posted();
    },
    start(params: SndParams) {
      p = params;
      running = true;
      [before, startedAt, live] = [given, now(), false];
      Atomics.store(h, RATE, params.rate);
      Atomics.store(h, RUN, 1);
      post({ type: 'capture-start', rate: params.rate });
      if (o.schedule !== false) timer ??= setInterval(pump, PUMP_MS);
    },
    stop: halt,
    restored: (params: SndParams, bytes: number) => bound.restored(params, bytes),
    release() {
      halt();
      items = [];
      [before, given] = [0, 0];
      Atomics.store(h, READ, Atomics.load(h, WRITE));
      bound.posted();
    },
  } satisfies SndSource & Record<string, unknown>;
}
