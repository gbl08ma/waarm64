// A/V sync's sound end (bench/audio/avsync.ts; dev-only): after the page's volume, posts the context frame of each
// onset (the first sample over the threshold after 300 ms under it: the sync clip's beep) on its port.
declare const currentFrame: number;
declare const sampleRate: number;
declare function registerProcessor(name: string, p: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

class Onset extends AudioWorkletProcessor {
  private quiet = 0;
  process(inputs: Float32Array[][]) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const loud = Math.abs(ch[i]) > 0.02;
      if (loud && this.quiet > 0.3 * sampleRate) this.port.postMessage(currentFrame + i);
      this.quiet = loud ? 0 : this.quiet + 1;
    }
    return true;
  }
}
registerProcessor('webpc-onset', Onset);
