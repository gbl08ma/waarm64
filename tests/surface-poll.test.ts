// The surface windows' asks (web/app/surface-poll.svelte.ts, docs/frontend.md "A disk's surface") in Chromium over
// made-up live sources (tests/browser/surface-poll.html): an answer that a newer ask of the same source replaced (a
// resize, a Refresh) isn't taken, but its reads and writes show with the next answer taken, at that answer's scale;
// several dropped in a row add up; another source's answer, dropped, carries nothing, and the picture is stale until
// the new source answers. (carryActivity itself: tests/surface.test.ts.) ~3 s.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';

let browser: Browser;
let base: string;
let close: () => void;
before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => { await browser?.close(); close?.(); });

const MiB = 2 ** 20;
type Made = { size: number; cellBytes: number; read?: number[]; write?: number[] };

async function open() {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/tests/browser/surface-poll.html`);
  await page.waitForFunction(() => window.__poll !== undefined);
  return { page, errors };
}
/** Waits for the source to have `n` asks; returns the last one's source and cells. */
async function asked(page: Page, n: number) {
  await page.waitForFunction((n) => window.__poll.asks.length >= n, n);
  return page.evaluate((n) => ({ key: window.__poll.asks[n - 1].key, cells: window.__poll.asks[n - 1].cells }), n);
}
const answer = (page: Page, i: number, m: Made) => page.evaluate(([i, m]) => window.__poll.answer(i, m), [i, m] as const);
/** The poll's state once an answer is no longer in flight (a microtask or two after it was given). */
const state = async (page: Page) => {
  await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
  return page.evaluate(() => window.__poll.state());
};

test("a replaced answer's reads and writes show with the next one taken, at its scale; another source's carry nothing", async () => {
  const { page, errors } = await open();
  await page.evaluate(() => { window.__poll.use('a'); window.__poll.room(8); });
  assert.deepEqual(await asked(page, 1), { key: 'a', cells: 8 });
  // A resize before the answer: a newer ask; the first answer, at 1 MiB a cell, is dropped.
  await page.evaluate(() => window.__poll.room(4));
  assert.deepEqual(await asked(page, 2), { key: 'a', cells: 4 });
  await answer(page, 0, { size: 8 * MiB, cellBytes: MiB, read: [1], write: [6] });
  assert.equal((await state(page)).answers, 0, 'the replaced answer is not taken');
  // The next answer, at 2 MiB a cell: its own read at cell 3, and the dropped one's at cells 0 (read) and 3 (written).
  await answer(page, 1, { size: 8 * MiB, cellBytes: 2 * MiB, read: [3] });
  assert.deepEqual(await state(page), { answers: 1, stale: false, cellBytes: 2 * MiB, activity: [1, 0, 0, 3] });

  // Two replaced in a row (a Refresh, then another) add up; the one taken had no activity of its own.
  await page.evaluate(() => window.__poll.refresh());
  await asked(page, 3);
  await page.evaluate(() => window.__poll.refresh());
  await asked(page, 4);
  await page.evaluate(() => window.__poll.refresh());
  await asked(page, 5);
  await answer(page, 2, { size: 8 * MiB, cellBytes: 2 * MiB, write: [0] });
  await answer(page, 3, { size: 8 * MiB, cellBytes: 2 * MiB, read: [2] });
  assert.equal((await state(page)).answers, 1);
  await answer(page, 4, { size: 8 * MiB, cellBytes: 2 * MiB });
  assert.deepEqual(await state(page), { answers: 2, stale: false, cellBytes: 2 * MiB, activity: [2, 0, 1, 0] });

  // Carried once: the answer after takes only its own.
  await page.evaluate(() => window.__poll.refresh());
  await asked(page, 6);
  await answer(page, 5, { size: 8 * MiB, cellBytes: 2 * MiB, read: [1] });
  assert.deepEqual((await state(page)).activity, [0, 1, 0, 0]);

  // Another source: the picture is stale until it answers, and the old source's answer, dropped, carries nothing.
  await page.evaluate(() => window.__poll.refresh());
  await asked(page, 7);
  await page.evaluate(() => window.__poll.use('b'));
  assert.deepEqual(await asked(page, 8), { key: 'b', cells: 4 });
  assert.equal((await state(page)).stale, true);
  await answer(page, 6, { size: 8 * MiB, cellBytes: 2 * MiB, read: [0, 1, 2, 3] });
  assert.equal((await state(page)).answers, 3, "the old source's answer isn't taken");
  await answer(page, 7, { size: 8 * MiB, cellBytes: 2 * MiB, write: [3] });
  assert.deepEqual(await state(page), { answers: 4, stale: false, cellBytes: 2 * MiB, activity: [0, 0, 0, 2] });
  assert.deepEqual(errors, []);
  await page.close();
});
