// A disk's URL, checked when it is added (docs/plans/machines.md §4.2; what a host must give: docs/plans/remote-disks.md
// §3; a chunked image's manifest, web/chunked.ts, needs no ranges): reachable over HTTPS (or from the page's own
// origin), with CORS for the page's origin (the page is cross-origin isolated: a response without CORS doesn't reach
// it), byte ranges answered with 206, `Content-Range` exposed, and a suffix range (the end of a qcow2 is read that way
// by some tools; the page reads plain ranges, but a server that fails it is often a proxy rewriting ranges). Says what
// fails and what the server needs, in words.
import { checkManifest, isManifestUrl, type Manifest } from '../chunked.ts';

export type UrlCheck = {
  ok: boolean;
  /** What fails, each with what the server needs; empty when it is fine. */
  problems: string[];
  /** The file's size (from `Content-Range` or `Content-Length`), when known. */
  bytes?: number;
  /** The server's validators, for the disk's identity (§3.1). */
  etag?: string;
  lastModified?: string;
  /** The first bytes (a qcow2 header: its virtual size), when the range read worked. */
  head?: Uint8Array;
};

const CORS_HINT = "CORS for this page's origin: `Access-Control-Allow-Origin` (this origin or *), `Access-Control-Expose-Headers: Content-Range, Content-Length, ETag`, and `Range` allowed in answers to OPTIONS";

/** Checks `url` from this page (any origin); never throws. */
export async function checkUrl(url: string, origin = globalThis.location?.origin): Promise<UrlCheck> {
  let u: URL;
  try {
    u = new URL(url, globalThis.location?.href);
  } catch {
    return { ok: false, problems: ["This isn't a URL."] };
  }
  const problems: string[] = [];
  const sameOrigin = u.origin === origin;
  if (u.protocol !== 'https:' && !sameOrigin && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') problems.push('The URL must be HTTPS: the page is served securely and the browser blocks plain HTTP from it.');
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, problems: ['Only http(s) URLs can be disks.'] };
  const out: UrlCheck = { ok: false, problems };
  if (isManifestUrl(u.href)) return checkChunked(u, out);
  // A range read: what the disk does all the time. A failure here is the network or CORS (the browser doesn't say which).
  let r: Response;
  try {
    r = await fetch(u, { headers: { Range: 'bytes=0-511' }, cache: 'no-store' });
  } catch {
    problems.push(`The server didn't answer the page, or answered without CORS. It needs ${CORS_HINT}.`);
    return out;
  }
  if (r.status === 404) {
    problems.push('The server says there is no such file (404).');
    return out;
  }
  if (r.status === 200) {
    problems.push('The server ignores byte ranges (it sent the whole file for a range request): it must answer `Range: bytes=…` with 206 Partial Content.');
    void r.body?.cancel();
  } else if (r.status !== 206) {
    problems.push(`The server answered ${r.status} ${r.statusText} to a range request (it should be 206).`);
    return out;
  } else {
    const range = r.headers.get('content-range');
    if (!range) problems.push('The server sends Content-Range but the page can\'t see it: it needs `Access-Control-Expose-Headers: Content-Range`.');
    else out.bytes = Number(range.split('/')[1]) || undefined;
    out.head = new Uint8Array(await r.arrayBuffer());
    out.etag = r.headers.get('etag') ?? undefined;
    out.lastModified = r.headers.get('last-modified') ?? undefined;
  }
  // A suffix range: preflighted (only `bytes=a-b` is CORS-safelisted), so it also checks that OPTIONS allows `Range`.
  try {
    const s = await fetch(u, { headers: { Range: 'bytes=-512' }, cache: 'no-store' });
    if (s.status !== 206) problems.push(`The server answered ${s.status} to a suffix range (\`bytes=-512\`); it should be 206.`);
    void s.body?.cancel();
  } catch {
    problems.push("The server refused a preflighted range request: its answer to OPTIONS must allow the `Range` header (`Access-Control-Allow-Headers: Range`).");
  }
  if (out.bytes === undefined && r.status === 200) out.bytes = Number(r.headers.get('content-length')) || undefined;
  out.ok = problems.length === 0;
  return out;
}

/**
 * A chunked image (web/chunked.ts): its manifest, and its first piece's first bytes (by range, or the whole piece
 * where the host has no ranges, which a chunked image allows). The manifest's id stands as the disk's `etag`, so the
 * disk's identity follows the content (docs/plans/machines.md §3.1).
 */
async function checkChunked(u: URL, out: UrlCheck): Promise<UrlCheck> {
  const fail = (why: string) => (out.problems.push(why), out);
  let m: Manifest;
  try {
    const r = await fetch(u, { cache: 'no-store' });
    if (r.status === 404) return fail('The server says there is no such file (404).');
    if (!r.ok) return fail(`The server answered ${r.status} ${r.statusText} for the manifest.`);
    m = checkManifest(await r.json());
  } catch (e) {
    return fail(e instanceof TypeError ? `The server didn't answer the page, or answered without CORS. It needs ${CORS_HINT}.` : `The manifest isn't a chunked image's: ${(e as Error).message}.`);
  }
  try {
    const r = await fetch(new URL(m.pieces.replace('{hash}', m.hashes[0]), u), { headers: { Range: 'bytes=0-511' }, cache: 'no-store' });
    if (r.status !== 206 && r.status !== 200) return fail(`The server answered ${r.status} ${r.statusText} for the image's first piece (it should be next to the manifest, as tools/chunk-image.ts wrote it).`);
    out.head = new Uint8Array(await r.arrayBuffer()).slice(0, 512);
  } catch {
    return fail(`The server didn't give the page the image's first piece. It needs ${CORS_HINT}, for the pieces too.`);
  }
  Object.assign(out, { bytes: m.size, etag: m.id, ok: out.problems.length === 0 });
  return out;
}

/** The note the URL form shows beside a URL disk (docs/devices.md "Over HTTP": what is read once is kept in this browser). */
export const URL_SLOW = "The first boot reads it over the network, and what it read stays in this browser, so the next boots read that from here. A chunked image with a boot's reads in its manifest (tools/disk-trace.ts) first-boots about as fast as a file. To keep all of it, store it in the browser.";
