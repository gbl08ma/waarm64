// A chunked image (docs/plans/remote-disks.md §4.1): the image file cut into equal pieces at byte offsets, each a file
// named by its SHA-256, listed by a manifest (tools/chunk-image.ts makes them). Read as one file (a `Source`), so
// qcow2, the block cache and the overlay above it are unchanged. A piece is read by range where the host answers
// ranges, and whole where it answers a range with the whole file (Cloudflare Pages): the host is tried once, and then
// `span` tells a cache above to take the whole piece. The manifest's `id` (a hash of the pieces' hashes) is the image's identity: it
// changes with the content, whatever the URL.
import type { Source } from './devices.ts';

export const CHUNKED_FORMAT = 'webpc-chunked-1';

export type Manifest = {
  format: typeof CHUNKED_FORMAT;
  /** The image's file name, for the page to show. */
  name?: string;
  /** The image file's bytes. */
  size: number;
  /** Each piece's bytes (the last one may be shorter): a whole number of MiB. */
  piece: number;
  /** The pieces' URL relative to the manifest, `{hash}` replaced by the piece's. */
  pieces: string;
  /** Each piece's SHA-256 (hex), in order. */
  hashes: string[];
  /** SHA-256 of the hashes joined by newlines: the image's identity. */
  id: string;
  /**
   * A boot's reads (tools/disk-trace.ts): the image file's blocks of `block` bytes in the order the boot first read
   * them, which the page fetches ahead of the guest (docs/plans/remote-disks.md R5). Not part of the identity.
   */
  prefetch?: { block: number; blocks: number[] };
};

/** Whether a disk's URL names a chunked image's manifest (by its path's `.json`). */
export const isManifestUrl = (url: string) => /\.json$/i.test(new URL(url, 'http://x').pathname);

/** Checks a parsed manifest; throws saying what's wrong. */
export function checkManifest(m: unknown): Manifest {
  const x = m as Manifest;
  if (!x || x.format !== CHUNKED_FORMAT) throw new Error(`not a chunked image's manifest (format ${String(x?.format)})`);
  if (!(x.size > 0) || !(x.piece >= 1 << 20) || x.piece % (1 << 20) || !Array.isArray(x.hashes) || x.hashes.length !== Math.ceil(x.size / x.piece) || typeof x.pieces !== 'string')
    throw new Error("the chunked image's manifest is malformed");
  return x;
}

/** A synchronous GET (with a `Range` header if given): the status and the body. */
export type SyncGet = (url: string, range?: string) => { status: number; body?: Uint8Array };

/** A synchronous XHR (workers only). */
export const xhrGet: SyncGet = (url, range) => {
  const x = new XMLHttpRequest();
  x.open('GET', url, false);
  x.responseType = 'arraybuffer';
  if (range) x.setRequestHeader('Range', range);
  x.send();
  const b = x.response as ArrayBuffer | null;
  return { status: x.status, body: b ? new Uint8Array(b) : undefined };
};

