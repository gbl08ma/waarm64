// The Home page (web/app/MachinesPage.svelte, docs/machines.md §7) and the URL check (web/app/urlcheck.ts) in
// Chromium, without a guest: a machine made, set and given disks from several sources through the modal's controls,
// kept across a reload, opened on the page; a URL refused with the reason when its server lacks CORS or ranges.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { t } from '../web/i18n.ts';
import { answerAsks } from './page-ask.ts';
import { words } from './words.ts';
import { MAX_RESIZE } from '../web/app/resize.ts';
import { newEmptyMachine, openHome } from './page-home.ts';

const DEMO = { format: 'waarm64-chunked-1', name: 'Desktop Demo', size: 4096, piece: 1 << 20, pieces: 'pieces/{hash}.bin', hashes: ['0'.repeat(64)], id: createHash('sha256').update('0'.repeat(64)).digest('hex') };
let browser: Browser;
let base: string;
let close: () => void;
/**
 * Another origin: serves 4 KiB at /disk.img, with CORS and ranges, or without (`/plain/…`), or ignoring ranges (`/noranges/…`);
 * at /c/demo.json a chunked image's manifest of it, named.
 */
let other: Server;
let otherBase: string;
before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const body = Buffer.alloc(4096, 7);
  other = createServer((req, res) => {
    const cors = !req.url!.startsWith('/plain/');
    if (cors) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, ETag');
      res.setHeader('Access-Control-Allow-Headers', 'Range');
    }
    res.setHeader('ETag', '"v1"');
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();
    if (req.url === '/c/demo.json') return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(DEMO));
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
    if (!m || req.url!.startsWith('/noranges/')) return void res.writeHead(200, { 'Content-Length': body.length }).end(body);
    const [a, b] = m[1] === '' ? [body.length - Number(m[2]), body.length - 1] : [Number(m[1]), Math.min(Number(m[2] || body.length - 1), body.length - 1)];
    res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${body.length}`, 'Content-Length': b - a + 1 }).end(body.subarray(a, b + 1));
  });
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  otherBase = `http://localhost:${(other.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => { await browser?.close(); close?.(); other?.close(); });

test('the URL check: what a disk server needs, said when it lacks it', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${base}/tests/browser/core.html`);
  const check = (url: string) => page.evaluate(async (url) => {
    const { checkUrl } = await import('/web/app/urlcheck.ts' as string);
    const r = await checkUrl(url);
    return { ok: r.ok, problems: r.problems.map((p: { key: string }) => p.key), bytes: r.bytes, etag: r.etag, ...(r.chunked ? { chunked: r.chunked } : {}), ...(r.name ? { name: r.name } : {}) };
  }, url);
  // A chunked image's manifest: its id the identity (wherever it's hosted), its name the disk's.
  assert.deepEqual(await check(`${otherBase}/c/demo.json`), { ok: true, problems: [], bytes: 4096, etag: undefined, chunked: DEMO.id, name: 'Desktop Demo' });
  // The dev server's files (sirv): a weak ETag of the size and modification time.
  const raw = await check(`${base}/tests/qcow2/data.raw`);
  assert.deepEqual({ ...raw, etag: undefined }, { ok: true, problems: [], bytes: 196608, etag: undefined });
  assert.match(raw.etag ?? '', /^W\/"196608-\d+"$/);
  assert.deepEqual(await check(`${otherBase}/disk.img`), { ok: true, problems: [], bytes: 4096, etag: '"v1"' });
  const plain = await check(`${otherBase}/plain/disk.img`);
  assert.equal(plain.ok, false);
  assert.ok(plain.problems.includes('machines:urlcheck.noAnswer'), plain.problems.join(' '));
  const noRanges = await check(`${otherBase}/noranges/disk.img`);
  assert.ok(noRanges.problems.includes('machines:urlcheck.noRanges'), noRanges.problems.join(' '));
  assert.ok((await check(`${base}/no/such.img`)).problems.includes('machines:urlcheck.notFound'));
  await context.close();
});

test('a machine opened by `?disk=` on a chunked image is called what its manifest names it', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await answerAsks(page);
  await page.goto(`${base}/web/app/?disk=${encodeURIComponent(`${otherBase}/c/demo.json`)}`);
  await page.waitForFunction(() => document.getElementById('machine')?.textContent === 'Desktop Demo', undefined, { timeout: 30_000 });
  await context.close();
});

const modal = (page: Page) => page.locator('.machines');
/** Add a disk…: the wizard's source, then its fields; Add. `again`: the wizard is open still (a refused add), its fields filled anew. */
async function addDisk(page: Page, source: string, fields: Record<string, string>, again = false) {
  if (!again) {
    await page.locator('#add-disk').waitFor({ state: 'detached' }); // the last add's wizard closes after its disk shows
    await page.locator('[data-action=add-disk-open]').click();
    await page.locator(`#add-disk [data-source=${source}]`).click();
  }
  for (const [k, v] of Object.entries(fields)) {
    const f = page.locator(`#add-disk [data-field=${k}]`);
    await (k.endsWith('-unit') ? f.selectOption(v) : f.fill(v));
  }
  await page.locator('#add-disk [data-action=add-disk]').click();
}
/** Waits for the machine's `n`-th disk in the modal; on a timeout, says the modal's error. */
const disk = (page: Page, n: number) => page.locator('.machines section.machine [data-attachment]').nth(n).waitFor({ timeout: 30_000 })
  .catch(async (e) => { throw new Error(`${e}; the modal says: ${await page.locator('.machines').textContent()}`); });

