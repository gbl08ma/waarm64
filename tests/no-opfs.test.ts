// A browser that refuses OPFS (Firefox's private windows: `getDirectory` throws a SecurityError): the page's store and
// the overlays fall back to memory (`hasOpfs`, web/overlay.ts), so the page loads and a machine runs.
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Before the modules load: a navigator with OPFS's entry point that refuses, and an IndexedDB that must not be opened.
Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: () => Promise.reject(new DOMException('Security error when calling GetDirectory', 'SecurityError')) } });
Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open() { throw new Error('IndexedDB opened without OPFS'); } } });
const { hasOpfs, openOverlay, saveFlash, loadFlash } = await import('../web/overlay.ts');
const { Store } = await import('../web/app/store.ts');

test('without OPFS the store and the overlays are in memory', async () => {
  assert.equal(await hasOpfs(), false);
  const store = await Store.open(); // the in-memory one: this IndexedDB throws when opened
  try {
    assert.equal(await store.files.size('machines'), 0);
  } finally {
    store.close();
  }
  const o = await openOverlay('webpc-test', 'image');
  o.data.write(new Uint8Array([7]), { at: 0 });
  o.close();
  const again = await openOverlay('webpc-test', 'image');
  const b = new Uint8Array(1);
  again.data.read(b, { at: 0 });
  again.close();
  assert.equal(b[0], 7);
  await saveFlash('webpc-test', new Uint8Array([9]));
  assert.deepEqual([...(await loadFlash('webpc-test'))!], [9]);
});
