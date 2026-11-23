// Clipboard sharing with an X11 session (docs/plans/clipboard.md §3.2 "X11", §6 step 5) on images/debian-sway/build.sh's
// Debian: the test switches the user's next login on tty1 to an X session (`/tmp/x11`: its ~/.bash_profile runs Xvfb on
// display 1 with a cookie of its own, `-auth ~/.Xauthority`, as startx would) and ends sway, so that the agent's way to
// it is the real one: logind's files (a tty's session: no DISPLAY= in them), the X server found among the user's
// processes, its cookie from its `-auth` file, its socket in /tmp/.X11-unix through the unit's private /tmp (bound in
// read-only). The guest's side is xclip as the user, from the serial shell.
// - Text both ways: short (inline), past xclip's chunk (2.7 MB, so xclip sends it by INCR) and past the agent's threshold
//   (400 KB to xclip by INCR); the host's text copied back isn't offered back.
// - Images both ways: a PNG copied with xclip reaches the host with its pixels; the host's 1.5 MB PNG reaches xclip by
//   INCR, byte for byte.
// - HTML both ways (plan §3.2): xclip's text/html on the host's clipboard; the host's HTML and text, each by its type.
// - The toolbar's switch: PAUSE leaves the guest's clipboard without the host's text; RESUME brings sharing back.
// - What the agent and its session child cost while X runs (plan §3.3's targets), and the X server's end (a new
//   session, a new child, sharing again).
// WAARM64_AGENT_IDLE=<s> sets the idle window (default 20 s).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { credentialsQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';
import { pageFixture } from './debian-fixture.ts';
import { loadSnapshotFile } from '../bench/snapshot-start.ts';
import { PAGE_QUERY } from './page-query.ts';
import { answerAsks } from './page-ask.ts';
import { desktopNow, desktops, recordDesktop } from './page-desktop.ts';

const debian = (process.env.WAARM64_DISTROS ?? '').split(',').includes('debian');
const IMAGE = 'target/images/debian-sway/disk.qcow2';
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const AGENT = new URL('../target/images/agent/waarm64-agent', import.meta.url);
const skip = !debian ? 'SKIPPED: scripts/ci-debian.sh --platform runs it (WAARM64_DISTROS=debian)'
  : !existsSync(new URL(`../${IMAGE}`, import.meta.url)) ? 'SKIPPED: run images/debian-sway/build.sh'
  : (!existsSync(FIRMWARE) || !existsSync(AGENT)) && 'SKIPPED: run images/build.sh edk2 agent';
const IDLE_S = Number(process.env.WAARM64_AGENT_IDLE ?? 20);

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
type Link = { agent?: Hello };
type Share = { pending?: string; onWritten?: (s: string) => void; onImage?: () => void };
const hello = (page: Page) =>
  page.waitForFunction(() => (window as unknown as { __agent?: Link }).__agent?.agent, null, { timeout: 120_000, polling: 100 }).then((h) => h.jsonValue() as Promise<Hello>);
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const hostText = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
// The guest's side: xclip as the user on display 1; and what the agent says in the journal.
const X = 'xc() { runuser -u user -- env DISPLAY=:1 XAUTHORITY=/home/user/.Xauthority "$@"; }';
const journal = (page: Page) => run(page, 'journalctl -b -u waarm64-agent -o cat --no-pager | grep -vE "restart|Start|Consumed" | tail -6');
/** Waits until the host's clipboard says `want` (by its SHA-256). */
async function hostHas(page: Page, want: string, what: string, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const got = await hostText(page);
    if (got === want) return;
    if (Date.now() > end) assert.fail(`${what}: the host's clipboard has ${got.length} characters (${sha(got).slice(0, 12)}…), not ${want.length}: ${JSON.stringify(got.slice(0, 60))}; the guest's targets: ${await run(page, 'xc xclip -o -selection clipboard -t TARGETS')}; the agent says: ${await journal(page)}`);
    await page.waitForTimeout(250);
  }
}
/** The paste chord on the screen with `text` in the host's clipboard. */
async function pasteChord(page: Page, text: string) {
  await page.evaluate((s) => navigator.clipboard.writeText(s), text);
  await page.locator('#screen').focus();
  await page.keyboard.press('Control+V');
}
/** The guest's clipboard as `target`, by its SHA-256 (empty: nothing there). */
const guestHas = (page: Page, target = 'UTF8_STRING') => run(page, `xc xclip -o -selection clipboard -t ${target} 2>/dev/null | sha256sum | cut -c1-64`);
/** Waits until the guest's clipboard has `want` as `target` (its SHA-256 `hash`). */
async function guestHasHash(page: Page, hash: string, what: string, target = 'UTF8_STRING') {
  for (let i = 0; ; i++) {
    const got = await guestHas(page, target);
    if (got === hash) return;
    if (i > 40) assert.fail(`${what}: the guest's ${target} is ${got}, not ${hash}; its targets: ${await run(page, 'xc xclip -o -selection clipboard -t TARGETS')}; the agent says: ${await journal(page)}`);
    await page.waitForTimeout(500);
  }
}
type HostImage = { types: string[]; size: number; sha: string; width: number; left: number[]; right: number[] };
/** The host's clipboard's PNG, if it has one: its types, its bytes' size and SHA-256, its width and two of its pixels. */
const readHostImage = (page: Page) => page.evaluate(async (): Promise<HostImage | undefined> => {
  const item = (await navigator.clipboard.read()).find((i) => i.types.includes('image/png'));
  if (!item) return undefined;
  const blob = await item.getType('image/png');
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const [w, h] = [bitmap.width, bitmap.height];
  const g = new OffscreenCanvas(w, h).getContext('2d')!;
  g.drawImage(bitmap, 0, 0);
  const at = (x: number) => [...g.getImageData(x, h >> 1, 1, 1).data.subarray(0, 3)];
  return { types: [...item.types], size: blob.size, sha: [...d].map((x) => x.toString(16).padStart(2, '0')).join(''), width: w, left: at(w >> 3), right: at(w - 1 - (w >> 3)) };
});
async function hostImage(page: Page, f: (x: HostImage) => boolean, what: string, ms = 60_000): Promise<HostImage> {
  const end = Date.now() + ms;
  for (;;) {
    const got = await readHostImage(page);
    if (got && f(got)) return got;
    if (Date.now() > end) assert.fail(`${what}: the host's clipboard has ${JSON.stringify(got)}; the agent says: ${await journal(page)}`);
    await page.waitForTimeout(250);
  }
}
/**
 * Waits for the agent's session child on the X server's CLIPBOARD (display 1), in a session after `after`, and for the
 * page to say the guest's desktop is X11's (DESKTOP).
 */
