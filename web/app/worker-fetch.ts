// What the machine worker (web/app/worker.ts) fetches to start a machine: the core, the kernel and initrd whole (with
// their progress posted), the disks' presence; a file that isn't there is a failure a user can act on.
import { msg, MsgError } from '../msg.ts';
import type { Machine } from './machine.ts';
import { failure } from './worker-errors.ts';
import { post } from './worker-post.ts';

export const CORE = new URL('../../target/wasm32-unknown-unknown/release/waarm64_core.wasm', import.meta.url).href;
/** A URL as the user knows it: a path in the repository. */
const repoPath = (url: string) => new URL(url).pathname.replace(/^\//, '');

/** Why the file at `url` couldn't be fetched (the server's answer, `status`), as a failure a user can act on. */
function missing(url: string, machine: Machine, status: number) {
  const why =
    status === 404
      ? msg('machine:worker-fetch.http.notFound', { status })
      : msg('machine:worker-fetch.http', { status });
  if (url === CORE)
    return failure(
      'missing-core',
      msg('machine:worker-fetch.noCore'),
      new MsgError('machine:worker-fetch.noCore.cause', { path: repoPath(url), why }),
    );
  return failure(
    'missing-image',
    msg('machine:worker-fetch.noImage', { machine: machine.title }),
    new MsgError('machine:worker-fetch.noImage.cause', { path: repoPath(url), why, prepare: machine.prepare }),
  );
}

/** Checks the disks at `urls` are there (they're read by ranges as the guest needs them, not downloaded). */
export const checkDisks = (urls: string[], machine: Machine) =>
  Promise.all(
    urls.map((url) =>
      fetch(url, { method: 'HEAD' }).then((r) => {
        if (!r.ok) throw missing(url, machine, r.status);
      }),
    ),
  );

/** The response for `url`, or a failure that says why there's none. */
async function get(url: string, machine: Machine) {
  const r = await fetch(url).catch((err: unknown) => {
    throw failure(
      url === CORE ? 'missing-core' : 'missing-image',
      msg('machine:worker-fetch.noServer', { path: repoPath(url) }),
      new MsgError('machine:worker-fetch.noServer.cause', undefined, { cause: err }),
    );
  });
  if (!r.ok) throw missing(url, machine, r.status);
  return r;
}

/** A response's body whole: `size` bytes as announced (any past them kept too); `read` counts each part as it comes. */
async function body(r: Response, size: number, read: (n: number) => void, stopped: () => boolean) {
  const out = new Uint8Array(size);
  const parts: Uint8Array[] = []; // past the announced length (none expected)
  let at = 0;
  if (!r.body) throw new Error(`no body in the response for ${r.url}`);
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done || stopped()) break;
    if (at + value.length <= out.length) out.set(value, at);
    else parts.push(value);
    at += value.length;
    read(value.length);
  }
  if (!parts.length && at === out.length) return out;
  const all = new Uint8Array(at);
  all.set(out.subarray(0, Math.min(at, out.length)));
  for (let k = out.length, j = 0; j < parts.length; k += parts[j++].length) all.set(parts[j], k);
  return all;
}

/** Fetches `urls` whole, posting the progress over all of them (Content-Length; the server sends it). */
export async function download(urls: string[], machine: Machine, stopped: () => boolean) {
  const responses = await Promise.all(urls.map((url) => get(url, machine)));
  const sizes = responses.map((r) => Number(r.headers.get('content-length')) || 0);
  const total = sizes.reduce((a, b) => a + b, 0);
  let loaded = 0;
  let posted = 0;
  const progress = (force = false) => {
    const now = performance.now();
    if (force || now - posted >= 100) {
      posted = now;
      post({ type: 'progress', loaded, total });
    }
  };
  progress(true);
  const read = (n: number) => {
    loaded += n;
    progress();
  };
  const files = await Promise.all(responses.map((r, i) => body(r, sizes[i], read, stopped)));
  progress(true);
  return files;
}