test('the modal makes a machine, sets it, gives it disks from several sources, keeps it across a reload and opens it', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/`);
  await openHome(page);
  await newEmptyMachine(page);
  const m = modal(page).locator('section.machine[data-selected]');
  await m.waitFor();
  const id = await m.getAttribute('data-selected');
  await m.locator('[data-field=name]').fill('Workbench');
  await m.locator('[data-field=ncpus]').fill('2');
  await m.locator('[data-field=ram]').fill('1024');
  await m.locator('[data-field=jit]').fill('128');
  await m.locator('[data-field=display]').selectOption('2d');
  // The keyboard layout: a new machine follows the browser, with its note; none set, no note; "Match this browser" answers either way.
  assert.equal(await m.locator('[data-field=keyboard] option:checked').textContent(), t('machines:KeyboardField.keyboard.follow'));
  const followNote = await m.locator('[data-keyboard-note]').textContent() ?? '';
  assert.ok(['machines:KeyboardField.keyboard.followNote.now', 'machines:KeyboardField.keyboard.followNote'].some((k) => words(k, {}, { whole: true }).test(followNote)), followNote);
  await m.locator('[data-field=keyboard]').selectOption({ index: 0 });
  assert.equal(await m.locator('[data-keyboard-note]').count(), 0);
  await m.locator('[data-action=match-keyboard]').click();
  await m.locator('[data-keyboard-match]').waitFor();
  await m.locator('[data-field=keyboard]').selectOption({ label: t('machines:keyboard.pt') });
  assert.match(await m.locator('[data-keyboard-note]').textContent() ?? '', words('machines:KeyboardField.keyboard.setNote', {}, { whole: true }));
  await m.locator('[data-action=save]').click();
  await modal(page).locator('.pick', { hasText: 'Workbench' }).waitFor();
  // The network's settings in the guest (the Network tab): on for a new machine, with its note; off is saved as false.
  await m.locator('[data-tab=network]').click();
  assert.equal(await m.locator('[data-field=net-config]').isChecked(), true);
  assert.match(await m.locator('[data-net-config-note]').textContent() ?? '', words('machines:NetworkTab.netConfig.on', {}, { whole: true }));
  await m.locator('[data-field=net-config]').uncheck();
  assert.match(await m.locator('[data-net-config-note]').textContent() ?? '', words('machines:NetworkTab.netConfig.off', {}, { whole: true }));
  await m.locator('[data-action=save]').click();
  await page.waitForFunction(() => document.querySelector('.machines [data-action=save]')?.hasAttribute('disabled'));
  // A URL disk (checked), a blank one, a ramdisk; a URL whose server lacks CORS is refused with the reason (the wizard stays open).
  await m.locator('[data-tab=disks]').click();
  await addDisk(page, 'url', { url: `${otherBase}/plain/disk.img` });
  await page.locator('#add-disk .error', { hasText: words('machines:urlcheck.noAnswer', { needs: t('machines:urlcheck.corsHint') }) }).waitFor();
  await addDisk(page, 'url', { url: `${base}/tests/qcow2/deflate.qcow2` }, true);
  await disk(page, 0);
  await addDisk(page, 'blank', { 'size-unit': 'MiB', size: '64' });
  await disk(page, 1);
  await addDisk(page, 'ramdisk', { 'size-unit': 'MiB', size: '32' });
  await disk(page, 2);
  // A disk with an overlay (New empty) has Export…, a wizard: the changes or the whole disk, then the format (raw for the
  // whole disk only), Back between them; a blank disk has no changes of its own and starts at the format.
  const exporting = page.locator('#export');
  const saves = async () => exporting.locator('[data-save]').evaluateAll((els) => els.map((e) => e.getAttribute('data-save')));
  await m.locator('[data-attachment]').nth(0).getByRole('button', { name: t('disks:Disks.newEmpty') }).click();
  await m.locator('[data-attachment]').nth(0).locator('[data-action=export]').click();
  assert.match((await exporting.locator('h2').textContent())!, words('disks:ExportSteps.title', {}, { whole: true }));
  assert.equal(await exporting.locator('[data-action=export-back]').count(), 0);
  await exporting.locator('[data-export=changes]').click();
  assert.equal(await exporting.locator('h2').textContent(), t('disks:ExportSteps.title.changes'));
  assert.deepEqual(await saves(), ['compressed', 'qcow2']);
  await exporting.locator('[data-action=export-back]').click();
  await exporting.locator('[data-export=whole]').click();
  assert.equal(await exporting.locator('h2').textContent(), t('disks:ExportSteps.title.whole'));
  assert.deepEqual(await saves(), ['compressed', 'qcow2', 'raw']);
  await exporting.locator('[data-action=export-cancel]').click();
  await exporting.waitFor({ state: 'detached' });
  await m.locator('[data-attachment]').nth(1).getByRole('button', { name: t('disks:Disks.newEmpty') }).click();
  await m.locator('[data-attachment]').nth(1).locator('[data-action=export]').click();
  assert.equal(await exporting.locator('h2').textContent(), t('disks:ExportSteps.title.whole'));
  assert.deepEqual(await saves(), ['compressed', 'qcow2', 'raw']);
  assert.equal(await exporting.locator('[data-action=export-back]').count(), 0);
  await page.keyboard.press('Escape');
  await exporting.waitFor({ state: 'detached' });

  const record = () => page.evaluate(async (id) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    const m = await store.get('machines', id);
    const disks = await Promise.all(m.attachments.map((a: { disk: string }) => store.get('disks', a.disk)));
    store.close();
    return { name: m.name, ncpus: m.ncpus, ramMiB: m.ramMiB, jitMiB: m.jitMiB, keyboard: m.keyboard, netConfig: m.netConfig, display: m.display, disks: disks.map((d: { kind: string; size: number }) => [d.kind, d.size]), readOnly: m.attachments.map((a: { readOnly: boolean }) => a.readOnly) };
  }, id);
  const want = { name: 'Workbench', ncpus: 2, ramMiB: 1024, jitMiB: 128, keyboard: 'pt', netConfig: false, display: '2d', disks: [['url', 1 << 20], ['blank', 64 << 20], ['ramdisk', 32 << 20]], readOnly: [false, false, false] };
  const got = await record();
  assert.ok((got.disks[0][1] as number) > 0);
  assert.deepEqual({ ...got, disks: got.disks.slice(1) }, { ...want, disks: want.disks.slice(1) });
  // Reordered and read-only from the list; detached.
  await m.locator('[data-attachment]').nth(1).getByRole('button', { name: t('common:MoveButtons.up') }).click();
  await page.waitForFunction(async (id) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    const m = await store.get('machines', id);
    const first = await store.get('disks', m.attachments[0].disk);
    store.close();
    return first.kind === 'blank';
  }, id);
  // The list shows the move too (it rereads after the store): the rows are keyed, so the blank disk's row moves without
  // being replaced, and a locator resolved before then holds its disabled box and waits for it forever.
  await m.locator('[data-attachment]').nth(0).locator('.meta', { hasText: words('disks:disk-lines.meta', { kind: t('disks:disk-kind.blank') }, { start: true }) }).waitFor();
  await m.locator('[data-attachment]').nth(1).locator('.meta', { hasText: words('disks:disk-lines.meta', { kind: t('disks:disk-kind.url') }, { start: true }) }).waitFor();
  await m.locator('[data-attachment]').nth(1).getByRole('checkbox', { name: t('disks:Disks.readOnly') }).check();
  await page.waitForFunction(async (id) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    const m = await store.get('machines', id);
    store.close();
    return m.attachments[1].readOnly === true;
  }, id);
  // Only the ramdisk has a swap box (web/app/guest-swap.ts); checked, the record says so.
  assert.equal(await m.locator('[data-attachment]').getByRole('checkbox', { name: t('disks:Disks.swap') }).count(), 1);
  await m.locator('[data-attachment]').nth(2).getByRole('checkbox', { name: t('disks:Disks.swap') }).check();
  await page.waitForFunction(async (id) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    const m = await store.get('machines', id);
    store.close();
    return m.attachments[2].swap === true;
  }, id);
  await m.locator('[data-attachment]').nth(2).getByRole('button', { name: t('disks:Disks.detach.button') }).click();
  await page.waitForFunction(() => document.querySelectorAll('.machines [data-attachment]').length === 2);

  // Kept across a reload (the Home page stays open: `#home`), and opened on the page: the toolbar names it.
  await page.reload();
  await modal(page).waitFor();
  await modal(page).locator('.pick', { hasText: 'Workbench' }).click();
  await m.locator('[data-action=open]').click();
  await page.waitForURL(new RegExp(`[?&]m=${id}`));
  await page.waitForFunction(() => (document.getElementById('machine')?.textContent ?? '') === 'Workbench');
  assert.deepEqual(errors, []);
  await context.close();
});

