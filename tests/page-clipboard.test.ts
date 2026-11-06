// Clipboard sharing with a Wayland session (docs/plans/clipboard.md §6 step 3) on images/debian-sway/build.sh's Debian:
// the user `user` logged in on tty1 at boot, whose login shell runs a headless sway, so the agent's way to the session is
// the real one (logind's files, the user's runtime directory, sway's socket). The page has the browser's clipboard
// (Playwright grants clipboard-read and clipboard-write) and web/app/clipboard.ts (`window.__clipboard`). The guest's
// side is wl-clipboard as the user, from the serial shell.
// - `wl-copy` in the guest reaches the host's clipboard: short text inline, long text requested in DATA frames.
// - The host's clipboard and the paste chord (Ctrl+V on the screen) reach `wl-paste`, short and long (streamed through
//   the agent's MOREs), and a second paste of the same; the guest copying the host's text back isn't offered back.
// - PAUSE drops the host's text from the guest's clipboard and stops both ways; RESUME brings them back.
// - The agent follows sway's end (the session's: `exec sway`) and its start in a new session.
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
const link = <T>(page: Page, f: (l: Link) => T) => page.evaluate(`(${f})(window.__agent)`) as Promise<T>;
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

  // PAUSE: the host's text leaves the guest's clipboard; nothing either way until RESUME.
  await pasteChord(page, 'before the pause');
  await guestHasText(page, 'before the pause', 'the paste chord before the pause');
  await link(page, (l) => l.pause());
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
  await link(page, (l) => l.resume());
  await run(page, 'wlc wl-copy guest-after-resume >/dev/null 2>&1; echo copied');
  await hostHas(page, 'guest-after-resume', 'wl-copy after RESUME');
  await pasteChord(page, 'host after resume');
  await guestHasText(page, 'host after resume', 'the paste chord after RESUME');

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
  await run(page, 'pkill -x sway; echo stopped');
  const again = await swayUp(page, up.session);
  t.diagnostic(`sway again, session ${again.session}; its runs: ${await run(page, 'grep "^== sway" /tmp/sway.log')}`);
  await run(page, 'wlc wl-copy guest-after-sway-again >/dev/null 2>&1; echo copied');
  await hostHas(page, 'guest-after-sway-again', 'wl-copy with sway again');
  await pasteChord(page, 'host with sway again');
  await guestHasText(page, 'host with sway again', 'the paste chord with sway again');
  assert.equal(await run(page, `ps -o pid= --ppid ${pid} | wc -l`), '1', 'one session child');

  assert.deepEqual(errors, []);
  await context.close();
}));
