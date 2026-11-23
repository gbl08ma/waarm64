// Screenshots of the page's every state that needs no guest (docs/frontend.md "Screenshots"), for looking at a UI
// change and comparing it with a baseline: headless Chromium (a temporary profile, as the tests launch it) on the dev
// server, the browser's records seeded through the page's own modules (a machine with disks, an overlay, snapshots, an
// adapter on a connection, a USB device, a folder), then the toolbar and each of its menus, the message bar, the
// Home page's panes and a machine's tabs (also 720 px wide), every dialog and wizard step, the demo store's page
// (tools/screens-demos.ts; also 720 px wide) and the introduction (tools/screens-intro.ts; also 720 px wide), one PNG
// per state.
//   node tools/screens.ts [--label before] [--only <substring>[,<substring>…]] [--css <file>]
// writes bench/results/local/screens/<label>/<state>.png (label `now` by default) and lists the states it couldn't
// reach (they need a guest or hardware) in `missed.txt` there. `--css` adds a stylesheet to every page (a look to try:
// tokens to compare in two sets).
//   node tools/screens.ts --compare before [--label now]
// compares two sets taken before: each state's changed pixels and where (states only one set has are listed too).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { chromium, type Page } from 'playwright-core';
import { ROOT, startServer } from './serve.ts';
import { demoScreens } from './screens-demos.ts';
import { introScreens } from './screens-intro.ts';

const { values: args } = parseArgs({
  options: { label: { type: 'string', default: 'now' }, only: { type: 'string' }, compare: { type: 'string' }, css: { type: 'string' } },
});
const SCREENS = `${ROOT}bench/results/local/screens`;
const DIR = `${SCREENS}/${args.label}`;
if (args.compare) {
  await compare(`${SCREENS}/${args.compare}`, DIR);
  process.exit(0);
}

/** Compares the PNGs of two sets in Chromium (a canvas each): per state, the pixels that differ and their box. */
async function compare(a: string, b: string) {
  const names = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.png')) : []);
  const [as, bs] = [names(a), names(b)];
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  const page = await browser.newPage();
  let same = 0;
  for (const f of as.filter((f) => bs.includes(f))) {
    const [x, y] = [a, b].map((d) => readFileSync(`${d}/${f}`).toString('base64'));
    const r = await page.evaluate(async ([x, y]) => {
      const load = async (s: string) => {
        const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob());
        const c = new OffscreenCanvas(img.width, img.height).getContext('2d')!;
        c.drawImage(img, 0, 0);
        return c.getImageData(0, 0, img.width, img.height);
      };
      const [p, q] = [await load(x), await load(y)];
      if (p.width !== q.width || p.height !== q.height) return `size ${p.width}×${p.height} → ${q.width}×${q.height}`;
      let n = 0, x0 = p.width, y0 = p.height, x1 = -1, y1 = -1;
      for (let i = 0; i < p.data.length; i += 4) {
        if (p.data[i] === q.data[i] && p.data[i + 1] === q.data[i + 1] && p.data[i + 2] === q.data[i + 2]) continue;
        const px = (i / 4) % p.width, py = Math.floor(i / 4 / p.width);
        n++;
        [x0, y0, x1, y1] = [Math.min(x0, px), Math.min(y0, py), Math.max(x1, px), Math.max(y1, py)];
      }
      return n ? `${n} px in ${x0},${y0}–${x1},${y1}` : '';
    }, [x, y] as const);
    if (r) console.log(`${f.slice(0, -4)}: ${r}`);
    else same++;
  }
  for (const f of as.filter((f) => !bs.includes(f))) console.log(`${f.slice(0, -4)}: only in ${a}`);
  for (const f of bs.filter((f) => !as.includes(f))) console.log(`${f.slice(0, -4)}: only in ${b}`);
  console.log(`${same} states the same`);
  await browser.close();
}

const WIDE = { width: 1280, height: 800 };
const NARROW = { width: 720, height: 900 };

const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
if (!args.only) rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
const missed: string[] = [];
const taken: string[] = [];

