// The page's AudioWorklets (docs/audio.md "How it fits together"): `waarm64-snd` plays the sound ring (web/audio-ring.ts) that the device
// worker's virtio-snd writes. Each render quantum (128 frames) it copies what the ring has, up to a quantum, and
// moves the read index (compare-and-exchange: the device worker's own clock may move it too, around a hand-over),
// plays silence for what's missing, and counts a gap in a started stream's sound as an underrun when the sound
// comes back (so a stream's end isn't one). It plays only while the stream runs (`RUN`) and its context runs at the
// stream's rate (`RATE`: the page makes a context per rate); only then does its heartbeat (`QUANTA`) move, which
// is what tells the device worker that the read index is the worklet's. Nothing is allocated in `process`.
import { CAPACITY, DROPPED, DROPS, EPOCH, GAP_FRAMES, QUANTA, RATE, READ, RUN, UNDERRUNS, WAKE, WAKE_QUANTA, WRITE, ringViews } from './audio-ring.ts';

// The AudioWorkletGlobalScope's names (not in the DOM's lib).
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  constructor(options?: { processorOptions?: unknown });
}

const QUANTUM = 128;

class SndProcessor extends AudioWorkletProcessor {
  private h: Int32Array;
  private data: Float32Array;
  private epoch = -1;
  /** Sound was played since the stream started: a dry ring from here is a gap. */
  private played = false;
  /** In a gap: the frames of silence played so far. */
  private gap = 0;
  private dry = false;
  private quanta = 0;

  constructor(options: { processorOptions: { ring: SharedArrayBuffer } }) {
    super();
    ({ h: this.h, data: this.data } = ringViews(options.processorOptions.ring));
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const [left, right] = outputs[0];
    const h = this.h;
    if (!Atomics.load(h, RUN) || Atomics.load(h, RATE) !== sampleRate) {
      left.fill(0);
      right?.fill(0);
      return true;
    }
    const epoch = Atomics.load(h, EPOCH);
    if (epoch !== this.epoch) [this.epoch, this.played, this.dry, this.gap] = [epoch, false, false, 0];
    const r = Atomics.load(h, READ);
    let n = Math.min(QUANTUM, (Atomics.load(h, WRITE) - r) >>> 0);
    if (n > 0) {
      const at = (r >>> 0) % CAPACITY;
      for (let k = 0; k < n; k++) {
        const i = 2 * ((at + k) % CAPACITY);
        left[k] = this.data[i];
        if (right) right[k] = this.data[i + 1];
      }
      // Lost to the device worker's clock (a hand-over): this quantum is silence.
      if (Atomics.compareExchange(h, READ, r, (r + n) | 0) !== r) n = 0;
    }
    left.fill(0, n);
    right?.fill(0, n);
    if (n > 0 && this.dry) {
      Atomics.add(h, UNDERRUNS, 1);
      Atomics.add(h, GAP_FRAMES, this.gap);
      [this.dry, this.gap] = [false, 0];
    }
    if (n < QUANTUM && (this.played || this.dry)) {
      this.dry = true;
      this.gap += QUANTUM - n;
    }
    if (n > 0) this.played = true;
    Atomics.add(h, QUANTA, 1);
    if (++this.quanta % WAKE_QUANTA === 0) {
      Atomics.add(h, WAKE, 1);
      Atomics.notify(h, WAKE);
    }
    return true;
  }
}

registerProcessor('waarm64-snd', SndProcessor);

/**
 * The microphone's worklet (audio S4): writes its input (a MediaStreamAudioSourceNode's, mono to both channels) into the
 * microphone's ring while the device worker asks for it (`RUN`, at the context's rate), each quantum moving its
 * heartbeat; what doesn't fit is dropped and counted. Nothing is allocated in `process`.
 */
class MicProcessor extends AudioWorkletProcessor {
  private h: Int32Array;
  private data: Float32Array;

  constructor(options: { processorOptions: { ring: SharedArrayBuffer } }) {
    super();
    ({ h: this.h, data: this.data } = ringViews(options.processorOptions.ring));
  }

  process(inputs: Float32Array[][]) {
    const h = this.h;
    const left = inputs[0]?.[0];
    if (!left || !Atomics.load(h, RUN) || Atomics.load(h, RATE) !== sampleRate) return true;
    const right = inputs[0][1] ?? left;
    const w = Atomics.load(h, WRITE);
    const n = Math.min(left.length, CAPACITY - ((w - Atomics.load(h, READ)) >>> 0));
    const at = (w >>> 0) % CAPACITY;
    for (let k = 0; k < n; k++) {
      const i = 2 * ((at + k) % CAPACITY);
      this.data[i] = left[k];
      this.data[i + 1] = right[k];
    }
    Atomics.store(h, WRITE, (w + n) | 0);
    if (n < left.length) {
      Atomics.add(h, DROPS, 1);
      Atomics.add(h, DROPPED, left.length - n);
    }
    Atomics.add(h, QUANTA, 1);
    return true;
  }
}

registerProcessor('waarm64-mic', MicProcessor);
