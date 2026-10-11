// The page's sound (docs/plans/audio.md §4, docs/frontend.md "Sound"): the AudioContext, the worklet that plays
// the machine's sound ring (web/audio-worklet.ts, web/audio-ring.ts) and the volume. Each machine start gets a new
// ring and a port (`attach`), which go to the device worker's virtio-snd (web/snd.ts `ringSink`); the device says
// on the port when its stream starts (and at what rate) and stops. The context is made at the stream's rate, so the
// browser does the resampling to the output device's; a new rate makes a new context. A context made before the
// page had a user gesture starts suspended (the browser's autoplay rule): `gesture` resumes it, and until then the
// device worker plays the ring on its own clock, so the guest doesn't stall. The data never crosses this thread.
//
// The microphone (audio S4, decisions 13 and 14): each start also makes a microphone ring. When the guest starts
// recording, the device says so (`capture-start`, with the stream's rate) and the page asks for the microphone
// (`getUserMedia`: the browser's prompt the first time), with the browser's echo cancellation, noise suppression and
// gain control unless `raw`; a context at that rate feeds it to the `webpc-mic` worklet, which fills the ring. When
// recording stops the microphone is closed (the browser's indicator goes off). Turned off, refused, or until it's
// granted, the guest records silence in real time (the device worker's clock).
import { LATENCY, newRing, ringViews } from './audio-ring.ts';
import type { SndStats, SndToPage } from './snd.ts';

const WORKLET = new URL('./audio-worklet.ts', import.meta.url);

export class PageAudio {
  private ctx?: AudioContext;
  private node?: AudioWorkletNode;
  private gain?: GainNode;
  private ring?: SharedArrayBuffer;
  private mic?: SharedArrayBuffer;
  private port?: MessagePort;
  private micCtx?: AudioContext;
  private micStream?: MediaStream;
  private micEnabled = true;
  private micRaw = false;
  /** The guest is recording, at this rate. */
  private capture?: number;
  /** The microphone: not asked for (`idle`), being asked for, open, turned off in the menu, or refused by the browser. */
  micState: 'idle' | 'asking' | 'on' | 'off' | 'denied' = 'idle';
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
    this.queue(() => this.closeMic());
    [this.ring, this.mic, this.port, this.playing, this.capture] = [newRing(), newRing(), channel.port1, false, undefined];
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
      } else if (m.type === 'capture-start') {
        this.capture = m.rate;
        this.queue(() => this.openMic());
      } else if (m.type === 'capture-stop') {
        this.capture = undefined;
        this.queue(() => this.closeMic());
      }
      this.onChange();
    };
    return { ring: this.ring, mic: this.mic!, port: channel.port2 };
  }

  /** The machine stopped: its ring is no longer played. */
  detach() {
    this.port?.close();
    this.node?.disconnect();
    [this.port, this.node, this.ring, this.mic, this.playing, this.capture] = [undefined, undefined, undefined, undefined, false, undefined];
    this.queue(() => this.closeMic());
    this.onChange();
  }

  /** A click or key on the machine (a user gesture): the context may run now. */
  gesture() {
    if (this.ctx?.state === 'suspended') void this.ctx.resume().then(() => this.onChange(), () => {});
    if (this.micCtx?.state === 'suspended') void this.micCtx.resume().catch(() => {});
  }

  /** Sound is started and the browser waits for a click or key to play it (not while its context is being made). */
  waiting() {
    return this.playing && !!this.ctx && this.ctx.state !== 'running';
  }

  /** The menu's Microphone and Raw choices: applied at once to a recording guest (the microphone opened again or closed). */
  setMic(enabled: boolean, raw: boolean) {
    if (enabled === this.micEnabled && raw === this.micRaw) return;
    [this.micEnabled, this.micRaw] = [enabled, raw];
    if (!enabled && this.micState === 'denied') this.micState = 'off';
    this.queue(async () => {
      await this.closeMic();
      if (this.capture !== undefined) await this.openMic();
    });
  }

  /** The open microphone's settings as the browser applied them (tests: the processing), or none. */
  micSettings() {
    return this.micStream?.getAudioTracks()[0]?.getSettings();
  }

  /** The microphone's ring's header (tests: what the worklet wrote). */
  micHeader() {
    return this.mic ? ringViews(this.mic).h : undefined;
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

  /** Opens the microphone for the recording guest, into the current microphone ring, unless it's turned off. */
  private async openMic() {
    const mic = this.mic;
    const rate = this.capture;
    if (!mic || rate === undefined || this.micStream) return;
    if (!this.micEnabled) {
      this.micState = 'off';
      this.onChange();
      return;
    }
    this.micState = 'asking';
    this.onChange();
    const processing = !this.micRaw;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: processing, noiseSuppression: processing, autoGainControl: processing } });
    } catch (e) {
      console.warn(`webpc: no microphone: ${e}`);
      this.micState = 'denied';
      this.onChange();
      return;
    }
    if (mic !== this.mic || this.capture === undefined || !this.micEnabled) {
      for (const t of stream.getTracks()) t.stop(); // the guest stopped recording meanwhile
      this.micState = this.micEnabled ? 'idle' : 'off';
      this.onChange();
      return;
    }
    this.micStream = stream;
    // A context at the stream's rate: the browser resamples the microphone to it.
    const ctx = new AudioContext({ sampleRate: rate, latencyHint: 'interactive' });
    this.micCtx = ctx;
    await ctx.audioWorklet.addModule(WORKLET);
    if (this.micCtx !== ctx) return; // closed meanwhile
    const node = new AudioWorkletNode(ctx, 'webpc-mic', { numberOfInputs: 1, numberOfOutputs: 0, processorOptions: { ring: mic } });
    new MediaStreamAudioSourceNode(ctx, { mediaStream: stream }).connect(node);
    void ctx.resume().catch(() => {});
    this.micState = 'on';
    this.onChange();
  }

  /** Closes the microphone (the browser's indicator goes off). */
  private async closeMic() {
    const [stream, ctx] = [this.micStream, this.micCtx];
    [this.micStream, this.micCtx] = [undefined, undefined];
    for (const t of stream?.getTracks() ?? []) t.stop();
    await ctx?.close().catch(() => {});
    if (this.micState === 'on' || this.micState === 'asking') {
      this.micState = 'idle';
      this.onChange();
    }
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