/** Runs `f` for state `name` (skipped unless it matches `--only`); a failure is listed as missed, and the run goes on. */
async function state(name: string, f: () => Promise<void>) {
  if (args.only && !args.only.split(',').some((o) => name.includes(o))) return;
  try {
    await f();
  } catch (e) {
    missed.push(`${name}: ${String(e).split('\n')[0]}`);
  }
}
/** The viewport as it is now, as `<name>.png`. */
async function shot(page: Page, name: string) {
  await page.waitForTimeout(150); // a frame for what the last click changed
  await page.screenshot({ path: `${DIR}/${name}.png`, animations: 'disabled', caret: 'hide' });
  taken.push(name);
}
const settle = (page: Page) => page.waitForTimeout(150);

/** One context (one profile: the seed's records are in it) for every page. */
const context = await browser.newContext({ viewport: WIDE, colorScheme: 'dark', locale: 'en-US', timezoneId: 'UTC' });
context.setDefaultTimeout(5000);
/** A page at `viewport`; its errors are listed as missed. */
async function open(viewport = WIDE, hash = '') {
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  page.on('pageerror', (e) => missed.push(`(page error) ${String(e).split('\n')[0]}`));
  await page.goto(`${base}/web/app/${hash}`);
  await page.locator('#machines-open').waitFor();
  if (args.css) await page.addStyleTag({ path: args.css });
  return page;
}

/**
 * The page's state, changed by `f`: its areas (web/app/areas/: the dev server gives the page and these imports one
 * module each) as `a`, and the page's live folders (main.ts's `window.__folders`) as `folders`.
 */
const setUi = (page: Page, f: string) => page.evaluate(async (f) => {
  const area = (name: string) => import(`/web/app/areas/${name}.svelte.ts`);
  const a = {
    ...(await area('power')), ...(await area('message-bar')), ...(await area('current')), ...(await area('usb')),
    ...(await area('clipboard')), ...(await area('machines-nav')), ...(await area('screen')), ...(await area('boot-card')),
  };
  new Function('a', 'folders', f)(a, (window as unknown as { __folders?: unknown }).__folders);
}, f);

// ---- The seed: what the browser keeps, made through the page's modules (as the tests make their machines). ----
type Seed = { machine: string; bare: string; tailnet: string; folder: string; blank: string };
async function seed(page: Page): Promise<Seed> {
  const ids = await page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { createMachine, createDisk, attach } = await import('/web/app/machines.ts' as string);
    const { createFolder } = await import('/web/app/folders.ts' as string);
    const { newId } = await import('/web/app/shape.ts' as string);
    const { page: actions } = await import('/web/app/page.ts' as string);
    const store = await Store.open();
    // Fixed times, addresses and the connections' ids (their order), so that two sets differ only where the page does.
    const now = Date.UTC(2026, 10, 1, 12);
    const tailnet = { id: 'c00000000001', name: 'Home tailnet', kind: 'tailnet', ephemeral: false, tailnet: { controlURL: 'https://controlplane.tailscale.com', hostname: 'workbench', exitNode: '', stateKey: '' }, connectAtStart: true, lastUsed: now, created: now };
    tailnet.tailnet.stateKey = tailnet.id;
    const tailcat = { id: 'c00000000002', name: 'tailcat', kind: 'tailcat', ephemeral: false, tailcat: { serve: true, relay: '', identityKey: newId() }, connectAtStart: false, lastUsed: 0, created: now };
    const room = { id: 'c00000000003', name: 'Room', kind: 'room', ephemeral: false, room: { link: 'waarm64-room:example?r=1', incoming: true, relayOnly: false, identityKey: newId() }, connectAtStart: false, lastUsed: 0, created: now };
    for (const c of [tailnet, tailcat, room]) await store.put('connections', c);
    const folder = await createFolder(store, { kind: 'opfs', name: 'Shared' });
    const m = await createMachine(store, { name: 'Workbench', ncpus: 2, ramMiB: 2048 });
    const url = await createDisk(store, { kind: 'url', url: '/tests/qcow2/deflate.qcow2', size: 1 << 20, bytes: 196608 });
    const blank = await createDisk(store, { kind: 'blank', size: 64 << 20 });
    const ram = await createDisk(store, { kind: 'ramdisk', size: 32 << 20 });
    await createDisk(store, { kind: 'blank', size: 16 << 20, name: 'Spare' }); // in no machine: Attach to a machine…
    for (const d of [url, blank, ram]) await attach(store, m, d);
    const overlay = { id: 'a00000000001', name: 'Before the upgrade', disk: blank.id, identity: blank.identity, generation: 0, bytes: 0, created: now, modified: now };
    const scratch = { ...overlay, id: 'a00000000002', name: 'Changes' };
    for (const o of [overlay, scratch]) await store.put('overlays', o);
    m.attachments[1].overlay = overlay.id;
    m.adapters[0] = { ...m.adapters[0], mac: '52:54:00:12:34:56', connection: tailnet.id };
    m.usbDevices = [{ id: newId(), api: 'usb', vendorId: 0x0781, productId: 0x5581, productName: 'Ultra USB 3.0', serialNumber: '4C530001', connector: 0, atStart: true }];
    m.folders = [{ id: folder.id, readOnly: false }];
    await store.put('machines', m);
    const bare = await createMachine(store, { name: 'Bare', network: false, usb: false });
    // Two kept snapshots: one of the machine as it is, one orphaned (made when it had another size).
    const { shape, hash } = await actions.shapeNow(m, new Map((await store.all('disks')).map((d: { id: string }) => [d.id, d])), await store.all('overlays'));
    const pins: unknown[] = [];
    await store.put('snapshots', { id: newId(), machine: m.id, name: 'Logged in', created: now - 3600_000, bytes: 412 << 20, shape, shapeHash: hash, pins });
    await store.put('snapshots', { id: newId(), machine: m.id, name: 'Old size', created: now - 86400_000, bytes: 380 << 20, shape: { ...shape, ramMiB: 1024 }, shapeHash: 'orphaned', pins });
    store.close();
    return { machine: m.id, bare: bare.id, tailnet: tailnet.id, folder: folder.id, blank: blank.id };
  });
  return ids;
}

