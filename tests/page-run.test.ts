// The run's lifecycle on the page (web/app/run/, docs/frontend.md "The worker protocol"), on the Buildroot guest: what
// ends a run ends all of it. The review's findings (2026-11-11) that only the page shows.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { t } from '../web/i18n.ts';
import { answerAsks } from './page-ask.ts';

const IMAGES = new URL('../target/images/linux/Image', import.meta.url);
const skip = !existsSync(IMAGES) && 'SKIPPED: run images/build.sh';

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

/** The page's state once it settles (away from `from`), with the message bar's words and actions. */
const settled = (page: Page, ms = 30_000, from?: string) =>
  page.waitForFunction((from) => document.body.dataset.state !== from && ['running', 'failed', 'crashed', 'idle', 'off'].includes(document.body.dataset.state!), from, { timeout: ms, polling: 50 })
    .then(() => page.evaluate(() => ({ state: document.body.dataset.state, text: document.getElementById('message-text')?.textContent ?? '', actions: [...document.querySelectorAll('#message-actions button')].map((b) => b.textContent) })));

type Workers = { url: string; worker: Worker; terminated: boolean }[];
/** Records the page's workers (`window.__workers`): their script, and whether the page terminated them. */
const recordWorkers = (page: Page) => page.addInitScript(() => {
  const RealWorker = window.Worker;
  const all: Workers = [];
  (window as unknown as { __workers: Workers }).__workers = all;
  window.Worker = class extends RealWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      const entry = { url: String(url), worker: this as Worker, terminated: false };
      all.push(entry);
      const terminate = this.terminate.bind(this);
      this.terminate = () => { entry.terminated = true; terminate(); };
    }
  };
});

test('finding 3: an uncaught error in the machine worker says crashed and ends the run: the worker goes, the disk is free for another tab', { skip, timeout: 120_000 }, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await recordWorkers(page);
  await page.goto(`${base}/web/app/?machine=buildroot&ncpus=1&view=terminal`);
  assert.equal((await settled(page)).state, 'running');
  await page.evaluate(() => {
    const w = (window as unknown as { __workers: Workers }).__workers.find((x) => /\/app\/worker\.ts/.test(x.url))!;
    w.worker.onerror!(new ErrorEvent('error', { message: 'planted' }));
  });
  assert.equal(await page.evaluate(() => document.body.dataset.state), 'crashed');
  await page.waitForFunction(() => (window as unknown as { __workers: Workers }).__workers.filter((x) => /\/app\/worker\.ts/.test(x.url)).every((x) => x.terminated), null, { timeout: 10_000, polling: 100 });
  const second = await ctx.newPage(); // the disk was the first tab's: free now
  await second.goto(`${base}/web/app/?machine=buildroot&ncpus=1&view=terminal`);
  const r = await settled(second, 60_000);
  assert.equal(r.state, 'running', r.text);
  await ctx.close();
});

/** Makes stored machine `name` with a blank disk in the page's store (as the Machines page would); returns its id. */
const makeMachine = (page: Page, name: string) => page.evaluate(async (name) => {
  const { Store } = await import('/web/app/store.ts' as string);
  const { newId } = await import('/web/app/shape.ts' as string);
  const store = await Store.open();
  const now = Date.now();
  const disk = newId();
  await store.put('disks', { id: disk, kind: 'blank', name: 'blank.img', size: 64 << 20, identity: { kind: 'blank', id: disk, bytes: 64 << 20 }, created: now });
  const id = newId();
  await store.put('machines', { id, name, ncpus: 1, ramMiB: 512, display: '2d', network: false, attachments: [{ id: newId(), disk, readOnly: false }], created: now, modified: now });
  store.close();
  return id as string;
}, name);

test("finding 4: a machine opened from the Machines page whose last tab was killed doesn't start: the memory signal's choices first", { timeout: 60_000 }, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await answerAsks(page);
  await page.goto(`${base}/web/app/?clocksync=0&view=terminal`); // the page's machine, waiting for a disk
  const id = await makeMachine(page, 'Killed');
  await page.evaluate(async (id) => {
    const { markAlive } = await import('/web/app/memory.ts' as string);
    markAlive(id, { name: 'Killed', ramMiB: 512, ncpus: 1, jitMiB: 256, gib: 1.5, peakGiB: 1.6, t: Date.now() - 3_600_000 });
  }, id);
  await page.click('#machines-open');
  await page.locator('.machines .pick', { hasText: 'Killed' }).click();
  await page.locator('.machines section.machine[data-selected] [data-action=open]').click();
  await page.waitForFunction((asIs) => document.body.dataset.state === 'idle' && [...document.querySelectorAll('#message-actions button')].some((b) => b.textContent === asIs), t('machine:memory-signal.crashed.asIs'), { timeout: 10_000, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the page is ${await page.evaluate(() => `${document.body.dataset.state}: ${document.getElementById('message-text')?.textContent}`)}`); });
  await ctx.close();
});
