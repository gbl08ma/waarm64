// The host half of the JIT (docs/jit.md): installs the modules the core generates into its function table.
import type { CompileJob, CompiledJob } from './jit-compile-worker.ts';

/** How long a vCPU's host keeps a compiled module it hasn't installed, and how many at most (`jitHost`). */
const RECEIVED_KEEP_MS = 30_000;
const RECEIVED_MAX = 4096;

/** A flush of at least this many slots is worth a {@link collect}. */
const NUDGE_SLOTS = 4096;
/** An install this long is logged (`waarm64-slow install`). */
const SLOW_INSTALL_MS = 20;

/**
 * Asks V8 to collect now. The flushed blocks' instances are garbage, and V8 frees their code only when a
 * major GC collects them; a worker's JS heap stays small, so that GC can come minutes late and the dead
 * code piles up (a Go build on 4 vCPUs: the tab peaked at 9.6 GB with the code cache capped). Allocating a large
 * ArrayBuffer (untouched, so no memory) reports external-memory pressure, which makes V8 collect.
 */
function collect() {
  try {
    new ArrayBuffer(256 << 20);
  } catch {
    // no address space to spare: the GC comes when it comes
  }
}

/**
 * The host half of the JIT: compiles a module the core generated,
 * synchronously, and puts its exports f0, f1, … into the core's function table
 * at JIT slot `slot` on (after the core's own entries). The modules import the
 * memory, the spill memories (`ram1`, …), the table, the core's exports (its helpers) and the host clock (`now_ms`) from `env`, and
 * already-installed blocks they chain to from `t`, by table index. With a
 * port to the compile worker (`compile`), the core hands it each module it
 * emits first, and installs it once compiled there: a hit in V8's module cache.
 */
export function jitHost(
  memory: WebAssembly.Memory,
  now_ms: () => number,
  port?: MessagePort,
  spill: WebAssembly.Memory[] = [],
) {
  let table: WebAssembly.Table | undefined;
  let base = 0;
  let imports: WebAssembly.Imports = {};
  // The bytes are copied out of the shared memory (V8 compiles only unshared ones) into one buffer, reused.
  let scratch = new ArrayBuffer(0);
  // Slots the last install used up to (its end), and the highest slot end since the cache last flushed.
  let lastEnd = 0;
  let hi = 0;
  // The compile worker's compiled modules by number, as they arrive through the event loop (ABI 37): installing one
  // skips V8's decoding and validating the bytes again, which `new WebAssembly.Module` does before it finds them in
  // its cache (four fifths of an install: bench/boot/REPORT.md "M8: the compile worker's modules, posted").
  const received = new Map<number, { module?: WebAssembly.Module; at: number }>();
  if (port) {
    port.onmessage = (e: MessageEvent<CompiledJob>) => {
      const now = performance.now();
      received.set(e.data.seq, { module: e.data.module, at: now });
      // A table that doesn't install (a vCPU asleep) keeps nothing alive for long.
      for (const [k, v] of received)
        if (now - v.at > RECEIVED_KEEP_MS || received.size > RECEIVED_MAX) received.delete(k);
        else break;
    };
    (port as { unref?(): void }).unref?.(); // Node: listening doesn't keep the worker alive
  }
  return {
    bind(core: WebAssembly.Instance) {
      table = core.exports.__indirect_function_table as WebAssembly.Table;
      base = table.length;
      // The spill memories as `env.ram1`…, which modules import for their loads' and stores' spill arms (docs/spill-memories.md).
      imports = {
        env: { ...core.exports, memory, table, now_ms, ...Object.fromEntries(spill.map((m, k) => [`ram${k + 1}`, m])) },
      };
    },
    install(ptr: number, len: number, slot: number, seq: number): number {
      if (!table) return -1;
      const t0 = performance.now();
      let module: WebAssembly.Module;
      // The worker's compiled module (seq 0: none, compile the bytes); -2 if it isn't here yet.
      const got = seq !== 0 ? received.get(seq >>> 0) : undefined;
      if (seq !== 0 && !got) return -2;
      if (got?.module) {
        module = got.module;
        for (const k of received.keys()) if (((k - (seq >>> 0)) | 0) <= 0) received.delete(k);
      } else {
        // (A module the worker failed to compile: compiled here, to report the error.)
        if (scratch.byteLength < len) scratch = new ArrayBuffer(Math.max(len, 2 * scratch.byteLength, 1 << 16));
        const bytes = new Uint8Array(scratch, 0, len);
        bytes.set(new Uint8Array(memory.buffer, ptr >>> 0, len)); // `ptr` is a u32 the i32 import signs
        module = new WebAssembly.Module(bytes);
      }
      const t1 = performance.now();
      // Blocks it chains to that are already compiled (M5 step 7): `t.<table index>`.
      const t: Record<string, WebAssembly.ExportValue> = {};
      for (const i of WebAssembly.Module.imports(module)) if (i.module === 't') t[i.name] = table.get(Number(i.name));
      const f = new WebAssembly.Instance(module, { ...imports, t }).exports;
      const n = Object.keys(f).length;
      const at = base + slot;
      const t2 = performance.now();
      let gc = 0;
      const restart = slot < lastEnd;
      // The slots start over from 0 when the cache flushes: its old blocks are dead, so the table lets go of
      // the ones this module doesn't overwrite, and V8 can free their instances and code.
      if (restart) {
        for (let k = slot + n; k < hi; k++) table.set(base + k, null);
        // Only for a big cache (JIT-stress flushes every few blocks).
        if (hi > NUDGE_SLOTS) {
          gc = performance.now();
          collect();
          gc = performance.now() - gc;
        }
        hi = 0;
      }
      lastEnd = slot + n;
      hi = Math.max(hi, lastEnd);
      if (table.length < at + n) table.grow(at + n - table.length);
      for (let k = 0; k < n; k++) table.set(at + k, f[`f${k}`]);
      // An install the vCPU felt (it runs on the vCPU's thread, the guest's clock running on): for the benchmarks'
      // timelines (bench/gpu/guest-session.ts collects `waarm64-slow` lines).
      const ms = performance.now() - t0;
      if (ms >= SLOW_INSTALL_MS)
        console.debug(
          `waarm64-slow install ${ms.toFixed(1)} ms at ${(performance.timeOrigin + t0).toFixed(0)}: compile ${(t1 - t0).toFixed(1)} instantiate ${(t2 - t1).toFixed(1)} gc ${gc.toFixed(1)} bytes ${len} functions ${n}${restart ? ' (slots start over)' : ''}`,
        );
      return at;
    },
    /** `env.jit_compile`: posts a copy of the module to the compile worker; 0 without one. */
    compile(ptr: number, len: number, seq: number, epoch: number, ready: number): number {
      if (!port || !table) return 0;
      const bytes = new Uint8Array(len);
      bytes.set(new Uint8Array(memory.buffer, ptr >>> 0, len));
      port.postMessage(
        {
          seq: seq >>> 0,
          epoch: epoch >>> 0,
          ready: ready >>> 0,
          bytes: bytes.buffer,
          t: performance.timeOrigin + performance.now(),
        } satisfies CompileJob,
        [bytes.buffer],
      );
      return 1;
    },
  };
}
