// The run's lifecycle on the page (web/app/run/, docs/frontend.md "The worker protocol"), on the Buildroot guest: what
// ends a run ends all of it. The review's findings (2026-11-11) that only the page shows.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { t } from '../web/i18n.ts';
import { answerAsks } from './page-ask.ts';
import { openHome } from './page-home.ts';

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
  await page.goto(`${base}/web/app/?autostart=1&machine=buildroot&ncpus=1&view=terminal`);
  assert.equal((await settled(page)).state, 'running');
  await page.evaluate(() => {
    const w = (window as unknown as { __workers: Workers }).__workers.find((x) => /\/app\/worker\.ts/.test(x.url))!;
    w.worker.onerror!(new ErrorEvent('error', { message: 'planted' }));
  });
  assert.equal(await page.evaluate(() => document.body.dataset.state), 'crashed');
  await page.waitForFunction(() => (window as unknown as { __workers: Workers }).__workers.filter((x) => /\/app\/worker\.ts/.test(x.url)).every((x) => x.terminated), null, { timeout: 10_000, polling: 100 });
  const second = await ctx.newPage(); // the disk was the first tab's: free now
  await second.goto(`${base}/web/app/?autostart=1&machine=buildroot&ncpus=1&view=terminal`);
  const r = await settled(second, 60_000);
  assert.equal(r.state, 'running', r.text);
  await ctx.close();
});

/** Makes stored machine `name` with a blank disk in the page's store (as the Home page would); returns its id. */
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

test("finding 4: a machine opened from the Home page whose last tab was killed doesn't start: the memory signal's choices first", { timeout: 60_000 }, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await answerAsks(page);
  await page.goto(`${base}/web/app/?autostart=1&clocksync=0&view=terminal`); // the page's machine, waiting for a disk
  const id = await makeMachine(page, 'Killed');
  await page.evaluate(async (id) => {
    const { markAlive } = await import('/web/app/memory.ts' as string);
    markAlive(id, { name: 'Killed', ramMiB: 512, ncpus: 1, jitMiB: 256, gib: 1.5, peakGiB: 1.6, t: Date.now() - 3_600_000 });
  }, id);
  await openHome(page);
  await page.locator('.machines .pick', { hasText: 'Killed' }).click();
  await page.locator('.machines section.machine[data-selected] [data-action=open]').click();
  await page.waitForFunction((asIs) => document.body.dataset.state === 'idle' && [...document.querySelectorAll('#message-actions button')].some((b) => b.textContent === asIs), t('machine:memory-signal.crashed.asIs'), { timeout: 10_000, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the page is ${await page.evaluate(() => `${document.body.dataset.state}: ${document.getElementById('message-text')?.textContent}`)}`); });
  await ctx.close();
});

test("finding 5: a 3D machine's Copy screen settles (no picture) when its GPU worker never answers", { timeout: 60_000 }, async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/tests/browser/core.html`); // any page of the origin
  const r = await page.evaluate(async () => {
    const { ClipboardActions } = await import('/web/app/areas/clipboard-actions.ts' as string);
    const { Replies } = await import('/web/app/run/replies.ts' as string);
    const replies = { grabs: new Replies(), screens: new Replies() };
    const silent = { postMessage() {} }; // a GPU worker busy for good, or replaced
    const actions = new ClipboardActions({ run: { gpu: silent } }, replies, () => document.createElement('canvas'));
    const t0 = performance.now();
    const png = await Promise.race([actions.screenPng(), new Promise((r) => setTimeout(() => r('hung'), 20_000))]);
    return { png: png === undefined ? 'none' : String(png), s: Math.round((performance.now() - t0) / 1000) };
  });
  assert.equal(r.png, 'none', 'settled without a picture');
  assert.ok(r.s <= 12, `within the 2D path's 10 s (${r.s} s)`);
  await page.close();
});

