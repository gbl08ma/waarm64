// The guest agent on Debian (docs/devices.md "The guest's agent"; clipboard sharing: docs/plans/clipboard.md §2–§3):
// the agent (agent/, web/app/guest-agent.ts), over fw_cfg into /run and started by its credential unit, connects to the
// page over the machine's vsock (web/vsock-device.ts `AGENT_PORT`) and answers the page's HELLO (web/app/agent-link.ts,
// `window.__agent`), here with `?clipboard=1`.
// Then: what it costs idle (plan §3.3's targets: no CPU time, no wakeups, its RSS), TYPE's text on the foreground
// console (a reader on tty1 writes what it gets to a file; a long paste arrives whole; none of it while tty1 is in
// graphics mode, as under a compositor: TYPED says why), COPY's text of tty1's screen (none in graphics mode), the toolbar's clipboard
// button (sharing, then its switch: PAUSE stopping TYPE and RESUME restoring it; waiting once the agent stops), a trim
// from the Home page's storage bar (a deleted file's blocks out of the overlay, its files compacted), the
// page carrying on when the agent stops, and the connection itself without the agent: perl connected to the agent's
// port echoing it into itself (a small frame, and 320 KiB of 64 KiB frames past the link's window and vsock's credit, so
// the guest's buffers, the credit and the window's flow all turn over). The agent's start again at the end: its unit
// runs it anew.
// WAARM64_AGENT_IDLE=<s> sets the idle window (default 20 s; the plan's measurement is 60).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { unattendedQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';
import { PAGE_QUERY } from './page-query.ts';
import { answerAsks } from './page-ask.ts';
import { CAP, COPIED, FRAME, TRIMMED, TYPED } from '../web/agent-frame.ts';
import { words } from './words.ts';

const debian = (process.env.WAARM64_DISTROS ?? '').split(',').includes('debian');
const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const AGENT = new URL('../target/images/agent/waarm64-agent', import.meta.url);
const skip = !debian ? 'SKIPPED: scripts/ci-debian.sh runs it (WAARM64_DISTROS=debian)' : (!existsSync(IMAGE) || !existsSync(FIRMWARE) || !existsSync(AGENT)) && 'SKIPPED: run images/build.sh debian edk2 agent';
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
  await onSerial(page, `clear; echo "<<${runs}:$({ ${cmd}; } | tr '\\n<>' ' []')>"">"\n`);
  await shows(page, re, ms);
  return re.exec(await terminal(page))![1].trim();
}
type Hello = { version: number; caps: number };
type Link = { open: boolean; backlog: number; agent?: Hello; paused: boolean; send(type: number, payload?: Uint8Array): boolean; type(text: string): boolean; copy(ms: number): Promise<{ status: number; text: string } | undefined>; pause(): void; resume(): void; onFrame?: (f: { type: number; payload: Uint8Array }) => void };
const link = <T>(page: Page, f: (l: Link) => T) => page.evaluate(`(${f})(window.__agent)`) as Promise<T>;
const isOpen = (page: Page, open: boolean) =>
  page.waitForFunction((want) => (window as unknown as { __agent?: Link }).__agent?.open === want, open, { timeout: 120_000, polling: 100 });
const hello = (page: Page) =>
  page.waitForFunction(() => (window as unknown as { __agent?: Link }).__agent?.agent, null, { timeout: 120_000, polling: 100 }).then((h) => h.jsonValue() as Promise<Hello>);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** The toolbar's clipboard button's state (web/app/ClipboardMenu.svelte), once it is `want`. */
