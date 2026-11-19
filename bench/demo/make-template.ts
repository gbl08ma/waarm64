// Makes a demo's template (bench/demo/REPORT.md "DEMO loop 1", "DEMO loop 3"; loop 5's automated build starts from it):
// the image chunked into a site laid out as vmdisks.tny.im's will be (bench/demo/site.ts: one shared `pieces/`), a
// stored machine made on the page (the dev server, `?ready=guest`) with that image by its URL on the site, booted in a
// fresh profile until the guest agent says it's up (the machine `running`) and root's prompt is on the serial console,
// the console cleared to the motd, a snapshot kept there (the page has the agent drop the guest's caches first), flagged
// as a template with its frames deflated (tools/snapshot-template.ts `--deflate`) and chunked beside the image with
// the machine's definition (its disk's URL relative to it), and a thumbnail of the console (`--thumbnail`):
//   <site>/pieces/<sha256>.bin, <site>/<name>/manifest.json, definition.json, snapshot.json, template.json (what it
//   holds), thumb.webp
//   node bench/demo/make-template.ts [--image target/images/alpine-demo/alpine-demo.qcow2] [--name alpine-demo]
//     [--site bench/results/local/demo/site] [--ram 512] [--cpus 2] [--definition <file>] [--core <wasm>] [--thumbnail]
//     [--ready agent|prompt] [--lz4] [--drop] [--compact] [--settle 5] [--label <the image's name>] [--session <json>]
// `--session` (a desktop: DEMO loop 12): root logged in on the serial console, the recipe's user on the screen, sway and
// the session's apps up, the thumbnail the screen's (tools/demo-site.ts `Session`); the snapshot is the desktop's.
// tools/build-demos.ts (the demos' build: docs/remote-disks.md "Building the demos") runs it per demo with
// `--definition`: the machine made by importing that definition (its MAC, the disk's serial, its CPUs and RAM: what the
// shape hash covers, so a rebuild gives the same hash), its one URL disk's `url`, `name`, `identity` and `size` filled in here
// from the chunked image; without it, a machine made as the page's New machine makes one (`--ram`, `--cpus`; a random
// MAC and serial). `--core`: the page runs that core build (a wasm file, e.g. a copy's `assets/waarm64_core-*.wasm`)
// instead of the checkout's target/, and the frames are deflated by it.
// `--ready prompt`: an image without the agent (the spike's: bench/demo/spike-image.sh), whose prompt is the sign; `--lz4`:
// the frames as the page wrote them (LZ4). `--drop` drops the guest's page cache by the shell before the snapshot (`echo 3 >
// /proc/sys/vm/drop_caches`: what the agent does), `--compact` that and compacts its memory (`echo 1 >
// /proc/sys/vm/compact_memory`: free memory in whole blocks the guest reports); `--settle` waits that many seconds at the
// prompt first (free page reporting hands the freed memory back: SNAPZ leaves it out). Bounded: run it under `timeout 600`.
import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Page } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';
import { chromiumEnv } from '../../tools/nosme.ts';
import { siteServer, type Served } from './site.ts';
import { snapInfo } from './snapinfo.ts';
import { answerAsks } from '../../tests/page-ask.ts';
import type { Session } from '../../tools/demo-site.ts';

