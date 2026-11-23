// The address over a stored machine's record (docs/frontend.md "Query parameters", docs/machines.md §5.1): a machine
// opened with `?mouse=1&ncpus=2` runs with the mouse and two vCPUs, its kept snapshot carries the shape it ran with
// (not its record's), restores on the same address, and is orphaned on the machine as its record has it. The guest is
// the firmware on a disk with nothing to boot: no Debian (it stays `booting`, which a snapshot can be taken of).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { PAGE_QUERY } from './page-query.ts';
import { answerAsks } from './page-ask.ts';
import { t } from '../web/i18n.ts';
import { words } from './words.ts';
import { openHome } from './page-home.ts';

// A guest boots on the default kernel: skipped without it (a clone without images, GitHub Actions).
const kernel = !existsSync(new URL('../target/images/linux/Image', import.meta.url)) && 'SKIPPED: run images/build.sh linux';

let base: string;
let close: () => void;
let profile: { dir: string; context: BrowserContext } | undefined;
before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  await profile?.context.close();
  if (profile) rmSync(profile.dir, { recursive: true, force: true });
  close?.();
});

const stateIs = (page: Page, ...states: string[]) => page.waitForFunction((s) => s.includes(document.body.dataset.state!), states, { timeout: 60_000, polling: 100 })
  .catch(async (e) => { throw new Error(`${e}; the page is ${await page.evaluate(() => `${document.body.dataset.state}: ${(document.getElementById('message-text')?.textContent ?? '')}`)}`); });
const inStore = <T>(page: Page, f: string, a: unknown) => page.evaluate(async ({ f, a }) => {
  const { Store } = await import('/web/app/store.ts' as string);
  const store = await Store.open();
  try {
    return await (new Function('store', 'a', `return (${f})(store, a)`))(store, a);
  } finally {
    store.close();
  }
}, { f, a }) as Promise<T>;

test('the address over a stored machine: its snapshot has the shape it ran with, restores there, and is orphaned without it', { skip: kernel, timeout: 180_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'waarm64-overrides-'));
  const context = await chromium.launchPersistentContext(dir, { executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  profile = { dir, context };
  const page = context.pages()[0] ?? await context.newPage();
  const errors: string[] = [];
  const dialogs: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page, (q) => { dialogs.push(q.text); return true; });
  await page.goto(`${base}/tests/browser/core.html`);
  const id = await page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { createDisk, createMachine, attach } = await import('/web/app/machines.ts' as string);
    const store = await Store.open();
    const m = await createMachine(store, { name: 'Overridden', ncpus: 1, ramMiB: 512, display: '2d', network: false, usb: false, mouse: false });
    await attach(store, m, await createDisk(store, { kind: 'url', url: '/tests/qcow2/deflate.qcow2', size: 1 << 20, bytes: 106496 }));
    store.close();
    return m.id as string;
  });
  const overridden = `${base}/web/app/?autostart=1&${PAGE_QUERY}m=${id}&view=terminal&mouse=1&ncpus=2`;
  await page.goto(overridden);
  await stateIs(page, 'booting', 'running');
  const status = async () => JSON.parse((await page.locator('[data-status]').getAttribute('data-status', { timeout: 30_000 })) ?? '{}') as { ncpus?: number };
  await page.waitForFunction(() => !!document.querySelector('[data-status]')?.getAttribute('data-status'), null, { timeout: 30_000 });
  assert.equal((await status()).ncpus, 2, 'it runs with the address\'s vCPUs');

  // Kept: the snapshot's shape is the run's (two vCPUs, a mouse), not the record's.
  const before = await page.locator('#message').getAttribute('data-snapshot');
  await page.locator('#save-snapshot').click();
  await page.waitForFunction(([b, src]) => document.getElementById('message')?.dataset.snapshot !== (b ?? undefined) && new RegExp(src!).test(document.getElementById('message-text')?.textContent ?? ''), [before, words('snapshots:snapshot-actions.kept', {}, { start: true }).source] as const, { timeout: 120_000 });
  const snaps = await inStore<{ id: string; shape: { ncpus: number; devices: string[] } }[]>(page, `async (store, id) => store.snapshotsOf(id)`, id);
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].shape.ncpus, 2);
  assert.ok(snaps[0].shape.devices.includes('mouse'), `devices ${snaps[0].shape.devices}`);
  const rec = await inStore<{ ncpus: number; mouse?: boolean }>(page, `async (store, id) => store.get('machines', id)`, id);
  assert.deepEqual([rec.ncpus, !!rec.mouse], [1, false], 'the record is as it was: the address doesn\'t write it');

  // Restored on the same address: the shapes match, the worker makes the same devices.
  await openHome(page);
  await page.locator('.machines [data-tab=snapshots]').click();
  await page.locator(`.machines [data-snapshot="${snaps[0].id}"]`).getByRole('button', { name: t('snapshots:Snapshots.restore') }).click();
  await page.waitForFunction(() => document.body.dataset.state !== 'booting', null, { timeout: 30_000, polling: 50 })
    .catch((e) => { throw new Error(`${e}; the last dialog: ${dialogs.at(-1)}`); });
  await stateIs(page, 'running');
  assert.equal((await status()).ncpus, 2);

  // As its record has it (no `?mouse=1`, one vCPU): the snapshot is of another shape, shown disabled.
  await page.goto(`${base}/web/app/?autostart=1&${PAGE_QUERY}m=${id}&view=terminal`);
  await stateIs(page, 'booting', 'running');
  await page.locator('#load-snapshot').click();
  const item = page.locator(`#load-snapshot [data-snapshot="${snaps[0].id}"], [data-snapshot="${snaps[0].id}"]`).first();
  await page.waitForFunction((sid) => (document.querySelector(`[data-snapshot="${sid}"]`) as HTMLButtonElement | null)?.disabled === true, snaps[0].id, { timeout: 10_000 });
  assert.ok(await item.isDisabled());
  assert.deepEqual(errors, []);
});
