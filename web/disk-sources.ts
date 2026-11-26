// A disk image's bytes (`Source`): over HTTP, on a web server through the block cache, a file the user chose, a
// blank disk's zeros, a local file in Node.
import { BLOCK_CACHE, cachedSource } from './blockcache.ts';
import { cacheIdentity, cacheKey, openBlockStore } from './diskcache.ts';
import { chunkedSource, fetchBytes, isManifestUrl, syncXhr } from './chunked.ts';
import type { MapLeaves } from './overlay.ts';

/** A disk image's bytes: synchronous range reads (`undefined` on a short or failed read). */
export type Source = {
  size: number;
  read(off: number, len: number): Uint8Array | undefined;
  close?(): void;
  /** What a read of [off, off + len) fetches anyway, if more (a chunked image's whole piece where the host has no ranges): a cache asks for all of it and keeps it. */
  span?(off: number, len: number): [number, number];
  /** The same as `read`, without blocking (`fetch`: a remote disk's, which several requests then read at once, R4). */
  readAsync?(off: number, len: number): Promise<Uint8Array | undefined>;
  /** The 4 KiB blocks that may read as other than zeros, ascending (every other block reads as zeros), where the source knows them: a stored disk's held blocks, a blank disk's none. */
  held?(): Iterable<number>;
  /** Its block map, where it is one (a stored disk's: web/stored.ts `blockSource`; a blank disk's, empty), read-only (web/surface.ts). */
  leaves?(): Pick<MapLeaves, 'top' | 'recs' | 'n'>;
  /** Which of its file's bytes are here without a fetch, in blocks of `block` bytes (a remote image's: in the block cache's memory or kept in OPFS; web/blockcache.ts), read-only (web/surface.ts). */
  kept?: { block: number; has(k: number): boolean };
};

/** What a server's HEAD said of an image: its size and what says it changed (its ETag, or its modification time). */
export type DiskHead = { size: number; validator?: string };

/** A HEAD's answer as a `DiskHead`, by its headers (`get`: a `Response`'s or an `XMLHttpRequest`'s). */
export const headOf = (get: (name: string) => string | null): DiskHead => ({
  size: Number(get('content-length')),
  validator: get('etag') ?? get('last-modified') ?? undefined,
});

/**
 * An image over HTTP range requests: synchronous XHRs (workers only), which block the thread, or `fetch` (`readAsync`),
 * which doesn't: the device worker in realtime mode reads by `fetch`, several requests at once, and the rest (the
 * deterministic mode, the image's header and tables at its opening, the disk jobs' workers) synchronously. The device
 * worker reads it through a block cache (web/blockcache.ts). `head`: the server's answer to a HEAD made already (the
 * machine worker's check that the disk is there, web/app/worker-fetch.ts `checkDisks`), else one is made here.
 */
export function httpSource(url: string, head?: DiskHead): Source & { validator?: string } {
  if (!head) {
    // Bounded as `fetchBytes` is (`syncXhr`): a read every try of which timed out fails.
    const x = syncXhr('HEAD', url);
    if (x?.status !== 200) throw new Error(`${url}: ${x?.status ?? 'no answer'}`);
    head = headOf((n) => x.getResponseHeader(n));
  }
  return {
    size: head.size,
    // What says the file changed (for the cache kept in OPFS).
    validator: head.validator,
    read(off, len) {
      const x = syncXhr('GET', url, `bytes=${off}-${off + len - 1}`);
      const b = x?.response as ArrayBuffer | null | undefined;
      return x?.status === 206 && b?.byteLength === len ? new Uint8Array(b) : undefined;
    },
    async readAsync(off, len) {
      const b = await fetchBytes(url, 206, { Range: `bytes=${off}-${off + len - 1}` });
      return b?.length === len ? b : undefined;
    },
  };
}

/**
 * A disk on a web server, as the device worker reads it: a chunked image (by its manifest) or a file, through the block
 * cache, over the blocks kept in OPFS where the image has an identity that changes with it (a chunked image's id, a
 * server's validator) and this browser has room (web/diskcache.ts). `chunked`: a chunked image's content id, which its
 * manifest must name; `head`, a file's HEAD made already (`httpSource`).
 */
export async function remoteSource(url: string, keep: boolean, realtime: boolean, chunked?: string, head?: DiskHead) {
  const src = isManifestUrl(url) ? chunkedSource(url, undefined, chunked) : httpSource(url, head);
  const identity =
    'manifest' in src
      ? cacheIdentity({ chunked: src.manifest.id })
      : src.validator
        ? cacheIdentity({ url, size: src.size, validator: src.validator })
        : undefined;
  const store =
    identity && keep
      ? await openBlockStore(await cacheKey(identity), src.size, BLOCK_CACHE.block).catch(() => undefined)
      : undefined;
  const cached = cachedSource(src, BLOCK_CACHE, store);
  // A chunked image's boot trace, fetched ahead of the guest (realtime: the deterministic mode reads one at a time).
  const trace = 'manifest' in src ? src.manifest.prefetch : undefined;
  if (trace && realtime) void cached.prefetch(reblock(trace.blocks, trace.block, BLOCK_CACHE.block));
  return cached;
}

/** Blocks of `from` bytes as the blocks of `to` bytes that cover them, in the same order (each once). */
function reblock(blocks: number[], from: number, to: number) {
  if (from === to) return blocks;
  const out = new Set<number>();
  for (const b of blocks)
    for (let k = Math.floor((b * from) / to); k <= Math.floor(((b + 1) * from - 1) / to); k++) out.add(k);
  return [...out];
}

/** An image the user chose (a `File`): `FileReaderSync`'s synchronous slices, so workers only. */
export function blobSource(file: Blob): Source {
  const reader = new FileReaderSync();
  return {
    size: file.size,
    read(off, len) {
      if (off + len > file.size) return undefined;
      try {
        const b = reader.readAsArrayBuffer(file.slice(off, off + len));
        return b.byteLength === len ? new Uint8Array(b) : undefined;
      } catch {
        return undefined; // the file changed or went away under us
      }
    },
  };
}

/** A blank disk's bytes: zeros. */
export const zeroSource = (size: number): Source => ({
  size,
  read: (off, len) => (off >= 0 && off + len <= size ? new Uint8Array(len) : undefined),
  held: () => [],
  leaves: () => NO_LEAVES,
});
/** A map with nothing in it (a blank disk's). */
const NO_LEAVES = { top: new Uint32Array(0), recs: new Uint32Array(0), n: 0 };

/** An image in a local file (`file:` URLs, Node only: its boots and the JIT's). */
export async function fileSource(url: string): Promise<Source> {
  const fs = await import('node:fs');
  const fd = fs.openSync(new URL(url), 'r');
  return {
    size: fs.fstatSync(fd).size,
    read(off, len) {
      const b = new Uint8Array(len);
      return fs.readSync(fd, b, 0, len, off) === len ? b : undefined;
    },
    close: () => fs.closeSync(fd),
  };
}
