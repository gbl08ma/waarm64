// A chunked image (docs/devices.md "A chunked image", docs/remote-disks.md): the image file cut into equal pieces at byte offsets, each a file
// named by its SHA-256, listed by a manifest (tools/chunk-image.ts makes them). Read as one file (a `Source`), so
// qcow2, the block cache and the overlay above it are unchanged. A piece is fetched whole (any static host serves it,
// ranges or not) and `span` tells a cache above to keep the whole piece. The manifest's `id` (a hash of the pieces'
// hashes) is the image's identity: it changes with the content, whatever the URL. Nothing is taken on the host's word:
// a manifest's id must be its hashes' (`checkManifest`) and the one the disk was added as (`chunkedSource`'s
// `chunked`), and each piece is checked against its hash before a byte of it is used, so what a disk reads is its id's
// content whoever serves it.
import type { Source } from './disk-sources.ts';
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
/** A remote read's connection that brings no byte for this long is taken as stalled: aborted, and tried again. */
export const STALL_MS = 20_000;
/** Tries of a read whose connections stall (a failed or refused one isn't tried again: the guest's I/O error retries). */
export const STALL_TRIES = 2;

/**
 * `url`'s body (with `headers`: a range) if the answer's status is `ok`, else undefined (the network failed, another
 * status, or every try stalled). Bounded by progress, not by a total deadline: a slow server's read takes as long as
 * its bytes keep coming, and a connection that went quiet (the network lost without an error, which `fetch` would
 * wait out for good) doesn't hold the read, the block cache's fetch slots and the drain of a pause behind it.
 */
export async function fetchBytes(
  url: string,
  ok: number,
  headers?: Record<string, string>,
  stallMs = STALL_MS,
  tries = STALL_TRIES,
): Promise<Uint8Array | undefined> {
  for (let t = 0; t < tries; t++) {
    const quiet = new AbortController();
    let timer = setTimeout(() => quiet.abort(), stallMs);
    const progress = () => {
      clearTimeout(timer);
      timer = setTimeout(() => quiet.abort(), stallMs);
    };
    try {
      const r = await fetch(url, { headers, signal: quiet.signal });
      if (r.status !== ok) return void r.body?.cancel();
      if (!r.body) return new Uint8Array(0);
      progress();
      // Into one buffer of the length it says, as `arrayBuffer()` would (an encoded body: the parts, joined).
      const said = r.headers.get('content-encoding') ? NaN : Number(r.headers.get('content-length') ?? NaN);
      const reader = r.body.getReader();
      const parts: Uint8Array[] = [];
      let n = 0;
      let out = Number.isSafeInteger(said) ? new Uint8Array(said) : undefined;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        progress();
        if (out && n + value.length <= out.length) out.set(value, n);
        else {
          if (out) parts.push(out.subarray(0, n));
          out = undefined;
          parts.push(value);
        }
        n += value.length;
      }
      if (out) return n === out.length ? out : out.subarray(0, n);
      if (parts.length === 1) return parts[0];
      const joined = new Uint8Array(n);
      let at = 0;
      for (const p of parts) {
        joined.set(p, at);
        at += p.length;
      }
      return joined;
    } catch {
      if (!quiet.signal.aborted) return undefined; // the network
    } finally {
      clearTimeout(timer);
    }
  }
  return undefined;
}

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
  if (
    !(x.size > 0) ||
    !(x.piece >= 1 << 20) ||
    x.piece % (1 << 20) ||
    !Array.isArray(x.hashes) ||
    x.hashes.length !== Math.ceil(x.size / x.piece) ||
    typeof x.pieces !== 'string' ||
    !x.hashes.every(isHash) ||
    !isHash(x.id) ||
    contentId(x.hashes) !== x.id
  )
    throw new MsgError('disks:chunked.malformed');
  return x;
}

/** A synchronous GET (with a `Range` header if given): the status and the body. */
export type SyncGet = (url: string, range?: string) => { status: number; body?: Uint8Array };

/**
 * A synchronous read's bound, on its whole answer: long enough for a slow link's piece (2 MiB at ~17 KB/s; `STALL_MS`
 * there failed every piece under ~100 KB/s, which `fetchBytes` reads), short enough that a dead connection ends.
 */
export const SYNC_STALL_MS = 120_000;

/**
 * A synchronous XHR (workers only), sent, or undefined when every try timed out (a failed read). Bounded as `fetchBytes`
 * is, but by the whole answer (a synchronous request tells no progress; hence `SYNC_STALL_MS`): a try that hasn't ended in `stallMs` is
 * aborted and tried again, `tries` times. A window refuses a synchronous request's `timeout`: there it isn't bounded.
 * A failure of the network throws, as `send` does.
 */