async function xUp(page: Page, after = 0) {
  for (let i = 0; ; i++) {
    const lines = await journal(page);
    const m = [...lines.matchAll(/a child for session (\w+) \(uid 1000\)/g)].pop();
    const desktop = await desktopNow(page);
    if (m && desktop === 'x11' && lines.slice(lines.lastIndexOf(m[0])).includes("on the X server's CLIPBOARD (:1)")) {
      const session = Number(m[1].replace(/\D/g, ''));
      if (session > after) return { session, journal: lines };
    }
    if (i > 90) assert.fail(`the agent's child didn't come up on X (the page's desktop: ${desktop}): the agent says: ${lines}; X says: ${await run(page, 'tail -c 600 /tmp/x11.log; ls -la /tmp/.X11-unix; ps -o pid,user,args -u user')}`);
    await page.waitForTimeout(1000);
  }
}
/** The toolbar's switch, and the button's state after it. */
async function share(page: Page, on: boolean) {
  if (!(await page.evaluate(() => (document.getElementById('clipboard-menu') as HTMLDetailsElement).open))) await page.click('#clipboard-menu > summary');
  await page.setChecked('#clipboard-on', on);
  await page.click('#clipboard-menu > summary');
  await page.waitForFunction((w) => document.getElementById('clipboard-menu')?.dataset.state === w, on ? 'sharing' : 'paused', { timeout: 10_000, polling: 100 });
}

