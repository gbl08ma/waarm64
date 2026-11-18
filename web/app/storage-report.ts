// What the browser's storage holds for the Home page (docs/machines.md §2 "Storage"), and its persistence.
import { cacheBytes } from '../diskcache.ts';
import { shaderStoreSize } from '../venus-cache.ts';
import { msg, type Msg } from '../msg.ts';
import { machineDir, type Store } from './store.ts';

/** What the browser's storage holds for the Home page (§2 "Storage"): the estimate, persistence, and each big item's bytes. */
export async function storageReport(store: Store) {
  const est = await navigator.storage.estimate();
  const persisted = await navigator.storage.persisted();
  const items: { what: Msg; bytes: number }[] = [];
  for (const d of await store.all('disks'))
    if (d.kind === 'stored')
      items.push({
        what: msg('machines:storage-report.storage.stored', { name: d.name }),
        bytes: await store.files.size(`disks/${d.id}`),
      });
  const disks = new Map((await store.all('disks')).map((d) => [d.id, d.name]));
  for (const o of await store.all('overlays')) {
    const disk = disks.get(o.disk);
    const what =
      disk === undefined
        ? msg('machines:storage-report.storage.overlayOfNone', { overlay: o.name })
        : msg('machines:storage-report.storage.overlay', { disk, overlay: o.name });
    items.push({ what, bytes: await store.files.size(`overlays/${o.id}`) });
  }
  for (const m of await store.all('machines'))
    items.push({
      what: msg('machines:storage-report.storage.machine', { name: m.name }),
      bytes: await store.files.size(machineDir(m.id)),
    });
  const remote = await cacheBytes();
  items.push({ what: msg('machines:storage-report.storage.remote'), bytes: remote });
  // Vulkan's translated shaders (web/venus-cache.ts), the origin's for every machine.
  const shaders = (await shaderStoreSize().catch(() => ({ bytes: 0 }))).bytes;
  items.push({ what: msg('machines:storage-report.storage.shaders'), bytes: shaders });
  items.sort((a, b) => b.bytes - a.bytes);
  const usage = est.usage ?? 0;
  const counted = items.reduce((n, x) => n + x.bytes, 0);
  return {
    usage,
    quota: est.quota ?? 0,
    persisted,
    items,
    remote,
    shaders,
    counted,
    behind: countBehind(usage, counted),
  };
}

/**
 * Whether the browser's count of the origin's usage (`estimate()`) is short of the files the page lists (`counted`:
 * their sizes, a part of what the origin holds, so a count that agrees is at least this). Chromium's count has been
 * seen 19 GiB short of a stored disk's files, which the profile's directory did hold (docs/machines.md "Storage").
 * A file that grew between the two reads is no mismatch: the slack is 1% or 16 MiB, whichever is more.
 */
export const countBehind = (usage: number, counted: number) => counted - usage > Math.max(16 << 20, counted / 100);

/** Asks the browser to keep this origin's storage under pressure (§2): once, the first time something is stored. */
export async function askPersist() {
  try {
    if (!(await navigator.storage.persisted())) return await navigator.storage.persist();
    return true;
  } catch {
    return false;
  }
}
