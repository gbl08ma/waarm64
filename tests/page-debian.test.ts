// The page end to end on Debian (M8 loop 6): what a user does, in headless Chromium, on as few
// Debian boots as the checks allow (a boot is the expensive thing: docs/testing.md "Debian boots").
// Debian boots on the page (web/app/, JIT, realtime, 2 parallel vCPUs, a fresh OPFS overlay).
// Three boots, ~4 min alone:
// 1. A fresh profile: a Buildroot snapshot is refused before anything stops; a key typed on the
//    screen reaches GRUB (its menu is on the virtio-gpu screen and EDK2 has no keyboard driver but
//    the serial console's, so the page sends the screen's keys there): `c` stops the countdown and
//    the kernel doesn't start until GRUB's menu is told to boot. Root logs in on the serial terminal
//    (xterm.js to the PL011) and on the screen (keys on the canvas through virtio-input to tty1's
//    getty); a command typed on the screen writes a marker to /dev/ttyAMA0 that comes back on the
//    serial side; the platform the firmware gave Linux (RTC, framebuffer, EFI, both vCPUs, a
//    credential read back from fw_cfg; the keyboard layout `?keyboard=gb` and the network's drop-ins set through SMBIOS); the page's size reaches the guest (the console is born at it,
//    a bigger window is a new preferred mode, a smaller one never crops the console); a snapshot of
//    the logged-in machine with a file on its disk (the machine runs on).
// 2. A reload (as a user closes the tab: no shutdown): the file written in 1 is on the disk.
//    (Reset disk is the Buildroot test's, tests/browser.test.ts.)
// 3. Another fresh profile, another window size: the snapshot loads (still logged in, its shell's
//    variable, the file read past the page cache, the firmware's variable store beside the new
//    overlay, the screen drawn at its own size and the new window's size as the preferred mode);
//    Suspend and a reload resume it; a reload after that boots its disk normally with every file.
// Realtime: not reproducible, so WAARM64_PAGE_RUNS repeats it (all must pass). Opt-in with
// WAARM64_DISTROS=debian (scripts/ci-debian.sh).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { t } from '../web/i18n.ts';
import { words } from './words.ts';
import { MACHINES, readiness, readyWatcher } from '../web/app/machine.ts';
import { SnapshotWriter } from '../web/snapshot-file.ts';
import { coreStateVersion, storedCodec } from './snapshot-codecs.ts';
import { unattendedQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';
import { PAGE_QUERY } from './page-query.ts';
import { peaks } from './audio-tap.ts';
import { sndDisk, toneWav } from './snd-disk.ts';
import { GAP_FRAMES } from '../web/audio-ring.ts';
import { levelToValue } from '../web/snd.ts';
import { answerAsks } from './page-ask.ts';

// The page's `running` state comes from the serial console's `ready` marker (web/app/worker.ts, machine.ts `readiness`).
// Debian's is agetty's prompt: it must be found wherever a drain puts it, also with a kernel line
// right after it. (M8 loop 6: the marker was matched only at the end of a drain's output, and
// one page sat in `booting` for 4 minutes; that's the likely cause, not caught in the act.)
test("the page's ready marker: Debian's login prompt in any chunk, not a service's name", () => {
  const debian = (...chunks: string[]) => { const w = readyWatcher(MACHINES.debian.ready); return chunks.map(w); };
  assert.deepEqual(debian('Debian GNU/Linux 13 localhost ttyAMA0\r\n\r\nlocalhost login: '), [true]);
  assert.deepEqual(debian('\r\nlocalhost login: [   31.2] random: crng init done\r\n'), [true]);
  assert.deepEqual(debian('ttyAMA0\r\n\r\nlocalhost lo', 'gin: ', 'more'), [false, true, true]);
  assert.deepEqual(debian('Starting systemd-logind.service - User Login Management...\r\n', 'login: failure\r\n'), [false, false]);
  // The page's own machine (any guest): busybox's getty (Alpine's live ISO) writes `\n\r` before its prompt.
  const uefi = (...chunks: string[]) => { const w = readyWatcher(MACHINES.uefi.ready); return chunks.map(w); };
  assert.deepEqual(uefi('(/dev/ttyAMA0)\r\n\r\r\n\rlocalhost login: '), [true]);
  assert.deepEqual(uefi('\r\nlocalhost login: '), [true]);
  const buildroot = readyWatcher(MACHINES.buildroot.ready);
  assert.deepEqual(['Run /init as init process\r\n', '# '].map(buildroot), [false, true]);
});

// With clipboard sharing the guest's agent's HELLO is a sign too (docs/clipboard.md "The machine's state"): whichever
// comes first says `running`, once; a restored machine says nothing; without a marker only the agent's sign counts.
test("the page's readiness: the marker or the agent's HELLO, whichever first, once", () => {
  const said = (ready: RegExp | undefined, running: boolean, ...signs: string[]) => {
    let n = 0;
    const r = readiness(ready, running, () => n++);
    for (const s of signs) if (s === 'HELLO') r.up(); else r.serial(s);
    return n;
  };
  const login = MACHINES.debian.ready;
  assert.equal(said(login, false, 'localhost login: '), 1);
  assert.equal(said(login, false, 'HELLO', 'localhost login: ', 'HELLO'), 1);
  assert.equal(said(login, false, 'localhost login: ', 'HELLO'), 1);
  assert.equal(said(login, false, 'Starting systemd-logind.service'), 0);
  assert.equal(said(login, true, 'localhost login: ', 'HELLO'), 0, 'a restored machine is running already');
  assert.equal(said(undefined, false, 'localhost login: '), 0, 'no marker: the serial output says nothing');
  assert.equal(said(undefined, false, 'localhost login: ', 'HELLO'), 1);
});

const debian = (process.env.WAARM64_DISTROS ?? '').split(',').includes('debian');
const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const skip = !debian ? 'SKIPPED: scripts/ci-debian.sh runs it (WAARM64_DISTROS=debian)' : (!existsSync(IMAGE) || !existsSync(FIRMWARE)) ? 'SKIPPED: run images/build.sh debian edk2' : !existsSync(new URL('../target/images/linux-snd/snd-rec', import.meta.url)) && 'SKIPPED: run images/build.sh linux-snd (its snd-play and snd-rec)';
const RUNS = Number(process.env.WAARM64_PAGE_RUNS ?? 1);
/** The second disk (served from the repo): snd-play and a tone (tests/snd-disk.ts). */
const SND_DISK = `target/tests/snd-${process.pid}.tar`;
/** The fake microphone's tone, Hz. */
const MIC_HZ = 500;

let browser: Browser;
let base: string;
let close: () => void;
let dir: string;
before(async () => {
  if (skip) return;
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  dir = mkdtempSync(join(tmpdir(), 'waarm64-debian-'));
  // Chromium's fake microphone plays a 500 Hz tone (the guest records it: audio S4).
  writeFileSync(join(dir, 'mic.wav'), toneWav(10, 48000, [MIC_HZ, MIC_HZ]));
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${join(dir, 'mic.wav')}`],
  });
  mkdirSync(new URL('../target/tests', import.meta.url), { recursive: true });
  writeFileSync(new URL(`../${SND_DISK}`, import.meta.url), sndDisk(3, 44100));
});
after(async () => { await browser?.close(); close?.(); if (dir) rmSync(dir, { recursive: true }); rmSync(new URL(`../${SND_DISK}`, import.meta.url), { force: true }); });

// A boot to the login prompt takes ~35 s alone on 2 vCPUs; under load twice that.
const BOOT_MS = 240_000;

/** Waits until the page settles in `running` (from another state, e.g. after a reload or a reset). */
async function running(page: Page, from?: string, ms = BOOT_MS) {
  await page.waitForFunction((from) => document.body.dataset.state !== from && ['running', 'failed', 'crashed', 'idle', 'off'].includes(document.body.dataset.state!), from, { timeout: ms, polling: 250 })
    .catch(async (e) => {
      const [state, status] = await page.evaluate(() => [document.body.dataset.state, (document.getElementById('status')?.textContent ?? '')]);
      throw new Error(`${e}; the page is ${state} (${status}); the terminal shows: ${await terminal(page)}`);
    });
  const [state, message] = await page.evaluate(() => [document.body.dataset.state, (document.getElementById('message-text')?.textContent ?? '')]);
  assert.equal(state, 'running', message ?? '');
}

/** The serial terminal's visible rows (xterm.js's DOM renderer: no line breaks, so match spaces with \s). */
const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
const shows = (page: Page, re: RegExp, ms = 60_000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: ms, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the terminal shows: ${await terminal(page)}`); });
const message = (page: Page) => page.evaluate(() => document.getElementById('message-text')?.textContent ?? '');
const stateOf = (page: Page) => page.evaluate(() => document.body.dataset.state!);

