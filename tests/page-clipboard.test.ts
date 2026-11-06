// Clipboard sharing with a Wayland session (docs/plans/clipboard.md §6 step 3) on images/debian-sway/build.sh's Debian:
// the user `user` logged in on tty1 at boot, whose login shell runs a headless sway, so the agent's way to the session is
// the real one (logind's files, the user's runtime directory, sway's socket). The page has the browser's clipboard
// (Playwright grants clipboard-read and clipboard-write) and web/app/clipboard.ts (`window.__clipboard`). The guest's
// side is wl-clipboard as the user, from the serial shell.
// - `wl-copy` in the guest reaches the host's clipboard: short text inline, long text requested in DATA frames.
// - The host's clipboard and the paste chord (Ctrl+V on the screen) reach `wl-paste`, short and long (streamed through
//   the agent's MOREs), and a second paste of the same; the guest copying the host's text back isn't offered back.
// - Sync with the read permission (plan §4.1, way 1): a copy on the host reaches wl-paste by itself (Chromium fires
//   clipboardchange, on which the page reads; a focus with nothing new offers nothing).
// - The toolbar's switch: PAUSE drops the host's text from the guest's clipboard and stops both ways; RESUME brings
//   them back.
// - The agent follows sway's end (the session's: `exec sway`) and its start in a new session, where the page syncs the
//   host's text again (the agent's SESSION).
// - Images (plan §4.4): grim's screenshot copied as PNG reaches the host with grim's PPM's pixels, and isn't sent back;
//   a JPEG arrives as a PNG of its pixels; Copy the screen and a 1.5 MB PNG of noise reach wl-paste byte for byte (and
//   the noise back to the host); an offer past the 64 MiB cap is refused before any bytes cross.
// - What the agent and its session child cost while sway runs (plan §3.3's targets: no CPU time, no wakeups, VmRSS).
// WEBPC_AGENT_IDLE=<s> sets the idle window (default 20 s).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { credentialsQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';
import { PAGE_QUERY } from './page-query.ts';
import { answerAsks } from './page-ask.ts';

const debian = (process.env.WEBPC_DISTROS ?? '').split(',').includes('debian');
const IMAGE = 'target/images/debian-sway/disk.qcow2';
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const AGENT = new URL('../target/images/agent/webpc-agent', import.meta.url);
const skip = !debian ? 'SKIPPED: scripts/ci-debian.sh --platform runs it (WEBPC_DISTROS=debian)'
  : !existsSync(new URL(`../${IMAGE}`, import.meta.url)) ? 'SKIPPED: run images/debian-sway/build.sh'
  : (!existsSync(FIRMWARE) || !existsSync(AGENT)) && 'SKIPPED: run images/build.sh edk2 agent';
const IDLE_S = Number(process.env.WEBPC_AGENT_IDLE ?? 20);

