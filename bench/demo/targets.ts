// The systems bench/demo/run.ts times (bench/demo/REPORT.md): each one's page, how its console is read and typed on,
// what counts as its prompt, and the commands it can run. A target is what a visitor opens, as shipped: the others'
// demos on their own servers, ours deployed or as `npm run dist` builds it.
import { linkSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { Page } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';
import { untilLike } from './screen-like.ts';
import { brotliBytes, brotliRatio, bytesByKind, count, linkFromEnv, siteServer, throttle, type Served as Log } from './site.ts';

/** A target's local server: its base URL, how to stop it, and what it sent (where it counts). */
export type Served = {
  base: string;
  close: () => Promise<void>;
  kinds?: (until?: number) => Record<string, number>;
  pageBrotli?: (until?: number) => number;
};

export type Target = {
  /** The name on the command line and in the JSON. */
  name: string;
  /** The system, and what a run of this target is (for the report). */
  system: string;
  what: string;
  /**
   * A local server the page is served from (our own builds): its base URL, and how to stop it; where it counts what it
   * sends, the bytes by kind up to a moment (`kinds`), and the page's as a host that compresses would send them
   * (`pageBrotli`).
   */
  serve?: () => Promise<Served>;
  /** Run without a network past this computer (the host resolver answers nothing else). */
  offline?: boolean;
  /** Resolves when the page is loaded and waiting for the visitor (the moment before `click`). */
  ready?: (page: Page, ms: number) => Promise<void>;
  /** The visitor's click that starts the demo (after `ready`): resolves when the page has what it needs to start it. */
  click?: (page: Page, base: string) => Promise<void>;
  url: (base: string) => string;
  /** The console's text as it is now (its rows, newline-separated where the console allows). */
  text: (page: Page) => Promise<string>;
  /** Types on the console (a `\n` is Enter). */
  type: (page: Page, s: string) => Promise<void>;
  /** Resolves when the prompt is shown (`prompt`). */
  prompt: (page: Page, ms: number) => Promise<void>;
  /** What `prompt` means for this target. */
  promptIs: string;
  /** Console text that marks a boot's phases, timed as it first shows (the console polled every 250 ms: a line must stay that long). */
  phases?: [string, RegExp][];
  /** Logs in from the prompt to a shell (a login prompt's targets), before the command. */
  login?: (page: Page) => Promise<void>;
  /** A command whose output (`ok-42`) shows it ran: the prompt was usable. Absent: the target can't run one. */
  echo?: string;
  /** A second command after `echo`, answered `ok-48`. */
  again?: string;
  /** Type `echo` again after this many ms without its answer (a console that drops keys until it's ready). */
  retryMs?: number;
  /** The package install, if the guest can: its command, ending in a marker `apk-<status>-42`. */
  apk?: string;
  /** The longest a run's prompt may take. */
  timeoutMs: number;
};

const until = async (page: Page, what: () => Promise<boolean>, ms: number, label: string) => {
  const end = Date.now() + ms;
  while (!(await what())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await page.waitForTimeout(100);
  }
};
const shows = (t: Target, page: Page, re: RegExp, ms: number) => until(page, async () => re.test(await t.text(page)), ms, String(re));

/** Keys for a guest that reads key codes, not characters (v86: a PS/2 keyboard): Shift held for what needs it (US layout). */
const SHIFTED: Record<string, string> = {
  '!': 'Digit1', '@': 'Digit2', '#': 'Digit3', $: 'Digit4', '%': 'Digit5', '^': 'Digit6', '&': 'Digit7', '*': 'Digit8', '(': 'Digit9', ')': 'Digit0',
  _: 'Minus', '+': 'Equal', '{': 'BracketLeft', '}': 'BracketRight', '|': 'Backslash', ':': 'Semicolon', '"': 'Quote', '<': 'Comma', '>': 'Period', '?': 'Slash', '~': 'Backquote',
};
async function typeCodes(page: Page, s: string) {
  for (const ch of s) {
    if (ch === '\n') await page.keyboard.press('Enter');
    else if (/[A-Z]/.test(ch)) await page.keyboard.press(`Shift+Key${ch}`);
    else if (SHIFTED[ch]) await page.keyboard.press(`Shift+${SHIFTED[ch]}`);
    else await page.keyboard.press(ch === ' ' ? 'Space' : ch);
    await page.waitForTimeout(10);
  }
}

const ECHO = 'echo ok-$((6*7))';
/** apk's install, then the program it installed, then a marker with apk's status (the line typed shows none of `420`, `apk-0-42`). */
const APK = "apk add python3; python3 -c 'print(6*7*10)'; echo apk-$?-$((6*7))";

/** unkernel's demo: navigating to it boots Alpine (riscv64 user space on Linux built for wasm) to a root shell. */
const unkernel: Target = {
  name: 'unkernel',
  system: 'unkernel',
  what: 'https://unkernel.dev/ as shipped: Alpine 3.24 (riscv64) to its root shell, Wisp networking on',
  url: () => 'https://unkernel.dev/',
  // Its terminal is DOM rows (`#term .term-row`).
  text: (page) => page.evaluate(() => [...document.querySelectorAll('#term .term-row')].map((r) => r.textContent?.trimEnd()).join('\n')),
  type: async (page, s) => {
    await page.locator('#term').click();
    await page.keyboard.type(s, { delay: 5 });
  },
  prompt: (page, ms) => shows(unkernel, page, /⇒\s*$/, ms),
  promptIs: 'the shell prompt (`~ ⇒`), logged in',
  echo: ECHO,
  apk: APK,
  timeoutMs: 120_000,
};

/** v86's Buildroot demo: a 32-bit x86 PC boots a bzImage with BusyBox to a shell (text mode, readable as DOM). */
const v86Buildroot: Target = {
  name: 'v86-buildroot',
  system: 'v86',
  what: 'https://copy.sh/v86/?profile=buildroot: Buildroot (i686) booted from its bzImage to a root shell; networking needs `udhcpc` over a relay',
  url: () => 'https://copy.sh/v86/?profile=buildroot',
  text: (page) => page.evaluate(() => (document.getElementById('screen') as HTMLElement | null)?.innerText ?? ''),
  type: async (page, s) => {
    await page.locator('#screen_container').click();
    await typeCodes(page, s);
  },
  prompt: (page, ms) => shows(v86Buildroot, page, /~%\s*$/, ms),
  promptIs: 'the shell prompt (`~%`), logged in',
  echo: ECHO,
  timeoutMs: 180_000,
};

/** v86's Arch Linux demo: a saved state restored at a root shell on a graphical console (a canvas: not readable). */
const v86Arch: Target = {
  name: 'v86-arch',
  system: 'v86',
  what: 'https://copy.sh/v86/?profile=archlinux: Arch Linux 32 resumed from a saved state at a root shell (9p root on demand; networking off until `./networking.sh`)',
  url: () => 'https://copy.sh/v86/?profile=archlinux',
  // The guest's screen is a canvas; its serial port is a terminal under it, where the command's output goes.
  text: (page) => page.evaluate(() => document.querySelector('#terminal .xterm-rows')?.textContent ?? ''),
  type: async (page, s) => {
    await page.locator('#screen_container').click();
    await typeCodes(page, s);
  },
  // The emulator running (its clock shown) with the state loaded (the loading line hidden).
  prompt: (page, ms) =>
    until(page, () => page.evaluate(() => /\d/.test(document.getElementById('running_time')?.textContent ?? '') && getComputedStyle(document.getElementById('loading')!).display === 'none'), ms, 'the emulator running'),
  promptIs: 'the emulator running with its state loaded (the prompt is on a canvas: see the command)',
  echo: `${ECHO} > /dev/ttyS0`,
  retryMs: 5000,
  timeoutMs: 180_000,
};

/** Our page's serial terminal (xterm.js, DOM rows) and its typing. */
const ours = {
  phases: [['firmware', /BdsDxe|UEFI|EDK II/], ['loader', /Limine|GNU GRUB|Booting `/], ['kernel', /Booting Linux|Linux version|\[\s+\d+\.\d+\]/], ['userspace', /OpenRC|systemd\[1\]|Welcome to/]] as [string, RegExp][],
  text: (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? ''),
  type: async (page: Page, s: string) => {
    await page.locator('.xterm').click();
    await page.keyboard.type(s, { delay: 5 });
  },
  prompt: (page: Page, ms: number) => page.waitForFunction(() => document.body.dataset.state === 'running', null, { timeout: ms, polling: 100 }).then(() => undefined),
};

/** The deployed page's Desktop Demo (docs/remote-disks.md): Arch with sway on a chunked image from vmdisks.tny.im, a first boot. */
const desktop: Target = {
  name: 'waarm64-desktop',
  system: 'waarm64',
  what: 'https://vm.tny.im/?disk=https://vmdisks.tny.im/desktop/prefetch.json (the Desktop Demo, Arch Linux ARM with sway, UEFI) as deployed, its first boot, the page\'s defaults, the serial terminal shown beside the screen (`view=both`)',
  url: () => `https://vm.tny.im/?disk=${encodeURIComponent('https://vmdisks.tny.im/desktop/prefetch.json')}&view=both`,
  ...ours,
  prompt: ours.prompt,
  promptIs: 'the login prompt on the serial console (the machine `running`)',
  login: async (page) => {
    await shows(desktop, page, /login:\s*$/, 60_000);
    await desktop.type(page, 'root\n');
    await shows(desktop, page, /Password:\s*$|\]#\s*$/, 60_000);
    if (/Password:\s*$/.test(await desktop.text(page))) await desktop.type(page, 'root\n');
    await shows(desktop, page, /\]#\s*$/, 60_000);
  },
  echo: ECHO,
  timeoutMs: 300_000,
};

const DIST = new URL('../results/local/demo/dist/', import.meta.url).pathname;
const ALPINE = new URL('../../target/images/alpine-uefi/alpine.qcow2', import.meta.url).pathname;

/** The closest we have to Alpine at a prompt today: Alpine's published UEFI cloud image opened by URL on the page as `npm run dist` builds it. */
const alpine: Target = {
  name: 'waarm64-alpine',
  system: 'waarm64',
  what: 'the page as `npm run dist -- --out bench/results/local/demo/dist` builds it, on Vite\'s preview server on localhost, with `?disk=` Alpine 3.24.2\'s published UEFI cloud image (tiny, Limine; `images/build.sh alpine-uefi`) beside it: a first boot to its login prompt (root is locked in the cloud image: no command)',
  serve: async () => {
    if (!existsSync(`${DIST}index.html`)) throw new Error('build the page first: npm run dist -- --out bench/results/local/demo/dist');
    if (!existsSync(ALPINE)) throw new Error('images/build.sh alpine-uefi');
    const disk = `${DIST}alpine-uefi.qcow2`;
    if (!existsSync(disk)) linkSync(ALPINE, disk);
    const server: Server = await startServer(0, '127.0.0.1', DIST);
    return {
      base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      close: async () => {
        await new Promise((r) => server.close(r));
        unlinkSync(disk);
      },
    };
  },
  url: (base) => `${base}/?disk=/alpine-uefi.qcow2&view=both`,
  ...ours,
  promptIs: 'the login prompt on the serial console (the machine `running`)',
  timeoutMs: 300_000,
};

const SITE = new URL('../results/local/demo/site/', import.meta.url).pathname;

/**
 * DEMO loop 1's spike: the spike's Alpine template (bench/demo/make-template.ts) restored in a fresh profile with no
 * network past this computer: the page as `npm run dist` builds it on 127.0.0.1, the template's site (its image's and
 * snapshot's pieces, the definition) on localhost as vmdisks.tny.im would serve it, both counting what they send.
 * The click is the page's hook for a demo's card (web/app/template.ts: the definition imported, the snapshot fetched
 * and kept, the machine opened, its first start the restore).
 */
const templateTarget = (name: string, SPIKE: string, view: 'terminal' | 'screen'): Target => ({
  name,
  system: 'waarm64',
  what: `${process.env.DEMO_LINK ? `through one link of ${process.env.DEMO_LINK} (Mbit/s / RTT ms; bench/demo/site.ts throttle, the page's files at their brotli size): ` : ''}the page as 'npm run dist -- --out bench/results/local/demo/dist' builds it (Vite's preview on 127.0.0.1) and a demo's template (${SPIKE}${view === 'screen' ? ', a desktop: tools/build-demos.ts --out bench/results/local/demo/site' : ': bench/demo/make-template.ts'}; \`DEMO_TEMPLATE\` another) hosted under the demo's layout on localhost (bench/demo/site.ts), offline: the page loaded, then the click (the template's machine made and opened, its snapshot restored at its first start), to ${view === 'screen' ? 'its desktop on the screen' : 'the root shell'}`,
  offline: true,
  serve: async () => {
    if (!existsSync(`${DIST}index.html`)) throw new Error('build the page first: npm run dist -- --out bench/results/local/demo/dist');
    if (!existsSync(`${SITE}${SPIKE}/snapshot.json`)) throw new Error('make the template first: node bench/demo/make-template.ts');
    const log: Log[] = [];
    const hashes = (f: string) => new Set<string>((JSON.parse(readFileSync(`${SITE}${SPIKE}/${f}`, 'utf8')) as { hashes: string[] }).hashes);
    const [snap, disk] = [hashes('snapshot.json'), hashes('manifest.json')];
    const kindOf = (path: string) => {
      const h = /^\/pieces\/([0-9a-f]{64})\.bin$/.exec(path)?.[1];
      if (!h) return 'meta'; // the definition and the manifests
      return snap.has(h) ? 'snapshot' : disk.has(h) ? 'disk' : 'other';
    };
    const site = await siteServer(SITE, log, kindOf);
    const server: Server = await startServer(0, '127.0.0.1', DIST);
    count(server, log, () => 'page');
    let [pagePort, sitePort] = [(server.address() as { port: number }).port, Number(new URL(site.base).port)];
    // `DEMO_LINK=<Mbit/s>/<RTT ms>`: both behind one throttled link, the page's files at their compressed size.
    const link = linkFromEnv();
    const proxies = link ? [await throttle(pagePort, link, (p) => brotliRatio(DIST, p)), await throttle(sitePort, link)] : [];
    if (link) [pagePort, sitePort] = proxies.map((p) => p.port);
    return {
      base: `http://127.0.0.1:${pagePort}#http://localhost:${sitePort}`,
      close: async () => {
        // `DEMO_SERVED=<file>`: every response (when it ended, its path, kind and bytes), for a run's timeline.
        if (process.env.DEMO_SERVED) writeFileSync(process.env.DEMO_SERVED, `${JSON.stringify(log)}\n`);
        for (const p of proxies) await p.close();
        await new Promise((r) => server.close(r));
        await site.close();
      },
      kinds: (until) => bytesByKind(log, until),
      pageBrotli: (until) => brotliBytes(log, DIST, until),
    };
  },
  url: (base) => `${base.split('#')[0]}/?hooks`,
  ...ours,
  phases: undefined,
  ready: (page, ms) => page.waitForFunction(() => document.body.dataset.state === 'idle', null, { timeout: ms, polling: 50 }).then(() => undefined),
  click: async (page, base) => {
    const site = base.split('#')[1];
    await page.evaluate(([d, s]) => window.__waarm64FromTemplate!(d, s), [`${site}/${SPIKE}/definition.json`, 'snapshot.json']);
    // The view the demo's card opens (its `view`); a desktop's with the terminal beside it, where the command is typed.
    await page.locator(`[data-view-button="${view === 'screen' ? 'both' : 'terminal'}"]`).click();
  },
  ...(view === 'screen'
    ? {
        // The desktop visible: the screen like the template's thumbnail (bench/demo/screen-like.ts), the machine running.
        prompt: async (page: Page, ms: number) => {
          await ours.prompt(page, ms);
          await untilLike(page, readFileSync(`${SITE}${SPIKE}/${existsSync(`${SITE}${SPIKE}/resume.webp`) ? 'resume' : 'thumb'}.webp`), ms);
        },
        promptIs: "the restored machine running and its screen like the template's thumbnail (bench/demo/screen-like.ts: the desktop shown); the command on the serial console, root logged in there",
        echo: ECHO,
        // A program the snapshot didn't run (its pages read from the disk).
        again: 'pacman --version >/dev/null && echo ok-$((6*8))',
        timeoutMs: 300_000,
      }
    : {
        promptIs: 'the restored machine running (the root shell, logged in, is where the snapshot was taken)',
        echo: ECHO,
        // A program the boot didn't run (apk and its libraries, ~5 MB: read from the disk unless the snapshot has them cached).
        again: 'apk --version >/dev/null && echo ok-$((6*8))',
        apk: APK,
        timeoutMs: 120_000,
      }),
});
const template = templateTarget('waarm64-template', process.env.DEMO_TEMPLATE ?? 'alpine-demo', 'terminal');
/** DEMO loop 12: the Arch desktop and its 3D variant, resumed at the desktop (tools/build-demos.ts's builds, put in the site by `--out`). */
const desktopTemplate = templateTarget('waarm64-desktop-template', process.env.DEMO_TEMPLATE ?? 'arch-desktop', 'screen');
const glTemplate = templateTarget('waarm64-3d-template', process.env.DEMO_TEMPLATE ?? 'arch-3d', 'screen');

type IntroPage = { __intro: { can: boolean; guest?: { send(s: string): void }; marks: Record<string, number>; text(): string; ended(): string | undefined } };
/**
 * INTRO loop 1: the introduction's guest alone (bench/demo/intro.html: the runner the first screen uses, on the dev
 * server, so the page's own bytes aren't a deployment's). Ready is its first picture; the prompt is its shell's, after a
 * key pressed at the first picture ends the tour (by itself the tour hands over at ~41 s, by design).
 */
const introGuest: Target = {
  name: 'waarm64-intro-guest',
  system: 'waarm64',
  what: "the introduction's guest (images/build.sh intro) by web/app/intro/guest.ts on bench/demo/intro.html, the dev server on 127.0.0.1; a cold boot under the JIT, one vCPU, 64 MiB, a 512×320 framebuffer",
  offline: true,
  serve: async () => {
    const server: Server = await startServer(0, '127.0.0.1');
    return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise((r) => server.close(() => r())) };
  },
  url: (base) => `${base}/bench/demo/intro.html`,
  ready: async (page, ms) => {
    await page.waitForFunction(() => {
      const i = (window as unknown as Partial<IntroPage>).__intro;
      if (i && (!i.can || i.ended())) throw new Error(`the guest didn't run: ${i.can ? i.ended() : 'this browser can\'t'}`);
      return i?.marks.screen;
    }, null, { timeout: ms, polling: 10 });
  },
  text: (page) => page.evaluate(() => (window as unknown as IntroPage).__intro.text()),
  type: (page, s) => page.evaluate((s) => (window as unknown as IntroPage).__intro.guest!.send(s), s),
  prompt: async (page, ms) => {
    await introGuest.type(page, ' ');
    await page.waitForFunction(() => /waarm64;shell\x07[^]*~ # /.test((window as unknown as IntroPage).__intro.text()), null, { timeout: ms, polling: 10 });
  },
  promptIs: "the shell's prompt, after a key pressed at the first picture ended the tour; `ready` is the first picture on the canvas",
  echo: ECHO,
  timeoutMs: 60_000,
};

/**
 * INTRO loop 2: the introduction's first screen as a first visit meets it: the page as `npm run dist` builds it, opened
 * at `#intro` in a fresh profile, the small machine booting by itself in its frame. Ready is the frame's first picture;
 * the prompt is the shell's, after a key typed in the terminal at the first picture ended the tour. What the server sent
 * is counted by kind: the guest's file, the core, the rest of the page.
 */
const intro: Target = {
  name: 'waarm64-intro',
  system: 'waarm64',
  what: "the introduction (`#intro`) of the page as 'npm run dist -- --out bench/results/local/demo/dist' builds it, Vite's preview server on 127.0.0.1 (nothing compressed in transit: `pageBrotli` is the page's files less the core and the guest at brotli 5); its small machine (images/build.sh intro) boots by itself",
  offline: true,
  serve: async () => {
    if (!existsSync(`${DIST}index.html`)) throw new Error('build the page first: npm run dist -- --out bench/results/local/demo/dist');
    const log: Log[] = [];
    const server: Server = await startServer(0, '127.0.0.1', DIST);
    count(server, log, (path) => (/\/intro\.img-/.test(path) ? 'guest' : /\/waarm64_core-/.test(path) ? 'core' : 'page'));
    return {
      base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      close: () => new Promise((r) => server.close(() => r())),
      kinds: (until) => bytesByKind(log, until),
      pageBrotli: (until) => brotliBytes(log, DIST, until),
    };
  },
  url: (base) => `${base}/#intro`,
  ready: (page, ms) => page.locator('[data-intro] figure[data-guest="running"]').waitFor({ timeout: ms }),
  text: (page) => page.evaluate(() => document.querySelector('[data-intro] figure .xterm-rows')?.textContent ?? ''),
  type: async (page, s) => {
    await page.locator('[data-intro] figure .serial').click();
    await page.keyboard.type(s, { delay: 5 });
  },
  prompt: async (page, ms) => {
    await intro.type(page, ' ');
    await page.locator('[data-intro] figure[data-mark="shell"]').waitFor({ timeout: ms });
    await page.waitForFunction(() => /~ # /.test(document.querySelector('[data-intro] figure .xterm-rows')?.textContent ?? ''), null, { timeout: ms, polling: 10 });
  },
  promptIs: "the shell's prompt in the frame's terminal, after a key typed at the first picture ended the tour; `ready` is the frame's first picture",
  echo: ECHO,
  timeoutMs: 60_000,
};

/** The browser alone: an empty page, for the memory every target's numbers include. */
const blank: Target = {
  name: 'blank',
  system: 'Chromium',
  what: 'about:blank: headless Chromium\'s own processes, the floor under every target\'s memory',
  url: () => 'about:blank',
  text: async () => '',
  type: async () => {},
  prompt: async (page) => page.waitForTimeout(3000),
  promptIs: '3 s after the navigation',
  timeoutMs: 10_000,
};

export const TARGETS: Record<string, Target> = Object.fromEntries([unkernel, v86Buildroot, v86Arch, desktop, alpine, template, desktopTemplate, glTemplate, introGuest, intro, blank].map((t) => [t.name, t]));