test('a machine edited on the Home page while it is off on this page starts as it is now', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/`);
  await openHome(page);
  await newEmptyMachine(page);
  const m = modal(page).locator('section.machine[data-selected]');
  await m.locator('[data-action=open]').click();
  // On the page with no disks: it waits, and the Home page offers Start (not a disabled "on this page").
  await page.waitForFunction((src) => document.body.dataset.state === 'idle' && new RegExp(src).test((document.getElementById('message-text')?.textContent ?? '')), words('disks:power-actions.noDisks').source, { timeout: 10_000 });
  await openHome(page);
  await m.locator('[data-tab=disks]').click();
  await addDisk(page, 'blank', { 'size-unit': 'MiB', size: '64' });
  await disk(page, 0);
  assert.equal(await m.locator('[data-action=start]').isEnabled(), true);
  await m.locator('[data-action=start]').click();
  // It starts with the disk added since it was opened (the firmware loads and boots; a stale record would wait again).
  await page.waitForFunction(() => ['loading', 'booting', 'running'].includes(document.body.dataset.state!), null, { timeout: 30_000 });
  // The floating bar's words (the Home page, closing, may still be fading out with its own banner).
  // (A floating bar leaving keeps its words for its 250 ms: the words gone, not at once.)
  await page.waitForFunction((src) => !new RegExp(src).test(document.querySelector('#message #message-text')?.textContent ?? ''), words('disks:power-actions.noDisks').source, { timeout: 5_000 });
  assert.deepEqual(errors, []);
  await context.close();
});

test('Home: a tab counts only what it holds; Back to the machine and Esc lead back once a machine is on the page; Ctrl+click flips a menu\'s switch', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/`);
  // Ctrl+click on a menu's button flips its switch and leaves the menu closed: the sound, the mouse lock, the
  // on-screen keyboard.
  const quick = async (menu: string) => {
    await page.locator(`#${menu} > summary`).click({ modifiers: ['Control'] });
    assert.equal(await page.locator(`#${menu}`).getAttribute('open'), null, `${menu} stays closed`);
  };
  const soundOn = () => page.locator('#sound-on').isChecked();
  // The tooltip's second line says what a Ctrl+click would do now.
  const hint = async (menu: string) => (await page.locator(`#${menu} > summary`).getAttribute('title'))?.split('\n')[1];
  const was = await soundOn();
  assert.equal(await hint('sound-menu'), t(was ? 'sound:Sound.quick.off' : 'sound:Sound.quick.on', { key: 'Ctrl' }));
  await quick('sound-menu');
  assert.equal(await soundOn(), !was);
  assert.equal(await hint('sound-menu'), t(was ? 'sound:Sound.quick.on' : 'sound:Sound.quick.off', { key: 'Ctrl' }));
  await quick('sound-menu');
  assert.equal(await soundOn(), was);
  const lock = () => page.locator('#mouse-lock').getAttribute('data-on');
  await quick('mouse-lock');
  assert.equal(await lock(), 'true');
  await quick('mouse-lock');
  assert.equal(await lock(), null);
  assert.equal(await hint('keys'), t('toolbar:KeysMenu.quick.show', { key: 'Ctrl' }));
  await quick('keys');
  assert.equal(await page.locator('#osk-toggle').getAttribute('aria-pressed'), 'true');
  assert.equal(await hint('keys'), t('toolbar:KeysMenu.quick.hide', { key: 'Ctrl' }));
  await quick('keys');
  assert.equal(await page.locator('#osk-toggle').getAttribute('aria-pressed'), 'false');

  const home = page.locator('#machines-open');
  const back = page.locator('[data-action=back-to-machine]');
  await openHome(page);
  await newEmptyMachine(page);
  const m = modal(page).locator('section.machine[data-selected]');
  // An empty machine: one network adapter, nothing else; a tab holding none shows no count.
  await m.locator('[data-tab=settings]').waitFor();
  const counts = await m.locator('[data-tab]').evaluateAll((tabs) =>
    Object.fromEntries(tabs.map((b) => [(b as HTMLElement).dataset.tab, b.querySelector('.count')?.textContent ?? null])),
  );
  assert.deepEqual(counts, { settings: null, disks: null, network: '1', usb: null, folders: null, snapshots: null });
  // No machine on the page yet: no way back, and Esc keeps Home.
  assert.equal(await back.count(), 0);
  await page.keyboard.press('Escape');
  assert.equal(await home.getAttribute('aria-pressed'), 'true');
  await m.locator('[data-action=open]').click();
  await page.waitForFunction(() => document.body.dataset.state === 'idle', null, { timeout: 10_000 });
  // On the page: the list's foot leads back, and so does Esc, but not from a field being typed in.
  await openHome(page);
  await back.click();
  assert.equal(await home.getAttribute('aria-pressed'), 'false');
  await openHome(page);
  await m.locator('[data-tab=settings]').click();
  await m.locator('[data-field=name]').press('Escape');
  assert.equal(await home.getAttribute('aria-pressed'), 'true', 'Esc in a field keeps Home');
  await m.locator('[data-tab=settings]').click();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('machines-open')?.getAttribute('aria-pressed') === 'false', null, { timeout: 5_000 });
  assert.deepEqual(errors, []);
  await context.close();
});