const machinesPage = (page: Page) => page.locator('.machines');
/** Chooses `id` in the Home page's list and waits for its pane. */
async function choose(page: Page, id: string) {
  await page.click(`nav [data-machine="${id}"]`);
  await page.locator(`section.machine[data-selected="${id}"]`).waitFor();
  await settle(page);
}
async function tab(page: Page, id: string, t: string) {
  await page.locator(`section.machine[data-selected="${id}"] [data-tab=${t}]`).click();
  await settle(page);
}
/** Closes the open dialog (Esc) and waits for it to go. */
async function escape(page: Page) {
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog[open]'), undefined, { timeout: 5000 });
}

// ---- The run. ----
let seeded: Seed;
{
  const page = await open();
  seeded = await seed(page);
  await page.close();
}

// The toolbar and its menus, as the page shows them waiting for a disk; then with every menu a machine can have.
{
  const page = await open();
  await state('toolbar', async () => { await shot(page, 'toolbar'); });
  await state('message-warn', async () => {
    await page.locator('#message .banner').waitFor();
    await shot(page, 'message-warn');
  });
  await state('message-error', async () => {
    await page.evaluate(async () => {
      const { messageBar } = await import('/web/app/areas/message-bar.svelte.ts' as string);
      const { t } = await import('/web/i18n.ts' as string);
      messageBar.text = t('machine:power-actions.cantOpen');
      messageBar.details = ['NotFoundError: A requested file or directory could not be found.']; // i18n-ignore: a browser's error, as shown
      messageBar.from = [undefined, 'raw'];
      messageBar.kind = 'error';
    });
    await shot(page, 'message-error');
    await page.click('#message-close');
  });
  await state('message-error-named', async () => {
    // An error whose headline names a machine and whose cause is a message, then a browser's own words.
    await page.evaluate(async () => {
      const { messageBar } = await import('/web/app/areas/message-bar.svelte.ts' as string);
      const { t, msg } = await import('/web/i18n.ts' as string);
      const head = msg('machine:worker-errors.diskInUse', { machine: 'Workbench' });
      const cause = msg('folders:folders-page.inUseElsewhere', { name: 'Shared' });
      messageBar.text = t(head.key, head.params);
      messageBar.details = [t(cause.key, cause.params), 'NotFoundError: A requested file or directory could not be found.']; // i18n-ignore: a browser's error, as shown
      messageBar.from = [head, cause, 'raw'];
      messageBar.kind = 'error';
    });
    await shot(page, 'message-error-named');
    await page.click('#message-close');
  });
  await state('message-info', async () => {
    await page.evaluate(async () => {
      const { messageBar } = await import('/web/app/areas/message-bar.svelte.ts' as string);
      const { t } = await import('/web/i18n.ts' as string);
      messageBar.text = t('machine:trim-actions.full', { before: 3 << 30, after: 1 << 30 });
      messageBar.details = [];
      messageBar.from = [];
      messageBar.kind = 'info';
      messageBar.countdown = { ms: 15_000, id: 1, end: () => {} };
    });
    await page.waitForTimeout(5000); // a third of the ring run down
    await shot(page, 'message-info');
    await page.click('#message-close');
  });
  // The folders' menu shows while the machine runs with them, the clipboard's while it has sharing: both faked.
  await setUi(page, `a.current.hasGpu = true; a.current.hasNetwork = true; a.current.hasMouse = true; a.usb.on = true;
    Object.defineProperty(folders, 'running', { get: () => true }); folders.changed();
    a.clipboard.share = { state: 'waiting', stopped: false, canType: false, typed: undefined };
    a.power.state = 'running'; a.power.stateText = ''; a.messageBar.text = '';`);
  await state('toolbar-all', async () => { await shot(page, 'toolbar-all'); });
  const MENUS = ['load-snapshot', 'screen-menu', 'keys', 'mouse-lock', 'sound-menu', 'network', 'usb-menu', 'folders', 'clipboard-menu', 'machine-menu'];
  for (const id of MENUS) {
    await state(`menu-${id}`, async () => {
      await page.locator(`details#${id} > summary`).click();
      await page.locator(`details#${id}[open]`).waitFor({ timeout: 3000 });
      await shot(page, `menu-${id}`);
      await page.locator(`details#${id} > summary`).click();
    });
  }
  await page.close();
}