let browser: Browser;
let base: string;
let close: () => void;
before(async () => {
  if (skip) return;
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => { await browser?.close(); close?.(); });

const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
const shows = (page: Page, re: RegExp, ms = 60_000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: ms, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the terminal shows: ${await terminal(page)}`); });
const message = (page: Page) => page.evaluate(() => document.getElementById('message-text')?.textContent ?? '');
async function onSerial(page: Page, text: string) {
  await page.locator('.xterm').click();
  await page.keyboard.type(text, { delay: 10 });
}
let runs = 0;
/** Runs `cmd` on the serial shell: its output on one line (its lines joined by spaces), between markers of its own. */
async function run(page: Page, cmd: string, ms = 60_000) {
  const re = new RegExp(`<<${++runs}:([^<>]*)>>`);
  await onSerial(page, `clear; echo "<<${runs}:$({ ${cmd}; } 2>&1 | tr '\\n<>' ' []')>"">"\n`);
  await shows(page, re, ms);
  return re.exec(await terminal(page))![1].trim();
}
type Hello = { version: number; caps: number };
type Link = { open: boolean; agent?: Hello; paused: boolean; pause(): void; resume(): void };
type Share = { pending?: string; onWritten?: (s: string) => void };
const hello = (page: Page) =>
  page.waitForFunction(() => (window as unknown as { __agent?: Link }).__agent?.agent, null, { timeout: 120_000, polling: 100 }).then((h) => h.jsonValue() as Promise<Hello>);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const hostText = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
/** Waits until the host's clipboard says `want` (by its SHA-256: long texts make short messages). */
async function hostHas(page: Page, want: string, what: string, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const got = await hostText(page);
    if (got === want) return;
    if (Date.now() > end) {
      const page_ = await page.evaluate(() => {
        const w = window as unknown as { __frames?: number[]; __clipboard: Share };
        return `frames from the agent ${JSON.stringify(w.__frames)}, pending ${JSON.stringify(w.__clipboard.pending?.slice(0, 40))}, focus ${document.hasFocus()}`;
      });
      assert.fail(`${what}: the host's clipboard has ${got.length} characters (${sha(got).slice(0, 12)}…), not ${want.length} (${sha(want).slice(0, 12)}…): ${JSON.stringify(got.slice(0, 60))}; the page: ${page_}; the guest's clipboard: ${await run(page, 'wlc wl-paste -l; wlc wl-paste -n | head -c 80')}; the agent says: ${await journal(page)}`);
    }
    await page.waitForTimeout(250);
  }
}
/** The paste chord on the screen with `text` in the host's clipboard. */
async function pasteChord(page: Page, text: string) {
  await page.evaluate((s) => navigator.clipboard.writeText(s), text);
  await page.locator('#screen').focus();
  await page.keyboard.press('Control+V');
}
/** The writes of the guest's text to the host's clipboard, counted (`window.__writes`). */
const countWrites = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __clipboard: Share; __writes: number; __frames: number[]; __agent: { onFrame?: (f: { type: number }) => void } };
  w.__writes = 0;
  // The frames from the agent, by type (what a failure says).
  w.__frames = [];
  const on = w.__agent.onFrame;
  w.__agent.onFrame = (f) => { w.__frames.push(f.type); on?.(f as never); };
  w.__clipboard.onWritten = () => { w.__writes++; };
});
const writes = (page: Page) => page.evaluate(() => (window as unknown as { __writes: number }).__writes);
/** The toolbar's switch (the clipboard menu's Share the clipboard box), and the button's state after it. */
async function share(page: Page, on: boolean) {
  if (!(await page.evaluate(() => (document.getElementById('clipboard-menu') as HTMLDetailsElement).open))) await page.click('#clipboard-menu > summary');
  await page.setChecked('#clipboard-on', on);
  await page.click('#clipboard-menu > summary');
  await page.waitForFunction((w) => document.getElementById('clipboard-menu')?.dataset.state === w, on ? 'sharing' : 'paused', { timeout: 10_000, polling: 100 });
}
// The guest's side: wl-clipboard as the user, on whichever socket sway has; and what the agent says in the journal.
const W = 'wlc() { runuser -u user -- env XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=$(cd /run/user/1000 && ls wayland-? | head -1) "$@"; }';
const guestHas = (page: Page) => run(page, 'wlc wl-paste -n | sha256sum | cut -c1-64');
const journal = (page: Page) => run(page, 'journalctl -b -u webpc-agent -o cat --no-pager | grep -vE "restart|Start|Consumed" | tail -6');
/** Waits until the guest's clipboard has `want` (by its SHA-256). */
async function guestHasText(page: Page, want: string, what: string) {
  for (let i = 0; ; i++) {
    const got = await guestHas(page);
    if (got === sha(want)) return;
    if (i > 20) assert.fail(`${what}: the guest's clipboard isn't the host's text (${got}); the agent says: ${await journal(page)}`);
    await page.waitForTimeout(500);
  }
}
type HostImage = { types: string[]; size: number; sha: string; width: number; height: number; rgb: string; left: number[]; right: number[] };
/**
 * The host's clipboard's PNG, if it has one: its types, its bytes' size and SHA-256, its size in pixels, the SHA-256 of
 * its pixels (RGB, row by row) and two of them (at an eighth of its width from each side, halfway down).
 */