test("Add a disk's size (ui/SizeField.svelte): a number and its unit, the same size across a unit's change, refused empty or past the most, the disk made that size", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/`);
  await openHome(page);
  await newEmptyMachine(page);
  const m = modal(page).locator('section.machine[data-selected]');
  await m.locator('[data-tab=disks]').click();
  await page.locator('[data-action=add-disk-open]').click();
  await page.locator('#add-disk [data-source=blank]').click();
  const d = page.locator('#add-disk');
  const [amount, unit, add] = [d.locator('[data-field=size]'), d.locator('[data-field=size-unit]'), d.locator('[data-action=add-disk]')];
  assert.deepEqual([await amount.inputValue(), await unit.inputValue()], ['1', 'GiB'], 'a GiB to start with');
  // A unit's change keeps the size: 1 GiB is 1024 MiB.
  await unit.selectOption('MiB');
  assert.equal(await amount.inputValue(), '1024');
  // Empty: said under it, and Add is off.
  await amount.fill('');
  assert.equal(await d.locator('[data-size-problem]').textContent(), t('common:SizeField.empty'));
  assert.equal(await add.isDisabled(), true);
  // Past the most (the largest the page grows a disk to), in TiB.
  await unit.selectOption('TiB');
  await amount.fill('9');
  assert.equal(await d.locator('[data-size-problem]').textContent(), t('common:SizeField.large', { max: MAX_RESIZE }));
  assert.equal(await add.isDisabled(), true);
  // 1.5 GiB: no problem, and the disk is made that size.
  await unit.selectOption('GiB');
  await amount.fill('1.5');
  assert.equal(await d.locator('[data-size-problem]').count(), 0);
  await add.click();
  await disk(page, 0);
  const sizes = await page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    const disks = await store.all('disks');
    store.close();
    return disks.map((x: { size: number }) => x.size);
  });
  assert.deepEqual(sizes, [1536 * 2 ** 20]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("a 3D machine's Vulkan box: beside 3D only, its shape note, saved and kept over a reload", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/`);
  await openHome(page);
  await newEmptyMachine(page);
  const m = modal(page).locator('section.machine[data-selected]');
  await m.waitFor();
  const id = await m.getAttribute('data-selected');
  await m.locator('[data-field=name]').fill('Vk box');
  // A new machine is 3D, Vulkan off; it has no snapshots, so checking it says nothing of them.
  assert.equal(await m.locator('[data-field=vulkan]').isChecked(), false);
  await m.locator('[data-field=vulkan]').check();
  assert.equal(await m.locator('[data-vulkan-orphans]').count(), 0);
  // 2D has no Vulkan: the box goes; back to 3D, it is as it was.
  await m.locator('[data-field=display]').selectOption('2d');
  assert.equal(await m.locator('[data-field=vulkan]').count(), 0);
  await m.locator('[data-field=display]').selectOption('3d');
  assert.equal(await m.locator('[data-field=vulkan]').isChecked(), true);
  await m.locator('[data-action=save]').click();
  await page.waitForFunction(() => (document.querySelector('.machines [data-action=save]') as HTMLButtonElement | null)?.disabled !== false, null, { polling: 100 });
  const stored = () => page.evaluate(async (id) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { currentShape } = await import('/web/app/snapshots.ts' as string);
    const store = await Store.open();
    const rec = await store.get('machines', id);
    store.close();
    return { vulkan: rec.vulkan, shape: (await currentShape(rec, () => undefined)).shape.vulkan };
  }, id);
  assert.deepEqual(await stored(), { vulkan: true, shape: true });
  // With a kept snapshot, unchecking it says what it does to them.
  await page.evaluate(async (id) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { currentShape } = await import('/web/app/snapshots.ts' as string);
    const store = await Store.open();
    const { shape, hash } = await currentShape(await store.get('machines', id), () => undefined);
    await store.put('snapshots', { id: 'cccccccccccc', machine: id, name: 'Before', created: 1, bytes: 1, shape, shapeHash: hash, pins: [] });
    store.close();
  }, id);
  await page.reload();
  await modal(page).waitFor();
  await modal(page).locator('.pick', { hasText: 'Vk box' }).click();
  await modal(page).locator(`[data-selected="${id}"]`).waitFor();
  assert.equal(await modal(page).locator('section.machine [data-field=vulkan]').isChecked(), true);
  assert.equal(await modal(page).locator('section.machine [data-vulkan-orphans]').count(), 0);
  await modal(page).locator('section.machine [data-field=vulkan]').uncheck();
  await modal(page).locator('section.machine [data-vulkan-orphans]').waitFor();
  assert.equal(await modal(page).locator('section.machine [data-vulkan-orphans]').textContent(), t('machines:SettingsTab.vulkan.orphans.off'));
  assert.deepEqual(errors, []);
  await context.close();
});

test('the machine list says which machines are suspended (a suspended copy in OPFS), not "off"', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/`);
  await openHome(page);
  // Two machines: each click's machine is made and listed (chosen) before the next click; the list is read once both are.
  const picks = modal(page).locator('li > button.pick[data-machine]');
  for (const n of [1, 2]) {
    await newEmptyMachine(page);
    await page.waitForFunction((n) => document.querySelectorAll('.machines li > button.pick[data-machine]').length === n && !document.querySelector('.machines[data-busy]'), n, { timeout: 10_000 });
  }
  const ids = await picks.evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.machine!));
  assert.equal(ids.length, 2);
  // One machine gets a suspended copy, as Suspend leaves it (`machines/<id>/suspend`, not empty).
  await page.evaluate(async (id) => {
    let dir = await navigator.storage.getDirectory();
    for (const n of ['machines', id]) dir = await dir.getDirectoryHandle(n, { create: true });
    const w = await (await dir.getFileHandle('suspend', { create: true })).createWritable();
    await w.write(new Uint8Array(16));
    await w.close();
  }, ids[0]);
  await page.reload();
  await openHome(page);
  const meta = (id: string) => modal(page).locator(`button.pick[data-machine="${id}"] .meta`);
  const listMeta = (state: string) => words('machines:MachinesNav.list.meta', { count: 0, state: t(`machines:MachinesPage.state.${state}`) }, { whole: true });
  await page.waitForFunction(([id, src]) => new RegExp(src).test(document.querySelector(`.machines button.pick[data-machine="${id}"] .meta`)?.textContent ?? ''), [ids[0], listMeta('suspended').source], { timeout: 10_000 });
  assert.match(await meta(ids[1]).textContent() ?? '', listMeta('off'));
  await meta(ids[0]).click();
  // The chosen machine's header (it showed the last one made, which is off, until the click lands).
  await modal(page).locator(`section.machine[data-selected="${ids[0]}"] [data-machine-state]`).waitFor();
  assert.equal(await modal(page).locator(`section.machine[data-selected="${ids[0]}"] [data-machine-state]`).textContent(), t('machines:MachinesPage.state.suspended'));
  assert.deepEqual(errors, []);
  await context.close();
});

test("a machine's RAM past memory 0: the note, and a custom split's fields (a node added, removed), checked, saved and kept over a reload", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/`);
  await openHome(page);
  await newEmptyMachine(page);
  const m = modal(page).locator('section.machine[data-selected]');
  await m.locator('[data-field=ram]').fill('2048');
  assert.equal(await m.locator('[data-numa]').count(), 0, 'memory 0 holds 2 GiB');
  // 3 GiB is memory 0 whole: no NUMA node.
  await m.locator('[data-field=ram]').fill('3072');
  assert.equal(await m.locator('output').filter({ hasText: t('machines:SettingsTab.mib', { n: 3072 }) }).count() > 0, true, 'the slider says 3072 MiB');
  assert.equal(await m.locator('[data-numa]').count(), 0, 'memory 0 holds 3072 MiB');
  await m.locator('[data-field=ram]').fill('4096');
  assert.match(await m.locator('[data-numa]').textContent() ?? '', words('machines:machine.numa', { count: 1, fast: 3072, rest: 1024 }, { whole: true }));
  // A custom split, the box beside the RAM slider: it starts from the automatic split, a field per NUMA node; the RAM
  // is then its sum.
  assert.equal(await m.locator('[data-field=ram0]').count(), 0, 'no split fields while the split is automatic');
  const box = m.getByRole('checkbox', { name: t('machines:SettingsTab.ram.custom') });
  await box.check();
  const nodes = m.locator('[data-field=ram-node]');
  const values = async () => [await m.locator('[data-field=ram0]').inputValue(), ...await Promise.all((await nodes.all()).map((n) => n.inputValue()))];
  assert.deepEqual(await values(), ['3072', '1024']);
  assert.equal(await m.getByLabel(t('machines:RamSplit.node', { n: 1 })).inputValue(), '1024');
  assert.equal(await m.locator('[data-field=ram]').isDisabled(), true);
  await m.locator('[data-field=ram0]').fill('2048');
  await m.locator('[data-field=ram0]').dispatchEvent('change');
  assert.equal(await m.locator('[data-field=ram]').inputValue(), '3072');
  // Added nodes come at 1024 MiB; one out of range says why, and Save waits.
  await m.getByRole('button', { name: t('machines:RamSplit.node.add') }).click();
  await m.getByRole('button', { name: t('machines:RamSplit.node.add') }).click();
  assert.deepEqual(await values(), ['2048', '1024', '1024', '1024']);
  assert.equal(await m.locator('[data-field=ram]').inputValue(), '5120');
  await nodes.nth(1).fill('5000');
  await nodes.nth(1).dispatchEvent('change');
  assert.match(await m.locator('[data-split-problem]').textContent() ?? '', words('machines:machine.split.node', { max: 4096, mib: 5000 }));
  assert.equal(await m.locator('[data-action=save]').isDisabled(), true);
  assert.equal(await m.locator('[data-field=ram]').inputValue(), '5120', 'the RAM keeps the last valid split\'s sum');
  // Removed, the out-of-range node takes its warning with it; the RAM is the new sum.
  await m.getByRole('button', { name: t('machines:RamSplit.node.remove') }).nth(1).click();
  assert.deepEqual(await values(), ['2048', '1024', '1024']);
  assert.equal(await m.locator('[data-split-problem]').count(), 0);
  await nodes.nth(1).fill('512');
  await nodes.nth(1).dispatchEvent('change');
  assert.equal(await m.locator('[data-field=ram]').inputValue(), '3584');
  assert.match(await m.locator('[data-numa]').textContent() ?? '', words('machines:machine.numa', { count: 2, fast: 2048, rest: 1536 }, { whole: true }));
  // Up to 8 nodes: no "add a node" past them.
  for (let i = 2; i < 8; i++) await m.getByRole('button', { name: t('machines:RamSplit.node.add') }).click();
  assert.equal(await nodes.count(), 8);
  assert.equal(await m.getByRole('button', { name: t('machines:RamSplit.node.add') }).count(), 0);
  for (let i = 2; i < 8; i++) await m.getByRole('button', { name: t('machines:RamSplit.node.remove') }).last().click();
  assert.deepEqual(await values(), ['2048', '1024', '512']);
  await m.locator('[data-action=save]').click();
  await m.locator('[data-action=save]').and(page.locator(':disabled')).waitFor();
  // Kept: after a reload the box is ticked with the split, and turning it off is the automatic split again.
  await page.reload();
  await openHome(page);
  await modal(page).locator('.pick').first().click();
  await m.locator('[data-field=ram0]').waitFor();
  assert.equal(await box.isChecked(), true);
  assert.deepEqual([...await values(), await m.locator('[data-field=ram]').inputValue()], ['2048', '1024', '512', '3584']);
  await box.uncheck();
  assert.equal(await m.locator('[data-field=ram0]').count(), 0);
  assert.equal(await m.locator('[data-field=ram]').isDisabled(), false);
  assert.match(await m.locator('[data-numa]').textContent() ?? '', words('machines:machine.numa', { count: 1, fast: 3072, rest: 512 }, { whole: true }));
  assert.deepEqual(errors, []);
  await context.close();
});