test('finding 6: a guest reboot during a save restarts the machine once the save ends', { timeout: 60_000 }, async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/tests/browser/core.html`); // any page of the origin
  const r = await page.evaluate(async () => {
    const { PowerActions } = await import('/web/app/run/power-actions.ts' as string);
    const { power } = await import('/web/app/areas/power.svelte.ts' as string);
    let started = 0;
    const actions = new PowerActions({
      machine: { spec: {}, stored: undefined },
      runner: { stop: async () => undefined, start: () => void started++ },
      messages: { setState() {} },
      terminal: { term: { reset() {} } },
      later: {},
      signal: { crashedBefore: () => false, fits: () => true },
    });
    power.saving = true; // a snapshot being written when the guest resets
    const done = actions.rebooted(() => true);
    await new Promise((r) => setTimeout(r, 300));
    const during = started;
    power.saving = false; // the save ends (its job failed: the machine it saved reset)
    await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
    const replaced = actions.rebooted(() => false); // a reboot of a run replaced meanwhile: nothing
    await replaced;
    return { during, after: started };
  });
  assert.deepEqual(r, { during: 0, after: 1 });
  await page.close();
});

test('finding 7: a kept snapshot restored during a save says to wait, and asks nothing', { timeout: 60_000 }, async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/tests/browser/core.html`); // any page of the origin
  const r = await page.evaluate(async () => {
    const { SnapshotRestore } = await import('/web/app/areas/snapshot-restore.ts' as string);
    const calls: string[] = [];
    const restore = new SnapshotRestore({
      machine: { stored: { record: { id: 'aaaaaaaaaaaa' } }, store: { get: async () => void calls.push('store') } },
      power: { busy: () => (calls.push('busy'), true), exclusively: async () => void calls.push('exclusively') },
      runner: {},
    });
    await restore.restoreKept('bbbbbbbbbbbb');
    return calls;
  });
  assert.deepEqual(r, ['busy'], 'the busy check (which says to wait) first, nothing else');
  await page.close();
});

test("finding 8: a notice's end (an info notice's countdown, or closing an error's) brings back the stopped machine's error and its actions", { timeout: 60_000 }, async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/tests/browser/core.html`); // any page of the origin
  const bars = await page.evaluate(async () => {
    const { Messages } = await import('/web/app/run/messages.ts' as string);
    const { messageBar } = await import('/web/app/areas/message-bar.svelte.ts' as string);
    const messages = new Messages({ spec: {} }, () => undefined);
    const bar = () => ({ text: messageBar.text, actions: messageBar.actions.map((a: { label: string }) => a.label), kind: messageBar.kind, counts: !!messageBar.countdown });
    const retry = { label: 'action-1', run() {} };
    messages.setState('failed', 'failure-1', [retry]);
    messages.notify('notice-1');
    const info = bar();
    messageBar.countdown.end(); // the bar's ring ran down
    const afterInfo = bar();
    messages.notify('notice-2', 'error');
    const error = bar();
    messages.dismiss();
    return { info, afterInfo, error, afterError: bar() };
  });
  const failed = { text: 'failure-1', actions: ['action-1'], kind: 'error', counts: false };
  assert.deepEqual(bars, {
    info: { text: 'notice-1', actions: [], kind: 'info', counts: true },
    afterInfo: failed,
    error: { text: 'notice-2', actions: [], kind: 'error', counts: false },
    afterError: failed,
  });
  await page.close();
});

test("finding 9: \"Start with N MiB of RAM\" after a crash wins over the address's ?ram=; Cancel keeps the mark", { timeout: 60_000 }, async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/tests/browser/core.html?ram=4096&ncpus=2`); // any page of the origin, with the address's size
  const r = await page.evaluate(async ([ramLabel]) => {
    const { MemorySignal } = await import('/web/app/run/memory-signal.ts' as string);
    const { markAlive, lastCrash } = await import('/web/app/memory.ts' as string);
    const { answer, asking } = await import('/web/app/ask.svelte.ts' as string);
    const { resolveMachine } = await import('/web/app/run/config.ts' as string);
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    const now = Date.now();
    const record = { id: 'aaaaaaaaaaa9', name: 'Big', ncpus: 2, ramMiB: 2048, display: '2d', network: false, attachments: [], created: now, modified: now };
    await store.put('machines', record);
    let snapshots: unknown[] = [{}];
    const m = { name: 'uefi', stored: { record }, store: { ...store, get: (k: string, id: string) => store.get(k, id), put: (k: string, v: unknown) => store.put(k, v), snapshotsOf: async () => snapshots }, jitBudget: () => 320, ramMiB: 4096, ncpus: 2 };
    let shown: { label: string; run(): void }[] = [];
    let restarts = 0;
    const signal = new MemorySignal(m, { setState: (_s: string, _m: unknown, a: typeof shown) => { shown = a; } }, async () => void restarts++);
    markAlive(record.id, { name: 'Big', ramMiB: 4096, ncpus: 2, jitMiB: 320, gib: 3, peakGiB: 3.2, t: now - 3_600_000 });
    signal.crashedBefore();
    // With snapshots: it asks first; Cancel keeps the mark (the next start still warns).
    shown.find((a) => a.label === ramLabel)!.run();
    while (!asking.current) await new Promise((r) => setTimeout(r, 20));
    answer(false);
    await new Promise((r) => setTimeout(r, 100));
    const kept = !!lastCrash(record.id);
    // Without: chosen, the machine starts at it over the address's ?ram=.
    snapshots = [];
    shown.find((a) => a.label === ramLabel)!.run();
    while (!restarts) await new Promise((r) => setTimeout(r, 20));
    const saved = await store.get('machines', record.id);
    const resolved = resolveMachine(new URLSearchParams(location.search), saved, {}, { gpu: true, ramMiB: 2048, cores: 8 });
    store.close();
    return { kept, cleared: !lastCrash(record.id), ram: resolved.ramMiB, ncpus: resolved.ncpus, address: location.search };
  }, [t('machine:memory-signal.crashed.ram', { mib: 2048 })]);
  assert.deepEqual(r, { kept: true, cleared: true, ram: 2048, ncpus: 2, address: '?ncpus=2' });
  await page.close();
});