// A machine that doesn't run (frontend.md "The veil"), over a console's lines drawn on the canvas: its states' veils
// and plaques, and the boot card.
{
  const page = await open();
  await setUi(page, `a.messageBar.text = ''; a.screen.size = { width: 1280, height: 720 };`);
  await page.locator('#screen').evaluate((c: HTMLCanvasElement) => {
    const g = c.getContext('2d')!;
    g.font = '16px monospace';
    for (let i = 0; i < 40; i++) {
      g.fillStyle = i % 7 === 3 ? '#5f5' : '#ccc';
      g.fillText(`[  OK  ] Reached target ${i}`, 4, 18 + i * 18); // i18n-ignore: a guest's console line
    }
  });
  for (const s of ['idle', 'suspended', 'off', 'crashed', 'failed']) {
    await state(`screen-${s}`, async () => {
      await setUi(page, `a.power.paused = false; a.power.state = '${s}';`);
      await shot(page, `screen-${s}`);
    });
  }
  await state('screen-paused', async () => {
    await setUi(page, `a.power.state = 'running'; a.power.paused = true;`);
    await page.waitForTimeout(500); // the veil waits a moment into a pause
    await shot(page, 'screen-paused');
  });
  await state('screen-boot', async () => {
    await setUi(page, `a.power.paused = false; a.power.state = 'booting'; a.bootCard.title = 'Booting'; a.bootCard.line = 'EFI stub'; a.bootCard.serial = true; a.bootCard.shown = true;`); // i18n-ignore: stand-ins for the boot card's lines
    await shot(page, 'screen-boot');
  });
  await page.close();
}

