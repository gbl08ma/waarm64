// The snapshot file's codec 2 (docs/platform.md "The snapshot file"): the LZ4 block format through the core's
// lz4_flex (`core/src/codec.rs`), chosen by measurement (bench/boot/REPORT.md "M8 phase C loop 4", then "SNAPZ:
// compression across the emulator, measured"), and the frames' CRC-32 through the core's crc32fast. It runs in a core
// instance of its own on a small memory, so a file can be read before there is a VM, in Node and in a worker alike.
// Frames are at most 1 MiB + 32 bytes.
import type { Codec } from './snapshot-file.ts';

/** The largest frame payload (web/snapshot-file.ts: a RAM chunk and its page bitmap). */
export const MAX = (1 << 20) + 32;

/** The core's codec exports (docs/abi.md "SNAPZ: the snapshot codec and CRC"): addresses only, no VM, no allocation. */
export type CodecExports = {
  thread_alloc(size: number, align: number): number;
  lz_bound(len: number): number;
  lz_compress(src: number, len: number, dst: number, cap: number): number;
  lz_decompress(src: number, len: number, dst: number, cap: number): number;
  crc32(seed: number, src: number, len: number): number;
  snapshot_version(): number;
  snapshot_version_min(): number;
};

/**
 * An instance of the core `wasm` (its bytes or its compiled module) on a small memory of its own, for its codec's
 * exports: this file's codec, and each of a save's pool workers (web/snapshot-pool-worker.ts).
 */
export async function codecCore(wasm: BufferSource | WebAssembly.Module): Promise<{ ex: CodecExports; memory: WebAssembly.Memory }> {
  const memory = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
  const module = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);
  // The codec's exports call none of the core's imports (the clock, the JIT's, the spill memories' accessors: web/vm.ts
  // `coreImports`), so each is a stub that says so: this file needs none of web/vm.ts, and a pool worker loads little.
  const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {};
  for (const i of WebAssembly.Module.imports(module)) {
    (imports[i.module] ??= {})[i.name] = i.kind === 'memory' ? memory : () => { throw new Error(`the snapshot codec's core called ${i.module}.${i.name}`); };
  }
  const instance = await WebAssembly.instantiate(module, imports);
  const raw = instance.exports as unknown as CodecExports;
  for (const name of ['thread_alloc', 'lz_bound', 'lz_compress', 'lz_decompress', 'crc32', 'snapshot_version', 'snapshot_version_min'] as const) {
    if (typeof raw[name] !== 'function') throw new Error(`the core has no ${name}`);
  }
  return { ex: raw, memory };
}

/**
 * The LZ codec on an instance of the core `wasm` (its bytes or its compiled module), and that
 * core's `snapshot_version` (the format of the machine state it saves) and `snapshot_version_min`
 * (the oldest it reads); `module`, the core it runs (a save's pool starts its workers on it).
 */
export async function lzCodec(wasm: BufferSource | WebAssembly.Module): Promise<Codec & { snapshotVersion: number; snapshotVersionMin: number; module: WebAssembly.Module }> {
  const module = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);
  const { ex, memory } = await codecCore(module);
  const cap = ex.lz_bound(MAX) >>> 0;
  const [src, dst] = [ex.thread_alloc(cap, 16) >>> 0, ex.thread_alloc(cap, 16) >>> 0];
  if (!src || !dst) throw new Error('no memory for the snapshot codec');
  // The memory may grow (never here once the buffers exist, but the view is cheap to remake).
  const bytes = () => new Uint8Array(memory.buffer);
  return {
    id: 2,
    module,
    snapshotVersion: ex.snapshot_version(),
    snapshotVersionMin: ex.snapshot_version_min(),
    async compress(raw) {
      if (raw.length > MAX) throw new RangeError(`a ${raw.length}-byte frame is over the codec's ${MAX}`);
      bytes().set(raw, src);
      const n = ex.lz_compress(src, raw.length, dst, cap) >>> 0;
      if (!n) throw new Error('lz_compress failed');
      return bytes().slice(dst, dst + n); // a copy, not shared
    },
    async decompress(stored, rawLen) {
      if (rawLen > MAX || stored.length > cap) throw new RangeError('a frame is over the codec\'s size');
      bytes().set(stored, src);
      const n = ex.lz_decompress(src, stored.length, dst, rawLen) >>> 0;
      if (n !== rawLen) throw new Error('the frame does not unpack to its size');
      return bytes().slice(dst, dst + n);
    },
    crc32(data, seed = 0) {
      let c = seed >>> 0;
      for (let at = 0; at < data.length; at += cap) {
        const part = data.subarray(at, Math.min(at + cap, data.length));
        bytes().set(part, src);
        c = ex.crc32(c, src, part.length) >>> 0;
      }
      return c;
    },
  };
}
