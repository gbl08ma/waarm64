// A compositor's load on the page (graphics.md §19; dev-only, not in tests): sway in a UEFI disk image with sway and
// foot (the user's Arch image, `images/arch/build.sh` plus `pacman -S sway foot`; login arch/arch on the
// screen, root/root on the serial console), headless Chromium, 4 vCPUs, the screen fixed at 1376×762. Renderer modes:
// `virgl` (?gpu=virgl-null, or `?gpu=` + VIRGL_GPU, `virgl` for G3's renderer; WLR_RENDERER=gles2 on Mesa's virgl),
// `llvmpipe` (?gpu=2d: no virgl, gles2 on llvmpipe), `pixman` (?gpu=2d). Phases: sway idle, foot idle, foot scrolling a `date` loop.
// Each phase (bench/gpu/guest-session.ts `load`) reads /proc/stat and every thread's stat over 10 s on the serial
// terminal (busy percent per CPU, ms of CPU a second per thread) and the display's stats (`?displaystats`: flushes are
// frames, submits and stream bytes a second). Screenshots and results.json go to <outdir>.
//   node bench/gpu/sway-load.ts <mode> <image.qcow2> [outdir]
// PROFILE=1 samples the guest's PCs over the date loop and symbolizes the kernel's (results.profile).
// CAPTURE=<file.vglt> (virgl) keeps a trace of the guest's 3D commands from sway's start to foot's (web/virgl-trace.ts,
// the renderer's fixtures) and stops there; SCREEN=<w>x<h> changes the screen's size.
import { mkdirSync, writeFileSync } from 'node:fs';
import { encodeTrace } from '../../web/virgl-trace.ts';
import { GUEST_USER, openSession } from './guest-session.ts';

const mode = process.argv[2] ?? 'virgl';
const image = process.argv[3];
if (!image) throw new Error('usage: node bench/gpu/sway-load.ts <virgl|pixman|llvmpipe> <image.qcow2> [outdir]');
const out = process.argv[4] ?? new URL(`../results/local/sway-load/${mode}/`, import.meta.url).pathname;
const CAPTURE = process.env.CAPTURE;
const VIRGL_GPU = (process.env.VIRGL_GPU ?? 'virgl-null') + (CAPTURE ? ',capture' : '');
mkdirSync(out, { recursive: true });
const s = await openSession({ gpu: mode === 'virgl' ? VIRGL_GPU : '2d', image, out, screen: process.env.SCREEN, ramMiB: 1024 });
const { page, browser, gl, log, terminal, shows, onSerial, onScreen, rootShell, load: measure, close } = s;
const results: Record<string, unknown> = { mode, gl, chromium: browser.version() };
const load = async (label: string, secs = 10, during?: { start(): Promise<void>; stop(): Promise<void> }) => { results[label] = await measure(label, secs, during); };

await rootShell();
await onSerial('clear; uname -r; pacman -Q sway wlroots0.19 mesa foot 2>&1 | tr "\\n" " "; echo; ls /dev/dri\n');
await page.waitForTimeout(3000);
results.info = await terminal();
log('info', results.info);

// The user's session on the screen.
await onScreen(`${GUEST_USER}\n`);
await page.waitForTimeout(3000);
await onScreen(`${GUEST_USER}\n`);
await page.waitForTimeout(6000);
await load('console', 5);
const env = mode === 'pixman' ? 'WLR_RENDERER=pixman' : mode === 'llvmpipe' ? 'WLR_RENDERER=gles2' : 'WLR_RENDERER=gles2';
await onScreen(`${env} sway 2>/tmp/sway.log\n`);
await page.waitForTimeout(45_000);
await onSerial('clear; P=$(pidof sway); echo sway=$P; grep -o -E "libgallium[^ ]*|libpixman[^ ]*" /proc/$P/maps | sort -u; ls -l /proc/$P/fd | grep -o "/dev/dri/[a-zA-Z0-9]*" | sort | uniq -c; grep -i -E "renderer|egl|gles|driver" /tmp/sway.log | head -8\n');
await page.waitForTimeout(4000);
results.sway = await terminal();
log('sway', results.sway);
await load('sway-idle');
// The guest's cursor is the canvas's CSS cursor (docs/frontend.md): sway sets it once the pointer moves over the screen.
await page.locator('#screen').hover({ position: { x: 300, y: 300 } });
await page.locator('#screen').hover({ position: { x: 340, y: 320 } });
await page.waitForTimeout(2000);
results.cursor = await page.evaluate(() => getComputedStyle(document.querySelector('#screen')!).cursor.slice(0, 60));
log('cursor', results.cursor);
// foot (Alt+Enter), then a terminal that scrolls as fast as it can.
await page.locator('#screen').click();
await page.keyboard.down('Alt');
await page.waitForTimeout(150);
await page.keyboard.press('Enter', { delay: 80 });
await page.waitForTimeout(150);
await page.keyboard.up('Alt');
await page.waitForTimeout(20_000);
if (CAPTURE) {
  await onScreen('echo hello from foot; ls /\n');
  await page.waitForTimeout(5000);
  // The records concatenated, as base64 (a page hands strings back quickly, arrays of numbers slowly).
  const [n, b64] = await page.evaluate(() => {
    const rs = (window as unknown as { __virglCapture?: Uint8Array[] }).__virglCapture ?? [];
    let s = '';
    for (const r of rs) for (let k = 0; k < r.length; k += 8192) s += String.fromCharCode(...r.subarray(k, k + 8192));
    return [rs.length, btoa(s)] as const;
  });
  const records = { length: n };
  const trace = encodeTrace([new Uint8Array(Buffer.from(b64, 'base64'))]);
  writeFileSync(CAPTURE, trace);
  await page.locator('#screen').screenshot({ path: `${out}/capture.png` });
  log(`${CAPTURE}: ${records.length} records, ${trace.length} bytes`);
  await close();
  process.exit(0);
}
await load('foot-idle');
await onScreen('while true; do date; done\n');
await page.waitForTimeout(3000);
// PROFILE=1: the guest PC sampler over the date loop, the kernel's PCs symbolized (guest-session.ts `sampler`).
const sampler = process.env.PROFILE ? s.sampler : undefined;
await load('date-loop', 10, sampler);
if (sampler) {
  results.profile = await s.symbolize(36);
  log('profile', JSON.stringify(results.profile));
}
await page.keyboard.press('Control+KeyC');
await page.waitForTimeout(2000);
await onSerial('clear; grep -c . /tmp/sway.log; tail -5 /tmp/sway.log\n');
await page.waitForTimeout(2000);
results.tail = await terminal();
writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 1));
log('done');
await close();