test('a detached disk keeps its overlays: attached again from the browser\'s disks, the same URL is the same disk, deleted when no machine has it', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  const asked: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page, (q) => { asked.push(q.text); });
  await page.goto(`${base}/web/app/`);
  await openHome(page);
  await newEmptyMachine(page);
  const m = modal(page).locator('section.machine[data-selected]');
  await m.locator('[data-tab=disks]').click();
  const url = `${base}/tests/qcow2/deflate.qcow2`;
  await addDisk(page, 'url', { url });
  await disk(page, 0);
  await m.locator('[data-attachment]').first().getByRole('button', { name: t('disks:Disks.newEmpty') }).click(); // the prompt's default name
  await m.locator('[data-field=overlay] option', { hasText: t('disks:Disks.newOverlay.name') }).waitFor({ state: 'attached' });
  const diskId = await page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    const d = (await store.all('disks'))[0];
    store.close();
    return d.id as string;
  });
  // Detached: the message says where it goes and how it comes back.
  await m.locator('[data-attachment]').first().getByRole('button', { name: t('disks:Disks.detach.button') }).click();
  await page.waitForFunction(() => document.querySelectorAll('.machines [data-attachment]').length === 0);
  assert.match(asked.at(-1)!, words('disks:Disks.detach.confirm'));
  assert.match(asked.at(-1)!, words('disks:Disks.detach.keptOverlays', { count: 1 }));
  // Attached again from the browser's disks: the same disk, its overlay there.
  await page.locator('[data-action=add-disk-open]').click();
  await page.locator('#add-disk [data-source=known]').click();
  await page.locator(`#add-disk [data-disk="${diskId}"]`, { hasText: words('disks:DiskInfo.overlays', { count: 1 }) }).locator('[data-action=attach-known]').click();
  await disk(page, 0);
  await m.locator('[data-field=overlay] option', { hasText: t('disks:Disks.newOverlay.name') }).waitFor({ state: 'attached' });
  // The same URL added again is that disk: refused here, where it's attached already.
  await addDisk(page, 'url', { url });
  await page.locator('#add-disk .error', { hasText: words('disks:add-disk.attachedAlready') }).waitFor();
  await page.keyboard.press('Escape');
  // Detached and deleted from the browser's disks (Disks under the list of machines): its record and its overlay go.
  await m.locator('[data-attachment]').first().getByRole('button', { name: t('disks:Disks.detach.button') }).click();
  await page.waitForFunction(() => document.querySelectorAll('.machines [data-attachment]').length === 0);
  await modal(page).locator('nav [data-machine=disks]').click();
  await modal(page).locator(`section[data-selected=disks] [data-disk="${diskId}"] [data-action=delete-disk]:not([disabled])`).click();
  assert.match(asked.at(-1)!, words('disks:DisksPane.delete.confirm', { count: 1 }));
  await page.waitForFunction(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    const [disks, overlays] = [await store.all('disks'), await store.all('overlays')];
    store.close();
    return disks.length === 0 && overlays.length === 0;
  }, null, { timeout: 10_000 });
  assert.deepEqual(errors, []);
  await context.close();
});