// The Home page: its panes, a machine's tabs, its dialogs and the wizards, wide; the panes and tabs narrow too.
for (const [viewport, suffix] of [[WIDE, ''], [NARROW, '-narrow']] as const) {
  const page = await open(viewport, '#home');
  await machinesPage(page).waitFor();
  const { machine } = seeded;
  for (const pane of ['preferences', 'about', 'disks', 'folders', 'connections']) {
    await state(`machines-${pane}${suffix}`, async () => {
      await choose(page, pane);
      await shot(page, `machines-${pane}${suffix}`);
    });
  }
  await state(`machines-empty${suffix}`, async () => {
    // Nothing chosen: what the page shows before a choice.
    await setUi(page, 'a.machinesNav.choose("none");');
    await settle(page);
    await shot(page, `machines-empty${suffix}`);
  });
  await choose(page, machine);
  for (const t of ['settings', 'disks', 'network', 'usb', 'folders', 'snapshots']) {
    await state(`machine-${t}${suffix}`, async () => {
      await tab(page, machine, t);
      await shot(page, `machine-${t}${suffix}`);
    });
  }
  await state(`machine-settings-advanced${suffix}`, async () => {
    await tab(page, machine, 'settings');
    await page.locator('details[data-ram-split] > summary').click();
    await page.locator('[data-field=custom-split]').check();
    await shot(page, `machine-settings-advanced${suffix}`);
    await page.locator('[data-field=custom-split]').uncheck();
    await page.click('.machines [data-action=save] + button'); // Revert
  });
  await state(`machine-settings-dirty${suffix}`, async () => {
    await tab(page, machine, 'settings');
    await page.locator('[data-field=name]').fill('Workbench 2');
    await shot(page, `machine-settings-dirty${suffix}`);
    await page.click('.machines [data-action=save] + button');
  });
  await state(`machine-network-unsaved${suffix}`, async () => {
    await tab(page, machine, 'network');
    await page.click('[data-action=add-adapter]');
    await shot(page, `machine-network-unsaved${suffix}`);
    await page.click('.machines [data-action=save] + button');
  });
  await state(`machine-bare${suffix}`, async () => {
    // A machine without a network card, USB, disks or folders: the tabs' empty states.
    await choose(page, seeded.bare);
    await tab(page, seeded.bare, 'network');
    await shot(page, `machine-bare-network${suffix}`);
    await tab(page, seeded.bare, 'usb');
    await shot(page, `machine-bare-usb${suffix}`);
    await tab(page, seeded.bare, 'disks');
    await shot(page, `machine-bare-disks${suffix}`);
    await tab(page, seeded.bare, 'folders');
    await shot(page, `machine-bare-folders${suffix}`);
    await choose(page, machine);
  });
  await state(`machines-error${suffix}`, async () => {
    // The page's error banner: a Save of an invalid shares path shows it the page's way.
    await tab(page, machine, 'settings');
    await tab(page, machine, 'folders');
    await page.locator('[data-field=shares-path]').fill('relative/path');
    await page.click('.machines [data-action=save]');
    await page.locator('.machines > .error').waitFor({ timeout: 3000 });
    await shot(page, `machines-error${suffix}`);
    await page.click('.machines > .error .dismiss');
    await page.click('.machines [data-action=save] + button');
  });
  if (suffix) { await page.close(); continue; }

  // Dialogs over the Home page.
  await state('dialog-add-disk', async () => {
    await tab(page, machine, 'disks');
    await page.click('[data-action=add-disk-open]');
    await page.locator('#add-disk[open]').waitFor();
    await shot(page, 'dialog-add-disk');
    const sources = await page.$$eval('#add-disk [data-source]', (bs) => bs.map((b) => (b as HTMLElement).dataset.source!));
    for (const s of sources) {
      await state(`dialog-add-disk-${s}`, async () => {
        await page.click(`#add-disk [data-source=${s}]`);
        await shot(page, `dialog-add-disk-${s}`);
        if (s === 'url') {
          await page.locator('#add-disk [data-field=url]').fill(`${base}/tests/qcow2/deflate.qcow2`);
          await page.locator('#add-disk [data-field=url] + button').click();
          await page.locator('#add-disk .ok').waitFor({ timeout: 10_000 });
          await shot(page, 'dialog-add-disk-url-checked');
          await page.locator('#add-disk [data-field=url]').fill('http://127.0.0.1:9/disk.img');
          await page.locator('#add-disk [data-action=add-disk]').click();
          await page.locator('#add-disk .error').waitFor({ timeout: 10_000 });
          await shot(page, 'dialog-add-disk-url-refused');
        }
        await page.locator('#add-disk .buttons button', { hasText: /./ }).first().click(); // Back
      });
    }
    await escape(page);
  });
  await state('dialog-overlays', async () => {
    await tab(page, machine, 'disks');
    await page.locator('.machines [data-action=disk-overlays]').first().click();
    await page.locator('#overlays[open]').waitFor();
    await shot(page, 'dialog-overlays');
    await state('ask-prompt', async () => {
      await page.locator('#overlays [data-action=rename-overlay]').first().click();
      await page.locator('#ask[open]').waitFor();
      await shot(page, 'ask-prompt');
      await page.click('#ask [data-answer=cancel]');
    });
    await state('ask-delete-overlay', async () => {
      await page.locator('#overlays [data-action=delete-overlay]').last().click();
      await page.locator('#ask[open]').waitFor();
      await shot(page, 'ask-delete-overlay');
      await page.click('#ask [data-answer=cancel]');
    });
    await state('dialog-resize-overlay', async () => {
      // The second overlay is called Changes: its name in the dialog's title.
      await page.locator('#overlays [data-action=resize-overlay]').last().click();
      await page.locator('#resize-disk[open]').waitFor();
      await shot(page, 'dialog-resize-overlay');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('#resize-disk[open]'), undefined, { timeout: 5000 });
    });
    await state('dialog-export-overlay', async () => {
      await page.locator('#overlays [data-action=export]').last().click();
      await settle(page);
      await shot(page, 'dialog-export-overlay');
      await page.click('#overlays [data-action=export-back]');
    });
    await escape(page);
  });
  await state('ask-confirm', async () => {
    // Delete on a machine's head: a question with a dangerous OK.
    await tab(page, machine, 'settings');
    await page.locator(`section.machine[data-selected="${machine}"] .head button`).last().click();
    await page.locator('#ask[open]').waitFor();
    await shot(page, 'ask-confirm');
    await page.click('#ask [data-answer=cancel]');
  });
  await state('dialog-add-usb', async () => {
    await tab(page, machine, 'usb');
    await page.click('[data-action=add-usb]');
    await page.locator('#add-usb[open]').waitFor();
    await shot(page, 'dialog-add-usb');
    await escape(page);
  });
  await state('dialog-attach-disk', async () => {
    await choose(page, 'disks');
    await page.locator('.machines [data-action=attach-disk]').last().click();
    await page.locator('#attach-disk[open]').waitFor();
    await shot(page, 'dialog-attach-disk');
    await escape(page);
  });
  await state('dialog-disks-overlays', async () => {
    await choose(page, 'disks');
    await page.locator('.machines [data-action=disk-overlays]').first().click();
    await page.locator('#overlays[open]').waitFor();
    await shot(page, 'dialog-disks-overlays');
    await escape(page);
  });

  // The Network wizard: a new connection's kinds and each kind's step; attaching (the connections to pick from); editing each kind.
  const netStep = async (name: string, ...clicks: string[]) => {
    await state(name, async () => {
      await choose(page, 'connections');
      await page.click('[data-action=new-connection]');
      await page.locator('#net-wizard[open]').waitFor();
      for (const c of clicks) await page.click(c);
      await shot(page, name);
      await escape(page);
    });
  };
  await netStep('net-wizard-kind');
  await netStep('net-wizard-tailscale', '#net-pick-tailnet');
  await netStep('net-wizard-tailcat', '#net-pick-tailcat');
  await netStep('net-wizard-tailcat-serve', '#net-pick-tailcat', '#net-tc-serve', '#net-tc-advanced > summary');
  await netStep('net-wizard-local', '#net-pick-local');
  await netStep('net-wizard-room-pick', '#net-pick-room');
  await netStep('net-wizard-room-create', '#net-pick-room', '#net-room-create');
  await netStep('net-wizard-room-create-advanced', '#net-pick-room', '#net-room-create', '#net-room-advanced > summary');
  await netStep('net-wizard-room-join', '#net-pick-room', '#net-room-join');
  await netStep('net-wizard-error', '#net-pick-tailcat', '#net-tc-exit', '#net-connect');
  await state('net-wizard-pick', async () => {
    await choose(page, machine);
    await tab(page, machine, 'network');
    await page.click('[data-action=attach-connection]');
    await page.locator('#net-wizard[open]').waitFor();
    // An adapter that has a connection: the wizard asks first which change is meant.
    if (await page.locator('#net-step-change').isVisible()) {
      await shot(page, 'net-wizard-change');
      await page.click('#net-change-other');
    }
    await shot(page, 'net-wizard-pick');
    await escape(page);
  });
  const conns = await page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    const all = await store.all('connections');
    store.close();
    return all.map((c: { id: string; kind: string }) => [c.kind, c.id] as const);
  });
  for (const [kind, id] of conns) {
    await state(`connection-settings-${kind}`, async () => {
      await choose(page, 'connections');
      await page.click(`[data-connection="${id}"] [data-action=connection-details]`);
      await page.locator('[data-context-connection]').waitFor();
      await page.locator('.machines nav [data-section=settings]').last().click();
      await page.locator('section[data-selected=connection-settings]').waitFor();
      await shot(page, `connection-settings-${kind}`);
      await page.locator('.machines nav [data-action=back]').last().click();
    });
  }

  // The Folder wizard: a new folder's kinds and steps; attaching one (the folders to pick from).
  const folderStep = async (name: string, ...clicks: string[]) => {
    await state(name, async () => {
      await choose(page, 'folders');
      await page.click('[data-action=new-folder]');
      await page.locator('#folder-wizard[open]').waitFor();
      for (const c of clicks) await page.click(c);
      await shot(page, name);
      await escape(page);
    });
  };
  await folderStep('folder-wizard-kind');
  await folderStep('folder-wizard-host', '#folder-kind-host');
  await folderStep('folder-wizard-opfs', '#folder-kind-opfs');
  await state('folder-wizard-pick', async () => {
    await choose(page, seeded.bare);
    await tab(page, seeded.bare, 'folders');
    await page.click('[data-action=attach-folder]');
    await page.locator('#folder-wizard[open]').waitFor();
    await shot(page, 'folder-wizard-pick');
    await escape(page);
  });
  await state('machines-folders-files', async () => {
    await choose(page, 'folders');
    await page.locator('[data-action=folder-files]').first().click();
    await settle(page);
    await shot(page, 'machines-folders-files');
  });
  await page.close();
}

