// virtio-snd's deterministic ends (web/snd.ts; docs/audio.md): the sink that hashes what it plays and the source that
// records a known waveform, each completing its messages at the end of the DEVICE exit that posted them (so boots
// keep exact step counts). core/tests/common/snd.rs makes the same.
import { FMT_S16, FMT_S32, SAMPLE_BYTES, type SndParams, type SndSink, type SndSource } from './snd-proto.ts';

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
 * exactly that: docs/audio.md "Linux driver behavior"); what's left completes at the next exit, which the guest makes as soon as it
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
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      return out;
    },
    play(p: SndParams, frames: Uint8Array, done: (latencyBytes: number) => void) {
      queue.push({ p, frames: frames.slice(), done });
    },
    start() {
      running = true;
    },
    stop() {
      running = false;
    },
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
      const s = state as Played | null;
      if (!(
        s &&
        Number.isSafeInteger(s.frames) &&
        Number.isSafeInteger(s.bytes) &&
        Number.isSafeInteger(s.messages) &&
        /^[0-9a-f]{8}$/.test(s.fnv)
      ))
        throw new Error('the snapshot has no state for the sound device');
      played = { frames: s.frames, bytes: s.bytes, messages: s.messages, fnv: s.fnv };
    },
  } satisfies SndSink & Record<string, unknown>;
}

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
    start() {
      running = true;
    },
    stop() {
      running = false;
    },
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
      const s = state as Recorded | null;
      if (!(
        s &&
        Number.isSafeInteger(s.frames) &&
        Number.isSafeInteger(s.bytes) &&
        Number.isSafeInteger(s.messages) &&
        /^[0-9a-f]{8}$/.test(s.fnv)
      ))
        throw new Error('the snapshot has no state for the sound device');
      rec = { frames: s.frames, bytes: s.bytes, messages: s.messages, fnv: s.fnv };
    },
  } satisfies SndSource & Record<string, unknown>;
}
