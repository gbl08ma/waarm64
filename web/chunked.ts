// A chunked image (docs/devices.md "A chunked image", docs/remote-disks.md): the image file cut into equal pieces at byte offsets, each a file
// named by its SHA-256, listed by a manifest (tools/chunk-image.ts makes them). Read as one file (a `Source`), so
// qcow2, the block cache and the overlay above it are unchanged. A piece is fetched whole (any static host serves it,
// ranges or not) and `span` tells a cache above to keep the whole piece. The manifest's `id` (a hash of the pieces'
// hashes) is the image's identity: it changes with the content, whatever the URL. Nothing is taken on the host's word:
// a manifest's id must be its hashes' (`checkManifest`) and the one the disk was added as (`chunkedSource`'s
// `chunked`), and each piece is checked against its hash before a byte of it is used, so what a disk reads is its id's
// content whoever serves it.
import type { Source } from './devices.ts';
import { MsgError } from './msg.ts';
import { sha256Hex } from './sha256.ts';

export const CHUNKED_FORMAT = 'waarm64-chunked-1';

export type Manifest = {
  format: typeof CHUNKED_FORMAT;
  /**
   * What the page calls the image: a disk added by the manifest's URL and a machine opened by `?disk=` take it
   * (tools/chunk-image.ts `--name`; the image's file name by default), not the manifest's file name.
   */
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
   * them, which the page fetches ahead of the guest (docs/remote-disks.md "Publishing an image"). Not part of the identity.
   */
  prefetch?: { block: number; blocks: number[] };
};

/** Whether a disk's URL names a chunked image's manifest (by its path's `.json`). */
export const isManifestUrl = (url: string) => /\.json$/i.test(new URL(url, 'http://x').pathname);

const isHash = (h: unknown) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);

/** The content id of a chunked file whose pieces have `hashes`: what its manifest's `id` must be (tools/chunk-image.ts). */
export const contentId = (hashes: string[]) => sha256Hex(hashes.join('\n'));

/**
 * Checks a parsed manifest: its fields, its hashes hex (they go into the pieces' URLs), its id its hashes'; throws
 * saying what's wrong.
 */
