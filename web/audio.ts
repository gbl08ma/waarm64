// The page's sound (docs/plans/audio.md §4, docs/frontend.md "Sound"): the AudioContext, the worklet that plays
// the machine's sound ring (web/audio-worklet.ts, web/audio-ring.ts) and the volume. Each machine start gets a new
// ring and a port (`attach`), which go to the device worker's virtio-snd (web/snd.ts `ringSink`); the device says
// on the port when its stream starts (and at what rate) and stops. The context is made at the stream's rate, so the
// browser does the resampling to the output device's; a new rate makes a new context. A context made before the
// page had a user gesture starts suspended (the browser's autoplay rule): `gesture` resumes it, and until then the
// device worker plays the ring on its own clock, so the guest doesn't stall. The data never crosses this thread.
import { LATENCY, newRing, ringViews } from './audio-ring.ts';
import type { SndStats, SndToPage } from './snd.ts';

const WORKLET = new URL('./audio-worklet.ts', import.meta.url);

export class PageAudio {
  private ctx?: AudioContext;
  private node?: AudioWorkletNode;
  private gain?: GainNode;
  private ring?: SharedArrayBuffer;
  private port?: MessagePort;
  /** Context changes, one at a time. */
  private chain = Promise.resolve();
  private latencyTimer?: ReturnType<typeof setInterval>;
  private muted = false;
  private volume = 1;
  /** A stream is started on the current ring. */
  playing = false;
  /** The device's stats (`stats` on its spec), latest last, for measurements. */
  stats: SndStats[] = [];
  /** How long each stream ran, START to its stop (ms, the device worker's clock), for tests. */
  spans: number[] = [];
  /** Called when `waiting()` may have changed (a stream started or stopped, the context resumed). */
  onChange = () => {};

  /** A new ring and port for a machine that starts: they go in its start message (the device spec's `ring` and `port`). */
  attach() {
    this.port?.close();
    const channel = new MessageChannel();
    [this.ring, this.port, this.playing] = [newRing(), channel.port1, false];
    this.node?.disconnect();
    this.node = undefined;
    const port = channel.port1;
    port.onmessage = (e: MessageEvent<SndToPage>) => {
      if (port !== this.port) return;
      const m = e.data;
      if (m.type === 'start') {
        this.playing = true;
        this.queue(() => this.play(m.rate));
      } else if (m.type === 'stop') {
        this.playing = false;
        if (m.ms !== undefined) this.spans.push(m.ms);
      } else if (m.type === 'stats') {
        this.stats.push(m.stats);
      }
      this.onChange();
    };
    return { ring: this.ring, port: channel.port2 };
  }

  /** The machine stopped: its ring is no longer played. */
  detach() {
    this.port?.close();
    this.node?.disconnect();
    [this.port, this.node, this.ring, this.playing] = [undefined, undefined, undefined, false];
    this.onChange();
  }

  /** A click or key on the machine (a user gesture): the context may run now. */
  gesture() {
    if (this.ctx?.state === 'suspended') void this.ctx.resume().then(() => this.onChange(), () => {});
  }

  /** Sound is started and the browser waits for a click or key to play it (not while its context is being made). */
  waiting() {
    return this.playing && !!this.ctx && this.ctx.state !== 'running';
  }

  setVolume(volume: number, muted: boolean) {
    [this.volume, this.muted] = [volume, muted];
    if (this.gain) this.gain.gain.value = muted ? 0 : volume;
  }

  /** The ring's header (tests and measurements: underruns, the read index). */
  header() {
    return this.ring ? ringViews(this.ring).h : undefined;
  }

  /** The context, for tests and measurements. */
  context() {
    return this.ctx;
  }

  /** An analyser on what the page plays (after the volume), for tests: none before a stream started. */
  tap(fftSize = 8192) {
    if (!this.ctx || !this.gain) return undefined;
    const a = new AnalyserNode(this.ctx, { fftSize, smoothingTimeConstant: 0 });
    this.gain.connect(a);
    return a;
  }

  /** What the page plays, after the volume (measurements connect their own nodes: bench/audio/avsync.ts). */
  output() {
    return this.gain;
  }

  private queue(f: () => Promise<void>) {
    this.chain = this.chain.then(f).catch((e) => console.warn(`webpc: no sound: ${e}`));
  }

  /** Plays the current ring at `rate`: a context at that rate (a new one if the rate changed) and a worklet on the ring. */
  private async play(rate: number) {
    const ring = this.ring;
    if (!ring) return;
    if (this.ctx?.sampleRate !== rate) {
      void this.ctx?.close();
      this.node = undefined;
      // 'interactive': the browser's shortest output buffer. The guest's own buffer is the queue that absorbs jitter.
      const ctx = new AudioContext({ sampleRate: rate, latencyHint: 'interactive' });
      ctx.onstatechange = () => this.onChange();
      await ctx.audioWorklet.addModule(WORKLET);
      this.gain = new GainNode(ctx, { gain: this.muted ? 0 : this.volume });
      this.gain.connect(ctx.destination);
      this.ctx = ctx;
    }
    if (ring !== this.ring) return; // another machine started meanwhile
    if (!this.node) {
      this.node = new AudioWorkletNode(this.ctx!, 'webpc-snd', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { ring } });
      this.node.connect(this.gain!);
    }
    // Resumes at once if the page already had a gesture (the browser's sticky activation); else at the next one.
    void this.ctx!.resume().catch(() => {});
    // What's played reaches the ears this much later: the guest's ALSA counts it in its delay.
    const latency = () => {
      const c = this.ctx;
      if (c && this.ring) Atomics.store(ringViews(this.ring).h, LATENCY, Math.round((c.baseLatency + (c.outputLatency || 0)) * c.sampleRate));
    };
    latency();
    this.latencyTimer ??= setInterval(latency, 1000);
    this.onChange();
  }
}
