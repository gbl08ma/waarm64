// Codecs for the snapshot container's tests without a core (web/snapshot-file.ts `Codec`): the page's is the core's
// (web/lz.ts), whose CRC-32 is crc32fast's; these take the container's own JS CRC-32, which is the same function.
import { readFileSync } from 'node:fs';
import { lzCodec } from '../web/lz.ts';
import { crc32, type Codec } from '../web/snapshot-file.ts';

/** Every frame stored (codec 0): for files whose frames don't matter (a header, a few bytes). */
export const storedCodec: Codec = { id: 0, compress: async (b) => b, decompress: async (b) => b, crc32 };

/** Reads a stream to its end. */
async function collect(stream: ReadableStream<Uint8Array>) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A real compressor under the page's codec id (2): raw deflate through the platform's `CompressionStream`. */
export const deflateCodec: Codec = {
  id: 2,
  compress: (raw) => collect(new Blob([new Uint8Array(raw)]).stream().pipeThrough(new CompressionStream('deflate-raw'))),
  decompress: (stored) => collect(new Blob([new Uint8Array(stored)]).stream().pipeThrough(new DecompressionStream('deflate-raw'))),
  crc32,
};

/** The built core's state version (`snapshot_version`), for a header-only file the page reads as this core's. */
export async function coreStateVersion(): Promise<number> {
  return (await lzCodec(readFileSync(new URL('../target/wasm32-unknown-unknown/release/waarm64_core.wasm', import.meta.url)))).snapshotVersion;
}