export function checkManifest(m: unknown): Manifest {
  const x = m as Manifest;
  if (!x || x.format !== CHUNKED_FORMAT) throw new MsgError('disks:chunked.notManifest', { format: String(x?.format) });
  if (!(x.size > 0) || !(x.piece >= 1 << 20) || x.piece % (1 << 20) || !Array.isArray(x.hashes) || x.hashes.length !== Math.ceil(x.size / x.piece) || typeof x.pieces !== 'string' || !x.hashes.every(isHash) || !isHash(x.id) || contentId(x.hashes) !== x.id)
    throw new MsgError('disks:chunked.malformed');
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

/** The SHA-256 of `b` in hex, without blocking (the platform's). */
async function sha256(b: Uint8Array) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * A chunked image over HTTP, by its manifest's URL (`get`: synchronous XHRs by default, so workers only); `chunked`:
 * the content id the disk was added as, which the manifest must name (else it throws: another image under the URL).
 * Pieces are fetched whole and checked against their hashes (a range of one couldn't be), the last one kept for the
 * reads of it that follow; `span` tells a cache above to keep whole pieces. A piece that isn't its hash's reads as a
 * failed read.
 */
export function chunkedSource(url: string, get: SyncGet = xhrGet, chunked?: string): Source & { manifest: Manifest } {
  const mx = get(url);
  if (mx.status !== 200 || !mx.body) throw new Error(`${url}: ${mx.status}`);
  const m = checkManifest(JSON.parse(new TextDecoder().decode(mx.body)));
  if (chunked !== undefined && m.id !== chunked) throw new MsgError('disks:chunked.otherImage');
  const pieceUrl = (i: number) => new URL(m.pieces.replace('{hash}', m.hashes[i]), url).href;
  const pieceLen = (i: number) => Math.min(m.piece, m.size - i * m.piece);
  /** The last piece read (checked), for the reads of it that follow (a read over several pieces, a cache's blocks). */
  let last: [number, Uint8Array] | undefined;
  /** Piece `i` as fetched, if it's the piece its hash names. */
  const checked = (i: number, b: Uint8Array) => {
    if (b.byteLength !== pieceLen(i)) return undefined;
    last = [i, b];
    return b;
  };
  /** `len` bytes at `off` inside piece `i`. */
  const readPiece = (i: number, off: number, len: number): Uint8Array | undefined => {
    if (last?.[0] !== i) {
      const x = get(pieceUrl(i));
      if (x.status !== 200 || !x.body || x.body.byteLength !== pieceLen(i) || sha256Hex(x.body) !== m.hashes[i]) return undefined;
      checked(i, x.body);
    }
    return last![1].subarray(off, off + len);
  };
  /** `readPiece` without blocking (`fetch`; the platform's digest). */
  const readPieceAsync = async (i: number, off: number, len: number): Promise<Uint8Array | undefined> => {
    if (last?.[0] === i) return last[1].subarray(off, off + len);
    try {
      const r = await fetch(pieceUrl(i));
      if (r.status !== 200) return void r.body?.cancel();
      const b = new Uint8Array(await r.arrayBuffer());
      if (b.length !== pieceLen(i) || (await sha256(b)) !== m.hashes[i]) return undefined;
      return checked(i, b)?.subarray(off, off + len);
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
    // A read fetches its pieces whole: a cache above takes them all.
    span: (off, len) => [Math.floor(off / m.piece) * m.piece, Math.min(m.size, Math.ceil((off + len) / m.piece) * m.piece)],
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

/** Fetches and checks a chunked image's manifest; throws saying what's wrong. */
export async function fetchManifest(url: string): Promise<Manifest> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return checkManifest(await r.json());
}

/** A chunked image's manifest and the image file's first `n` bytes (its first piece's: by range, or whole), with `fetch`. */
export async function chunkedHead(url: string, n = 32): Promise<{ manifest: Manifest; head: Uint8Array }> {
  const manifest = await fetchManifest(url);
  const p = await fetch(new URL(manifest.pieces.replace('{hash}', manifest.hashes[0]), new URL(url, globalThis.location?.href)), { headers: { Range: `bytes=0-${n - 1}` } });
  if (p.status !== 206 && p.status !== 200) throw new Error(`${url}: its first piece: ${p.status}`);
  return { manifest, head: new Uint8Array(await p.arrayBuffer()).slice(0, n) };
}

/**
 * A chunked file fetched whole (a template snapshot: docs/machines.md "A machine from a template"): its pieces, `at
 * once` at a time, each checked against its hash (they are content-addressed: a piece that doesn't match is a broken
 * copy), joined into one Blob in order. `progress` is told the bytes so far; `manifest`: its manifest already fetched
 * (and checked again here), not fetched twice. Throws on a piece that is missing or wrong.
 */
export async function fetchChunked(
  url: string,
  o: { atOnce?: number; progress?: (done: number, total: number) => void; manifest?: Manifest } = {},
): Promise<{ manifest: Manifest; blob: Blob }> {
  const abs = new URL(url, globalThis.location?.href).href;
  const m = o.manifest ? checkManifest(o.manifest) : await fetchManifest(abs);
  const parts: Uint8Array[] = new Array<Uint8Array>(m.hashes.length);
  let next = 0;
  let done = 0;
  const one = async () => {
    while (next < m.hashes.length) {
      const i = next++;
      const r = await fetch(new URL(m.pieces.replace('{hash}', m.hashes[i]), abs));
      if (!r.ok) throw new Error(`${url}: piece ${i}: ${r.status}`);
      const b = new Uint8Array(await r.arrayBuffer());
      if (b.length !== Math.min(m.piece, m.size - i * m.piece) || (await sha256(b)) !== m.hashes[i])
        throw new Error(`${url}: piece ${i} isn't the one the manifest names`);
      parts[i] = b;
      done += b.length;
      o.progress?.(done, m.size);
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.atOnce ?? 6, m.hashes.length) }, one));
  return { manifest: m, blob: new Blob(parts as BlobPart[]) };
}
