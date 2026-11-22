// The host-visible window's write-watch, the host's side (docs/devices.md "virtio-gpu"; core/src/mem.rs `Watch`):
// which of the window's pages the guest wrote since the last look. A write to a window page fills the vCPU's write
// TLB entry only after marking the page in a bitmap, so later writes to it cost nothing; to look again the host
// bumps the watch's generation and waits for every running vCPU to drop those entries (marking their pages: they may
// have been written through them), then swaps the bitmap out. A vCPU drops them as it leaves its run loop too, so
// one that isn't running is never waited for. It drops them at its run loop's top: under parallel SMP's polled code
// the look stores 0 in each running vCPU's stop word after its bump (docs/abi.md "PERF: the stop word"), so one looping
// in compiled code, whose chunk no step count may end (the code without `acc`), gets there at its next poll.

/** core/src/mem.rs `Watch`, in u32 words. */
const GEN = 0;
const NCPUS = 1;
const WORDS = 2;
const PAGES = 3;
const ACK = 4;
const RUNNING = ACK + 128;
const BITMAP = RUNNING + 128;

export class WindowWatch {
  private readonly w: Int32Array;
  /** Each vCPU's stop word, as an index into `w`'s buffer's i32s. */
  private readonly stops: number[];
  private readonly i32: Int32Array;
  readonly pages: number;

  /** `at`: `vm_window_watch`'s pointer into the core's memory; `stops`: parallel SMP's stop words (`vm_cpu_stop`) there. */
  constructor(memory: WebAssembly.Memory | SharedArrayBuffer, at: number, stops: readonly number[] = []) {
    const buf = memory instanceof WebAssembly.Memory ? memory.buffer : memory;
    const head = new Int32Array(buf, at, BITMAP);
    this.w = new Int32Array(buf, at, BITMAP + head[WORDS]);
    this.i32 = new Int32Array(buf);
    this.stops = stops.map((a) => a / 4);
    this.pages = head[PAGES];
  }

  /**
   * The pages written since the last call, in order; returns once every vCPU has dropped the write entries it had
   * (`timeoutMs` bounds the wait for one that runs on without reaching a chunk boundary: then every page counts as
   * written, which is never wrong).
   */
  take(timeoutMs = 100): number[] {
    const w = this.w;
    const gen = (Atomics.add(w, GEN, 1) + 1) | 0;
    // The news, then the stop words: a vCPU in compiled code reaches its run loop's top at its next poll.
    for (let c = 0; c < this.stops.length; c++)
      if (Atomics.load(w, RUNNING + c) !== 0) Atomics.store(this.i32, this.stops[c], 0);
    const deadline = performance.now() + timeoutMs;
    let all = false;
    for (let c = 0; c < w[NCPUS]; c++) {
      while (Atomics.load(w, RUNNING + c) !== 0 && ((Atomics.load(w, ACK + c) - gen) | 0) < 0) {
        if (performance.now() > deadline) {
          all = true;
          break;
        }
        Atomics.wait(w, ACK + c, Atomics.load(w, ACK + c), 0.05);
      }
    }
    const out: number[] = [];
    for (let k = 0; k < w[WORDS]; k++) {
      let bits = Atomics.exchange(w, BITMAP + k, 0);
      if (all) bits = -1;
      for (; bits !== 0; bits &= bits - 1) {
        const page = k * 32 + 31 - Math.clz32(bits & -bits);
        if (page < this.pages) out.push(page);
      }
    }
    return out;
  }
}