test('the browser\'s disks: each disk\'s overlays renamed and deleted, attached to a machine (not to one that has it or has the most disks), refused deletion while attached', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page, (q) => (q.kind === 'prompt' ? 'Renamed' : true));
  await page.goto(`${base}/web/app/`);
  // Two machines: A with no disks, B with the most a machine can have; a detached blank disk X with two overlays.
  const ids = await page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { attach, createDisk, createMachine } = await import('/web/app/machines.ts' as string);
    const { createOverlay } = await import('/web/app/disks.ts' as string);
    const { MAX_DISKS } = await import('/web/app/shape.ts' as string);
    const store = await Store.open();
    const a = await createMachine(store, { name: 'Machine A' });
    const b = await createMachine(store, { name: 'Machine B' });
    for (let i = 0; i < MAX_DISKS; i++) await attach(store, b, await createDisk(store, { kind: 'blank', size: 1 << 20 }));
    const x = await createDisk(store, { kind: 'blank', size: 1 << 20, name: 'Disk X' });
    const first = await createOverlay(store, x, 'First');
    const second = await createOverlay(store, x, 'Second');
    store.close();
    return { a: a.id as string, b: b.id as string, x: x.id as string, first: first.id as string, second: second.id as string };
  });
  await openHome(page);
  await modal(page).locator('nav [data-machine=disks]').click();
  const pane = modal(page).locator('section[data-selected=disks]');
  const x = pane.locator(`[data-disk="${ids.x}"]`);
  await x.waitFor();
  assert.equal(await pane.locator('[data-disk]').count(), 17);
  assert.match((await x.textContent())!, words('disks:DiskInfo.onNone'));
  // Its overlays: one renamed, the other deleted.
  await x.locator('[data-action=disk-overlays]').click();
  const dialog = page.locator('#overlays');
  await dialog.locator(`[data-overlay="${ids.first}"] [data-action=rename-overlay]`).click();
  await dialog.locator(`[data-overlay="${ids.first}"] strong`, { hasText: 'Renamed' }).waitFor();
  await dialog.locator(`[data-overlay="${ids.second}"] [data-action=delete-overlay]`).click();
  await dialog.locator(`[data-overlay="${ids.second}"]`).waitFor({ state: 'detached' });
  assert.equal(await dialog.locator('[data-overlay]').count(), 1);
  // Export… takes the dialog's place (a blank disk's: straight to the format) and Back returns to the list.
  await dialog.locator(`[data-overlay="${ids.first}"] [data-action=export]`).click();
  assert.equal(await dialog.locator('h2').textContent(), t('disks:ExportSteps.title.whole'));
  assert.equal(await dialog.locator('[data-save]').count(), 3);
  assert.equal(await dialog.locator('[data-overlay]').count(), 0);
  await dialog.locator('[data-action=export-back]').click();
  await dialog.locator(`[data-overlay="${ids.first}"]`).waitFor();
  await dialog.locator('[data-action=close-overlays]').click();
  await dialog.waitFor({ state: 'detached' });
  // Attached: B, full, says so and can't take it; A takes it.
  await x.locator('[data-action=attach-disk]').click();
  const attach = page.locator('#attach-disk');
  assert.equal(await attach.locator(`[data-machine="${ids.b}"] [data-why]`).textContent(), t('disks:AttachDisk.full', { max: 16 }));
  assert.ok(await attach.locator(`[data-machine="${ids.b}"] [data-action=attach-to]`).isDisabled());
  await attach.locator(`[data-machine="${ids.a}"] [data-action=attach-to]`).click();
  await attach.waitFor({ state: 'detached' });
  await x.locator('[data-action=delete-disk][disabled]').waitFor();
  assert.match((await x.textContent())!, words('disks:DiskInfo.on', { machines: 'Machine A' }));
  // Again: A has it now.
  await x.locator('[data-action=attach-disk]').click();
  assert.equal(await attach.locator(`[data-machine="${ids.a}"] [data-why]`).textContent(), t('disks:AttachDisk.has'));
  assert.ok(await attach.locator(`[data-machine="${ids.a}"] [data-action=attach-to]`).isDisabled());
  await page.keyboard.press('Escape');
  await attach.waitFor({ state: 'detached' });
  // The same dialog from A's Disks tab: the overlay left, with the machine that uses it.
  await modal(page).locator(`nav [data-machine="${ids.a}"]`).click();
  const m = modal(page).locator(`section.machine[data-selected="${ids.a}"]`);
  await m.locator('[data-tab=disks]').click();
  await m.locator('[data-attachment] [data-field=overlay]').selectOption(ids.first);
  await page.waitForFunction(async ([a, o]) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    const rec = await store.get('machines', a);
    store.close();
    return rec?.attachments[0]?.overlay === o;
  }, [ids.a, ids.first]);
  await m.locator('[data-attachment] [data-action=disk-overlays]').click();
  assert.match((await dialog.locator(`[data-overlay="${ids.first}"]`).textContent())!, words('disks:Overlays.usedBy', { machines: 'Machine A' }));
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  await context.close();
});

test('a disk\'s read-only box on a running machine: powered off after asking, then saved; "visualize" after RAM\'s label while it runs; no gap over the Home page', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  const asked: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page, (q) => { asked.push(q.text); });
  await page.goto(`${base}/web/app/`);
  await openHome(page);
  await newEmptyMachine(page);
  const m = modal(page).locator('section.machine[data-selected]');
  const id = await m.getAttribute('data-selected');
  await m.locator('[data-tab=disks]').click();
  await addDisk(page, 'url', { url: `${base}/tests/qcow2/deflate.qcow2` });
  await disk(page, 0);
  assert.equal(await m.locator('[data-action=ram-open]').count(), 0, 'no "visualize" beside RAM while it is off');
  await m.locator('[data-action=open]').click();
  // Running (its Web Lock held): the box asks to power it off, then takes its value from the click.
  await page.waitForFunction(() => ['loading', 'booting', 'running'].includes(document.body.dataset.state!), null, { timeout: 30_000 });
  await openHome(page);
  // Its Settings tab: "visualize" beside RAM's label opens the RAM's map over the page, once it has RAM (booting or running).
  await page.waitForFunction(() => ['booting', 'running'].includes(document.body.dataset.state!), null, { timeout: 30_000 });
  // No message: no floating bar over the Home page (its messages show in the page's own banner), and no banner.
  await page.locator('#message').waitFor({ state: 'detached', timeout: 5_000 });
  // (A banner that was there folds away in 250 ms.)
  await page.locator('.machines .banner').waitFor({ state: 'detached', timeout: 5_000 }); // no gap over the Home page
  await m.locator('[data-tab=settings]').click();
  // A link beside the label's words (the box for a custom split beside the slider), outside the label: its words still name the slider.
  assert.equal(await m.locator('.name [data-action=ram-open]').count(), 1);
  assert.equal(await m.getByLabel(t('machines:SettingsTab.ram'), { exact: true }).getAttribute('data-field'), 'ram');
  await m.locator('[data-action=ram-open]').click();
  await page.locator('#ram-window').waitFor({ timeout: 10_000 });
  await page.locator('#ram-window [data-action=close]').click();
  await page.locator('#ram-window').waitFor({ state: 'detached', timeout: 5_000 });
  await m.locator('[data-tab=disks]').click();
  await page.waitForFunction((s) => (document.querySelector('.machines .head .meta')?.textContent ?? '').includes(s), t('machines:MachinesPage.state.running'), { timeout: 10_000 });
  // A click, then a wait: the box takes its value only after the power-off it asks for (`check()` verifies at once,
  // which a loaded run's slower power-off failed).
  const box = m.locator('[data-attachment]').first().getByRole('checkbox', { name: t('disks:Disks.readOnly') });
  await box.click();
  await page.waitForFunction((el) => (el as HTMLInputElement).checked, await box.elementHandle(), { timeout: 15_000 });
  await page.waitForFunction(async (id) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    const rec = await store.get('machines', id);
    store.close();
    return rec.attachments[0].readOnly === true;
  }, id, { timeout: 10_000 });
  assert.match(asked.at(-1)!, words('machines:MachinesPage.powerOff.confirm', {}, { start: true }));
  assert.equal(await page.locator('.machines .error').count(), 0, 'no error');
  await page.waitForFunction(() => document.body.dataset.state === 'off', null, { timeout: 10_000 });
  await m.locator('[data-tab=settings]').click();
  assert.equal(await m.locator('[data-action=ram-open]').count(), 0, 'no "visualize" after the power-off');
  assert.deepEqual(errors, []);
  await context.close();
});

