// The snapshot file's codec 2 (docs/platform.md "The snapshot file"): the core's LZ (`core/src/lz.rs`,
// the LZ4 block format), chosen by measurement over CompressionStream's deflate (bench/boot/REPORT.md
// "M8 phase C loop 4"). It runs in a core instance of its own on a small memory, so a file can be
// read before there is a VM, in Node and in a worker alike. Frames are at most 1 MiB + 32 bytes.
import type { Codec } from './snapshot-file.ts';
import { coreImports, unsigned } from './vm.ts';

/** The largest frame payload (web/snapshot-file.ts: a RAM chunk and its page bitmap). */
const MAX = (1 << 20) + 32;

/**
 * The LZ codec on an instance of the core `wasm` (its bytes or its compiled module), and that
 * core's `snapshot_version` (the format of the machine state it saves) and `snapshot_version_min`
 * (the oldest it reads).
 */
export async function lzCodec(wasm: BufferSource | WebAssembly.Module): Promise<Codec & { snapshotVersion: number; snapshotVersionMin: number }> {
  const memory = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
  const module = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);
  const instance = await WebAssembly.instantiate(module, coreImports(memory));
  const ex = unsigned(instance.exports) as unknown as {
    thread_alloc(size: number, align: number): number;
    lz_bound(len: number): number;
    lz_compress(src: number, len: number, dst: number, cap: number): number;
    lz_decompress(src: number, len: number, dst: number, cap: number): number;
    snapshot_version(): number;
    snapshot_version_min(): number;
  };
  const cap = ex.lz_bound(MAX) >>> 0;
  const [src, dst] = [ex.thread_alloc(cap, 16), ex.thread_alloc(cap, 16)];
  if (!src || !dst) throw new Error('no memory for the snapshot codec');
  // The memory may grow (never here once the buffers exist, but the view is cheap to remake).
  const bytes = () => new Uint8Array(memory.buffer);
  return {
    id: 2,
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
  };
}
