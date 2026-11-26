// The browser's grants on the file and directory handles the page keeps in IndexedDB (File System Access:
// docs/shares.md §1, docs/machines.md §3.2), asked with a bound. Chromium can leave `queryPermission` on a stored
// handle unanswered (a host folder's, seen on Linux after the computer restarted, while its settings still listed the
// folder as shared with the page): whatever awaits it waits forever, and a start that did stayed on its boot card with
// no error. Past `GRANT_WAIT_MS` the grant counts as not answered, which the caller treats as one that needs the user.

/** How long the browser gets to say whether a handle is granted, ms. */
export const GRANT_WAIT_MS = 3000;

/** `p`'s value, or undefined if it hasn't settled within `ms` (a rejection is passed on). */
export function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const t = setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

type Queried = { queryPermission?(o: { mode: 'read' | 'readwrite' }): Promise<PermissionState> };

/**
 * Whether handle `h` is granted for `mode` now: true or false as the browser says (a handle without
 * `queryPermission` is granted), undefined if it doesn't say within `ms`.
 */
export async function granted(h: Queried, mode: 'read' | 'readwrite', ms = GRANT_WAIT_MS) {
  if (!h.queryPermission) return true;
  const state = await within(h.queryPermission({ mode }), ms);
  return state === undefined ? undefined : state === 'granted';
}
