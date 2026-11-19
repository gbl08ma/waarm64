// What the demo store's page does with a demo (docs/frontend.md "The demo store"; DEMO-KICKOFF.md decisions 11–13):
// when a machine the visitor has from it was last used ("started before"), and a machine the visitor has checked before it's opened (its disk's files still on the server: a
// manifest's 404 says "this demo's files are gone" rather than the guest's I/O errors). DOM-free but for `fetch` and
// OPFS.
import { opfsDir } from '../overlay.ts';
import { fetchText } from './demo-store.ts';
import { gone } from './template.ts';
import type { MachineRecord } from './shape.ts';
import { overlayDir, type Store } from './store.ts';

/**
 * When machine `m` was last used: the last write into its disks' overlays (a run writes there, its first start's
 * restore too), else when its record last changed.
 */
export async function lastUsed(m: MachineRecord): Promise<number> {
  let when = m.modified;
  for (const a of m.attachments) {
    if (!a.overlay) continue;
    const dir = await opfsDir(overlayDir(a.overlay)).catch(() => undefined);
    for (const f of ['data', 'map']) {
      const t = await dir
        ?.getFileHandle(f)
        .then((h) => h.getFile())
        .then((file) => file.lastModified)
        .catch(() => undefined); // not written yet: nothing to say
      if (t !== undefined) when = Math.max(when, t);
    }
  }
  return when;
}

/**
 * Checks that machine `m`'s disks read from a server (a chunked image's manifest) are still there: throws "this demo's
 * files are gone" for a 404, or the server unreachable, in words.
 */
export async function checkDisks(store: Store, m: MachineRecord): Promise<void> {
  for (const a of m.attachments) {
    const d = await store.get('disks', a.disk);
    if (d?.kind !== 'url' || !d.url || d.identity.kind !== 'url' || !('chunked' in d.identity)) continue;
    await fetchText(d.url, { demo: true, gone: gone(d.url) });
  }
}