test('finding 10: closing the Home page after the guest itself stopped reads the edited record again', { timeout: 60_000 }, async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/tests/browser/core.html`); // any page of the origin
  const r = await page.evaluate(async () => {
    const { PageWindow } = await import('/web/app/areas/page-window.ts' as string);
    const { power } = await import('/web/app/areas/power.svelte.ts' as string);
    let reloads = 0;
    const machine = { run: {} }; // the run the guest's power-off ended: still the page's until the next stop
    const w = new PageWindow({ machine, screen: { fit() {}, canvas: { focus() {} } }, terminal: { term: { focus() {} } }, reloadStored: async () => void reloads++ });
    const closed = async (state: string) => {
      power.state = state;
      w.closeMachines();
      await new Promise((r) => setTimeout(r, 0));
      return reloads;
    };
    return { off: await closed('off'), crashed: await closed('crashed'), running: await closed('running') };
  });
  assert.deepEqual(r, { off: 1, crashed: 2, running: 2 });
  await page.close();
});

test('finding 11: the screen follows every density change, not only the first', { timeout: 60_000 }, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  // The width moves too: an override that changes only the density re-evaluates the media queries once (Chromium 14x).
  let width = 800;
  const density = (deviceScaleFactor: number) => cdp.send('Emulation.setDeviceMetricsOverride', { width: width += 10, height: 600, deviceScaleFactor, mobile: false });
  await page.goto(`${base}/tests/browser/core.html`); // any page of the origin, at 1 dppx
  await page.evaluate(async () => {
    const { watchDensity } = await import('/web/app/areas/screen-view.ts' as string);
    const w = window as unknown as { __densities: number[] };
    w.__densities = [];
    watchDensity(() => w.__densities.push(devicePixelRatio));
  });
  const seen = () => page.evaluate(() => (window as unknown as { __densities: number[] }).__densities);
  for (const d of [2, 1.5, 3]) {
    await density(d);
    await page.waitForFunction((d) => (window as unknown as { __densities: number[] }).__densities.at(-1) === d, d, { timeout: 5000, polling: 50 })
      .catch(async () => assert.fail(`no change heard at ${d}: ${JSON.stringify(await seen())}`));
  }
  assert.deepEqual(await seen(), [2, 1.5, 3]);
  await ctx.close();
});

test('finding 12: a run stopped while its start waits for the keyboard layout posts no start', { skip, timeout: 120_000 }, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await answerAsks(page);
  await page.addInitScript(() => {
    // The browser's layout answers only when the test says (`__layout`).
    const waiting: (() => void)[] = [];
    (window as unknown as { __layout: () => void }).__layout = () => waiting.splice(0).forEach((f) => f());
    Object.defineProperty(navigator, 'keyboard', { value: { getLayoutMap: () => new Promise((r) => waiting.push(() => r(new Map()))) } });
    const RealWorker = window.Worker;
    const all: { url: string; posted: string[] }[] = [];
    (window as unknown as { __workers: typeof all }).__workers = all;
    window.Worker = class extends RealWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        const entry = { url: String(url), posted: [] as string[] };
        all.push(entry);
        const post = this.postMessage.bind(this) as (m: unknown, t?: Transferable[]) => void;
        this.postMessage = ((m: { type?: string }, t?: Transferable[]) => { entry.posted.push(String(m?.type)); post(m, t); }) as Worker['postMessage'];
      }
    };
  });
  await page.goto(`${base}/web/app/?autostart=1&machine=buildroot&ncpus=1&view=terminal&keyboard=browser`);
  const machines = () => page.evaluate(() => (window as unknown as { __workers: { url: string; posted: string[] }[] }).__workers.filter((w) => /\/app\/worker\.ts/.test(w.url)).map((w) => w.posted));
  await page.waitForFunction(() => (window as unknown as { __workers: { url: string }[] }).__workers.some((w) => /\/app\/worker\.ts/.test(w.url)), null, { timeout: 30_000 });
  await page.waitForTimeout(1000); // the first run waits for the layout
  await page.locator('#restart').click(); // not running yet: no question; the first run stops, a second waits too
  await page.waitForFunction(() => (window as unknown as { __workers: { url: string }[] }).__workers.filter((w) => /\/app\/worker\.ts/.test(w.url)).length === 2, null, { timeout: 30_000 });
  await page.evaluate(() => (window as unknown as { __layout: () => void }).__layout());
  assert.equal((await settled(page, 60_000)).state, 'running');
  const [first, second] = await machines();
  assert.ok(!first.includes('start'), `the stopped run's worker was posted: ${first.join(', ')}`);
  assert.ok(second.includes('start'));
  await ctx.close();
});