const { values: a } = parseArgs({
  options: {
    image: { type: 'string', default: 'target/images/alpine-demo/alpine-demo.qcow2' },
    name: { type: 'string', default: 'alpine-demo' },
    site: { type: 'string', default: 'bench/results/local/demo/site' },
    ram: { type: 'string', default: '512' },
    cpus: { type: 'string', default: '2' },
    drop: { type: 'boolean', default: false },
    compact: { type: 'boolean', default: false },
    settle: { type: 'string', default: '5' },
    ready: { type: 'string', default: 'agent' },
    lz4: { type: 'boolean', default: false },
    definition: { type: 'string' },
    core: { type: 'string' },
    thumbnail: { type: 'boolean', default: false },
    session: { type: 'string' },
    label: { type: 'string' },
  },
});
const ROOT = new URL('../../', import.meta.url).pathname;
/**
 * `--session <json>`: a desktop resumed on the screen (tools/build-demos.ts's recipe `session`): `user` logged in on the
 * screen (tty1; its password the same, as images/arch's logins are), sway started there (`WLR_RENDERER=gles2` on a 3D
 * machine, `pixman` on 2D), then each of `apps` run through sway (`swaymsg exec`) until its window (`window`, an app_id
 * or X11 class in sway's tree) is up; `settle` s more, then the snapshot. `screen` is the page's fixed screen size (its
 * Size menu's: sway keeps the size it started with). Root is logged in on the serial console first (`root`/`root`) to
 * drive it, and stays logged in there (the demo's serial console, as the Alpine demo's).
 */
const session = a.session ? (JSON.parse(a.session) as Session) : undefined;
const site = resolve(ROOT, a.site!);
const dir = join(site, a.name!);
// The profile and the snapshot's files while it's made (removed after): beside the site, one per name.
const work = join(site, '.work', a.name!);
const core = a.core ? resolve(a.core) : undefined;
const log = (...x: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...x);
const chunk = (file: string, out: string, label: string) =>
  log(execFileSync('node', [join(ROOT, 'tools/chunk-image.ts'), file, out, '2', '--name', label, '--pieces', join(site, 'pieces')], { encoding: 'utf8' }).trim());

rmSync(dir, { recursive: true, force: true });
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
if (a.ready !== 'agent' && a.ready !== 'prompt') throw new Error('--ready is agent or prompt');
const imageFile = resolve(ROOT, a.image!);
const label = a.label ?? `Alpine (${a.name})`;
chunk(imageFile, dir, label);

/** A qcow2's virtual size (big-endian at byte 24), or a raw image's bytes. */
function virtualSize(file: string): number {
  const b = Buffer.alloc(32);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, b, 0, 32, 0);
  } finally {
    closeSync(fd);
  }
  return b.readUInt32BE(0) === 0x514649fb ? Number(b.readBigUInt64BE(24)) : statSync(file).size;
}

/** `--definition`'s file with its one URL disk made the chunked image at `url`. */
function definitionFor(url: string) {
  const def = JSON.parse(readFileSync(resolve(a.definition!), 'utf8')) as { disks: Record<string, unknown>[] };
  const urls = def.disks.filter((d) => d.kind === 'url');
  if (urls.length !== 1) throw new Error(`${a.definition}: a demo's definition has one URL disk (its image)`);
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { id: string; size: number; name?: string };
  Object.assign(urls[0], { url, name: m.name ?? urls[0].name, size: virtualSize(imageFile), identity: { kind: 'url', chunked: m.id, bytes: m.size } });
  return def;
}

const served: Served[] = [];
const disks = await siteServer(site, served, () => 'site');
const page0 = await startServer();
let coreServed = 0;
const base = `http://127.0.0.1:${(page0.address() as { port: number }).port}`;
const ctx = await chromium.launchPersistentContext(join(work, 'profile'), {
  executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
  headless: true,
  env: chromiumEnv(),
  acceptDownloads: true,
  downloadsPath: work,
});
// The given core build in place of the checkout's (the page, its workers and the deflate step all fetch this one URL).
if (core)
  await ctx.route('**/target/wasm32-unknown-unknown/release/waarm64_core.wasm', (r) => {
    coreServed++;
    return r.fulfill({ path: core, contentType: 'application/wasm' });
  });
