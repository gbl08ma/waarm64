// The serial terminal's size (docs/devices.md "The serial console's size"; docs/frontend.md "The serial terminal"): on
// the Buildroot guest with the tests' agent end (`?agentstub`, web/app/run/dev-knobs.ts), 80×25 until an agent whose
// HELLO says CAP.CONSOLE; then the terminal fits its view, the page says its columns and rows (CONSOLE), and says them
// again when the window's size changes; when the agent's connection ends, it keeps the size last said (the guest's tty
// keeps it: it no longer fits, but shows what the guest was told), and so for an agent without it that comes next.
// ~30 s.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { CAP, encodeFrame, encodeHello, FRAME, FrameReader } from '../web/agent-frame.ts';
import { PAGE_QUERY } from './page-query.ts';

const IMAGES = new URL('../target/images/', import.meta.url);
const skip = !(existsSync(new URL('buildroot/rootfs.ext4', IMAGES)) && existsSync(new URL('linux/Image', IMAGES))) && 'SKIPPED: run images/build.sh';

let browser: Browser;
let base: string;
let close: () => void;
before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => {
  await browser?.close();
  close?.();
});

/** The agent's end, played by the test: what the page sends is kept (and taken at once). */
const stub = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __agentStub: MessagePort; __stubGot: number[]; __stubConn: number };
    w.__stubGot = [];
    w.__stubConn = 0;
    w.__agentStub.onmessage = (e: MessageEvent<{ type: string; bytes?: Uint8Array; conn: number }>) => {
      if (e.data.type !== 'data' || !e.data.bytes || e.data.conn !== w.__stubConn) return;
      w.__stubGot.push(...e.data.bytes);
      w.__agentStub.postMessage({ type: 'taken', n: e.data.bytes.length, conn: e.data.conn });
    };
  });
/** The "agent" connects (`open`), or its connection ends. */
const openPort = (page: Page, open = true) =>
  page.evaluate((open) => {
    const w = window as unknown as { __agentStub: MessagePort; __stubConn: number; __stubGot: number[] };
    if (open) {
      w.__stubConn++;
      w.__stubGot = [];
    }
    w.__agentStub.postMessage({ type: 'open', open, conn: w.__stubConn });
  }, open);
/** The "agent" says HELLO with `caps`. */
const hello = (page: Page, caps: number) =>
  page.evaluate((b) => {
    const w = window as unknown as { __agentStub: MessagePort; __stubConn: number };
    w.__agentStub.postMessage({ type: 'data', bytes: new Uint8Array(b), conn: w.__stubConn });
  }, [...encodeFrame(FRAME.HELLO, encodeHello({ version: 1, caps }))]);
/** The CONSOLE frames the page has sent on this connection: [columns, rows] each. */
const consoles = async (page: Page) =>
  new FrameReader()
    .push(new Uint8Array(await page.evaluate(() => (window as unknown as { __stubGot: number[] }).__stubGot)))
    .filter((f) => f.type === FRAME.CONSOLE)
    .map((f) => {
      const v = new DataView(f.payload.buffer, f.payload.byteOffset);
      return [v.getUint16(0, true), v.getUint16(2, true)];
    });
/** The terminal's rows as xterm.js draws them, and whether it fits its box. */
const shown = (page: Page) =>
  page.evaluate(() => ({
    rows: document.querySelectorAll('.xterm-rows > div').length,
    size: document.getElementById('terminal')?.dataset.size,
    fit: document.getElementById('terminal')?.dataset.fit !== undefined,
  }));
