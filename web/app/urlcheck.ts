// A disk's URL, checked when it is added (docs/machines.md §4.2; what a host must give: docs/remote-disks.md
// §3; a chunked image's manifest, web/chunked.ts, needs no ranges): reachable over HTTPS (or from the page's own
// origin), with CORS for the page's origin (the page is cross-origin isolated: a response without CORS doesn't reach
// it), byte ranges answered with 206, `Content-Range` exposed, and a suffix range (the end of a qcow2 is read that way
// by some tools; the page reads plain ranges, but a server that fails it is often a proxy rewriting ranges). Says what
// fails and what the server needs, in words.
import { checkManifest, isManifestUrl, type Manifest } from '../chunked.ts';
import { msg, msgOf, type Msg } from '../msg.ts';

export type UrlCheck = {
  ok: boolean;
  /** What fails, each with what the server needs; empty when it is fine. */
  problems: Msg[];
  /** The file's size (from `Content-Range` or `Content-Length`), when known. */
  bytes?: number;
  /** The server's validators, for the disk's identity (§3.1). */
  etag?: string;
  lastModified?: string;
  /** What a chunked image's manifest calls the image. */
  name?: string;
  /** The first bytes (a qcow2 header: its virtual size), when the range read worked. */
  head?: Uint8Array;
};

/** What a server needs for CORS, a parameter of the problems that say so. */
const CORS_HINT = msg('machines:urlcheck.corsHint');

/** Whether the page may read `u` over plain HTTP: its own origin, or this computer. */
const plainOk = (u: URL, origin: string | undefined) =>
  u.origin === origin || u.hostname === 'localhost' || u.hostname === '127.0.0.1';

/** Checks `url` from this page (any origin); never throws. */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- no location in Node's tests
export async function checkUrl(url: string, origin = globalThis.location?.origin): Promise<UrlCheck> {
  let u: URL;
  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- no location in Node's tests
    u = new URL(url, globalThis.location?.href);
  } catch {
    return { ok: false, problems: [msg('machines:urlcheck.notUrl')] };
  }
  const problems: Msg[] = [];
  if (u.protocol !== 'https:' && !plainOk(u, origin)) problems.push(msg('machines:urlcheck.https'));
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    return { ok: false, problems: [msg('machines:urlcheck.httpOnly')] };
  const out: UrlCheck = { ok: false, problems };
  if (isManifestUrl(u.href)) return checkChunked(u, out);
  const r = await checkRange(u, out);
  if (!r) return out;
  await checkSuffix(u, problems);
  if (out.bytes === undefined && r.status === 200) out.bytes = Number(r.headers.get('content-length')) || undefined;
  out.ok = problems.length === 0;
  return out;
}

/**
 * A range read: what the disk does all the time. A failure here is the network or CORS (the browser doesn't say
 * which). Fills `out` from a 206; the response, or nothing when the check ends here.
 */
async function checkRange(u: URL, out: UrlCheck): Promise<Response | undefined> {
  let r: Response;
  try {
    r = await fetch(u, { headers: { Range: 'bytes=0-511' }, cache: 'no-store' });
  } catch {
    out.problems.push(msg('machines:urlcheck.noAnswer', { needs: CORS_HINT }));
    return undefined;
  }
  if (r.status === 404) {
    out.problems.push(msg('machines:urlcheck.notFound'));
    return undefined;
  }
  if (r.status === 200) {
    out.problems.push(msg('machines:urlcheck.noRanges'));
    void r.body?.cancel();
    return r;
  }
  if (r.status !== 206) {
    out.problems.push(msg('machines:urlcheck.rangeStatus', { status: r.status, statusText: r.statusText }));
    return undefined;
  }
  const range = r.headers.get('content-range');
  if (!range) out.problems.push(msg('machines:urlcheck.hiddenRange'));
  else out.bytes = Number(range.split('/')[1]) || undefined;
  out.head = new Uint8Array(await r.arrayBuffer());
  out.etag = r.headers.get('etag') ?? undefined;
  out.lastModified = r.headers.get('last-modified') ?? undefined;
  return r;
}

/** A suffix range: preflighted (only `bytes=a-b` is CORS-safelisted), so it also checks that OPTIONS allows `Range`. */
async function checkSuffix(u: URL, problems: Msg[]): Promise<void> {
  try {
    const s = await fetch(u, { headers: { Range: 'bytes=-512' }, cache: 'no-store' });
    if (s.status !== 206) problems.push(msg('machines:urlcheck.suffixStatus', { status: s.status }));
    void s.body?.cancel();
  } catch {
    problems.push(msg('machines:urlcheck.preflight'));
  }
}

/**
 * A chunked image (web/chunked.ts): its manifest, and its first piece's first bytes (by range, or the whole piece
 * where the host has no ranges, which a chunked image allows). The manifest's id stands as the disk's `etag`, so the
 * disk's identity follows the content (docs/machines.md §3.1).
 */
async function checkChunked(u: URL, out: UrlCheck): Promise<UrlCheck> {
  const fail = (why: Msg) => (out.problems.push(why), out);
  let m: Manifest;
  try {
    const r = await fetch(u, { cache: 'no-store' });
    if (r.status === 404) return fail(msg('machines:urlcheck.notFound'));
    if (!r.ok) return fail(msg('machines:urlcheck.manifestStatus', { status: r.status, statusText: r.statusText }));
    m = checkManifest(await r.json());
  } catch (e) {
    return fail(
      e instanceof TypeError
        ? msg('machines:urlcheck.noAnswer', { needs: CORS_HINT })
        : msg('machines:urlcheck.badManifest', {
            why: msgOf(e) ?? String((e as { message?: unknown } | null | undefined)?.message ?? e),
          }),
    );
  }
  try {
    const r = await fetch(new URL(m.pieces.replace('{hash}', m.hashes[0]), u), {
      headers: { Range: 'bytes=0-511' },
      cache: 'no-store',
    });
    if (r.status !== 206 && r.status !== 200)
      return fail(msg('machines:urlcheck.pieceStatus', { status: r.status, statusText: r.statusText }));
    out.head = new Uint8Array(await r.arrayBuffer()).slice(0, 512);
  } catch {
    return fail(msg('machines:urlcheck.noPiece', { needs: CORS_HINT }));
  }
  Object.assign(out, { bytes: m.size, etag: m.id, name: m.name, ok: out.problems.length === 0 });
  return out;
}

/** The note the URL form shows beside a URL disk (docs/devices.md "Over HTTP": what is read once is kept in this browser). */
export const URL_SLOW = msg('machines:urlcheck.slow');