/** A chunked image over HTTP, by its manifest's URL (`get`: synchronous XHRs by default, so workers only). */
export function chunkedSource(url: string, get: SyncGet = xhrGet): Source & { manifest: Manifest; ranges: () => boolean | undefined } {
  const mx = get(url);
  if (mx.status !== 200 || !mx.body) throw new Error(`${url}: ${mx.status}`);
  const m = checkManifest(JSON.parse(new TextDecoder().decode(mx.body)));
  const pieceUrl = (i: number) => new URL(m.pieces.replace('{hash}', m.hashes[i]), url).href;
  const pieceLen = (i: number) => Math.min(m.piece, m.size - i * m.piece);
  /** Whether the host answers ranges: unknown until the first piece read. */
  let ranges: boolean | undefined;
  /** The last whole piece (a host without ranges), for the reads of it that follow (a read over several pieces). */
  let whole: [number, Uint8Array] | undefined;
  /** `len` bytes at `off` inside piece `i`. */
  const readPiece = (i: number, off: number, len: number): Uint8Array | undefined => {
    if (whole?.[0] === i) return whole[1].subarray(off, off + len);
    const all = off === 0 && len === pieceLen(i);
    const x = get(pieceUrl(i), ranges === false || all ? undefined : `bytes=${off}-${off + len - 1}`);
    const b = x.body;
    if (!b) return undefined;
    if (x.status === 206 && b.byteLength === len) {
      ranges = true;
      return b;
    }
    if (x.status === 200 && b.byteLength === pieceLen(i)) {
      if (!all) ranges = false; // asked for a range, got the piece
      if (!all) whole = [i, b];
      return b.subarray(off, off + len);
    }
    return undefined;
  };
  /** `readPiece` without blocking (`fetch`). */
  const readPieceAsync = async (i: number, off: number, len: number): Promise<Uint8Array | undefined> => {
    if (whole?.[0] === i) return whole[1].subarray(off, off + len);
    const all = off === 0 && len === pieceLen(i);
    try {
      const r = await fetch(pieceUrl(i), ranges === false || all ? {} : { headers: { Range: `bytes=${off}-${off + len - 1}` } });
      if (r.status !== 206 && r.status !== 200) return void r.body?.cancel();
      const b = new Uint8Array(await r.arrayBuffer());
      if (r.status === 206 && b.length === len) return (ranges = true, b);
      if (r.status === 200 && b.length === pieceLen(i)) {
        if (!all) [ranges, whole] = [false, [i, b]];
        return b.subarray(off, off + len);
      }
    } catch {} // the network
    return undefined;
  };
  return {
    size: m.size,
    manifest: m,
    async readAsync(off, len) {
      if (off < 0 || len < 0 || off + len > m.size) return undefined;
      const parts: Promise<Uint8Array | undefined>[] = [];
      for (let at = off; at < off + len;) {
        const i = Math.floor(at / m.piece);
        const n = Math.min(off + len, (i + 1) * m.piece) - at;
        parts.push(readPieceAsync(i, at - i * m.piece, n));
        at += n;
      }
      const got = await Promise.all(parts);
      if (got.some((b) => !b)) return undefined;
      if (got.length === 1) return got[0];
      const out = new Uint8Array(len);
      let at = 0;
      for (const b of got) (out.set(b!, at), at += b!.length);
      return out;
    },
    ranges: () => ranges,
    // Without ranges a read fetches its pieces whole: a cache above takes them all.
    span: (off, len) => (ranges === false ? [Math.floor(off / m.piece) * m.piece, Math.min(m.size, Math.ceil((off + len) / m.piece) * m.piece)] : [off, off + len]),
    read(off, len) {
      if (off < 0 || len < 0 || off + len > m.size) return undefined;
      const out = new Uint8Array(len);
      for (let at = off; at < off + len;) {
        const i = Math.floor(at / m.piece);
        const n = Math.min(off + len, (i + 1) * m.piece) - at;
        const b = readPiece(i, at - i * m.piece, n);
        if (!b) return undefined;
        out.set(b, at - off);
        at += n;
      }
      return out;
    },
  };
}

/** A chunked image's manifest and the image file's first `n` bytes (its first piece's: by range, or whole), with `fetch`. */
export async function chunkedHead(url: string, n = 32): Promise<{ manifest: Manifest; head: Uint8Array }> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  const manifest = checkManifest(await r.json());
  const p = await fetch(new URL(manifest.pieces.replace('{hash}', manifest.hashes[0]), new URL(url, globalThis.location?.href)), { headers: { Range: `bytes=0-${n - 1}` } });
  if (p.status !== 206 && p.status !== 200) throw new Error(`${url}: its first piece: ${p.status}`);
  return { manifest, head: new Uint8Array(await p.arrayBuffer()).slice(0, n) };
}
