// The Home page's New machine in Chromium tests (web/app/NewMachine.svelte; docs/machines.md §6.3): its dialog reads our
// demo store for templates, which a test answers with an empty store (no request leaves the machine), then its Empty
// machine makes what New machine always made: the default settings, no disks, chosen on Home.
import type { Page } from 'playwright-core';
import { OUR_STORE } from '../web/app/demo-store.ts';

const answered = new WeakSet<Page>();

/** Clicks New machine on Home (open) and its Empty machine; our store answered empty unless the test routes it. */
export async function newEmptyMachine(page: Page) {
  if (!answered.has(page)) {
    answered.add(page);
    await page.route(OUR_STORE, (r) =>
      r.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: { type: 'waarm64-store', version: 1, demos: [] } }),
    );
  }
  await page.locator('[data-action=new-machine]').click();
  await page.locator('#new-machine [data-template=empty]').click();
}