const readHostImage = (page: Page) => page.evaluate(async (): Promise<HostImage | undefined> => {
  const item = (await navigator.clipboard.read()).find((i) => i.types.includes('image/png'));
  if (!item) return undefined;
  const blob = await item.getType('image/png');
  const hex = async (b: Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const [w, h] = [bitmap.width, bitmap.height];
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d')!;
  g.drawImage(bitmap, 0, 0);
  const d = g.getImageData(0, 0, w, h).data;
  const rgb = new Uint8Array(w * h * 3);
  for (let k = 0, j = 0; k < d.length; k += 4, j += 3) rgb.set(d.subarray(k, k + 3), j);
  const at = (x: number) => [...d.subarray(4 * ((h >> 1) * w + x), 4 * ((h >> 1) * w + x) + 3)];
  return { types: [...item.types], size: blob.size, sha: await hex(new Uint8Array(await blob.arrayBuffer())), width: w, height: h, rgb: await hex(rgb), left: at(w >> 3), right: at(w - 1 - (w >> 3)) };
});
/** Waits until the host's clipboard has a PNG that `f` takes. */
async function hostImage(page: Page, f: (x: HostImage) => boolean, what: string, ms = 60_000): Promise<HostImage> {
  const end = Date.now() + ms;
  for (;;) {
    const got = await readHostImage(page);
    if (got && f(got)) return got;
    if (Date.now() > end) assert.fail(`${what}: the host's clipboard has ${JSON.stringify(got && { ...got, rgb: undefined })}; the guest's: ${await run(page, 'wlc wl-paste -l | tr "\\n" " "')}; the agent says: ${await journal(page)}`);
    await page.waitForTimeout(250);
  }
}
/** Waits until the guest's clipboard has a PNG whose SHA-256 is `want`. */
async function guestHasImage(page: Page, want: string, what: string) {
  for (let i = 0; ; i++) {
    const got = await run(page, 'wlc wl-paste -n -t image/png 2>/dev/null | sha256sum | cut -c1-64');
    if (got === want) return;
    if (i > 40) assert.fail(`${what}: the guest's image/png is ${got}, not ${want}; its types: ${await run(page, 'wlc wl-paste -l | tr "\\n" " "')}; the agent says: ${await journal(page)}`);
    await page.waitForTimeout(500);
  }
}
/** Waits for sway's socket and the agent's session child on the compositor's data-control, in session `not` or later. */
async function swayUp(page: Page, after = 0) {
  for (let i = 0; ; i++) {
    const lines = await journal(page);
    const m = [...lines.matchAll(/a child for session (\w+) \(uid 1000\)/g)].pop();
    const sock = await run(page, 'ls /run/user/1000/ 2>/dev/null | grep -c "^wayland-[0-9]*$"');
    if (m && sock === '1' && /on the compositor's \w+data_control_manager_v1/.test(lines.slice(lines.lastIndexOf(m[0])))) {
      if (Number(m[1].replace(/\D/g, '')) > after) return { session: Number(m[1].replace(/\D/g, '')), journal: lines };
    }
    if (i > 60) {
      const ns = await run(page, 'p=$(systemctl show -p MainPID --value webpc-agent); cat /proc/$p/wchan; echo; grep -h inotify /proc/$p/fdinfo/*; cat /run/systemd/seats/seat0 | grep ACTIVE; s=$(sed -n "s/^ACTIVE=//p" /run/systemd/seats/seat0); grep -E "^(UID|STATE|CLASS|TYPE)=" /run/systemd/sessions/$s; ls /run/systemd/sessions; ps -o pid,user,args --ppid $p; loginctl list-sessions --no-legend; journalctl -b -u getty@tty1 -o cat --no-pager | tail -5');
      assert.fail(`sway or the agent's child didn't come up: sockets ${sock}; the agent says: ${lines}; sway says: ${await run(page, 'grep -v Xwayland /tmp/sway.log | tail -c 900; journalctl -b -o cat --no-pager | grep -iE "segfault|dumped|sway" | tail -4')}; the agent's namespace: ${ns}`);
    }
    await page.waitForTimeout(1000);
  }
}

test('clipboard sharing with sway: wl-copy to the host, the paste chord to wl-paste, long texts, echoes, the pause, sway again; idle costs', { skip, timeout: 15 * 60_000 }, (t) => withDebianLock(async () => {
  const context = await browser.newContext();
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/?${PAGE_QUERY}ncpus=2&view=both&clipboard=1&disk=/${IMAGE}&${credentialsQuery()}`);
  await page.waitForFunction(() => ['running', 'failed', 'crashed', 'idle', 'off'].includes(document.body.dataset.state!), null, { timeout: 300_000, polling: 250 });
  assert.equal(await page.evaluate(() => document.body.dataset.state), 'running', await message(page));
  await onSerial(page, 'root\n');
  await shows(page, /root@\S+:~# /);
  const h = await hello(page);
  assert.ok(h.caps & 2, `the agent shares text (caps ${h.caps})`);
  // In the serial shell itself (a command's $(…) would define it in a subshell).
  await onSerial(page, `${W}\n`);
  const up = await swayUp(page);
  t.diagnostic(`sway and the agent's child in session ${up.session}: ${up.journal}`);
  // The session sway runs in is a tty's (logged in by getty), active on seat0: the agent found it all the same.
  const props = await run(page, `loginctl show-session ${up.session} -p Type -p Seat -p Active -p Name`);
  for (const p of ['Type=tty', 'Seat=seat0', 'Active=yes', 'Name=user']) assert.ok(props.split(' ').includes(p), `session ${up.session}: ${props}`);
  await countWrites(page);

  // Guest to host: short text inline, then 200 KiB requested in DATA frames.
  await run(page, 'wlc wl-copy "$(printf "from the guest \\342\\230\\203")" >/dev/null 2>&1; echo copied');
  await hostHas(page, 'from the guest ☃', 'wl-copy');
  await run(page, 'seq 1 36000 >/tmp/long; stat -c %s /tmp/long; wlc wl-copy </tmp/long >/dev/null 2>&1');
  const long = Array.from({ length: 36000 }, (_, i) => `${i + 1}\n`).join('');
  await hostHas(page, long, 'wl-copy of 200 KiB');
  assert.equal(await writes(page), 2);

  // Host to guest: the paste chord, short (inline), again (from the agent's cache), and long (streamed: past the 4 KiB
  // inline, the 64 KiB cache and the 4 frames a request grants before a MORE).
  const short = 'from the host ✓ — π\n';
  await pasteChord(page, short);
  await guestHasText(page, short, 'the paste chord');
  assert.equal(await guestHas(page), sha(short), 'pasted again: the same');
  const big = Array.from({ length: 12000 }, (_, i) => `line ${i} of the host's text, ünïcödé\n`).join('');
  assert.ok(Buffer.byteLength(big) > 4 * 65536);
  await pasteChord(page, big);
  await guestHasText(page, big, 'the paste chord with 400 KiB');
  assert.equal(await guestHas(page), sha(big), 'pasted again: the same');
  // The guest copies the host's text back (a program that takes a paste and copies it): not offered to the host.
  await pasteChord(page, short);
  await guestHasText(page, short, 'the paste chord, short again');
  await run(page, 'wlc wl-paste -n >/tmp/back && wlc wl-copy </tmp/back >/dev/null 2>&1; echo copied back');
  await page.waitForTimeout(3000);
  assert.equal(await writes(page), 2, "the host's own text isn't offered back");
  // The same text pasted again when the guest has it: no offer, the key goes at once.
  const t0 = Date.now();
  await pasteChord(page, short);
  t.diagnostic(`the paste chord with what the guest has: ${Date.now() - t0} ms`);

  // Sync (way 1): the read permission is granted, so a copy on the host reaches the guest's clipboard with no paste:
  // Chromium fires clipboardchange and the page reads on it. A focus with nothing new offers nothing.
  assert.equal(await page.evaluate(() => document.getElementById('clipboard-menu')?.dataset.permission), 'granted');
  const offers = () => page.evaluate(() => (window as unknown as { __offers?: number }).__offers ?? 0);
  await page.evaluate(() => {
    const w = window as unknown as { __offers: number; __agent: { send(type: number, p?: Uint8Array): boolean } };
    w.__offers = 0;
    const send = w.__agent.send.bind(w.__agent);
    w.__agent.send = (type, p) => { if (type === 2) w.__offers++; return send(type, p); };
  });
  await page.evaluate((s) => navigator.clipboard.writeText(s), 'synced from the host');
  await guestHasText(page, 'synced from the host', 'sync with the read permission');
  assert.equal(await offers(), 1);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(1000);
  assert.equal(await offers(), 1, 'a focus with the same clipboard: no offer');
  assert.equal(await writes(page), 2, "the host's text isn't written back");

  // PAUSE from the toolbar's switch: the host's text leaves the guest's clipboard; nothing either way until RESUME.
  await pasteChord(page, 'before the pause');
  await guestHasText(page, 'before the pause', 'the paste chord before the pause');
  await share(page, false);
  for (let i = 0; ; i++) {
    const s = await run(page, 'wlc wl-paste -n >/dev/null 2>&1 && echo has || echo empty');
    if (s === 'empty') break;
    if (i > 20) assert.fail("the guest's clipboard kept the host's text after PAUSE");
    await page.waitForTimeout(500);
  }
  await pasteChord(page, 'during the pause');
  await page.waitForTimeout(2000);
  assert.equal(await run(page, 'wlc wl-paste -n >/dev/null 2>&1 && echo has || echo empty'), 'empty', 'paused: the paste chord offers nothing');
  await run(page, 'wlc wl-copy guest-during-pause >/dev/null 2>&1; echo copied');
  await page.waitForTimeout(3000);
  assert.equal(await hostText(page), 'during the pause', "paused: the guest's copy doesn't reach the host");
  await share(page, true);
  await run(page, 'wlc wl-copy guest-after-resume >/dev/null 2>&1; echo copied');
  await hostHas(page, 'guest-after-resume', 'wl-copy after RESUME');
  await pasteChord(page, 'host after resume');
  await guestHasText(page, 'host after resume', 'the paste chord after RESUME');

  // Images (plan §4.4). Guest to host: a screenshot (grim) copied as PNG reaches the host's clipboard with the same
  // pixels (against grim's PPM of the same screen); the page reads it back once, so the browser's re-encoding isn't
  // offered back to the guest.
  await page.evaluate(() => {
    const w = window as unknown as { __images: number; __clipboard: { onImage?: () => void } };
    w.__images = 0;
    w.__clipboard.onImage = () => { w.__images++; };
  });
  const images = () => page.evaluate(() => (window as unknown as { __images: number }).__images);
  const offersBefore = await offers();
  await run(page, 'wlc grim /tmp/s.png && wlc grim -t ppm /tmp/s.ppm && wlc wl-copy --type image/png </tmp/s.png >/dev/null 2>&1; echo copied');
  const ppm = await run(page, 'head -c 15 /tmp/s.ppm | tr "\\n" " "; tail -c 1440000 /tmp/s.ppm | sha256sum | cut -c1-64');
  const shot = await hostImage(page, (x) => x.width === 800, 'the screenshot');
  assert.equal(ppm, `P6 800 600 255 ${shot.rgb}`, "the screenshot's pixels on the host (grim's PPM)");
  assert.equal(await images(), 1);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(2000);
  assert.equal(await offers(), offersBefore, "the guest's screenshot, re-encoded by the browser, offered back");
  // A JPEG alone (made on the host, typed in as base64): the page converts it, the host gets a PNG of its pixels.
  const jpeg = await page.evaluate(async () => {
    const c = new OffscreenCanvas(64, 32);
    const g = c.getContext('2d')!;
    g.fillStyle = '#f00';
    g.fillRect(0, 0, 32, 32);
    g.fillStyle = '#00f';
    g.fillRect(32, 0, 32, 32);
    const b = new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer());
    return btoa(String.fromCharCode(...b));
  });
  assert.ok(jpeg.length < 3000, `a JPEG of ${jpeg.length} base64 characters`);
  await run(page, `echo ${jpeg} | base64 -d >/tmp/p.jpg && wlc wl-copy --type image/jpeg </tmp/p.jpg >/dev/null 2>&1; echo copied`);
  const converted = await hostImage(page, (x) => x.width === 64, 'the JPEG as PNG');
  assert.deepEqual(converted.types, ['image/png']);
  const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 12);
  assert.ok(near(converted.left, [255, 0, 0]) && near(converted.right, [0, 0, 255]), `the JPEG's pixels: ${converted.left} ${converted.right}`);
  assert.equal(await images(), 2);

  // Host to guest: Copy the screen (the toolbar's menu) puts the page's display on the host's clipboard as PNG; the
  // sync offers it, and wl-paste gets the bytes the browser gives.
  await page.click('#clipboard-menu > summary');
  await page.click('#clipboard-screen');
  const screen = await hostImage(page, (x) => x.width !== 64, 'the screen copied');
  t.diagnostic(`Copy the screen: ${screen.width}×${screen.height}, ${screen.size} bytes`);
  await guestHasImage(page, screen.sha, 'the screen in the guest');
  // A big picture (noise, 1024×512: past the 4 frames a request grants and the cap's checks), streamed; timed.
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(1024, 512);
    const g = c.getContext('2d')!;
    const img = g.createImageData(1024, 512);
    let x = 0x2545f491;
    for (let k = 0; k < img.data.length; k++) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      img.data[k] = k % 4 === 3 ? 255 : x & 0xff;
    }
    g.putImageData(img, 0, 0);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': c.convertToBlob({ type: 'image/png' }) })]);
  });
  const t1 = Date.now();
  const noise = await hostImage(page, (x) => x.width === 1024, 'the noise on the host');
  await guestHasImage(page, noise.sha, 'the noise in the guest');
  t.diagnostic(`a ${noise.size}-byte PNG to the guest's wl-paste: ${Date.now() - t1} ms`);
  // The guest copies it back (wl-copy of the file): written whole, the same pixels.
  await run(page, 'wlc wl-paste -n -t image/png >/tmp/big.png && wlc wl-copy --type image/png </tmp/big.png >/dev/null 2>&1; echo copied');
  for (let i = 0; (await images()) < 3; i++) {
    if (i > 120) assert.fail(`the guest's big PNG never written: ${await journal(page)}`);
    await page.waitForTimeout(250);
  }
  assert.equal((await hostImage(page, (x) => x.width === 1024, 'the noise back')).rgb, noise.rgb);

  // The cap, against the offer's size before any bytes cross (a page's offer past 64 MiB): the agent refuses it
  // (ACK TOO_LARGE) and requests nothing; the guest's clipboard keeps what it had.
  const before = await run(page, 'wlc wl-paste -l | tr "\\n" " "');
  const refused = await page.evaluate(async () => {
    const { encodeOffer, FRAME } = await import('/web/agent-frame.ts' as string) as typeof import('../web/agent-frame.ts');
    const w = window as unknown as { __frames: number[]; __agent: { send(type: number, p?: Uint8Array): boolean; onFrame?: (f: { type: number; payload: Uint8Array }) => void } };
    const requests = w.__frames.filter((k) => k === FRAME.REQUEST).length;
    const ack = new Promise<number[]>((resolve) => {
      const on = w.__agent.onFrame;
      w.__agent.onFrame = (f) => {
        on?.(f);
        if (f.type === FRAME.ACK && new DataView(f.payload.buffer, f.payload.byteOffset).getUint32(0, true) === 0x7fff0001) resolve([...f.payload]);
      };
      setTimeout(() => resolve([]), 10_000);
    });
    w.__agent.send(FRAME.OFFER, encodeOffer({ serial: 0x7fff0001, types: [{ type: 'image/png', size: (64 << 20) + 1 }] }));
    const a = await ack;
    await new Promise((r) => setTimeout(r, 1000));
    return { ack: a, requests: w.__frames.filter((k) => k === FRAME.REQUEST).length - requests };
  });
  assert.deepEqual(refused, { ack: [1, 0, 0xff, 0x7f, 3], requests: 0 }, 'ACK TOO_LARGE, no REQUEST');
  assert.equal(await run(page, 'wlc wl-paste -l | tr "\\n" " "'), before, "the guest's clipboard after the refused offer");

  // Idle while sway runs (plan §3.3): the agent and its session child take no CPU time and no wakeups.
  const pid = await run(page, 'systemctl show -p MainPID --value webpc-agent');
  const child = await run(page, `ps -o pid= --ppid ${pid} | tr -d " "`);
  assert.match(child, /^\d+$/, `one session child: ${child}`);
  assert.equal(await run(page, `stat -c %U /proc/${child}`), 'user', "the child runs as the session's user");
  const cost = async () => {
    const [p, c] = [await run(page, `cat /proc/${pid}/stat /proc/${pid}/status`), await run(page, `cat /proc/${child}/stat /proc/${child}/status`)];
    const parse = (s: string) => {
      const stat = s.split(/\s+/);
      return { ticks: Number(stat[13]) + Number(stat[14]), switches: Number(/voluntary_ctxt_switches:\s*(\d+)/.exec(s)![1]), rss: Number(/VmRSS:\s*(\d+)/.exec(s)![1]) };
    };
    return { agent: parse(p), child: parse(c) };
  };
  const a = await cost();
  await page.waitForTimeout(IDLE_S * 1000);
  const b = await cost();
  for (const k of ['agent', 'child'] as const) {
    t.diagnostic(`${k} idle over ${IDLE_S} s with sway: ${b[k].ticks - a[k].ticks} ticks, ${b[k].switches - a[k].switches} voluntary switches; VmRSS ${b[k].rss} KiB`);
    assert.equal(b[k].ticks, a[k].ticks, `${k}: no CPU time while idle`);
    assert.equal(b[k].switches, a[k].switches, `${k}: no wakeups while idle`);
    assert.ok(b[k].rss <= 1024, `${k}: VmRSS ${b[k].rss} KiB`);
  }

  // sway ends (and with it the session: `exec sway`); getty logs the user in again and sway starts in a new session.
  // The host's text the guest held goes with it; the agent says SESSION, and the page, which forgot what the guest
  // had, syncs it to the new session.
  await pasteChord(page, 'host before sway again');
  await guestHasText(page, 'host before sway again', 'the paste chord before sway again');
  await run(page, 'pkill -x sway; echo stopped');
  const again = await swayUp(page, up.session);
  t.diagnostic(`sway again, session ${again.session}; its runs: ${await run(page, 'grep "^== sway" /tmp/sway.log')}`);
  await guestHasText(page, 'host before sway again', "the host's text in the new session (SESSION)");
  await run(page, 'wlc wl-copy guest-after-sway-again >/dev/null 2>&1; echo copied');
  await hostHas(page, 'guest-after-sway-again', 'wl-copy with sway again');
  await pasteChord(page, 'host with sway again');
  await guestHasText(page, 'host with sway again', 'the paste chord with sway again');
  assert.equal(await run(page, `ps -o pid= --ppid ${pid} | wc -l`), '1', 'one session child');

  assert.deepEqual(errors, []);
  await context.close();
}));