/** Types on the serial terminal (xterm.js sends \r for Enter). */
async function onSerial(page: Page, text: string) {
  await page.locator('.xterm').click();
  await page.keyboard.type(text, { delay: 10 });
}

/** Logs in as root on the serial terminal, once its `login: ` prompt is up (`running` may come from systemd's READY=1 first). */
async function serialLogin(page: Page) {
  await shows(page, /login: /);
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

/** The canvas's pixels (the guest's scanout) and how many aren't black: the screen was drawn. */
const screenOf = (page: Page) => page.evaluate(() => {
  const src = document.querySelector<HTMLCanvasElement>('#screen')!;
  const c = document.createElement('canvas');
  [c.width, c.height] = [src.width, src.height];
  const ctx = c.getContext('2d')!;
  ctx.drawImage(src, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] | d[i + 1] | d[i + 2]) lit++;
  return { size: [src.width, src.height], lit };
});

/** The screen box as the page measures it (width down to 8), and the canvas's size (the guest's scanout). */
const geometry = (page: Page) => page.evaluate(() => {
  const box = document.getElementById('screen-view')!;
  const c = document.querySelector<HTMLCanvasElement>('#screen')!;
  return { want: [Math.floor(box.clientWidth / 8) * 8, box.clientHeight], canvas: [c.width, c.height] };
});
/** The first mode the guest's connector lists (the preferred one), read on the serial console. */
async function preferred(page: Page, tag: string): Promise<[number, number]> {
  await onSerial(page, `clear; echo ==${tag[0]}""${tag.slice(1)} $(head -qn1 /sys/class/drm/card*-Virtual-1/modes)\n`);
  const re = new RegExp(`==${tag}\\s+(\\d+)x(\\d+)`);
  await shows(page, re);
  const m = re.exec(await terminal(page))!;
  return [Number(m[1]), Number(m[2])];
}
/** The connector's `enabled` (a console with no mode to show is `disabled`). */
async function connector(page: Page, tag: string) {
  await onSerial(page, `clear; echo ==${tag[0]}""${tag.slice(1)} $(cat /sys/class/drm/card*-Virtual-1/enabled)\n`);
  const re = new RegExp(`==${tag}\\s+(enabled|disabled)`);
  await shows(page, re);
  return re.exec(await terminal(page))![1];
}