test('clipboard sharing with an X11 session: xclip both ways, INCR, images, HTML, the pause, X again; idle costs', { skip, timeout: 15 * 60_000 }, async (t) => {
  const query = `${PAGE_QUERY}ncpus=2&view=both&clipboard=1&disk=/${IMAGE}&${credentialsQuery()}`;
  // From a booted-Debian fixture of the sway image (tests/debian-fixture.ts): no boot is tested here.
  const fixture = await pageFixture(browser, base, query);
  await withDebianLock(async () => {
    const context = await browser.newContext();
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await answerAsks(page);
    await page.goto(`${base}/web/app/?autostart=1&${query}`);
    if (fixture) await loadSnapshotFile(page, fixture);
    await page.waitForFunction(() => ['running', 'failed', 'crashed', 'idle', 'off'].includes(document.body.dataset.state!), null, { timeout: 300_000, polling: 250 });
    assert.equal(await page.evaluate(() => document.body.dataset.state), 'running', await message(page));
    await shows(page, /login: /); // `running` may come from the agent's HELLO, before the getty's prompt
    await onSerial(page, 'root\n');
    await shows(page, /root@\S+:~# /);
    // A restored guest's clock stood still since the save.
    if (fixture) await run(page, `date -u -s @${(Date.now() / 1000).toFixed(3)} > /dev/null`);
    const h = await hello(page);
    assert.ok(h.caps & 2, `the agent shares text (caps ${h.caps})`);
    await onSerial(page, `${X}\n`);
    await recordDesktop(page);
    // The user's next login is an X session: sway ends (and its session), getty logs the user in again.
    await run(page, 'touch /tmp/x11; for i in $(seq 60); do pgrep -x sway >/dev/null && break; sleep 1; done; pkill -x sway; echo switched');
    const up = await xUp(page);
    t.diagnostic(`X in session ${up.session}: ${up.journal}`);
    const props = await run(page, `loginctl show-session ${up.session} -p Type -p Seat -p Active -p Display`);
    t.diagnostic(`session ${up.session}: ${props}; the unit: ${await run(page, 'systemd-analyze security waarm64-agent --no-pager 2>/dev/null | tail -1')}`);
    assert.ok(props.split(' ').includes('Type=tty') && props.split(' ').includes('Active=yes'), props);
    await page.evaluate(() => {
      const w = window as unknown as { __clipboard: Share; __writes: number; __images: number };
      w.__writes = w.__images = 0;
      w.__clipboard.onWritten = () => { w.__writes++; };
      w.__clipboard.onImage = () => { w.__images++; };
    });
    const counts = () => page.evaluate(() => { const w = window as unknown as { __writes: number; __images: number }; return { writes: w.__writes, images: w.__images }; });

    // Guest to host: short text inline; 2.7 MB, which xclip sends by INCR.
    await run(page, 'printf "from X11 \\342\\230\\203" >/tmp/s; xc xclip -i -selection clipboard </tmp/s >/dev/null 2>&1; echo copied');
    await hostHas(page, 'from X11 ☃', 'xclip -i');
    await run(page, 'seq 1 400000 >/tmp/huge; stat -c %s /tmp/huge; xc xclip -i -selection clipboard </tmp/huge >/dev/null 2>&1');
    const huge = Array.from({ length: 400000 }, (_, i) => `${i + 1}\n`).join('');
    assert.ok(huge.length > 2 << 20);
    const t0 = Date.now();
    await hostHas(page, huge, 'xclip -i of 2.7 MB (INCR)', 120_000);
    t.diagnostic(`2.7 MB from xclip (INCR) to the host: ${Date.now() - t0} ms`);

    // Host to guest: the paste chord, short (inline) and 400 KB (past the agent's threshold: to xclip by INCR).
    const short = 'from the host ✓ — π\n';
    await pasteChord(page, short);
    await guestHasHash(page, sha(short), 'the paste chord');
    assert.equal(await guestHas(page, 'STRING'), sha(short), 'as STRING too');
    const big = Array.from({ length: 12000 }, (_, i) => `line ${i} of the host's text, ünïcödé\n`).join('');
    assert.ok(Buffer.byteLength(big) > 256 << 10);
    await pasteChord(page, big);
    await guestHasHash(page, sha(big), 'the paste chord with 400 KB (INCR)');
    // The guest copies the host's text back: not offered to the host.
    const before = (await counts()).writes;
    await pasteChord(page, short);
    await guestHasHash(page, sha(short), 'the paste chord, short again');
    await run(page, 'xc xclip -o -selection clipboard >/tmp/back && xc xclip -i -selection clipboard </tmp/back >/dev/null 2>&1; echo copied back');
    await page.waitForTimeout(3000);
    assert.equal((await counts()).writes, before, "the host's own text isn't offered back");

    // Images. Guest to host: a PNG (made here, typed in as base64) copied with xclip: the host's PNG has its pixels.
    const png = await page.evaluate(async () => {
      const c = new OffscreenCanvas(64, 32);
      const g = c.getContext('2d')!;
      g.fillStyle = '#f00';
      g.fillRect(0, 0, 32, 32);
      g.fillStyle = '#00f';
      g.fillRect(32, 0, 32, 32);
      const b = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
      return btoa(String.fromCharCode(...b));
    });
    assert.ok(png.length < 3000, `a PNG of ${png.length} base64 characters`);
    await run(page, `echo ${png} | base64 -d >/tmp/p.png && xc xclip -i -selection clipboard -t image/png </tmp/p.png >/dev/null 2>&1; echo copied`);
    const got = await hostImage(page, (x) => x.width === 64, "xclip's PNG");
    const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 2);
    assert.ok(near(got.left, [255, 0, 0]) && near(got.right, [0, 0, 255]), `its pixels: ${got.left} ${got.right}`);
    // Host to guest: 1.5 MB of noise (1024×512), synced (the read permission), to xclip by INCR byte for byte.
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
    const noise = await hostImage(page, (x) => x.width === 1024, 'the noise on the host');
    const t1 = Date.now();
    await guestHasHash(page, noise.sha, 'the noise in the guest', 'image/png');
    t.diagnostic(`a ${noise.size}-byte PNG to xclip (INCR): ${Date.now() - t1} ms`);

    // HTML. Guest to host: xclip's text/html (alone) on the host's clipboard.
    await run(page, `printf '<b>bold</b> from X11' | xc xclip -i -selection clipboard -t text/html >/dev/null 2>&1; echo copied`);
    for (let i = 0; ; i++) {
      const html = await page.evaluate(async () => {
        const item = (await navigator.clipboard.read()).find((x) => x.types.includes('text/html'));
        return item ? (await item.getType('text/html')).text() : '';
      });
      if (/<b>bold<\/b> from X11/.test(html)) break;
      if (i > 80) assert.fail(`xclip's HTML on the host: ${JSON.stringify(html)}; the agent says: ${await journal(page)}`);
      await page.waitForTimeout(250);
    }
    // Host to guest: text and HTML in one item, synced: each by its type.
    await page.evaluate(() => navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob(['rich text'], { type: 'text/plain' }), 'text/html': new Blob(['<i>rich</i> text'], { type: 'text/html' }) })]));
    await guestHasHash(page, sha('rich text'), "the host's text beside its HTML");
    const targets = await run(page, 'xc xclip -o -selection clipboard -t TARGETS');
    assert.ok(targets.split(' ').includes('text/html') && targets.split(' ').includes('UTF8_STRING'), targets);
    const html = await run(page, 'xc xclip -o -selection clipboard -t text/html');
    assert.match(html, /\[i\]rich\[\/i\] text/, "the host's HTML (Chromium's, sanitised)");

    // PAUSE: the host's text leaves the guest's clipboard; RESUME: sharing again.
    await pasteChord(page, 'before the pause');
    await guestHasHash(page, sha('before the pause'), 'the paste chord before the pause');
    await share(page, false);
    for (let i = 0; ; i++) {
      if (await run(page, 'xc xclip -o -selection clipboard >/dev/null 2>&1 && echo has || echo empty') === 'empty') break;
      if (i > 20) assert.fail("the guest's clipboard kept the host's text after PAUSE");
      await page.waitForTimeout(500);
    }
    await run(page, 'echo guest-during-pause | xc xclip -i -selection clipboard >/dev/null 2>&1; echo copied');
    await page.waitForTimeout(3000);
    assert.equal(await hostText(page), 'before the pause', "paused: the guest's copy doesn't reach the host");
    await share(page, true);
    await run(page, 'printf guest-after-resume | xc xclip -i -selection clipboard >/dev/null 2>&1; echo copied');
    await hostHas(page, 'guest-after-resume', 'xclip after RESUME');

    // Idle while X runs (plan §3.3): the agent and its session child take no CPU time and no wakeups.
    const pid = await run(page, 'systemctl show -p MainPID --value waarm64-agent');
    const child = await run(page, `ps -o pid= --ppid ${pid} | tr -d " "`);
    assert.match(child, /^\d+$/, `one session child: ${child}`);
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
      t.diagnostic(`${k} idle over ${IDLE_S} s with X: ${b[k].ticks - a[k].ticks} ticks, ${b[k].switches - a[k].switches} voluntary switches; VmRSS ${b[k].rss} KiB`);
      assert.equal(b[k].ticks, a[k].ticks, `${k}: no CPU time while idle`);
      assert.equal(b[k].switches, a[k].switches, `${k}: no wakeups while idle`);
      assert.ok(b[k].rss <= 1024, `${k}: VmRSS ${b[k].rss} KiB`);
    }

    // The X server ends (and its session); getty logs the user in again, X comes back, and so does sharing.
    await run(page, 'pkill -x Xvfb; echo stopped');
    const again = await xUp(page, up.session);
    assert.deepEqual((await desktops(page)).slice(-3), ['x11', 'none', 'x11'], "the page's desktop: down with X, up with it again");
    t.diagnostic(`X again, session ${again.session}`);
    await run(page, 'printf guest-after-x-again | xc xclip -i -selection clipboard >/dev/null 2>&1; echo copied');
    await hostHas(page, 'guest-after-x-again', 'xclip with X again');
    await pasteChord(page, 'host with X again');
    await guestHasHash(page, sha('host with X again'), 'the paste chord with X again');

    assert.deepEqual(errors, []);
    await context.close();
  });
});