test("QA: a machine its guest powered off, or suspended, lets go of its workers (an idle tab runs nothing, keeps no guest memory); the pads are polled only while it runs", { skip, timeout: 180_000 }, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await answerAsks(page);
  await recordWorkers(page);
  await page.addInitScript(() => {
    // The page's gamepad listeners and its reads of the pads: either makes Chromium poll the pads (a thread in the browser).
    const pads = { listeners: new Set<string>(), reads: 0 };
    (window as unknown as { __pads: typeof pads }).__pads = pads;
    const [add, remove] = [window.addEventListener.bind(window), window.removeEventListener.bind(window)];
    window.addEventListener = ((type: string, f: EventListener, o?: AddEventListenerOptions) => {
      if (type.startsWith('gamepad')) pads.listeners.add(`${type} ${String(f)}`);
      add(type, f, o);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((type: string, f: EventListener, o?: EventListenerOptions) => {
      if (type.startsWith('gamepad')) pads.listeners.delete(`${type} ${String(f)}`);
      remove(type, f, o);
    }) as typeof window.removeEventListener;
    const read = Navigator.prototype.getGamepads;
    Navigator.prototype.getGamepads = function () {
      pads.reads++;
      return read.call(this);
    };
  });
  type Pads = { __pads: { listeners: Set<string>; reads: number } };
  const machines = () => page.evaluate(() => (window as unknown as { __workers: Workers }).__workers.filter((x) => /\/app\/worker\.ts/.test(x.url)).map((x) => x.terminated));
  const pads = () => page.evaluate(() => ({ listeners: (window as unknown as Pads).__pads.listeners.size, reads: (window as unknown as Pads).__pads.reads }));
  const listening = () => page.waitForFunction(() => (window as unknown as Pads).__pads.listeners.size === 2, null, { timeout: 5_000 });
  /** Waits until none of the machine workers is left running. */
  const workersGone = () => page.waitForFunction(() => (window as unknown as { __workers: Workers }).__workers.filter((x) => /\/app\/worker\.ts/.test(x.url)).every((x) => x.terminated), null, { timeout: 10_000, polling: 100 });
  const state = (s: string) => page.waitForFunction((s) => document.body.dataset.state === s, s, { timeout: 60_000, polling: 50 });

  // No machine: the page neither listens for the pads nor reads them.
  await page.goto(`${base}/web/app/?autostart=1`);
  await state('idle');
  await page.waitForTimeout(500);
  assert.deepEqual(await pads(), { listeners: 0, reads: 0 });

  await page.goto(`${base}/web/app/?autostart=1&machine=buildroot&ncpus=1&view=terminal&usb=1`);
  assert.equal((await settled(page, 120_000)).state, 'running');
  await listening();

  // Suspended: the machine worker goes (its vCPUs, its RAM, the framebuffer's frames), and the pads aren't followed.
  await page.locator('#suspend').click();
  await state('suspended');
  await workersGone();
  const idle = await pads();
  assert.equal(idle.listeners, 0, 'no gamepad listener on a suspended machine');
  await page.waitForTimeout(1000);
  assert.equal((await pads()).reads, idle.reads, 'no reads of the pads on a suspended machine');

  // Start resumes it in a new worker; the guest's own power-off ends that one too.
  await page.locator('#restart').click();
  assert.equal((await settled(page, 60_000)).state, 'running');
  assert.deepEqual(await machines(), [true, false]);
  await listening();
  await page.locator('.xterm').click();
  await page.keyboard.type('poweroff -f\n', { delay: 10 });
  await state('off');
  await workersGone();
  assert.equal((await pads()).listeners, 0, 'no gamepad listener on a machine powered off');

  // Started again at once: the stop of a run already let go of doesn't wait for its worker's answer.
  const t0 = Date.now();
  await page.locator('#restart').click();
  await page.waitForFunction(() => (window as unknown as { __workers: Workers }).__workers.filter((x) => /\/app\/worker\.ts/.test(x.url)).length === 3, null, { timeout: 10_000, polling: 20 });
  assert.ok(Date.now() - t0 < 2000, `the new run started ${Date.now() - t0} ms after Start`);
  assert.equal((await settled(page, 120_000, 'off')).state, 'running');
  await ctx.close();
});

test("QA: a panicked machine lets go of its workers too (it can't come back by itself: the worker ignores its reset), the panic's trace kept on show", { skip, timeout: 120_000 }, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await recordWorkers(page);
  // Buildroot resets at once after its panic (panic=-1): the worker keeps the crash on show, and its RAM, unless closed.
  await page.goto(`${base}/web/app/?autostart=1&machine=buildroot&ncpus=1&view=terminal&params=init=/nonexistent`);
  assert.equal((await settled(page, 60_000)).state, 'crashed');
  await page.waitForFunction(() => (window as unknown as { __workers: Workers }).__workers.filter((x) => /\/app\/worker\.ts/.test(x.url)).every((x) => x.terminated), null, { timeout: 15_000, polling: 100 });
  assert.equal(await page.evaluate(() => document.body.dataset.state), 'crashed', 'still said crashed');
  const shown = await page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
  assert.match(shown, /Kernel panic - not syncing: Requested init \/nonexistent failed/);
  // Started again: a new worker boots it.
  await page.locator('#restart').click();
  await page.waitForFunction(() => (window as unknown as { __workers: Workers }).__workers.filter((x) => /\/app\/worker\.ts/.test(x.url)).length === 2, null, { timeout: 10_000, polling: 50 });
  await ctx.close();
});