async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (ok(v)) return v;
    if (Date.now() > end) assert.fail(`${what}: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("the serial terminal: 80×25 without an agent that sets the guest's size; with one (CAP.CONSOLE) it fits its view and says its size, again at a resize; the size last said kept when the agent goes, and for an agent without it", { skip, timeout: 120_000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/web/app/?${PAGE_QUERY}machine=buildroot&view=terminal&agentstub`);
  await page.waitForFunction(() => document.body.dataset.state === 'running' && /# $/.test(`${document.querySelector('.xterm-rows')?.textContent?.trimEnd()} `), null, { timeout: 60_000, polling: 200 });
  await stub(page);
  assert.deepEqual(await shown(page), { rows: 25, size: '80x25', fit: false }, 'no agent: 80×25');
  // An agent that sets the serial console's size: the terminal fits the view, and its size is said.
  await openPort(page);
  await hello(page, CAP.TIME | CAP.CONSOLE);
  const [first] = await until(() => consoles(page), (c) => c.length > 0, 'CONSOLE at the HELLO');
  const [cols, rows] = first;
  assert.ok(cols > 80 && rows > 25, `a 1400×1000 window fits more than 80×25: ${cols}×${rows}`);
  assert.deepEqual(await shown(page), { rows, size: `${cols}x${rows}`, fit: true }, "the terminal's rows are the size said");
  // The terminal's own view has no frame, as the screen's has none: its cells start at the window's edge.
  const frame = await page.evaluate(() => {
    const s = document.querySelector('#terminal .xterm-screen')!.getBoundingClientRect();
    const st = getComputedStyle(document.getElementById('terminal')!);
    return { left: s.left, top: s.top, padding: st.padding, border: st.borderTopWidth };
  });
  assert.equal(frame.padding, '0px', `no padding in the terminal's own view: ${JSON.stringify(frame)}`);
  assert.equal(frame.border, '0px', `no border: ${JSON.stringify(frame)}`);
  assert.ok(frame.left === 0, `the cells at the window's left edge: ${JSON.stringify(frame)}`);
  // At every window height (a cell's worth, 1 px apart) the rows fitted are all inside the box: none clipped, no scrollbar.
  for (let h = 1000; h < 1020; h++) {
    await page.setViewportSize({ width: 1400, height: h });
    await page.waitForTimeout(80);
    const f = await page.evaluate(() => {
      const box = document.getElementById('terminal')!, view = document.getElementById('terminal-view')!;
      const s = box.querySelector('.xterm-screen')!.getBoundingClientRect(), b = box.getBoundingClientRect();
      return { over: s.bottom - (b.top + box.clientTop + box.clientHeight), scroll: view.scrollHeight - view.clientHeight, size: box.dataset.size };
    });
    assert.ok(f.over <= 0 && f.scroll <= 0, `at ${h} px the rows fit the box: ${JSON.stringify(f)}`);
  }
  await page.setViewportSize({ width: 1400, height: 1000 });
  if (process.env.WAARM64_CONSOLE_SHOT) await page.screenshot({ path: `${process.env.WAARM64_CONSOLE_SHOT}/console-fit.png` });
  // A smaller window: a smaller size, said once it settles.
  await page.setViewportSize({ width: 900, height: 600 });
  const c = await until(() => consoles(page), (c) => c.length > 1 && c.at(-1)![0] < cols && c.at(-1)![1] < rows, 'CONSOLE after the resize');
  const [cols2, rows2] = c.at(-1)!;
  const said = { rows: rows2, size: `${cols2}x${rows2}` };
  assert.deepEqual(await shown(page), { ...said, fit: true });
  assert.ok(cols2 >= 20 && rows2 >= 5, `${cols2}×${rows2}`);
  // The agent's connection ends: the guest's tty keeps the size said, so the terminal does too (no longer fitting).
  await openPort(page, false);
  await until(() => shown(page), (s) => !s.fit, 'the agent gone');
  await page.waitForTimeout(500);
  assert.deepEqual(await shown(page), { ...said, fit: false }, 'the size said kept when the agent goes');
  // A resize meanwhile changes nothing: nothing can tell the guest.
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.waitForTimeout(500);
  assert.deepEqual(await shown(page), { ...said, fit: false }, 'the size said kept at a resize without the agent');
  // An agent without CAP.CONSOLE: nothing said, the same size.
  await openPort(page);
  await hello(page, CAP.TIME);
  await page.waitForTimeout(1000);
  assert.deepEqual(await consoles(page), [], 'no CONSOLE to an agent without it');
  assert.deepEqual(await shown(page), { ...said, fit: false });
  // An agent with it again, the terminal hidden (the screen's view): the size it says is the one kept, not 80×25.
  await page.click('[data-view-button="screen"]');
  await openPort(page, false);
  await openPort(page);
  await hello(page, CAP.TIME | CAP.CONSOLE);
  await until(() => consoles(page), (c) => c.length > 0, 'CONSOLE at the HELLO, hidden');
  await page.waitForTimeout(500);
  assert.ok((await consoles(page)).every(([c, r]) => c === cols2 && r === rows2), `the hidden terminal says the size kept: ${JSON.stringify(await consoles(page))}`);
  assert.deepEqual(errors, []);
  await ctx.close();
});
