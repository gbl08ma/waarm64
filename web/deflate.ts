// qcow2's compressed clusters through the core's miniz_oxide (docs/devices.md "qcow2"; docs/abi.md "SNAPZ: qcow2's
// clusters through miniz_oxide"): raw deflate, inflated for a disk's reads (web/qcow2.ts) and deflated for a
// compressed export (web/qcow2-write.ts), synchronously, on a codec-only instance of the core (web/lz.ts `codecCore`)
// of the thread's own. Chosen over the platform's DecompressionStream and CompressionStream by measurement
// (bench/boot/REPORT.md "SNAPZ: compression across the emulator, measured" and "SNAPZ loop 6").
import { codecCore, type CodecExports } from './lz.ts';

/** The core's `wasm` (web/app/worker-fetch.ts fetches it to start a machine; a thread without it fetches it here). */
export const CORE = new URL('../target/wasm32-unknown-unknown/release/waarm64_core.wasm', import.meta.url).href;

type DeflateExports = CodecExports & {
  inflate_raw(src: number, len: number, dst: number, cap: number): number;
  deflate_raw(src: number, len: number, dst: number, cap: number, level: number): number;
};

export type Deflate = {
  /** The raw deflate stream at the start of `input` (bytes after its end ignored) unpacked to exactly `size` bytes, or undefined. */
  inflate(input: Uint8Array, size: number): Uint8Array | undefined;
  /** `data` as one raw deflate stream at miniz's `level` when it takes at most `cap` bytes (default: fewer than `data`'s), or undefined. */
  deflate(data: Uint8Array, level: number, cap?: number): Uint8Array | undefined;
};

/** The codec on a codec-only instance of the core `module`. */
export async function deflateOn(module: WebAssembly.Module): Promise<Deflate> {
  const { ex: raw, memory } = await codecCore(module);
  const ex = raw as DeflateExports;
  if (typeof ex.inflate_raw !== 'function' || typeof ex.deflate_raw !== 'function') throw new Error('the core has no inflate_raw or deflate_raw');
  // Two buffers in the instance's memory, grown as a call needs (a cluster is at most 2 MiB; the old ones are left:
  // the core exports no free, and what is left is at most what the largest call took).
  const buf = [{ at: 0, cap: 0 }, { at: 0, cap: 0 }];
  const room = (k: 0 | 1, n: number) => {
    const b = buf[k];
    if (n > b.cap) {
      const cap = Math.max(64 << 10, 2 ** Math.ceil(Math.log2(n)));
      const at = ex.thread_alloc(cap, 16) >>> 0;
      if (!at) throw new Error('no memory for the deflate codec');
      buf[k] = { at, cap };
    }
    return buf[k].at;
  };
  const bytes = () => new Uint8Array(memory.buffer); // the memory may grow (the compressor's tables come from its heap)
  return {
    inflate(input, size) {
      const src = room(0, input.length);
      const dst = room(1, size);
      bytes().set(input, src);
      const n = ex.inflate_raw(src, input.length, dst, size) >>> 0;
      return n === size ? bytes().slice(dst, dst + n) : undefined;
    },
    deflate(data, level, cap = data.length - 1) {
      if (cap <= 0) return undefined;
      const src = room(0, data.length);
      const dst = room(1, cap);
      bytes().set(data, src);
      const n = ex.deflate_raw(src, data.length, dst, cap, level) >>> 0;
      return n ? bytes().slice(dst, dst + n) : undefined;
    },
  };
}

let module: Promise<WebAssembly.Module> | undefined;
let codec: Promise<Deflate> | undefined;

/**
 * The core this thread's codec runs on: `given` where the thread has it already (the device worker gets the
 * machine's: web/devices.ts `DevicesInit.core`), else `CORE` fetched (read, in Node) and compiled, once a thread.
 */
export function coreModule(given?: WebAssembly.Module): Promise<WebAssembly.Module> {
  return (module ??= given ? Promise.resolve(given) : loadCore());
}

async function loadCore() {
  if (CORE.startsWith('file:')) {
    const fs = await import('node:fs');
    return WebAssembly.compile(fs.readFileSync(new URL(CORE)));
  }
  const r = await fetch(CORE);
  if (!r.ok) throw new Error(`the core for qcow2's clusters: HTTP ${r.status}`);
  return WebAssembly.compile(await r.arrayBuffer());
}

/** This thread's codec (one instance, made at its first use). */
export const threadDeflate = (): Promise<Deflate> => (codec ??= coreModule().then(deflateOn));