const text = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
const until = async (page: Page, re: RegExp, ms: number) => {
  const end = Date.now() + ms;
  while (!re.test(await text(page))) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${re}; the console: ${(await text(page)).slice(-600)}`);
    await page.waitForTimeout(250);
  }
};
const type = async (page: Page, s: string) => {
  await page.locator('.xterm').click();
  await page.keyboard.type(s, { delay: 10 });
};
/** A command's output on the serial console (root's shell), between markers. */
let runs = 0;
const run = async (page: Page, cmd: string, ms = 60_000) => {
  const m = `MT${++runs}x`;
  await type(page, `clear; echo ${m}-be""gin; ${cmd}; echo ${m}-e""nd\n`);
  await until(page, new RegExp(`${m}-end`), ms);
  const t = await text(page);
  return t.slice(t.lastIndexOf(`${m}-begin`) + m.length + 6, t.lastIndexOf(`${m}-end`)).trim();
};
// Keys typed on the screen by their codes (the guest's keymap is US), as bench/gpu/guest-session.ts types them.
const SHIFTED: Record<string, string> = { '|': 'Backslash', '>': 'Period', '<': 'Comma', _: 'Minus', '"': 'Quote', '&': 'Digit7', '*': 'Digit8', '(': 'Digit9', ')': 'Digit0', $: 'Digit4', ':': 'Semicolon', '?': 'Slash', '~': 'Backquote', '+': 'Equal', '{': 'BracketLeft', '}': 'BracketRight', '!': 'Digit1', '%': 'Digit5', '^': 'Digit6', '#': 'Digit3', '@': 'Digit2' };
const PLAIN: Record<string, string> = { ' ': 'Space', '\n': 'Enter', '-': 'Minus', '=': 'Equal', '/': 'Slash', '.': 'Period', ',': 'Comma', ';': 'Semicolon', "'": 'Quote', '\\': 'Backslash', '[': 'BracketLeft', ']': 'BracketRight', '`': 'Backquote' };
const onScreen = async (page: Page, s: string) => {
  await page.locator('#screen').click();
  for (const c of s) {
    await page.keyboard.press(SHIFTED[c] ? `Shift+${SHIFTED[c]}` : PLAIN[c] ?? (/[A-Z]/.test(c) ? `Shift+Key${c}` : /[a-z]/.test(c) ? `Key${c.toUpperCase()}` : /[0-9]/.test(c) ? `Digit${c}` : c));
    await page.waitForTimeout(40);
  }
};
/**
 * `--session`: root on the serial console, the user's session on the screen, sway, its apps' windows up. A step that
 * doesn't come throws with what the guest says of it (sway's log, the processes).
 */
async function desktop(page: Page, s: Session, id: string) {
  if (/login:\s*$/.test(await text(page))) {
    await type(page, 'root\n');
    await until(page, /Password:\s*$|\]#\s*$/, 60_000);
    if (/Password:\s*$/.test(await text(page))) await type(page, 'root\n');
    await until(page, /\]#\s*$/, 60_000);
  }
  // The kernel's command line the session wants (e.g. init_on_free=1: what the kernel frees is zero, out of the
  // snapshot): added to systemd-boot's entry on the ESP and booted again once (the change is in the template's overlay).
  if (s.cmdline && !(await run(page, 'cat /proc/cmdline')).split(/\s+/).includes(s.cmdline.split(' ')[0])) {
    const entry = (await run(page, 'bootctl status 2>/dev/null | sed -n "s/^ *source: //p" | head -n 1')).trim() || '/boot/loader/entries/arch.conf';
    await run(page, `sed -i "s/^options .*/& ${s.cmdline}/" ${entry} && sync && grep -c "${s.cmdline}" ${entry}`);
    await type(page, 'clear; reboot\n');
    await page.waitForTimeout(15_000);
    await until(page, /login:\s*$|\]#\s*$/, 300_000);
    if (/login:\s*$/.test(await text(page))) {
      await type(page, 'root\n');
      await until(page, /Password:\s*$|\]#\s*$/, 60_000);
      if (/Password:\s*$/.test(await text(page))) await type(page, 'root\n');
      await until(page, /\]#\s*$/, 60_000);
    }
    const now = await run(page, 'cat /proc/cmdline');
    if (!now.includes(s.cmdline)) throw new Error(`the kernel's command line after the reboot: ${now}`);
    log('booted again with', s.cmdline);
  }
  const t0 = Date.now();
  const wait = async (what: string, ok: () => Promise<boolean>, ms: number, diag: string) => {
    for (const end = Date.now() + ms; !(await ok()); await page.waitForTimeout(1000))
      if (Date.now() > end) throw new Error(`${what} didn't come in ${ms / 1000} s: ${await run(page, diag)}`);
    log(what, 'after', Date.now() - t0, 'ms');
  };
  await run(page, 'loadkeys us 2>/dev/null; true');
  const uid = (await run(page, `id -u ${s.user}`)).trim();
  // The name, then the password once getty asked for it (the screen has no text to read: a fixed wait), until the
  // user's shell runs.
  await onScreen(page, `${s.user}\n`);
  await page.waitForTimeout(3000);
  await onScreen(page, `${s.user}\n`);
  // logind's session on tty1 with its runtime directory (a shell alone isn't enough: typed at once, sway found no
  // XDG_RUNTIME_DIR once), then a moment for the shell's prompt.
  await wait('the session', async () => (await run(page, `pgrep -u ${s.user} -x bash >/dev/null && test -d /run/user/${uid} && loginctl list-sessions --no-legend | grep -c ' ${s.user} .*tty1'`)) === '1', 120_000, 'loginctl list-sessions --no-legend; ps -eo user,args | tail -n 8');
  await page.waitForTimeout(2000);
  const display = await page.evaluate(async (id) => {
    const { Store } = await import('/web/app/store.ts' as string);
    return ((await (await Store.open()).get('machines', id)) as { display: string }).display;
  }, id);
  await onScreen(page, `WLR_RENDERER=${display === '3d' ? 'gles2' : 'pixman'} sway 2>/tmp/sway.log\n`);
  const rt = `/run/user/${uid}`;
  await wait('sway', async () => (await run(page, `ls ${rt}/ | grep -c sway-ipc`)) === '1', 180_000, 'tail -n 8 /tmp/sway.log');
  const asUser = (cmd: string) => `su ${s.user} -c "export XDG_RUNTIME_DIR=${rt} WAYLAND_DISPLAY=wayland-1 SWAYSOCK=$(ls ${rt}/sway-ipc.*.sock); ${cmd}"`;
  for (const app of s.apps) {
    const shown = async () => Number(await run(page, asUser(`swaymsg -t get_tree | grep -c -E '\\"(app_id|class)\\": \\"${app.window}\\"'`))) > 0;
    // Again until it runs: sway may not take commands at once.
    // (`run` is typed into su's double-quoted command: no quotes in it.)
    for (let i = 0; i < 5 && !(await shown()); i++) {
      await run(page, asUser(`swaymsg exec '${app.run}' >/dev/null`));
      for (let k = 0; k < 30 && !(await shown()); k++) await page.waitForTimeout(2000);
    }
    await wait(`the window ${app.window}`, shown, 120_000, 'ps -eo args | tail -n 8; tail -n 5 /tmp/sway.log');
  }
  await page.waitForTimeout((s.settle ?? 15) * 1000);
}
try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on('pageerror', (e) => log('[page error]', e.message.slice(0, 300)));
  page.on('console', (m) => m.type() === 'error' && log('[console]', m.text().slice(0, 300)));
  await page.addInitScript(() => {
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = undefined; // a download, not a picker
  });
  await page.goto(`${base}/web/app/?clocksync=0`);
  const url = `${disks.base}/${a.name}/manifest.json`;
  const id = a.definition
    ? await page.evaluate(async (def) => {
        const { Store } = await import('/web/app/store.ts' as string);
        const { checkDefinition, importDefinition } = await import('/web/app/definitions.ts' as string);
        const { machine } = await importDefinition(await Store.open(), checkDefinition(def));
        return machine.id as string;
      }, definitionFor(url))
    : await page.evaluate(
    async ([url, ram, cpus]) => {
      const { Store } = await import('/web/app/store.ts' as string);
      const { createMachine, createDisk, attach } = await import('/web/app/machines.ts' as string);
      const { checkUrl } = await import('/web/app/urlcheck.ts' as string);
      const store = await Store.open();
      const c = await checkUrl(url);
      if (!c.ok || !c.head) throw new Error(`the image's URL: ${JSON.stringify(c.problems)}`);
      // A qcow2's virtual size, at byte 24 of its header (big-endian).
      const v = new DataView(c.head.buffer, c.head.byteOffset);
      const size = v.getUint32(0) === 0x514649fb ? Number(v.getBigUint64(24)) : c.bytes;
      const m = await createMachine(store, { name: 'Alpine', ncpus: Number(cpus), ramMiB: Number(ram), display: '2d', network: true, usb: false, mouse: false, touch: false, shares: false });
      const d = await createDisk(store, { kind: 'url', url, name: c.name, size, bytes: c.bytes, chunked: c.chunked });
      await attach(store, m, d);
      return m.id as string;
    },
    [url, a.ram!, a.cpus!],
  );
  log('machine', id);
  if (session?.screen)
    await page.evaluate(([key, screen]) => localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? '{}'), screen })), ['waarm64.settings', session.screen]);
  // A desktop's snapshot holds its 3D state: past 64 MiB the page asks first (frontend.md "Snapshots"): yes.
  if (session) await answerAsks(page);
  await page.goto(`${base}/web/app/?clocksync=0&ready=guest&dropcaches=1&m=${id}&view=both`);
  // Root is logged in (no login prompt to see); with the agent, the machine is `running` once it says hello. Without
  // it, the page's state stays `booting`: the prompt is the sign.
  const t0 = Date.now();
  if (a.ready === 'agent') {
    await page.waitForFunction(() => document.body.dataset.state === 'running', null, { timeout: 300_000, polling: 250 });
    log('the agent up after', Date.now() - t0, 'ms');
  }
  await until(page, session ? /login:\s*$|\]#\s*$/ : /~#\s*$/, 300_000);
  log('prompt after', Date.now() - t0, 'ms');
  if (session) await desktop(page, session, id);
  if (process.env.MEMINFO) {
    await type(page, 'clear; free -k; grep -E "^(Cached|Buffers|Slab|SReclaimable|AnonPages|Shmem|KernelStack|PageTables|MemFree|Percpu|VmallocUsed)" /proc/meminfo; cat /sys/kernel/mm/transparent_hugepage/enabled 2>&1; cat /proc/cmdline; ip link show eth0\n');
    await page.waitForTimeout(3000);
    log('meminfo', (await page.evaluate(() => [...document.querySelectorAll('.xterm-rows > div')].map((r) => r.textContent?.trimEnd()).filter(Boolean).join('\n'))));
  }
  // Free memory the guest reports (virtio-balloon's free page reporting: whole 4 MiB blocks, 2 s after) is zero in the
  // snapshot; memory freed in small pieces isn't. `--compact` gathers it into whole blocks first.
  // The console as a restore shows it (the snapshot carries its tail): the motd and the prompt.
  const prep = [a.drop || a.compact ? 'sync; echo 3 > /proc/sys/vm/drop_caches' : '', a.compact ? 'echo 1 > /proc/sys/vm/compact_memory' : '', 'clear', session ? '' : 'cat /etc/motd'];
  await type(page, `${prep.filter(Boolean).join('; ')}\n`);
  await page.waitForTimeout(Number(a.settle) * 1000);
  await until(page, session ? /\]#\s*$/ : /~#\s*$/, 10_000);
  if (a.thumbnail) {
    // The console as the card shows it: its top, 16:10, as WebP (Chromium's canvas encodes it).
    // The guest's screen alone: the page's own layers over it (the "Click to type" hint, the cursor, the boot card) hidden.
    const png = (await page.locator(session ? '#screen' : '.xterm').screenshot({ style: '#screen-frame > :not(#screen) { visibility: hidden !important; }' })).toString('base64');
    const webp = await page.evaluate(async (png) => {
      const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
      const w = Math.min(img.width, Math.round((img.height * 16) / 10));
      const canvas = Object.assign(document.createElement('canvas'), { width: 480, height: 300 });
      canvas.getContext('2d')!.drawImage(img, 0, 0, w, (w * 10) / 16, 0, 0, 480, 300);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.85));
      if (blob?.type !== 'image/webp') throw new Error('this Chromium encodes no WebP');
      return [...new Uint8Array(await blob.arrayBuffer())];
    }, png);
    writeFileSync(join(dir, 'thumb.webp'), Uint8Array.from(webp));
  }
  // The toolbar's Snapshot keeps it in the machine (a stored machine's), then the kept file is downloaded.
  await page.locator('#save-snapshot').click();
  const kept = (id: string) =>
    page.evaluate(async (id) => {
      const { Store } = await import('/web/app/store.ts' as string);
      return (await (await Store.open()).all('snapshots')).some((s: { machine: string }) => s.machine === id) as boolean;
    }, id);
  // A desktop's ~1 GiB of RAM and its 3D state take longer.
  for (const end = Date.now() + (session ? 420_000 : 180_000); !(await kept(id)); await page.waitForTimeout(500))
    if (Date.now() > end) {
      await page.screenshot({ path: join(site, `${a.name}-failed.png`) }).catch(() => {});
      const bar = await page.evaluate(() => `${document.getElementById('message-text')?.textContent ?? ''} | ${document.getElementById('message-details')?.textContent ?? ''} | state ${document.body.dataset.state}`);
      throw new Error(`the snapshot was not kept; the message bar: ${bar} (the page: ${join(site, `${a.name}-failed.png`)})`);
    }
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.evaluate(async (id) => {
      const { Store, snapshotPath } = await import('/web/app/store.ts' as string);
      const { opfsDir } = await import('/web/overlay.ts' as string);
      const s = (await (await Store.open()).all('snapshots')).find((x: { machine: string }) => x.machine === id);
      const path: string = snapshotPath(id, s.id);
      const file = await (await (await opfsDir(path.slice(0, path.lastIndexOf('/')))).getFileHandle(s.id)).getFile();
      const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: 'alpine.waarm64snap' });
      document.body.append(link);
      link.click();
    }, id),
  ]);
  const plain = join(work, 'plain.waarm64snap');
  await download.saveAs(plain);
  const def = await page.evaluate(async (id) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { exportDefinition } = await import('/web/app/definitions.ts' as string);
    return exportDefinition(await Store.open(), id);
  }, id);
  // The disk's URL relative to the definition (the store's rule: docs/plans/first-demo.md §4), so the site moves whole.
  for (const d of def.disks) if (d.url) d.url = 'manifest.json';
  writeFileSync(join(dir, 'definition.json'), `${JSON.stringify(def, null, 1)}\n`);
  const template = join(work, 'template.waarm64snap');
  execFileSync('node', [join(ROOT, 'tools/snapshot-template.ts'), plain, template, ...(a.lz4 ? [] : ['--deflate']), ...(core ? ['--core', core] : [])], { stdio: 'inherit' });
  if (core && !coreServed) throw new Error(`the page never fetched the core, so --core ${core} wasn't the one it ran`);
  chunk(template, join(dir, 'snapshot.json'), `${label}, its template`);
  const info = { made: new Date().toISOString(), image: a.image, core: core ?? 'the checkout\'s', definition: a.definition, session, ram: def.machine.ramMiB, cpus: def.machine.ncpus, ready: a.ready, deflate: !a.lz4, drop: a.drop || a.compact, compact: a.compact, settle: Number(a.settle), snapshot: snapInfo(template), lz4: snapInfo(plain), siteBytesBoot: served.reduce((n, s) => n + s.bytes, 0) };
  writeFileSync(join(dir, 'template.json'), `${JSON.stringify(info, null, 1)}\n`);
  log('template', JSON.stringify(info));
} finally {
  await ctx.close();
  await new Promise((r) => page0.close(r));
  await disks.close();
}
rmSync(work, { recursive: true, force: true });
try {
  rmdirSync(join(site, '.work')); // when no other name's is there
} catch {}
