// The page's questions (web/app/ask.svelte.ts, Ask.svelte) in Chromium, without a guest: a question its caller takes
// down (a wait's `close`, `closableConfirm`'s) leaves the dialog, shown or queued. `asking.current` holds Svelte's proxy
// of the question, never equal to it: compared with it, the clean stop's "Shutting down" stayed open after the guest's
// power-off, over the export and the next boot.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
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

test('a question taken down by its caller leaves the dialog, shown or queued', { timeout: 30_000 }, async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/tests/browser/core.html`);
  const r = await page.evaluate(async () => {
    const { ask, asking, answer } = await import('/web/app/ask.svelte.ts' as string);
    const shown = () => asking.current?.text ?? null;
    const out: Record<string, unknown> = {};
    // A wait closed while shown: gone, nothing after it.
    const w = ask.wait('wait');
    out.waitShown = shown();
    w.close();
    out.afterWait = shown();
    // A closable question closed while shown: Cancel's answer, the next one shown.
    const c = ask.closableConfirm('closable');
    const after = ask.confirm('after');
    out.closableShown = shown();
    c.close();
    out.closableAnswer = await c.answer;
    out.afterClosable = shown();
    // Closed while queued behind `after`: taken out of the queue, never shown.
    const queued = ask.wait('queued');
    queued.close();
    answer(true);
    out.afterAnswer = await after;
    out.afterQueued = shown();
    return out;
  });
  assert.deepEqual(r, {
    waitShown: 'wait',
    afterWait: null,
    closableShown: 'closable',
    closableAnswer: false,
    afterClosable: 'after',
    afterAnswer: true,
    afterQueued: null,
  });
  await page.close();
});

test("a question whose words are an error draws them as the page draws errors: a message's names, a developer's words as code", { timeout: 30_000 }, async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/web/app/?autostart=1`);
  await page.locator('#message-text').waitFor();
  const r = await page.evaluate(async () => {
    const { ask } = await import('/web/app/ask.svelte.ts' as string);
    const { describe, MsgError } = await import('/web/i18n.ts' as string);
    void ask.confirm(describe(new MsgError('disks:ResizeDisk.title', { name: 'disk-1' }, { cause: new Error('boom-1') })));
    const d = document.getElementById('ask')!;
    for (let i = 0; i < 100 && !d.querySelector('.ask-text code'); i++) await new Promise((res) => setTimeout(res, 20));
    return { name: d.querySelector('.ask-text .name')?.textContent, code: d.querySelector('.ask-text code')?.textContent, text: d.querySelector('.ask-text')?.textContent };
  });
  assert.deepEqual({ name: r.name, code: r.code }, { name: 'disk-1', code: 'boom-1' }, JSON.stringify(r));
  assert.match(r.text ?? '', /disk-1\nboom-1/);
  await page.close();
});

test('a question answered the moment its dialog opens: no error from the focus after it', { timeout: 30_000 }, async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/web/app/?autostart=1`);
  await page.locator('#message-text').waitFor();
  const r = await page.evaluate(async () => {
    const { ask, asking } = await import('/web/app/ask.svelte.ts' as string);
    const d = document.getElementById('ask') as HTMLDialogElement;
    // OK clicked from a mutation observer: its callback runs before the dialog's queued focus.
    new MutationObserver(() => { if (d.open) d.querySelector<HTMLButtonElement>('[data-answer=ok]')?.click(); }).observe(d, { attributes: true, subtree: true, childList: true });
    const answers = [await ask.confirm('first'), await ask.prompt('second', 'text')];
    await new Promise((res) => setTimeout(res, 100));
    return { answers, open: d.open, shown: asking.current?.text ?? null };
  });
  assert.deepEqual(r, { answers: [true, 'text'], open: false, shown: null });
  assert.deepEqual(errors, []);
  await page.close();
});
