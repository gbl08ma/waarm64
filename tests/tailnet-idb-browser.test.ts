// What the tailnet backends keep in IndexedDB, in headless Chromium with no rig: Tailscale's node state
// (web/tailscale-state.ts) is read in one transaction, so its keys and values pair up while another writer churns the
// same profile; tailcat's kept identity (web/tailcat.ts `tailcatIdentity`) is made once when several starts race, the
// later `add`s losing and adopting the first's. The rigs' tests (tests/tailscale-browser.test.ts,
// tests/tailcat-browser.test.ts) run the clients themselves.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';

let browser: Browser;
let base: string;
let closeServer: () => void;
before(async () => {
  const server = await startServer();
  closeServer = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => {
  await browser?.close();
  closeServer?.();
});

/** A page of the dev server's origin (the test imports the modules itself), in a context of its own. */
async function originPage(): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`# page error: ${e}`));
  await page.goto(`${base}/web/tailcat.ts`);
  return page;
}

test("tailscale-state's start reads keys and values in one transaction: they pair up under another writer", { timeout: 60_000 }, async () => {
  const page = await originPage();
  try {
    const bad = await page.evaluate(async (url) => {
      const m = (await import(url)) as typeof import('../web/tailscale-state.ts');
      const profile = `p${Math.random()}`;
      const keys = Array.from({ length: 40 }, (_, i) => `k${String(i).padStart(2, '0')}`);
      // Each value names its key: a value read in another transaction than the keys lands beside the wrong one.
      const seed = await m.openState(profile);
      for (const k of keys) seed.setState(k, `v:${k}`);
      seed.close();
      // Another tab: the lowest keys deleted and put back, over and over, shifting the rest by one while it runs.
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open('waarm64-tailscale', 1);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      let churning = true;
      const churn = (async () => {
        for (let n = 0; churning; n++) {
          const k = keys[n % 4];
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('state', 'readwrite');
            const s = tx.objectStore('state');
            s.delete(`${profile}/${k}`);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('state', 'readwrite');
            tx.objectStore('state').put(`v:${k}`, `${profile}/${k}`);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
        }
      })();
      const wrong: string[] = [];
      let reads = 0;
      for (let i = 0; i < 200; i++) {
        const s = await m.openState(profile);
        const e = s.entries();
        s.close();
        reads++;
        for (const [k, v] of Object.entries(e)) if (v !== `v:${k}`) wrong.push(`${k}=${v}`);
        if (Object.keys(e).length < keys.length - 4) wrong.push(`only ${Object.keys(e).length} entries`);
      }
      churning = false;
      await churn;
      // The cleanup: the profile forgotten.
      await m.forgetProfile(profile);
      const left = Object.keys((await m.openState(profile)).entries()).length;
      db.close();
      return { wrong: wrong.slice(0, 5), reads, left };
    }, '/web/tailscale-state.ts');
    assert.deepEqual(bad.wrong, [], `each value beside its key in ${bad.reads} reads`);
    assert.equal(bad.left, 0, 'forgetting the profile leaves nothing');
  } finally {
    await page.context().close();
  }
});

test("tailcat's identity: starts that race make one, and the one kept is everyone's", { timeout: 60_000 }, async () => {
  const page = await originPage();
  try {
    const r = await page.evaluate(async (url) => {
      const m = (await import(url)) as typeof import('../web/tailcat.ts');
      const key = `race-${Math.random()}`;
      const all = await Promise.all(Array.from({ length: 6 }, () => m.tailcatIdentity(key)));
      const kept = await m.tailcatIdentity(key);
      const same = all.map((x) => x.key === kept.key && x.psk === kept.psk);
      const had = await m.hasTailcatIdentity(key);
      await m.forgetTailcatIdentity(key);
      return { same, had, gone: !(await m.hasTailcatIdentity(key)) };
    }, '/web/tailcat.ts');
    assert.deepEqual(r.same, [true, true, true, true, true, true], 'every start has the kept identity');
    assert.ok(r.had && r.gone, 'kept, then forgotten');
  } finally {
    await page.context().close();
  }
});