test("another machine's Start while one runs in this tab: a menu, In this tab or In a new tab (the address's knobs kept); there, Running in another tab", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/?view=terminal`);
  await openHome(page);
  await newEmptyMachine(page);
  const m = modal(page).locator('section.machine[data-selected]');
  await m.locator('[data-tab=disks]').click();
  await addDisk(page, 'url', { url: `${base}/tests/qcow2/deflate.qcow2` });
  await disk(page, 0);
  // Nothing runs here: Start alone.
  assert.equal(await m.locator('[data-action=open]').textContent(), t('machines:MachinePane.open'));
  assert.equal(await m.locator('[data-action=start-menu]').count(), 0, 'no menu');
  await m.locator('[data-action=open]').click();
  await page.waitForFunction(() => ['loading', 'booting', 'running'].includes(document.body.dataset.state!), null, { timeout: 30_000 });
  await openHome(page);
  const first = await m.getAttribute('data-selected');
  await newEmptyMachine(page);
  await modal(page).locator(`section.machine[data-selected]:not([data-selected="${first}"])`).waitFor();
  const other = await m.getAttribute('data-selected');
  const menu = m.locator('[data-action=start-menu]');
  assert.equal((await menu.locator('summary').textContent())?.trim(), t('machines:MachinePane.startMenu'));
  await menu.locator('summary').click();
  assert.equal(await menu.locator('[data-action=open]').textContent(), t('machines:MachinePane.startMenu.here'));
  const [tab] = await Promise.all([context.waitForEvent('page'), menu.locator('[data-action=open-new-tab]').click()]);
  await tab.waitForLoadState('domcontentloaded');
  const q = new URL(tab.url()).searchParams;
  assert.deepEqual([q.get('m'), q.get('view')], [other, 'terminal']);
  assert.equal(await menu.getAttribute('open'), null, 'the menu closed');
  assert.ok(['booting', 'running'].includes((await page.evaluate(() => document.body.dataset.state))!), 'this tab runs on');
  // In the new tab, the first machine runs in another: no Start, a disabled button that says so.
  await openHome(tab);
  await modal(tab).locator(`nav [data-machine="${first}"]`).click();
  const elsewhere = modal(tab).locator(`section.machine[data-selected="${first}"] [data-action=open]`, { hasText: t('machines:MachinePane.runningElsewhere') });
  await elsewhere.waitFor({ timeout: 10_000 });
  assert.ok(await elsewhere.isDisabled(), 'disabled');
  assert.equal(await modal(tab).locator(`section.machine[data-selected="${first}"] [data-action=start-menu]`).count(), 0, 'no menu');
  await tab.close();
  assert.deepEqual(errors, []);
  await context.close();
});

test("the storage bar's details: the browser's numbers when they agree, the three apart when its count is short", async () => {
  for (const behind of [false, true]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await answerAsks(page);
    // A count short of the files as Chromium was seen to give it (docs/machines.md "Storage"): usage 1 MiB.
    if (behind)
      await page.addInitScript(() => {
        const real = navigator.storage.estimate.bind(navigator.storage);
        navigator.storage.estimate = async () => ({
          ...(await real()),
          usage: 1 << 20,
        });
      });
    await page.goto(`${base}/web/app/`);
    // A stored disk's files: 40 MiB of data.
    await page.evaluate(async () => {
      const { Store } = await import("/web/app/store.ts" as string);
      const store = await Store.open();
      await store.writing(async () => {
        const root = await navigator.storage.getDirectory();
        const dir = await (
          await root.getDirectoryHandle("disks", { create: true })
        ).getDirectoryHandle("d1", { create: true });
        const w = await (
          await dir.getFileHandle("data", { create: true })
        ).createWritable();
        await w.write(new Uint8Array(40 << 20));
        await w.close();
        const identity = { kind: "stored", id: "d1", bytes: 64 << 20 };
        await store.put("disks", {
          id: "d1",
          name: "big.img",
          kind: "stored",
          size: 64 << 20,
          identity,
          generation: 1,
        });
      });
      store.close();
    });
    await openHome(page);
    const icon = page.locator("[data-action=storage-details]");
    await icon.waitFor();
    const est = await page.evaluate(() => navigator.storage.estimate());
    const line = await page.locator(".storage .used").textContent();
    if (behind) {
      assert.equal(
        await icon.getAttribute("title"),
        t("machines:StorageBar.details.behind.title"),
      );
      assert.match(line!, /^40 MiB /);
      assert.equal(
        line,
        t("machines:StorageBar.storage.counted", { used: 40 << 20 }),
      );
    } else {
      assert.equal(
        await icon.getAttribute("title"),
        t("machines:StorageBar.details.title"),
      );
      assert.equal(
        line,
        t("machines:StorageBar.storage", { used: est.usage, quota: est.quota }),
      );
    }
    await icon.click();
    const dialog = page.locator("#storage-details");
    await dialog.waitFor();
    assert.equal(
      await dialog.locator("h2").textContent(),
      t("machines:StorageDetails.title"),
    );
    assert.match(
      (await dialog.locator("[data-items]").textContent())!,
      /40 MiB/,
    );
    if (behind) {
      assert.equal(await dialog.locator("[data-summary]").count(), 0);
      assert.equal(
        await dialog.locator("[data-number=counted]").textContent(),
        t("machines:StorageDetails.behind.counted", { size: 40 << 20 }),
      );
      assert.equal(
        await dialog.locator("[data-number=usage]").textContent(),
        t("machines:StorageDetails.behind.usage", { size: 1 << 20 }),
      );
      assert.equal(
        await dialog.locator("[data-number=quota]").textContent(),
        t("machines:StorageDetails.behind.quota", { size: est.quota }),
      );
    } else {
      assert.equal(await dialog.locator("[data-behind]").count(), 0);
      const free = (est.quota ?? 0) - (est.usage ?? 0);
      assert.equal(
        await dialog.locator("[data-summary]").textContent(),
        t("machines:StorageDetails.summary", {
          used: est.usage,
          quota: est.quota,
          free,
        }),
      );
    }
    await dialog.locator("button").click();
    await dialog.waitFor({ state: "detached" });
    await context.close();
  }
});

test("the storage footer shows remote disks' kept blocks and clears them", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await answerAsks(page);
  await page.goto(`${base}/web/app/`);
  // A remote disk's kept blocks, as web/diskcache.ts leaves them: <its root>/<key>/{data,map}.
  await page.evaluate(async () => {
    const { cacheRoot } = await import('/web/diskcache.ts' as string);
    const dir = await (await cacheRoot()).getDirectoryHandle('0123abcd', { create: true });
    for (const [name, bytes] of [['data', 3 << 20], ['map', 4096]] as const) {
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(new Uint8Array(bytes));
      await w.close();
    }
  });
  await openHome(page);
  const clear = page.locator('[data-action=clear-remote-cache]');
  await clear.waitFor();
  assert.equal(await clear.textContent(), t('machines:StorageBar.storage.clear', { size: 3 << 20 }));
  await clear.click();
  await clear.waitFor({ state: 'detached' });
  const left = await page.evaluate(async () => {
    const { cacheRoot } = await import('/web/diskcache.ts' as string);
    const dir = await cacheRoot();
    const names: string[] = [];
    for await (const n of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(n);
    return names;
  });
  assert.deepEqual(left, []);
  await context.close();
});

test("the storage footer shows Vulkan's shader store and clears it; Preferences set its budget (VK4 T17)", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await answerAsks(page);
  await page.goto(`${base}/web/app/`);
  // Entries as the GPU worker leaves them (web/venus-cache.ts): flushed through IndexedDB, deflated.
  const stored = await page.evaluate(async () => {
    const { idbBackend, ShaderCache } = await import('/web/venus-cache.ts' as string);
    const backend = idbBackend();
    const c = await ShaderCache.open('build', { backend });
    c.put('a', crypto.getRandomValues(new Uint8Array(40_000)));
    c.put('b', new TextEncoder().encode('let x = 1;\n'.repeat(4000)));
    await c.flush();
    backend.close();
    return c.stats.bytes;
  });
  assert.ok(stored > 40_000 && stored < 45_000, `stored ${stored}`);
  await openHome(page);
  const clear = page.locator('[data-action=clear-shaders]');
  await clear.waitFor();
  assert.equal(await clear.textContent(), t('machines:StorageBar.storage.clearShaders', { size: stored }));
  await clear.click();
  await clear.waitFor({ state: 'detached' });
  const left = await page.evaluate(async () => (await import('/web/venus-cache.ts' as string)).shaderStoreSize());
  assert.deepEqual(left, { bytes: 0, entries: 0 });
  // The budget: the default chosen, a choice remembered for the next machine's start.
  await modal(page).locator('[data-machine=preferences]').click();
  const budget = modal(page).locator('[data-field=shader-budget]');
  assert.equal(await budget.inputValue(), '32');
  await budget.selectOption('64');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('waarm64.settings') ?? '{}').shaderMiB), 64);
  await context.close();
});

test("remote disks' blocks: in an expiring bucket of their own, cleared while a machine reads them, gone after a week unused", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${base}/web/app/`);
  // Each step named (`__step`), the whole bounded: once in ~30 ci.sh runs a step never resolved (PERF loop 55's second
  // run, 600 s, not seen in 12 runs alone or in the file), the browser's storage call or ours unknown; a hang now
  // fails in a minute and names it.
  const run = page.evaluate(async () => {
    const at = (s: string) => ((globalThis as { __step?: string }).__step = s);
    at('import');
    const dc = await import('/web/diskcache.ts' as string);
    // A store held open by a worker, as a running machine's device worker holds its disk's.
    const src = `const dc = await import(${JSON.stringify(`${location.origin}/web/diskcache.ts`)});
      const s = await dc.openBlockStore('feedc0de', 64 * 4096, 4096);
      if (!s) { postMessage('no store'); throw new Error('no store'); }
      for (let b = 0; b < 8; b++) s.put(b, new Uint8Array(4096).fill(b + 1));
      postMessage('ready');
      onmessage = () => postMessage({ active: s.active(), held: s.stats().held });`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { type: 'module' });
    // Bounded: a worker that fails (no store: no room, the lock held) says so rather than leaving the test waiting.
    const next = () => new Promise<unknown>((r, j) => {
      const timer = setTimeout(() => j(new Error('the worker said nothing in 30 s')), 30_000);
      w.onmessage = (e) => (clearTimeout(timer), r(e.data));
      w.onerror = (e) => (clearTimeout(timer), j(new Error(`the worker: ${e.message}`)));
    });
    at('the worker opens its store');
    const first = await next();
    if (first !== 'ready') throw new Error(`the worker's block store: ${String(first)} (${JSON.stringify(await navigator.storage.estimate())})`);
    const sb = (navigator as unknown as { storageBuckets: { keys(): Promise<string[]>; open(n: string): Promise<{ expires(): Promise<number | null>; persisted(): Promise<boolean> }> } }).storageBuckets;
    at('the bucket');
    const bucket = await sb.open(dc.CACHE_DIR);
    const days = ((await bucket.expires())! - Date.now()) / 86_400_000;
    const persisted = await bucket.persisted();
    at('cacheBytes before');
    const before = await dc.cacheBytes();
    at('clearCaches');
    const freed = await dc.clearCaches();
    w.postMessage(0);
    at("the worker's store after");
    const store = await next();
    at('cacheBytes after');
    const after = await dc.cacheBytes();
    w.terminate();
    // A cache last used eight days ago (the clock moved on): gone when the page next looks.
    at('an old cache written');
    const dir = await (await dc.cacheRoot()).getDirectoryHandle('0ld0ld', { create: true });
    const f = await (await dir.getFileHandle('map', { create: true })).createWritable();
    await f.write(new Uint8Array(4096));
    await f.close();
    at('cacheBytes fresh');
    const fresh = await dc.cacheBytes();
    const now = Date.now;
    Date.now = () => now() + 8 * 86_400_000;
    const later = await dc.cacheBytes();
    Date.now = now;
    at('the names');
    const names: string[] = [];
    for await (const n of ((await dc.cacheRoot()) as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(n);
    return { buckets: await sb.keys(), days, persisted, before, freed, store, after, fresh, later, names };
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void page
        .evaluate(() => (globalThis as { __step?: string }).__step)
        .then((step) => reject(new Error(`no answer in 60 s, at: ${step}`)), reject);
    }, 60_000);
  });
  const got = await Promise.race([run, hung]).finally(() => clearTimeout(timer));
  assert.ok(got.buckets.includes('remote-cache'), String(got.buckets));
  assert.ok(got.days > 6.9 && got.days <= 7, `expires in ${got.days} days`);
  assert.equal(got.persisted, false);
  assert.ok(got.before >= 8 * 4096, `${got.before} bytes before`);
  assert.ok(got.freed >= 8 * 4096, `${got.freed} bytes freed`);
  assert.deepEqual(got.store, { active: false, held: 0 });
  assert.equal(got.after, 0);
  assert.equal(got.fresh, 4096);
  assert.equal(got.later, 0);
  assert.deepEqual(got.names, []); // the worker's too, emptied, once nothing read it
  await context.close();
});
