// What the page does with a demo's machine (docs/frontend.md "The demo store"; docs/decisions.md "Demos"): when a
// machine the visitor has from it was last used and whether it has changes ("started before"), and a machine checked
// before it's opened or started (its disk's files still on the server: a manifest's 404 says "this demo's files are
// gone" rather than the guest's I/O errors). DOM-free but for `fetch` and OPFS.
import { msgOf } from '../msg.ts';
import { opfsDir, overlayMeta, suspended } from '../overlay.ts';
import { fetchText } from './demo-store.ts';
import { gone } from './template.ts';
import type { MachineRecord } from './shape.ts';
import { machineDir, overlayDir, type Store } from './store.ts';

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
 * What machine `m` holds beyond its demo as it started: `none` (its first start not taken yet, or its disks' overlays
 * still the template's forks as its first start left them), `disk` (an overlay written since, or one that isn't that
 * fork: another snapshot restored, another overlay chosen) or `suspended` (a suspended copy: it resumes where it was).
 */
export async function changesOf(store: Store, m: MachineRecord): Promise<'none' | 'disk' | 'suspended'> {
  if (await suspended(machineDir(m.id)).catch(() => undefined)) return 'suspended';
  if (m.restoreFirst) return 'none'; // made, not started: the demo as it is
  for (const a of m.attachments) {
    if (!a.overlay) continue; // read-only: nothing of the machine's
    const o = await store.get('overlays', a.overlay);
    if (!o?.fork) return 'disk';
    const now = await overlayMeta(overlayDir(o.id)).catch(() => undefined);
    if (now?.generation !== o.fork.generation) return 'disk';
  }
  return 'none';
}

/** Whether `e` says a demo's files are gone (a manifest's 404: `gone`). */
export const isGone = (e: unknown) => msgOf(e)?.key === 'machines:template.gone';

/**
 * Checks that machine `m`'s disks read from a server (a chunked image's manifest) are still there: throws "this demo's
 * files are gone" for a 404, or the server unreachable, in words. `goneOnly`: only the 404 throws (a start, which goes
 * on without the server as the guest's reads would, its blocks perhaps cached).
 */
export async function checkDisks(store: Store, m: MachineRecord, o: { goneOnly?: boolean } = {}): Promise<void> {
  for (const a of m.attachments) {
    const d = await store.get('disks', a.disk);
    if (d?.kind !== 'url' || !d.url || d.identity.kind !== 'url' || !('chunked' in d.identity)) continue;
    try {
      await fetchText(d.url, { demo: true, gone: gone(d.url) });
    } catch (e) {
      if (!o.goneOnly || isGone(e)) throw e;
    }
  }
}
