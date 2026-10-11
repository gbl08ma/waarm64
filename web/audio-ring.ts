// The sound ring (docs/plans/audio.md §4, docs/devices.md "snd"): a SharedArrayBuffer that the device worker writes
// a playback stream's frames into and the page's AudioWorklet (web/audio-worklet.ts) plays out of. A
// single-producer, single-consumer ring of interleaved stereo f32 frames (a mono stream is written to both
// channels) behind a header of i32 words, read and written with Atomics only. The indices count frames and wrap
// at 2^32: `(write - read) >>> 0` is what's queued.
//
// The microphone's ring (audio S4) is the same the other way round: the page's `webpc-mic` worklet writes what the
// microphone hears (WRITE, its QUANTA heartbeat) while the device worker asks for it (RUN, at RATE), and the device
// worker's source reads it (READ); frames the ring had no room for are counted in UNDERRUNS (times) and GAP_FRAMES.
//
// Who moves the read index: the worklet while it plays (its `QUANTA` heartbeat moves and its context runs at the
// stream's rate); else the device worker itself, at the stream's rate by the wall clock (no page, a context not
// resumed yet). Both move it by compare-and-exchange, so a hand-over can't move it backwards or past `WRITE`.

/** Frames the ring holds (a power of 2): 1.37 s at 48 kHz, more than a guest's buffer at the rates guests use. */
export const CAPACITY = 1 << 16;

/** Header words. */
/** Frames written (the device worker's). */
export const WRITE = 0;
/** Frames consumed (the worklet's, or the device worker's own clock's). */
export const READ = 1;
/** 1 while the stream is started: the worklet consumes only then (0: stopped, paused or released; it plays silence). */
export const RUN = 2;
/** The worklet's heartbeat: +1 per render quantum it played the ring in (128 frames at the stream's rate). */
export const QUANTA = 3;
/** Underruns: gaps in a started stream's sound (the ring ran dry, then frames came again), counted when they end. */
export const UNDERRUNS = 4;
/** The frames of silence those gaps played. */
export const GAP_FRAMES = 5;
/** The browser's output latency in frames (the page's: `baseLatency + outputLatency`), reported to the guest as `latency_bytes`. */
export const LATENCY = 6;
/** The stream's rate (the device worker's): the worklet plays only if its context runs at it. */
export const RATE = 7;
/** Bumped by the device worker at each START: the worklet's "played since the start" (what makes a dry ring a gap) resets. */
export const EPOCH = 8;
/** Bumped and notified by the worklet every `WAKE_QUANTA` quanta: what the device worker can wait on instead of a timer. */
export const WAKE = 9;
/** The device worker's: completions it gave that the core hasn't taken yet, at its last pump (a diagnostic: the core takes them when a vCPU runs). */
export const UNTAKEN = 10;
const HEADER_WORDS = 16;
const HEADER_BYTES = HEADER_WORDS * 4;

/** The worklet wakes the device worker every this many quanta (~5 ms at 48 kHz). */
export const WAKE_QUANTA = 2;

/** A new ring: the header, then `CAPACITY` stereo frames. */
export const newRing = () => new SharedArrayBuffer(HEADER_BYTES + CAPACITY * 2 * 4);

/** The header's words and the frames of `ring`. */
export const ringViews = (ring: SharedArrayBuffer) => ({ h: new Int32Array(ring, 0, HEADER_WORDS), data: new Float32Array(ring, HEADER_BYTES, CAPACITY * 2) });

/** The microphone's ring: times, and frames, the worklet had no room for (the device worker didn't read in time). */
export const DROPS = UNDERRUNS;
export const DROPPED = GAP_FRAMES;

/** Frames queued: written and not consumed. */
export const queued = (h: Int32Array) => (Atomics.load(h, WRITE) - Atomics.load(h, READ)) >>> 0;