/** Clicks Save snapshot (a download: no file picker) and returns the file's path, once the page says it's saved. */
async function save(page: Page, name: string) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    page.locator('#save-snapshot').click(),
  ]);
  const path = join(dir, name);
  await download.saveAs(path);
  await page.waitForFunction((src) => new RegExp(src).test((document.getElementById('message-text')?.textContent ?? '')), words('snapshots:snapshot-actions.saved', {}, { start: true }).source, { timeout: 60_000 });
  const info = JSON.parse(await page.evaluate(() => document.getElementById('message')?.dataset.snapshot!)) as { bytes: number; pausedMs: number; hintMs?: number; hinted?: number };
  assert.equal(info.bytes, readFileSync(path).length, 'the page counted the bytes the file has');
  return { path, ...info };
}
/** Waits until the page has started loading a snapshot (the boot card's title), so a following `running` is the restored machine's. */
const loadingSnapshot = (page: Page) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById('boot-title')!.textContent!), words('machine:runner.boot.loading', {}, { start: true }).source, { timeout: 30_000, polling: 20 });
/** The page's OPFS: each directory's files and their sizes. */
const opfs = (page: Page) => page.evaluate(async () => {
  const out: Record<string, Record<string, number>> = {};
  const root = (await navigator.storage.getDirectory()) as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> };
  for await (const [name, h] of root.entries()) {
    if (h.kind !== 'directory') continue;
    out[name] = {};
    for await (const [file, f] of (h as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) out[name][file] = (await (f as FileSystemFileHandle).getFile()).size;
  }
  return out;
});
/** A snapshot with nothing in it but a header: what the page checks before it touches anything. */
async function headerOnly(name: string, header: Record<string, unknown>) {
  const parts: Uint8Array[] = [];
  const w = new SnapshotWriter((b) => { parts.push(b.slice()); }, { format: 1, coreVersion: await coreStateVersion(), abi: 0, created: new Date().toISOString(), ...header }, { codec: storedCodec });
  await w.end();
  const path = join(dir, name);
  writeFileSync(path, Buffer.concat(parts));
  return path;
}
/** The firmware's variable store beside the default disk's overlay, once EDK2 has written to it (an erased bank is all 0xFF). */
const flashWritten = (page: Page) => page.waitForFunction(async () => {
  try {
    const f = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('waarm64-debian')).getFileHandle('flash')).getFile();
    return f.size === 1 << 20 && new Uint8Array(await f.arrayBuffer()).some((b) => b !== 0xff);
  } catch {
    return false;
  }
}, null, { timeout: 30_000, polling: 500 });

