// Vulkan's shader store as the page left it (web/venus-cache.ts: IndexedDB `waarm64-shaders`), written to a file for
// bench/vulkan/store-codecs.ts (VK4 T49's follow-up: the codecs measured on a real program's store). godot.ts and
// venus-run.ts call it at their end with STORE_DUMP set: `<out>/shader-store.json`, each entry its key, build, last use,
// whether packed and its stored bytes in base64.
import { writeFileSync } from 'node:fs';
import type { Page } from 'playwright-core';

export type DumpedEntry = { key: string; version: string; used: number; packed?: boolean; codec?: string; b64: string };

export async function dumpStore(page: Page, file: string) {
  // The store writes back a second after a change.
  await page.waitForTimeout(2500);
  const entries = await page.evaluate(() => new Promise<unknown[]>((resolve, reject) => {
    const r = indexedDB.open('waarm64-shaders');
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const g = r.result.transaction('entries', 'readonly').objectStore('entries').getAll();
      g.onerror = () => reject(g.error);
      g.onsuccess = () => {
        const b64 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
        resolve((g.result as { key: string; version: string; used: number; packed?: boolean; codec?: string; bytes: Uint8Array }[])
          .map((e) => ({ key: e.key, version: e.version, used: e.used, packed: e.packed, codec: e.codec, b64: b64(e.bytes) })));
        r.result.close();
      };
    };
  }));
  writeFileSync(file, JSON.stringify(entries));
  return entries.length;
}