export function syncXhr(
  method: string,
  url: string,
  range?: string,
  stallMs = SYNC_STALL_MS,
  tries = STALL_TRIES,
): XMLHttpRequest | undefined {
  for (let t = 0; t < tries; t++) {
    const x = new XMLHttpRequest();
    x.open(method, url, false);
    x.responseType = 'arraybuffer';
    if (typeof document === 'undefined') x.timeout = stallMs;
    if (range) x.setRequestHeader('Range', range);
    try {
      x.send();
      return x;
    } catch (e) {
      if ((e as DOMException | undefined)?.name !== 'TimeoutError') throw e;
    }
  }
  return undefined;
}

/** A synchronous GET by XHR (workers only): status 0 when every try timed out (`syncXhr`). */
export const xhrGet: SyncGet = (url, range) => {
  const x = syncXhr('GET', url, range);
  const b = x?.response as ArrayBuffer | null | undefined;
  return { status: x?.status ?? 0, body: b ? new Uint8Array(b) : undefined };
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
      if (x.status !== 200 || !x.body || x.body.byteLength !== pieceLen(i) || sha256Hex(x.body) !== m.hashes[i])
        return undefined;
      checked(i, x.body);
    }
    return last![1].subarray(off, off + len);
  };
  /** `readPiece` without blocking (`fetch`; the platform's digest). */
  const readPieceAsync = async (i: number, off: number, len: number): Promise<Uint8Array | undefined> => {
    if (last?.[0] === i) return last[1].subarray(off, off + len);
    const b = await fetchBytes(pieceUrl(i), 200);
    if (b?.length !== pieceLen(i) || (await sha256(b)) !== m.hashes[i]) return undefined;
    return checked(i, b)?.subarray(off, off + len);
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
      for (const b of got) {
        out.set(b!, at);
        at += b!.length;
      }
      return out;
    },
    // A read fetches its pieces whole: a cache above takes them all.
    span: (off, len) => [
      Math.floor(off / m.piece) * m.piece,
      Math.min(m.size, Math.ceil((off + len) / m.piece) * m.piece),
    ],
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
  const p = await fetch(
    new URL(manifest.pieces.replace('{hash}', manifest.hashes[0]), new URL(url, globalThis.location?.href)),
    { headers: { Range: `bytes=0-${n - 1}` } },
  );
  if (p.status !== 206 && p.status !== 200) throw new Error(`${url}: its first piece: ${p.status}`);
  return { manifest, head: new Uint8Array(await p.arrayBuffer()).slice(0, n) };
}

/**
 * A chunked file fetched whole (a template snapshot: docs/machines.md "A machine from a template"): its pieces, `at
 * once` at a time, each checked against its hash (they are content-addressed: a piece that doesn't match is a broken
 * copy), joined into one Blob in order (each piece a Blob as it comes, which the browser may keep on disk rather than in
 * memory). `progress` is told the bytes so far; `manifest`: its manifest already fetched (and checked again here), not
 * fetched twice; `signal` aborts it (its `AbortError` thrown). Throws on a piece that is missing or wrong
 * (`disks:chunked.pieceStatus`, with the status; `disks:chunked.pieceWrong`), or the network's error; the first failure
 * stops the other pieces' downloads.
 */
export async function fetchChunked(
  url: string,
  o: {
    atOnce?: number;
    progress?: (done: number, total: number) => void;
    manifest?: Manifest;
    signal?: AbortSignal;
  } = {},
): Promise<{ manifest: Manifest; blob: Blob }> {
  const abs = new URL(url, globalThis.location?.href).href;
  const m = o.manifest ? checkManifest(o.manifest) : await fetchManifest(abs);
  const parts: Blob[] = new Array<Blob>(m.hashes.length);
  const stop = new AbortController();
  const signal = o.signal ? AbortSignal.any([o.signal, stop.signal]) : stop.signal;
  let next = 0;
  let done = 0;
  const one = async () => {
    while (next < m.hashes.length) {
      signal.throwIfAborted();
      const i = next++;
      const r = await fetch(new URL(m.pieces.replace('{hash}', m.hashes[i]), abs), { signal });
      if (!r.ok) {
        void r.body?.cancel();
        throw new MsgError('disks:chunked.pieceStatus', { index: i, status: r.status });
      }
      const b = new Uint8Array(await r.arrayBuffer());
      if (b.length !== Math.min(m.piece, m.size - i * m.piece) || (await sha256(b)) !== m.hashes[i])
        throw new MsgError('disks:chunked.pieceWrong', { index: i });
      parts[i] = new Blob([b]);
      done += b.length;
      o.progress?.(done, m.size);
    }
  };
  o.progress?.(0, m.size); // its size known: the progress shows from the start
  const workers = Array.from({ length: Math.min(o.atOnce ?? 6, m.hashes.length) }, () =>
    one().catch((e: unknown) => {
      stop.abort(); // the first failure: the others stop (their AbortErrors aren't the one thrown)
      throw e;
    }),
  );
  try {
    await Promise.all(workers);
  } catch (e) {
    await Promise.allSettled(workers);
    throw o.signal?.aborted ? (o.signal.reason as Error) : e;
  }
  return { manifest: m, blob: new Blob(parts) };
}
