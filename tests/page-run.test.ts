// The run's lifecycle on the page (web/app/run/, docs/frontend.md "The worker protocol"), on the Buildroot guest: what
// ends a run ends all of it. The review's findings (2026-11-11) that only the page shows.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';

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