// The page's own (transient) machine on the Home page: `?machine=` with a disk, its Disks and Snapshots tabs.
await state('machines-transient', async () => {
  const page = await open(WIDE, '#home');
  await setUi(page, `a.current.transient = { label: 'This page’s machine', disk: 'disk.qcow2' }; a.current.hasOverlay = true; a.current.canSuspend = true; a.machinesNav.choose('page');`); // i18n-ignore: a test's label
  await page.locator('section.machine[data-selected="page"]').waitFor();
  await shot(page, 'machines-transient-disks');
  await page.locator('section.machine[data-selected="page"] [data-tab=snapshots]').click();
  await shot(page, 'machines-transient-snapshots');
  await page.close();
});

// The demo store's page (tools/screens-demos.ts: the stores answered there), in profiles of its own.
await demoScreens(browser, { base, state, shot, css: args.css }, WIDE, NARROW);
// The introduction (tools/screens-intro.ts), in profiles of its own.
await introScreens(browser, { base, state, shot, css: args.css }, WIDE, NARROW);

await browser.close();
server.close();
// What a guest or hardware shows, which this tool doesn't reach.
const unreached = [
  'a running machine\'s screen (a guest)',
  'the on-screen keyboard over a running machine (a guest)',
  'the Network menu connected, the USB menu with devices attached, the Folders menu with folders shared (a guest; hardware)',
  'the Clipboard menu\'s sharing states (a guest\'s agent)',
  'Add a USB device past its first step (the browser\'s device chooser)',
  'the Folder wizard\'s host step past Choose (the browser\'s directory picker)',
];
writeFileSync(`${DIR}/missed.txt`, [...missed.map((m) => `failed: ${m}`), ...unreached.map((u) => `not reached: ${u}`)].join('\n') + '\n');
console.log(`${taken.length} screenshots in ${DIR}`);
for (const m of missed) console.log(`missed: ${m}`);
