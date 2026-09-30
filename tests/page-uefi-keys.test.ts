// The keys of the page's serial terminal, end to end through xterm.js (M8 phase B loop 3): arrows,
// Enter, Esc and Ctrl-X reach EDK2's terminal driver and GRUB. On Debian's unmodified image, in
// headless Chromium: GRUB's menu (arrows) -> "UEFI Firmware Settings" (the guest resets; the flash
// bank kept the variable that asks for the setup, over the page's restart of the machine) -> EDK2's
// boot menu and setup forms (arrows, Enter, Esc) -> Continue -> the disk's loader again -> GRUB's
// editor (e, F2's command line, Esc, arrows, End, typing) -> Ctrl-X boots the edited entry, and
// the kernel's command line has what was typed. One Debian boot and two firmware starts, ~1.5 min.
// Opt-in with WEBPC_DISTROS=debian, like Debian's other Chromium tests.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { unattendedQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';

const debian = (process.env.WEBPC_DISTROS ?? '').split(',').includes('debian');
const has = (rel: string) => existsSync(new URL(`../target/images/${rel}`, import.meta.url));
const skip = !debian ? 'SKIPPED: set WEBPC_DISTROS=debian' : (!has('debian/disk.qcow2') || !has('edk2/QEMU_EFI.fd')) && 'SKIPPED: run npm start (or images/build.sh debian edk2)';

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

/** The terminal's rows, one per line (xterm.js's DOM renderer), trailing spaces trimmed. */
const rows = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.xterm-rows > div')].map((d) => d.textContent!.replace(/\s+$/, '')).join('\n'));
const shows = (page: Page, re: RegExp, ms = 120_000) =>
  page.waitForFunction(([src, flags]) => new RegExp(src, flags).test([...document.querySelectorAll('.xterm-rows > div')].map((d) => d.textContent!.replace(/\s+$/, '')).join('\n')), [re.source, re.flags], { timeout: ms, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the terminal shows:\n${await rows(page)}`); });
/** Presses keys one at a time with a moment between them: the firmware's terminal driver tells a lone Esc from the start of a key sequence by waiting (~2 s). */
async function press(page: Page, ...keys: string[]) {
  for (const k of keys) {
    await page.keyboard.press(k);
    await page.waitForTimeout(k === 'Escape' ? 2500 : 150);
  }
}

test('the serial terminal\'s keys reach EDK2 and GRUB: menus, forms, the editor, Ctrl-X', { skip, timeout: 10 * 60_000 }, () => withDebianLock(async () => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  try {
    await page.goto(`${base}/web/app/?ncpus=2&view=terminal&${unattendedQuery()}`);
    await page.locator('.xterm').click();

    // GRUB's menu: two arrows down to "UEFI Firmware Settings" (its asterisk marks the entry), Enter.
    await shows(page, /Advanced options for Debian/);
    await press(page, 'ArrowDown', 'ArrowDown');
    await shows(page, /\|\*UEFI Firmware Settings/, 10_000);
    await press(page, 'Enter');

    // The guest reset itself (the page restarts the machine) into EDK2's boot device menu: the variable that asked for it was kept in the flash bank.
    await shows(page, /Please select boot device/);
    await page.waitForTimeout(1000);
    await press(page, 'Enter'); // "EFI Firmware Setup"
    await shows(page, /Select Language\s+<Standard English>/);
    await press(page, 'ArrowDown', 'ArrowDown', 'Enter'); // Boot Manager
    await shows(page, /Boot Manager Menu/);
    await press(page, 'Escape');
    await shows(page, /Select Language\s+<Standard English>/, 10_000);
    await press(page, 'ArrowDown', 'ArrowDown'); // from Boot Manager: Boot Maintenance Manager, Continue
    await shows(page, /<Standard English>\s+Continue/, 10_000); // its help text
    await press(page, 'Enter');
    await shows(page, /Please select boot device/);
    await page.waitForTimeout(1000);
    await press(page, 'ArrowDown', 'Enter'); // "UEFI Misc Device": the disk

    // GRUB's editor: Ctrl-N goes to the last line, the arrows to the `linux` line, Ctrl-E to its end, then F2's command line and Esc.
    await shows(page, /Advanced options for Debian/);
    await press(page, 'e');
    await shows(page, /Minimum Emacs-like screen editing/);
    await page.waitForTimeout(2000);
    for (let i = 0; i < 40; i++) { await page.keyboard.press('Control+n'); await page.waitForTimeout(30); } // the last line (the editor's Emacs keys: plain bytes)
    await shows(page, /initrd\s+\/boot\/initrd\.img/, 10_000);
    await press(page, 'ArrowUp', 'ArrowUp', 'ArrowUp', 'Control+e'); // the `linux` line (`initrd`, `echo`, `linux`)
    await page.keyboard.type(' webpc.keytest=1', { delay: 20 });
    await shows(page, /webpc\.keytest=1/, 10_000);
    // F2 opens GRUB's command line (it runs a command), Esc returns to the editor with the edit kept.
    await press(page, 'F2');
    await shows(page, /grub>/, 10_000);
    await page.keyboard.type('echo f2-works', { delay: 20 });
    await press(page, 'Enter');
    await shows(page, /^f2-works\ngrub>/m, 10_000); // the prompt is back: an Esc before it would interrupt the command
    await press(page, 'Escape');
    await shows(page, /Minimum Emacs-like screen editing/, 10_000);
    await shows(page, /webpc\.keytest=1/, 10_000);
    await press(page, 'Control+x');

    // The edited entry boots; its kernel has the typed parameter.
    await shows(page, /\S+ login:$/m, 240_000);
    await page.keyboard.type('root\n', { delay: 10 });
    await shows(page, /root@\S+:~#/, 60_000);
    await page.keyboard.type('tr " " "\\n" </proc/cmdline | grep -x webpc.key""test=1\n', { delay: 10 }); // (the quotes keep the command's echo from matching)
    await shows(page, /^webpc\.keytest=1$/m, 30_000);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}));