for (let run = 1; run <= RUNS; run++) {
  test(`the page runs Debian: a key on the screen stops GRUB; root logs in on the screen and on the serial terminal; the platform is the firmware's; the page's size reaches the guest; the disk persists over a reload; a snapshot loads in a fresh profile, suspends and resumes${RUNS > 1 ? ` (run ${run})` : ''}`, { skip, timeout: 25 * 60_000 }, () => withDebianLock(async () => {
    // The UK layout: the screen's typing below is the same on it (Debian's image has no console keymaps anyway).
    // `ready=guest`: only systemd's READY=1 over the notify socket (docs/devices.md "vsock") says the machine is up.
    const query = `ncpus=2&view=both&snd=&disk2=/${SND_DISK}&keyboard=gb&mouse=1&touch=1&ready=guest&${unattendedQuery()}`;
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, hasTouch: true }); // a fresh profile: an empty OPFS
    const page = await context.newPage();
    await page.addInitScript(() => { (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = undefined; }); // headless Chromium's picker would wait for a dialog nobody answers
    const errors: string[] = [];
    const dialogs: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await answerAsks(page, (q) => { dialogs.push(q.text); });
    const t0 = performance.now();
    const at = () => `${((performance.now() - t0) / 1000).toFixed(1)} s`;
    await page.goto(`${base}/web/app/?${PAGE_QUERY}${query}`);

    // A snapshot of another machine is refused at once, before anything stops (written by Buildroot's page: only the header matters).
    await page.setInputFiles('#load-snapshot-input', await headerOnly('buildroot-header.waarm64snap', { machine: 'buildroot', label: MACHINES.buildroot.label, ncpus: 2, disk: null, devices: ['rng', 'blk', 'keyboard', 'tablet'], disks: [] }));
    await page.waitForTimeout(1000);
    assert.match(dialogs.at(-1)!, words('snapshots:snapshot-restore.load.otherMachine', { name: 'buildroot-header.waarm64snap', other: MACHINES.buildroot.label, otherId: 'buildroot', machine: t('machines:machine.debian'), id: 'debian' }, { start: true }));
    assert.notEqual(await stateOf(page), 'failed');

    // GRUB's menu counts 5 s from when it starts (~5 s after the boot manager did): `c` on the screen until it is stopped.
    await shows(page, /BdsDxe: starting/, 120_000);
    await page.locator('#screen').click();
    for (const t = performance.now(); performance.now() - t < 25_000;) {
      await page.keyboard.press('c');
      await page.waitForTimeout(400);
    }
    assert.doesNotMatch(await terminal(page), /Linux version/, "GRUB booted: the screen's key never reached it");
    // Back to the menu (Esc, which the firmware's terminal tells from a key sequence by waiting), whose entry boots.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(2500);
    await page.keyboard.press('Enter');
    await running(page);
    console.log(`# debian page ${run}: running (systemd's READY=1) at ${at()}`);
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
    await shows(page, /==begin\s*rtc-efi[^]*?0 virtio_gpudrmfb[^]*?efi[^]*?qemu_fw_cfg\s*2\s*Etc\/UTC\s*\S*zoneinfo\/Etc\/UTC\s*==end/);
    // The notify socket (docs/devices.md "vsock"): the virtio-vsock (ID 19) bound to Linux's transport, the guest's CID 3,
    // and the credential systemd read (its READY=1 made the page `running` above), and no complaint from PID 1 about either;
    // the page's drop-in for systemd 258+'s generated sshd-vsock.socket, installed by the debug generator (this Debian has
    // no sshd and systemd 257: no socket to apply it to; web/app/firmware-files.ts).
    await onSerial(page, 'clear; echo ==vs""ock $(for d in /sys/bus/virtio/devices/*; do [ $(cat $d/device) = 0x0013 ] && basename $(readlink $d/driver); done) $(cat /sys/firmware/qemu_fw_cfg/by_name/opt/io.systemd.credentials/vmm.notify_socket/raw) $(journalctl -b -o cat _PID=1 | grep -c "readiness notification\\|notify_socket") $(cat /run/systemd/generator.early/sshd-vsock.socket.d/waarm64-no-issue.conf).\n');
    await shows(page, /==vsock vmw_vsock_virtio_transport vsock-stream:2:8573 0 \[Socket\] ExecStartPost= ExecStopPre=\./);
    // The SMBIOS tables over fw_cfg (core/src/smbios.rs), through EDK2's SMBIOS 3.0 entry point to Linux's DMI.
    await onSerial(page, 'clear; cd /sys/class/dmi/id; echo ==dm""i $(cat sys_vendor product_name product_family chassis_vendor bios_vendor bios_version); cd\n');
    await shows(page, /==dmi waarm64 waarm64 Virtual Machine waarm64 EDK II ArmVirtQemuKernel/);
    // The keyboard layout (web/app/keyboard.ts): SMBIOS credentials, a unit that ran before the logins; Debian's
    // /etc/default/keyboard, read back by localed, and XKB_DEFAULT_* in this login's environment.
    await onSerial(page, 'clear; echo ==kb""d $(systemctl show -P Result waarm64-keyboard.service) $(localectl status | grep -o "X11 Layout: [a-z]*" | cut -d" " -f3) $XKB_DEFAULT_LAYOUT $XKB_DEFAULT_MODEL.\n');
    await shows(page, /==kbd success gb gb pc105\./);
    // The network's settings (web/app/guest-net.ts): the unit ran before networkd, and networkd reads its drop-in in /run
    // for the file that configures the adapter (Debian's netplan's, which sorts before the page's card.network).
    await onSerial(page, 'clear; l=$(ls /sys/class/net | grep ^e | head -1); echo ==ne""t $(systemctl show -P Result waarm64-network.service) $(networkctl status --json=short $l | grep -o "\\"NetworkFileDropins\\":[^]]*]") ==en""d\n');
    await shows(page, /==net success "NetworkFileDropins":\["\/run\/systemd\/network\/[^"]+\.network\.d\/50-waarm64\.conf"\] ==end/);
    // Nothing speculates, and the core's SMCCC answers say so (docs/cpu.md): Spectre-v4 is not affected. (Spectre-v2 still
    // reads "Mitigation: CSV2, but not BHB": BHB is only cleared by CSV2_3, backlog "Spectre-BHB".)
    await onSerial(page, 'clear; echo ==ss""b $(cat /sys/devices/system/cpu/vulnerabilities/spec_store_bypass)\n');
    await shows(page, /==ssb Not affected/);
    // The pointing devices (`?mouse=1&touch=1`, docs/frontend.md "Mouse lock", "Touch"): the tablet with the side buttons
    // and the horizontal and high-resolution wheels, the relative mouse (the same wheels), the multitouch screen (direct);
    // a touch on the page's screen reaches the touchscreen's events.
    await onSerial(page, 'clear; for d in /sys/class/input/input*; do case "$(cat $d/name)" in waarm64\\ t*|waarm64\\ m*) echo "==$(tr " " _ <$d/name):p=$(cat $d/properties):r=$(cat $d/capabilities/rel):a=$(cat $d/capabilities/abs):k=$(cat $d/capabilities/key | tr " " .)";; esac; done; echo ==in""put\n');
    await shows(page, /==input/);
    const devices = (await terminal(page)).replace(/\s+/g, ' ');
    for (const want of ['==waarm64_tablet:p=0:r=1940:a=3:k=1f0000.0.0.0.0', '==waarm64_mouse:p=0:r=1943:a=0:k=1f0000.0.0.0.0', '==waarm64_touchscreen:p=2:r=0:a=260800000000003:k=400.0.0.0.0.0']) {
      assert.ok(devices.includes(want), `missing ${want}: ${devices}`);
    }
    await onSerial(page, 'clear; e=$(grep -l touchscreen /sys/class/input/event*/device/name | cut -d/ -f5); (timeout 8 cat /dev/input/$e | wc -c >/tmp/touch.n &); sleep 1; echo ==touch""-wait\n');
    await shows(page, /==touch-wait/);
    {
      const cdp = await context.newCDPSession(page);
      const box = (await page.locator('#screen').boundingBox())!;
      const [x, y] = [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 20, y, id: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    }
    await onSerial(page, 'clear; sleep 8; echo ==touch $(cat /tmp/touch.n).\n');
    await shows(page, /==touch [1-9]\d*\./, 30_000);
    // The page's sound device (audio S2): Debian autoloads virtio_snd for it and has the card.
    await onSerial(page, 'clear; cat /proc/asound/cards; echo so""und-read\n');
    await shows(page, /VirtIO SoundCard[^]*sound-read/);
    // Its Master volume and switch are the Sound menu's (VIRTIO_SND_F_CTLS): read and written with perl's ioctls
    // (no alsa-utils in the image; snd_ctl_elem_value is 1,224 bytes, its values at 72), the guest's writes move the
    // menu, and the menu's reach the guest with a notification (SUBSCRIBE_EVENTS, then a 72-byte snd_ctl_event each).
    const ctl = `open(F,"+<","/dev/snd/controlC0") or die $!; $v=pack("LlLLa44L",0,2,0,0,$ARGV[0],0)."\\0"x1160; if(@ARGV>1){substr($v,72,8)=pack("q",$ARGV[1]); ioctl(F,0xc4c85513,$v) or die "w $!";} ioctl(F,0xc4c85512,$v) or die "r $!"; print "val=",unpack("q",substr($v,72,8)),";\\n";`;
    const events = `open(F,"+<","/dev/snd/controlC0") or die $!; $s=pack("l",1); ioctl(F,0xc0045516,$s) or die "s $!"; for(1..2){sysread(F,$e,72); ($t,$m,$n,$i,$d,$sd,$name)=unpack("lLLlLLZ44",$e); print "ev mask=$m $name;\\n";}`;
    await onSerial(page, `clear; cat > /tmp/ctl.pl <<'E'\n${ctl}\nE\ncat > /tmp/ev.pl <<'E'\n${events}\nE\n`);
    const menu = () => page.evaluate(() => [(document.getElementById('sound-volume') as HTMLInputElement).value, (document.getElementById('sound-on') as HTMLInputElement).checked]);
    const [level] = await menu();
    await onSerial(page, `clear; perl /tmp/ctl.pl 'Master Playback Volume'; perl /tmp/ctl.pl 'Master Playback Switch' 0; perl /tmp/ctl.pl 'Master Playback Volume' 200; echo mi""xer-set\n`);
    await shows(page, new RegExp(`val=${levelToValue(Number(level) / 100)};\\s*val=0;\\s*val=200;\\s*mixer-set`));
    await page.waitForFunction(() => (document.getElementById('sound-volume') as HTMLInputElement).value === '15', null, { timeout: 5000 });
    assert.deepEqual(await menu(), ['15', false], "the guest's Master moves the menu");
    await onSerial(page, 'clear; (perl /tmp/ev.pl > /tmp/ev.txt &); sleep 1; echo li""stening\n');
    await shows(page, /listening/);
    await page.evaluate(() => {
      const [v, on] = [document.getElementById('sound-volume') as HTMLInputElement, document.getElementById('sound-on') as HTMLInputElement];
      v.value = '80';
      v.dispatchEvent(new Event('input', { bubbles: true }));
      on.checked = true;
      on.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await onSerial(page, `clear; sleep 1; perl /tmp/ctl.pl 'Master Playback Volume'; perl /tmp/ctl.pl 'Master Playback Switch'; cat /tmp/ev.txt; echo mi""xer-read\n`);
    await shows(page, new RegExp(`val=${levelToValue(0.8)};\\s*val=1;\\s*ev mask=1 Master Playback Volume;\\s*ev mask=1 Master Playback Switch;\\s*mixer-read`));
    // Back to the level the test started at, for what it plays next.
    await page.evaluate((l) => { const v = document.getElementById('sound-volume') as HTMLInputElement; v.value = l; v.dispatchEvent(new Event('input', { bubbles: true })); }, String(level));
    // Debian's driver plays a file (audio S3): snd-play (aplay's buffer, 500 ms in 4 periods) from the second disk,
    // 3 s at 44.1 kHz (the page's context follows the stream's rate); its own clock says the sound's length within a
    // period, nothing underran, and the page hears 440 and 660 Hz.
    await onSerial(page, 'clear; mkdir -p /tmp/p && tar -xf /dev/vdb -C /tmp/p && /tmp/p/snd-play /tmp/p/tone.wav; echo pl""ay-done\n');
    await page.waitForFunction(() => { const c = (window as unknown as { __audio: { context(): AudioContext | undefined } }).__audio.context(); return c?.state === 'running' && c.sampleRate === 44100; }, null, { timeout: 20_000 });
    const heard = await peaks(page);
    assert.ok(Math.abs(heard.hz[0] - 440) < 12 && Math.abs(heard.hz[1] - 660) < 12, `heard ${heard.hz} Hz`);
    await shows(page, /play-done/, 30_000);
    const playLog = await page.evaluate(() => (window as unknown as { __serialLog(): string }).__serialLog());
    const [, played, sound, took, xruns] = /snd-play: played (\d+) frames \((\d+) ms of sound\) in (\d+) ms, (\d+) underruns/.exec(playLog) ?? [];
    assert.ok(played, `snd-play didn't finish: ${playLog.slice(-1500)}`);
    const gaps = await page.evaluate((i) => (window as unknown as { __audio: { header(): Int32Array } }).__audio.header()[i], GAP_FRAMES);
    console.log(`# Debian played ${played} frames (${sound} ms) in ${took} ms, ${xruns} underruns; the ring's gaps ${gaps} frames; heard ${heard.hz.map((h) => h.toFixed(0))} Hz; ${/snd-play: delay .*/.exec(playLog)?.[0]}`);
    assert.equal(Number(xruns), 0);
    assert.ok(Math.abs(Number(took) - Number(sound)) < 125, `${sound} ms of sound took ${took} ms`);
    // And records (audio S4): 3 s from the page's microphone (the browser's fake device, 500 Hz) through Debian's
    // driver, at its length in its own time, no overrun, the tone on both channels (the browser's processing is on).
    await onSerial(page, 'clear; /tmp/p/snd-rec 48000 2 3; echo re""c-done\n');
    await shows(page, /rec-done/, 30_000);
    const recLog = await page.evaluate(() => (window as unknown as { __serialLog(): string }).__serialLog());
    const [, rframes, rms, overruns, left, right] = /snd-rec: recorded (\d+) frames in (\d+) ms, (\d+) overruns, (\d+) Hz left, (\d+) Hz right/.exec(recLog) ?? [];
    assert.ok(rframes, `snd-rec didn't finish: ${recLog.slice(-1500)}`);
    console.log(`# Debian recorded ${rframes} frames in ${rms} ms, ${overruns} overruns, ${left} and ${right} Hz (the microphone's ${MIC_HZ})`);
    assert.equal(Number(overruns), 0);
    assert.ok(Math.abs(Number(rms) - 3000) < 150, `3 s took ${rms} ms`);
    assert.ok(Math.abs(Number(left) - MIC_HZ) <= 15 && Math.abs(Number(right) - MIC_HZ) <= 15, `${left}, ${right} Hz`);
    // The screen's text as the guest has it: bash's prompt and the command on tty1.
    await onSerial(page, 'clear; tr -s " " </dev/vcs1 | grep -o "root@[a-z]*:~# echo from-" | head -1; echo scr""een-read\n');
    await shows(page, /root@[a-z]+:~# echo from-\s*screen-read/);
    // The screen was drawn: the canvas isn't black (fbcon's text).
    const shown = await screenOf(page);
    assert.ok(shown.lit > 0, 'the screen is black');

    // The page's size reaches the guest (M8 graphics G1 loop 5), checked before anything puts up a message (its bar takes from the
    // screen box). Born at it: the guest's preferred mode and the canvas are the screen box's.
    const g0 = await geometry(page);
    assert.deepEqual(await preferred(page, 'born'), g0.want, 'the preferred mode at the boot is the screen box');
    assert.deepEqual(g0.canvas, g0.want, 'the console took it');
    // A bigger window: fbcon's buffer is the old size, so it refuses the new preferred mode (DRM's VIRTUAL_X) and takes the born size
    // from the EDID's extra modes; without it the console went blank. The new preferred mode is what a fresh probe lists.
    await page.setViewportSize({ width: 1700, height: 1000 });
    await page.waitForFunction(([w, h]) => { const b = document.getElementById('screen-view')!; return b.clientWidth > w && b.clientHeight > h; }, g0.want, { timeout: 10_000 });
    const g1 = await geometry(page);
    await page.waitForTimeout(2500); // the debounce, the display event, the guest's probe
    assert.equal(await connector(page, 'grown'), 'enabled', 'the console survives a bigger window');
    await onSerial(page, 'echo detect >/sys/class/drm/card0-Virtual-1/status; sleep 1\n');
    assert.deepEqual(await preferred(page, 'listed'), g1.want, 'a probe lists the new preferred mode');
    assert.deepEqual((await geometry(page)).canvas, g0.canvas, 'the console keeps its buffer');
    // A smaller one: the guest takes it, fbcon would crop its buffer, and the display asks for the whole buffer again.
    await page.setViewportSize({ width: 1200, height: 800 });
    // The guest crops for a moment, then the display gives it its whole buffer back: settled when the canvas is the born size again, and it stays.
    await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>('#screen')!.width !== 0, null, { timeout: 5000 });
    await page.waitForTimeout(4000);
    await page.waitForFunction(([w, h]) => { const c = document.querySelector<HTMLCanvasElement>('#screen')!; return c.width === w && c.height === h; }, g0.canvas, { timeout: 30_000 });
    await page.waitForTimeout(2500);
    assert.equal(await connector(page, 'shrunk'), 'enabled');
    assert.deepEqual((await geometry(page)).canvas, g0.canvas, 'the console is not cropped');
    // Files on the disk (synced), a variable in the shell, then a snapshot of the running machine, which runs on.
    await onSerial(page, 'echo waarm64-kept-$((6*7)) >/root/waarm64-mark && echo disk-kept-$((6*7)) >/root/snapmark && sync && SNAPVAR=ram-kept-$((6*7)) && echo sy""nced\n');
    await shows(page, /synced/);
    const saved = await save(page, 'debian.waarm64snap');
    console.log(`# debian snapshot: ${(saved.bytes / 1e6).toFixed(1)} MB, machine paused ${saved.pausedMs.toFixed(0)} ms, ${((saved.hinted ?? 0) / 2 ** 20).toFixed(0)} MiB hinted in ${saved.hintMs?.toFixed(0)} ms`);
    // The balloon's hint ran before the pause (web/balloon.ts): most of the guest's free memory handed over, then back.
    assert.ok((saved.hinted ?? 0) > 256 << 20, `the guest handed over its free memory (${saved.hinted} bytes)`);
    assert.equal(await stateOf(page), 'running');
    await onSerial(page, 'echo sti""ll-$((6*7))\n');
    await shows(page, /still-42/);

    console.log(`# debian page ${run}: sizes checked, snapshot saved at ${at()}`);

    // Persistence: a reload (as a user closes the tab: no shutdown). The firmware's variable store is kept beside the overlay as it
    // changes (a closed tab doesn't shut the machine down): EDK2 wrote its boot variables to the flash bank within seconds of the boot.
    await flashWritten(page);
    await page.reload();
    await running(page);
    console.log(`# debian page ${run}: reloaded, running at ${at()}`);
    await serialLogin(page);
    await onSerial(page, 'cat /root/waarm64-mark\n');
    await shows(page, /cat \/root\/waarm64-mark\s*waarm64-kept-42/);
    assert.deepEqual(errors, []);
    await context.close();

    // A fresh profile: the page starts booting Debian, the snapshot replaces that machine.
    // Another window size than the one saved in: the display device is restored (the console's screen drawn again), then told the new size.
    const fresh = await browser.newContext({ viewport: { width: 1700, height: 1000 } });
    const p2 = await fresh.newPage();
    const errors2: string[] = [];
    p2.on('pageerror', (e) => errors2.push(String(e)));
    await answerAsks(p2);
    await p2.goto(`${base}/web/app/?${PAGE_QUERY}${query}`);
    const t1 = performance.now();
    await p2.setInputFiles('#load-snapshot-input', saved.path);
    await loadingSnapshot(p2);
    await running(p2, undefined, 120_000);
    const loadMs = performance.now() - t1;
    console.log(`# debian snapshot: load ${(loadMs / 1000).toFixed(1)} s from the choice to running`);
    assert.ok(loadMs < 60_000, `loaded in ${(loadMs / 1000).toFixed(1)} s`);
    // The display: the restored scanout is drawn at the saved size (fbcon's buffer is that size, and the console is never cropped),
    // and the guest has the new window's size as its preferred mode (the `size` message sent at `running`).
    // (The device worker draws on its own timer: poll for the first frame.)
    await p2.waitForFunction(() => {
      const src = document.querySelector<HTMLCanvasElement>('#screen')!;
      const c = document.createElement('canvas');
      [c.width, c.height] = [src.width, src.height];
      const ctx = c.getContext('2d')!;
      ctx.drawImage(src, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] | d[i + 1] | d[i + 2]) return true;
      return false;
    }, null, { timeout: 10_000, polling: 100 }).catch(() => assert.fail('the restored screen is drawn'));
    const restored = await screenOf(p2);
    assert.deepEqual(restored.size, shown.size, 'the console keeps its buffer');
    const want = await p2.evaluate(() => { const b = document.getElementById('screen-view')!; const r = b.getBoundingClientRect(); return [Math.floor(r.width / 8) * 8, Math.floor(r.height)]; });
    assert.notDeepEqual(want, shown.size, 'the window is another size');
    // The firmware's variable store is back beside the new overlay (the restore deleted the copy): written before `running` is posted.
    const flash = await p2.evaluate(async () => {
      try {
        const f = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('waarm64-debian')).getFileHandle('flash')).getFile();
        return { size: f.size, written: new Uint8Array(await f.arrayBuffer()).some((b) => b !== 0xff) };
      } catch (e) {
        return String(e);
      }
    });
    assert.deepEqual(flash, { size: 1 << 20, written: true }, "the firmware's variable store was written beside the restored overlay");
    // Still logged in, in the shell it was: the terminal's saved tail (the last command before the save), its variable, and the
    // file on the disk (read past the page cache).
    await shows(p2, /sy""nced\s*synced/);
    await onSerial(p2, 'clear; echo var=[$SNAPVAR]; sync; echo 3 >/proc/sys/vm/drop_caches; cat /root/snapmark; echo re""ad\n');
    await shows(p2, /var=\[ram-kept-42\][^]*?disk-kept-42\s*read/);
    // The restored guest's balloon driver held the hinted memory: its backend said DONE at the start, so it's free again.
    await onSerial(p2, "clear; echo ==fr\"\"ee $(awk '/MemFree/{print int($2/1024)}' /proc/meminfo)\n");
    await shows(p2, /==free \d+/);
    const free = Number(/==free (\d+)/.exec(await terminal(p2))![1]);
    assert.ok(free > 256, `the restored guest has its free memory back (${free} MiB free)`);
    // And the disk takes writes: a new file, synced, read back from the disk.
    await onSerial(p2, 'echo after-$((6*7)) >/root/after && sync && echo 3 >/proc/sys/vm/drop_caches && cat /root/after && echo wr""itten\n');
    await shows(p2, /after-42[^]*?written/);
    // The guest's connector lists the new mode after a probe (the restored guest hasn't re-read it until then).
    await p2.waitForTimeout(2500); // the debounce, the display event
    await onSerial(p2, 'echo detect >/sys/class/drm/card0-Virtual-1/status; sleep 1; echo ==pre""f $(head -qn1 /sys/class/drm/card*-Virtual-1/modes)\n');
    await shows(p2, /==pref\s+\d+x\d+/);
    assert.match(await terminal(p2), new RegExp(`==pref\\s+${want[0]}x${want[1]}`), "the guest's preferred mode is the new window's");
    // And the console is still on the screen, whole: the window's mode is wider than fbcon's buffer, so it took the EDID's second mode
    // (its buffer's size). With no mode it can take, fbcon blanks the screen.
    const later = await screenOf(p2);
    assert.ok(later.lit > 0, 'the console is still shown after the display event');
    assert.deepEqual(later.size, shown.size, 'at its own size');
    // Suspend: the machine stops with its memory kept beside the overlay; a reload resumes it, still logged in.
    await onSerial(p2, 'SUSVAR=suspended-$((6*7)); clear; echo re""ady-to-suspend\n');
    await shows(p2, /ready-to-suspend/);
    const t2 = performance.now();
    await p2.locator('#suspend').click();
    await p2.waitForFunction(() => document.body.dataset.state === 'suspended', null, { timeout: 120_000 });
    const suspendMs = performance.now() - t2;
    const kept = (await opfs(p2))['waarm64-debian'];
    assert.ok(kept.suspend > 1 << 20, JSON.stringify(kept));
    await p2.reload();
    const t3 = performance.now();
    await running(p2, undefined, 120_000);
    console.log(`# debian suspend: ${(kept.suspend / 1e6).toFixed(1)} MB kept, suspended in ${(suspendMs / 1000).toFixed(1)} s, resumed ${((performance.now() - t3) / 1000).toFixed(1)} s after the reload`);
    assert.match((await message(p2))!, words('machine:worker.resumed', {}, { start: true }));
    assert.equal((await opfs(p2))['waarm64-debian'].suspend, undefined, 'a resumed machine has no suspended copy');
    await onSerial(p2, 'clear; echo var=[$SUSVAR]; echo third-$((6*7)) >/root/third && sync && echo 3 >/proc/sys/vm/drop_caches && cat /root/snapmark /root/after /root/third && echo al""l-three\n');
    await shows(p2, /var=\[suspended-42\][^]*?disk-kept-42\s*after-42\s*third-42\s*all-three/);
    // A reload now boots the machine's disk normally (the overlay the restore wrote and the resumed machine
    // wrote on, the variable store beside it): the files are there.
    await p2.reload();
    await running(p2);
    assert.doesNotMatch((await message(p2)) ?? '', words('machine:worker.resumed'));
    await shows(p2, /login: /);
    await onSerial(p2, 'root\n');
    await shows(p2, /root@\S+:~# /);
    await onSerial(p2, 'cat /root/snapmark /root/after /root/third\n');
    await shows(p2, /cat \/root\/snapmark \/root\/after \/root\/third\s*disk-kept-42\s*after-42\s*third-42/);
    assert.deepEqual(errors2, []);
    await fresh.close();
    console.log(`# debian page ${run}: done at ${at()}`);
  }));
}
