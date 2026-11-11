// The copy editor (docs/i18n.md "Editing the copy on the page", web/app/copy-edit*.ts) in Chromium, without a guest:
// turned on from the console, no mark left in the page's words, a message's words changed with Alt+click where they
// are shown, kept across a reload, given by `copyEdit.dump()`, forgotten by `copyEdit.clear()`; and the catalog
// written from a dump (tools/copy-apply.ts).
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { applyCopy } from '../tools/copy-apply.ts';
import { t } from '../web/i18n.ts';

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

const KEY = 'machine:main.openDisk';
const NEW = 'Choose a disk image…'; // i18n-ignore
/** The message bar's button for KEY. */
const button = (page: Page, words: string) => page.locator('#message button', { hasText: words });
/** Marks left anywhere in the page's text or attributes. */
const marks = (page: Page) => page.evaluate(() => {
  const found: string[] = [];
  if (document.body.innerText.includes('⁣')) found.push('text');
  for (const el of document.querySelectorAll('*')) for (const a of el.getAttributeNames()) if (el.getAttribute(a)!.includes('⁣')) found.push(`${el.tagName}[${a}]`);
  return found;
});
/** The marks left once the editor has had up to 5 s to take them out of what it rendered (CI's load once read them first). */
const marksSettled = async (page: Page) => {
  await page.waitForFunction(() => document.querySelector('[data-copy-edit]') && !document.body.innerText.includes('⁣')
    && ![...document.querySelectorAll('*')].some((el) => el.getAttributeNames().some((a) => el.getAttribute(a)!.includes('⁣'))), null, { timeout: 5000 }).catch(() => {});
  return marks(page);
};

test('the copy editor: words changed where they are shown, kept, dumped and forgotten', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/web/app/`);
  await button(page, t(KEY)).waitFor();
  // Off by default: no editor, no marks.
  assert.equal(await page.locator('#copy-edit').count(), 0);
  assert.equal(await page.evaluate(() => typeof (globalThis as { copyEdit?: unknown }).copyEdit), 'object');

  await page.evaluate(() => (globalThis as unknown as { copyEdit: { start(): void } }).copyEdit.start());
  await page.waitForLoadState('load');
  await page.locator('#copy-edit').waitFor({ state: 'attached' });
  await button(page, t(KEY)).waitFor();
  assert.deepEqual(await marksSettled(page), []);

  // Alt+click opens the message's entry; saved words show at once.
  await button(page, t(KEY)).click({ modifiers: ['Alt'] });
  const entry = page.locator(`#copy-edit [data-key="${KEY}"]`);
  await entry.waitFor();
  await entry.locator('textarea').fill(NEW);
  await entry.locator('[data-save]').click();
  await button(page, NEW).waitFor({ timeout: 5000 });
  const dump = async () => JSON.parse(await page.evaluate(() => (globalThis as unknown as { copyEdit: { dump(): string } }).copyEdit.dump())) as Record<string, string>;
  assert.deepEqual(await dump(), { [KEY]: NEW });

  // Kept across a reload (the editor still on), and rendered from the start.
  await page.reload();
  await button(page, NEW).waitFor();
  assert.deepEqual(await marksSettled(page), []);

  // Off again: the catalog's words; the changes kept until cleared.
  await page.evaluate(() => (globalThis as unknown as { copyEdit: { stop(): void } }).copyEdit.stop());
  await page.waitForLoadState('load');
  await button(page, t(KEY)).waitFor();
  assert.equal(await page.locator('#copy-edit').count(), 0);
  assert.deepEqual(await dump(), { [KEY]: NEW });
  await page.evaluate(() => (globalThis as unknown as { copyEdit: { clear(): void } }).copyEdit.clear());
  assert.deepEqual(await dump(), {});
  assert.deepEqual(errors, []);
  await context.close();
});

test('the catalog written from a dump: words changed, notes kept, unknown keys reported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'copy-apply-'));
  try {
    cpSync(new URL('../web/messages/en/', import.meta.url), dir, { recursive: true });
    const before = JSON.parse(readFileSync(join(dir, 'machine.json'), 'utf8'));
    const r = applyCopy(dir, { [KEY]: NEW, 'machine:nope.nope': 'x', 'nope:a.b': 'y' });
    assert.deepEqual(r.files, [join(dir, 'machine.json')]);
    assert.deepEqual(r.unknown.sort(), ['machine:nope.nope', 'nope:a.b']);
    const now = JSON.parse(readFileSync(join(dir, 'machine.json'), 'utf8'));
    assert.equal(now['main.openDisk'].message, NEW);
    assert.equal(now['main.openDisk'].note, before['main.openDisk'].note);
    assert.equal(Object.keys(now).length, Object.keys(before).length);
    // The rest of the file as it was.
    now['main.openDisk'].message = before['main.openDisk'].message;
    assert.equal(`${JSON.stringify(now, null, 2)}\n`, readFileSync(new URL('../web/messages/en/machine.json', import.meta.url), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