const buttonIs = (page: Page, want: string) =>
  page.waitForFunction((w) => document.getElementById('clipboard-menu')?.dataset.state === w, want, { timeout: 30_000, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the clipboard button is ${await page.evaluate(() => document.getElementById('clipboard-menu')?.dataset.state)}`); });
/** The toolbar's switch (the clipboard menu's Share the clipboard box). */
async function share(page: Page, on: boolean) {
  if (!(await page.evaluate(() => (document.getElementById('clipboard-menu') as HTMLDetailsElement).open))) await page.click('#clipboard-menu > summary');
  await page.setChecked('#clipboard-on', on);
  await page.click('#clipboard-menu > summary');
}
/** The reader's file on the guest: its SHA-256 and size. */
const typed = (page: Page) => run(page, 'sha256sum </tmp/typed | cut -c1-64; stat -c %s /tmp/typed').then((s) => s.split(/\s+/));
const TYPE = 5;

/**
 * The serial console's size (CONSOLE, docs/devices.md "The serial console's size"): the guest's tty is the terminal's
 * rows (as xterm.js draws them) after the agent's HELLO, and follows a change of the window's height.
 */
async function consoleFollows(page: Page, run: (page: Page, cmd: string) => Promise<string>) {
  // The terminal's size as the page has it (`data-size`, columns × rows), and the guest's (`stty size`: rows columns).
  const sizes = async () => {
    const [r, c] = (await run(page, 'stty size < /dev/ttyAMA0')).split(/\s+/).map(Number);
    const [pc, pr] = (await page.evaluate(() => document.getElementById('terminal')?.dataset.size ?? '0x0')).split('x').map(Number);
    return { guest: `${c}x${r}`, page: `${pc}x${pr}`, rows: pr };
  };
  const agrees = async (what: string) => {
    let s = await sizes();
    for (let i = 0; i < 20 && s.guest !== s.page; i++, s = await sizes()) await page.waitForTimeout(250);
    assert.equal(s.guest, s.page, `${what}: the guest's size is the terminal's (${JSON.stringify(s)})`);
    return s;
  };
  const first = await agrees('at the HELLO');
  assert.ok(first.rows > 25, `the terminal fits the view: ${JSON.stringify(first)}`);
  const v = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.setViewportSize({ width: v.width, height: v.height - 160 });
  const smaller = await agrees('after the window shrank');
  assert.ok(smaller.rows < first.rows, `fewer rows: ${JSON.stringify([first, smaller])}`);
  await page.setViewportSize(v);
  await agrees('back');
}

test('the guest agent on Debian: it arrives, connects, says HELLO, costs nothing idle, types on the console, copies its screen, pauses; the page carries on without it; the connection echoes', { skip, timeout: 15 * 60_000 }, (t) => withDebianLock(async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  // Every message the bar shows, as it shows it (a notice may be replaced before it is read).
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { messages: string[] }).messages = seen;
    new MutationObserver(() => {
      const t = document.getElementById('message-text')?.textContent ?? '';
      if (seen.at(-1) !== t) seen.push(t);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  await page.goto(`${base}/web/app/?${PAGE_QUERY}ncpus=2&view=both&clipboard=1&${unattendedQuery()}`);
  await page.waitForFunction(() => ['running', 'failed', 'crashed', 'idle', 'off'].includes(document.body.dataset.state!), null, { timeout: 300_000, polling: 250 });
  assert.equal(await page.evaluate(() => document.body.dataset.state), 'running', await message(page));

  // The agent: over fw_cfg, started by its unit, connected over vsock, its HELLO (version 1, TYPE, TIME).
  await shows(page, /login: /); // `running` may come from the agent's HELLO, before the getty's prompt
  await onSerial(page, 'root\n');
  await shows(page, /root@\S+:~# /);
  const h = await hello(page).catch(async (e) => {
    const why = await run(page, 'journalctl -b -u waarm64-agent -o cat --no-pager | grep -vE "restart|Start|Consumed" | sort | uniq -c | tail -8');
    throw new Error(`${e}; the guest says: ${why}`);
  });
  assert.equal(h.version, 1);
  assert.ok(h.caps & 1, `the agent can TYPE (caps ${h.caps})`);
  assert.ok(h.caps & 16, `the agent sets the clock (caps ${h.caps})`);
  await buttonIs(page, 'sharing');
  assert.equal(await run(page, 'test -d /sys/module/vmw_vsock_virtio_transport && echo vsock'), 'vsock');
  assert.equal(await run(page, 'systemctl is-active waarm64-agent'), 'active');
  await consoleFollows(page, run);
  // A login that ends and starts again (systemd starts agetty anew, which hangs the tty up) finds the size still set
  // (it passes without the agent's hold too: docs/devices.md "The serial console's size").
  await onSerial(page, 'exit\n');
  await shows(page, /login: \s*$/, 60_000);
  await onSerial(page, 'root\n');
  await shows(page, /root@\S+:~# \s*$/);
  const [r, c] = (await run(page, 'stty size')).split(/\s+/).map(Number);
  assert.equal(`${c}x${r}`, await page.evaluate(() => document.getElementById('terminal')?.dataset.size), 'the size after a new login');
  const pid = await run(page, 'systemctl show -p MainPID --value waarm64-agent');
  assert.equal(await run(page, `readlink /proc/${pid}/exe`), '/run/waarm64/agent');
  const size = Number(await run(page, `stat -L -c %s /proc/${pid}/exe`));
  assert.equal(size, (await import('node:fs')).statSync(AGENT).size, 'the binary the page served');
  // The fw_cfg read's cost (plan §3.1: one MMIO read a byte; the gzip in pieces of a page, so none read twice), measured
  // in the guest.
  const [gz, readUs, gunzipUs] = (await run(page, 'd=/sys/firmware/qemu_fw_cfg/by_name/opt/waarm64; cat $d/agent.[0-9][0-9][0-9]/size | awk "{ n += \\$1 } END { print n }"; s=$(date +%s%N); cat $d/agent.[0-9][0-9][0-9]/raw >/tmp/agent.gz; m=$(date +%s%N); gzip -dc /tmp/agent.gz >/dev/null; e=$(date +%s%N); echo $(( (m - s) / 1000 )) $(( (e - m) / 1000 ))')).split(/\s+/).map(Number);
  t.diagnostic(`agent: ${size} bytes, ${gz} gzipped; fw_cfg read in the guest ${(readUs / 1000).toFixed(1)} ms (${(readUs * 1000 / gz).toFixed(0)} ns a byte), gunzip ${(gunzipUs / 1000).toFixed(1)} ms`);

  // Idle (plan §3.3): no CPU time (utime + stime), no wakeups (voluntary context switches), VmRSS about 1 MiB or less.
  const cost = async () => {
    const [ticks, switches, rss] = (await run(page, `{ awk '{print $14 + $15}' /proc/${pid}/stat; awk '/^voluntary_ctxt_switches/ {print $2}' /proc/${pid}/status; awk '/^VmRSS/ {print $2}' /proc/${pid}/status; }`)).split(/\s+/).map(Number);
    return { ticks, switches, rss };
  };
  const before = await cost();
  await page.waitForTimeout(IDLE_S * 1000);
  const idle = await cost();
  t.diagnostic(`agent idle over ${IDLE_S} s: ${idle.ticks - before.ticks} ticks, ${idle.switches - before.switches} voluntary switches; VmRSS ${idle.rss} KiB (${before.ticks} ticks and ${before.switches} switches since its start)`);
  assert.equal(idle.ticks, before.ticks, 'no CPU time while idle');
  assert.equal(idle.switches, before.switches, 'no wakeups while idle');
  assert.ok(idle.rss <= 1024, `VmRSS ${idle.rss} KiB`);

  // TYPE: a reader on tty1, the foreground console (getty stopped), writes what it gets to /tmp/typed. Line ends arrive
  // as Enter (CR, which the terminal turns into NL); UTF-8 whole.
  assert.equal(await run(page, 'cat /sys/class/tty/tty0/active'), 'tty1');
  await run(page, 'systemctl stop getty@tty1; : >/tmp/typed; setsid sh -c "echo \\$\\$ >/tmp/reader; exec cat >>/tmp/typed" </dev/tty1 >/dev/tty1 2>&1 & echo started');
  const text = 'héllo wörld ☃ 𝄞\r\nsecond line\n';
  assert.equal(await link(page, (l) => l.type('héllo wörld ☃ 𝄞\r\nsecond line\n')), true);
  const want = text.replace(/\r\n?/g, '\n');
  for (let i = 0; ; i++) {
    const [hash, n] = await typed(page);
    if (hash === sha(want)) break;
    if (i > 20) assert.fail(`tty1's reader got ${n} bytes, not ${Buffer.byteLength(want)} (${hash})`);
    await page.waitForTimeout(500);
  }
  // A long paste (20 KiB in lines of 100 bytes) into a slow reader (the terminal not canonical, a dd of 512 bytes at a time):
  // the terminal's 4 KiB buffer fills, and the agent waits for room rather than lose the rest. (No `>>` in a command: `run`
  // would take its echo, as it is typed, for its output, and the paste would race the reader's start.)
  await run(page, 'kill $(cat /tmp/reader); stty -F /dev/tty1 -icanon -echo min 1; setsid sh -c "while dd bs=512 count=1 status=none; do sleep 0.01; done | tee -a /tmp/typed >/dev/null" </dev/tty1 >/dev/null 2>&1 & echo started');
  const long = Array.from({ length: 200 }, (_, i) => `${String(i).padStart(4, '0')} ${'abcdefghij'.repeat(9)}abcd\n`).join('');
  assert.equal(await page.evaluate(([s]) => (window as unknown as { __agent: Link }).__agent.type(s), [long]), true);
  const wantLong = want + long;
  const t0 = performance.now();
  for (let i = 0; ; i++) {
    const [hash, n] = await typed(page);
    if (hash === sha(wantLong)) {
      t.diagnostic(`the long paste reached the slow reader whole in ${((performance.now() - t0) / 1000).toFixed(1)} s or less`);
      break;
    }
    if (i > 120) assert.fail(`after the long paste tty1's reader has ${n} bytes, not ${Buffer.byteLength(wantLong)}; the first line missing or out of order: ${await run(page, 'grep -o "^[0-9][0-9][0-9][0-9] " /tmp/typed | awk "NR - 1 != \\$1 + 0 { print NR - 1, \\$1; exit }"')}; the agent says: ${await run(page, 'journalctl -b -u waarm64-agent -o cat --no-pager | tail -3')}; its start: ${await run(page, 'head -c 160 /tmp/typed | od -An -c | tr -s " "')}; tty1 held by ${await run(page, 'for p in /proc/[0-9]*; do ls -l $p/fd 2>/dev/null | grep -q "/dev/tty1$" && echo $(basename $p) $(cat $p/comm); done')}; the session: ${await run(page, 'loginctl list-sessions --no-legend; cat /run/systemd/seats/seat0 | grep ACTIVE')}`);
    await page.waitForTimeout(1000);
  }

  // PAUSE from the toolbar's switch: the agent drops TYPE (sent as a raw frame: the link itself refuses to type while
  // paused) until RESUME.
  await share(page, false);
  await buttonIs(page, 'paused');
  assert.equal(await link(page, (l) => l.type('refused\n')), false, 'the link refuses while paused');
  assert.equal(await page.evaluate((k) => (window as unknown as { __agent: Link }).__agent.send(k, new TextEncoder().encode('paused\n')), TYPE), true);
  await page.waitForTimeout(3000);
  assert.deepEqual(await typed(page), [sha(wantLong), String(Buffer.byteLength(wantLong))], 'nothing typed while paused');
  await share(page, true);
  await buttonIs(page, 'sharing');
  assert.equal(await link(page, (l) => l.type('resumed\n')), true);
  const wantResumed = wantLong + 'resumed\n';
  for (let i = 0; ; i++) {
    const [hash, n] = await typed(page);
    if (hash === sha(wantResumed)) break;
    if (i > 20) assert.fail(`after RESUME tty1's reader has ${n} bytes, not ${Buffer.byteLength(wantResumed)}`);
    await page.waitForTimeout(500);
  }

  // tty1 in graphics mode, as a compositor that runs on it puts it (KDSETMODE KD_GRAPHICS, by perl as root): TYPE is
  // refused, the page hears why (TYPED NOT_TEXT), and nothing waits in tty1's input for whatever reads it once the
  // compositor ends. Back in text mode, TYPE types again (TYPED DONE).
  await page.evaluate((k) => {
    const w = window as unknown as { __typed: number[]; __agent: Link };
    w.__typed = [];
    const on = w.__agent.onFrame;
    w.__agent.onFrame = (f) => { if (f.type === k) w.__typed.push(f.payload[0]); on?.(f); };
  }, FRAME.TYPED);
  const kdMode = (mode: number) => run(page, `perl -e 'open(my $t, "+<", "/dev/tty1") or die; ioctl($t, 0x4B3A, ${mode}) or die "$!"' && echo mode ${mode}`);
  const typedSaid = (n: number) => page.waitForFunction((m) => (window as unknown as { __typed: number[] }).__typed.length >= m, n, { timeout: 10_000, polling: 100 })
    .then(() => page.evaluate(() => (window as unknown as { __typed: number[] }).__typed.at(-1)));
  assert.equal(await kdMode(1), 'mode 1');
  assert.equal(await link(page, (l) => l.type('under graphics\n')), true);
  assert.equal(await typedSaid(1), TYPED.NOT_TEXT);
  // COPY under graphics: no text, and the page hears why.
  assert.deepEqual(await page.evaluate(() => (window as unknown as { __agent: Link }).__agent.copy(10_000)), { status: COPIED.GRAPHICS, text: '' });
  await page.waitForTimeout(1000);
  assert.deepEqual(await typed(page), [sha(wantResumed), String(Buffer.byteLength(wantResumed))], 'nothing typed in graphics mode');
  assert.equal(await kdMode(0), 'mode 0');
  assert.equal(await link(page, (l) => l.type('text again\n')), true);
  assert.equal(await typedSaid(2), TYPED.DONE);
  const wantText = wantResumed + 'text again\n';
  for (let i = 0; ; i++) {
    const [hash, n] = await typed(page);
    if (hash === sha(wantText)) break;
    if (i > 20) assert.fail(`back in text mode tty1's reader has ${n} bytes, not ${Buffer.byteLength(wantText)}`);
    await page.waitForTimeout(500);
  }

  // COPY: tty1's screen as text (vcsu, UTF-8 whole), its lines without their trailing blanks, no blank rows at its end.
  // Characters the console's font has: vcsu's first read builds its copy from the glyphs (a snowman came back ■).
  await run(page, `printf '\\033[H\\033[2Jcopy marker \\303\\251 \\303\\237\\nsecond   \\n' >/dev/tty1; echo written`);
  const copied = await page.evaluate(() => (window as unknown as { __agent: Link }).__agent.copy(10_000));
  assert.equal(copied?.status, COPIED.OK, JSON.stringify(copied));
  assert.equal(copied.text, 'copy marker é ß\nsecond', JSON.stringify(copied));

  // The agent stopped: the page hears its connection end, the link refuses, the machine runs on.
  await run(page, 'systemctl stop waarm64-agent; echo stopped');
  await isOpen(page, false);
  await buttonIs(page, 'waiting');
  assert.equal(await link(page, (l) => l.type('nobody\n')), false);
  assert.equal(await link(page, (l) => l.agent), undefined);
  assert.equal(await page.evaluate(() => document.body.dataset.state), 'running');

  // The connection without the agent: perl connects to the agent's port (AF_VSOCK 40, struct sockaddr_vm for the host's
  // CID 2) and echoes what it reads into it.
  await onSerial(page, `clear; perl -e 'socket(my $s, 40, 1, 0) or die "socket: $!"; connect($s, pack("SSLLCx3", 40, 0, 8574, 2, 0)) or die "connect: $!"; while (sysread($s, my $b, 65536)) { my $o = 0; $o += syswrite($s, $b, length($b) - $o, $o) while $o < length $b }' & echo st""arted\n`);
  await shows(page, /started/);
  await isOpen(page, true);
  const echoed = await page.evaluate(async () => {
    const link = (window as unknown as { __agent: Link }).__agent;
    const sum = (b: Uint8Array) => b.reduce((a, x) => (a * 31 + x) >>> 0, 7);
    const sent: [number, number, number][] = [];
    const got: [number, number, number][] = [];
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${got.length} of ${sent.length} frames back after 120 s (backlog ${link.backlog})`)), 120_000);
      link.onFrame = (f) => {
        if (f.type === 1 || f.type === 7) return; // the link's own HELLO and RESUME at the connection, echoed (whether before this or after)
        got.push([f.type, f.payload.length, sum(f.payload)]);
        if (got.length === sent.length) { clearTimeout(timer); resolve(); }
      };
    });
    const frames: [number, Uint8Array][] = [[3, new TextEncoder().encode('hello from the page')]];
    for (let i = 0; i < 5; i++) frames.push([4, Uint8Array.from({ length: 65536 }, (_, k) => (k * 7 + i * 13) & 0xff)]);
    for (const [type, payload] of frames) {
      sent.push([type, payload.length, sum(payload)]);
      if (!link.send(type, payload)) throw new Error('the link refused a frame');
    }
    await done;
    return { sent, got };
  });
  assert.deepEqual(echoed.got, echoed.sent);
  await onSerial(page, 'clear; kill %1; echo cl""osed\n');
  await shows(page, /closed/);
  await isOpen(page, false);

  // Started again (its unit reads fw_cfg anew): HELLO again, and it types.
  await run(page, 'systemctl start waarm64-agent; echo started');
  await hello(page);
  assert.equal(await link(page, (l) => l.paused), false);
  assert.equal(await link(page, (l) => l.type('again\n')), true);
  const wantAgain = wantText + 'again\n';
  for (let i = 0; ; i++) {
    const [hash, n] = await typed(page);
    if (hash === sha(wantAgain)) break;
    if (i > 20) assert.fail(`after the restart tty1's reader has ${n} bytes, not ${Buffer.byteLength(wantAgain)}`);
    await page.waitForTimeout(500);
  }
  // TRIM, last (the Home page's visit resizes the screen: the page has a size to say at an echoed HELLO after it),
  // from the Home page's storage bar (Free unused disk space; docs/devices.md "Disk space handed back"): a
  // deleted file's 48 MiB leave the overlay, whose files shrink by them at the compaction in full that follows (a
  // change compacts only past half free), and the message bar says so.
  assert.ok(h.caps & CAP.TRIM, `the agent trims (caps ${h.caps})`);
  // 96 MiB kept beside it: the 48 MiB trimmed stay under half the overlay, which only the compaction asked for gives back.
  await run(page, 'for f in keep big; do dd if=/dev/urandom of=/root/$f bs=1M count=$([ $f = keep ] && echo 96 || echo 48) 2>/dev/null; done; sync; rm /root/big; sync; echo done', 300_000);
  await page.click('#machines-open');
  await page.click('[data-action="trim-disks"]');
  const got = await page.waitForFunction(() => window.__trimmed, null, { timeout: 240_000, polling: 250 }).then((r) => r.jsonValue()) as { status?: number; before?: number; after?: number };
  t.diagnostic(`trim: ${JSON.stringify(got)}`);
  if (got.status !== TRIMMED.TRIMMED) {
    await page.click('[data-action="back"]');
    assert.fail(`TRIMMED ${got.status}; the agent says: ${await run(page, 'journalctl -b -u waarm64-agent -o cat --no-pager | tail -5')}`);
  }
  assert.ok(got.before! - got.after! >= 40 << 20, `the overlays went from ${got.before} to ${got.after} bytes`);
  await page.click('[data-action="back"]');
  const said = words('machine:trim-actions.trimmed');
  await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('message-text')?.textContent ?? ''), said.source, { timeout: 10_000, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the message bar said: ${await page.evaluate(() => JSON.stringify((window as unknown as { messages: string[] }).messages.slice(-6)))}`); });
  await run(page, 'rm /root/keep; echo gone');
  assert.match(await run(page, 'journalctl -b -u waarm64-agent -o cat --no-pager | grep -c "trim: the filesystems trimmed"'), /^1$/);

  assert.deepEqual(errors, []);
  await page.close();
}));
