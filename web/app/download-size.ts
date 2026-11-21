// What a download's progress counts a file as (web/app/worker-fetch.ts `download`): the bytes its body reads, which
// fetch hands over decoded. A server that compresses a file on the way (Cloudflare sends the core zstd-encoded, with
// no Content-Length) gives no such size, or a Content-Length that is the encoded one.

/** The bytes a response's body reads as: its Content-Length when the server didn't encode it, else `known` (a size
 *  recorded at build time), else undefined (not known). */
export function bodySize(headers: Headers, known?: number): number | undefined {
  const encoding = headers.get('content-encoding');
  const length = Number(headers.get('content-length'));
  if ((!encoding || encoding === 'identity') && length > 0) return length;
  return known === 0 ? undefined : known; // 0 recorded: not built, not known
}

/** The progress's total over files of `sizes`: 0 (none shown, only what arrived) unless every size is known. */
export const totalOf = (sizes: (number | undefined)[]) =>
  sizes.every((s) => s !== undefined) ? sizes.reduce<number>((a, b) => a + b, 0) : 0;
