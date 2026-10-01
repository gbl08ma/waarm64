// The page end to end on Debian (M8 loop 6): what a user does, in headless Chromium.
// Debian boots on the page (web/app/, JIT, realtime, 2 parallel vCPUs, a fresh OPFS
// overlay); root logs in on the serial terminal (xterm.js to the PL011) and on the
// screen (keys on the canvas through virtio-input to tty1's getty); a command typed on
// the screen writes a marker to /dev/ttyAMA0 that comes back on the serial side; the
// platform the firmware gave Linux (RTC, framebuffer, EFI, both vCPUs, a credential read back
// from fw_cfg); a file written to the disk is there after a reload (Reset disk is the Buildroot
// test's, tests/browser.test.ts). Two Debian boots, ~1.5 min alone. Realtime: not reproducible, so WEBPC_PAGE_RUNS repeats it (all
// must pass). Opt-in with WEBPC_DISTROS=debian, like Debian's other Chromium tests
// (scripts/ci.sh sets it when the image is current).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { MACHINES, readyWatcher } from '../web/app/machine.ts';
import { unattendedQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';

// The page's `running` state comes from the serial console's `ready` marker (web/app/worker.ts).
// Debian's is agetty's prompt: it must be found wherever a drain puts it, also with a kernel line
// right after it. (M8 loop 6: the marker was matched only at the end of a drain's output, and
// one page sat in `booting` for 4 minutes; that's the likely cause, not caught in the act.)
test("the page's ready marker: Debian's login prompt in any chunk, not a service's name", () => {
  const debian = (...chunks: string[]) => { const w = readyWatcher(MACHINES.debian.ready); return chunks.map(w); };
  assert.deepEqual(debian('Debian GNU/Linux 13 localhost ttyAMA0\r\n\r\nlocalhost login: '), [true]);
  assert.deepEqual(debian('\r\nlocalhost login: [   31.2] random: crng init done\r\n'), [true]);
  assert.deepEqual(debian('ttyAMA0\r\n\r\nlocalhost lo', 'gin: ', 'more'), [false, true, true]);
  assert.deepEqual(debian('Starting systemd-logind.service - User Login Management...\r\n', 'login: failure\r\n'), [false, false]);
  const buildroot = readyWatcher(MACHINES.buildroot.ready);
  assert.deepEqual(['Run /init as init process\r\n', '# '].map(buildroot), [false, true]);
});

const debian = (process.env.WEBPC_DISTROS ?? '').split(',').includes('debian');
const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const skip = !debian ? 'SKIPPED: set WEBPC_DISTROS=debian' : (!existsSync(IMAGE) || !existsSync(FIRMWARE)) && 'SKIPPED: run npm start (or images/build.sh debian edk2)';
const RUNS = Number(process.env.WEBPC_PAGE_RUNS ?? 1);

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

// A boot to the login prompt takes ~35 s alone on 2 vCPUs; under `npm test` the other files share the host (twice that).
const BOOT_MS = 240_000;

/** Waits until the page settles in `running` (from another state, e.g. after a reload or a reset). */
async function running(page: Page, from?: string) {
  await page.waitForFunction((from) => document.body.dataset.state !== from && ['running', 'failed', 'crashed', 'idle', 'off'].includes(document.body.dataset.state!), from, { timeout: BOOT_MS, polling: 250 })
    .catch(async (e) => {
      const [state, status] = await page.evaluate(() => [document.body.dataset.state, document.getElementById('status')!.textContent]);
      throw new Error(`${e}; the page is ${state} (${status}); the terminal shows: ${await terminal(page)}`);
    });
  const [state, message] = await page.evaluate(() => [document.body.dataset.state, document.getElementById('message-text')!.textContent]);
  assert.equal(state, 'running', message ?? '');
}

/** The serial terminal's visible rows (xterm.js's DOM renderer: no line breaks, so match spaces with \s). */
const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
const shows = (page: Page, re: RegExp, ms = 60_000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: ms, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the terminal shows: ${await terminal(page)}`); });

/** Types on the serial terminal (xterm.js sends \r for Enter). */
async function onSerial(page: Page, text: string) {
  await page.locator('.xterm').click();
  await page.keyboard.type(text, { delay: 10 });
}

/** Logs in as root on the serial terminal (the page is `running`: its `login: ` prompt is up). */
async function serialLogin(page: Page) {
  await onSerial(page, 'root\n');
  await shows(page, /root@\S+:~# /); // not typed ahead: a key typed while login hands the tty over was lost (the first of the next line)
  await onSerial(page, 'echo lo""gged-in-$((6*7))\n');
  await shows(page, /logged-in-42/);
}

// Playwright's keyboard.type() sends a shifted character without Shift (web/input.ts maps keys by
// `code`, as a keyboard would): press Shift with its key instead.
const SHIFTED: Record<string, string> = {
  '~': 'Backquote', '!': 'Digit1', '@': 'Digit2', '#': 'Digit3', $: 'Digit4', '%': 'Digit5', '^': 'Digit6', '&': 'Digit7', '*': 'Digit8',
  '(': 'Digit9', ')': 'Digit0', _: 'Minus', '+': 'Equal', '{': 'BracketLeft', '}': 'BracketRight', '|': 'Backslash', ':': 'Semicolon',
  '"': 'Quote', '<': 'Comma', '>': 'Period', '?': 'Slash',
};
/** Types on the screen, a key at a time (virtio-input drops events past 1,024 queued). */
async function onScreen(page: Page, text: string) {
  await page.locator('#screen').click();
  for (const c of text) {
    if (SHIFTED[c]) await page.keyboard.press(`Shift+${SHIFTED[c]}`);
    else if (/[A-Z]/.test(c)) await page.keyboard.press(`Shift+Key${c}`);
    else if (c === '\n') await page.keyboard.press('Enter');
    else await page.keyboard.press(c);
    await page.waitForTimeout(10);
  }
}

for (let run = 1; run <= RUNS; run++) {
  test(`the page runs Debian: root logs in on the screen and on the serial terminal, the platform is the firmware's, the disk persists over a reload${RUNS > 1 ? ` (run ${run})` : ''}`, { skip, timeout: 20 * 60_000 }, () => withDebianLock(async () => {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } }); // a fresh profile: an empty OPFS
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const t0 = performance.now();
    const at = () => `${((performance.now() - t0) / 1000).toFixed(1)} s`;
    await page.goto(`${base}/web/app/?ncpus=2&view=both&${unattendedQuery()}`);
    await running(page);
    console.log(`# debian page ${run}: running at ${at()}`);
    // The screen shows the guest's console (fbcon), not the boot card.
    assert.equal(await page.locator('#boot').isHidden(), true);

    // The serial terminal first: from its shell the test sees tty1's text (/dev/vcs1), so it types on
    // the screen once tty1's getty has printed its prompt (keys typed earlier may be flushed by agetty).
    await serialLogin(page);
    await onSerial(page, "until grep -q 'login: ' /dev/vcs1; do sleep 0.2; done; echo tt\"\"y1-ready\n");
    await shows(page, /tty1-ready/);
    // Root on the screen, and a command there whose output goes to the serial console.
    await onScreen(page, 'root\n');
    // Not typed ahead there either: under CI's load the first key after `root` was lost (M8 loop 7).
    await onSerial(page, "until grep -q 'root@[a-z]*:~# ' /dev/vcs1; do sleep 0.2; done; echo tt\"\"y1-shell\n");
    await shows(page, /tty1-shell/);
    await onScreen(page, 'echo from-$(tty)-$((6*7)) >/dev/ttyAMA0\n');
    await shows(page, /from-\/dev\/tty1-42/);
    console.log(`# debian page ${run}: logged in on both consoles at ${at()}`);
    // What the firmware gave Linux, and a credential read back from fw_cfg (the login above relied on them: a shifted directory can't pass).
    await onSerial(page, 'clear; echo ==be""gin; cat /sys/class/rtc/rtc0/name; cat /proc/fb; ls -1 /sys/firmware; nproc; cat /sys/firmware/qemu_fw_cfg/by_name/opt/io.systemd.credentials/firstboot.timezone/raw; echo; readlink /etc/localtime; echo ==e""nd\n');
    await shows(page, /==begin\s*rtc-efi[^]*?0 simple[^]*?efi[^]*?qemu_fw_cfg\s*2\s*Etc\/UTC\s*\S*zoneinfo\/Etc\/UTC\s*==end/);
    // The screen's text as the guest has it: bash's prompt and the command on tty1.
    await onSerial(page, 'clear; tr -s " " </dev/vcs1 | grep -o "root@[a-z]*:~# echo from-" | head -1; echo scr""een-read\n');
    await shows(page, /root@[a-z]+:~# echo from-\s*screen-read/);
    // The screen was drawn: the canvas isn't black (fbcon's text).
    assert.ok(await page.evaluate(() => {
      const c = document.createElement('canvas');
      const src = document.querySelector<HTMLCanvasElement>('#screen')!;
      [c.width, c.height] = [src.width, src.height];
      const ctx = c.getContext('2d')!;
      ctx.drawImage(src, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] | d[i + 1] | d[i + 2]) return true;
      return false;
    }), 'the screen is black');

    // Persistence: a file written and synced, then a reload (as a user closes the tab: no shutdown).
    await onSerial(page, 'echo webpc-kept-$((6*7)) >/root/webpc-mark && sync && echo sy""nced\n');
    await shows(page, /synced/);
    // The firmware's variable store is kept beside the overlay as it changes (a closed tab doesn't shut the machine down):
    // EDK2 wrote its boot variables to the flash bank (an erased bank is all 0xFF) within seconds of the boot.
    await page.waitForFunction(async () => {
      try {
        const f = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('webpc-debian')).getFileHandle('flash')).getFile();
        return f.size === 1 << 20 && new Uint8Array(await f.arrayBuffer()).some((b) => b !== 0xff);
      } catch {
        return false;
      }
    }, null, { timeout: 30_000, polling: 500 });
    await page.reload();
    await running(page);
    console.log(`# debian page ${run}: reloaded, running at ${at()}`);
    await serialLogin(page);
    await onSerial(page, 'cat /root/webpc-mark\n');
    await shows(page, /cat \/root\/webpc-mark\s*webpc-kept-42/);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`# debian page ${run}: done at ${at()}`);
  }));
}
