// Snapshots while 3D is in use, on a real guest (docs/graphics.md "Snapshots with 3D in use"; dev-only, not in tests): the desktop guest
// (`target/arch/desktop.qcow2`, images/arch/desktop.sh) opened by its URL (a machine that isn't stored: its snapshots
// are files), 4 vCPUs, 2.5 GiB, the screen at 1376×762, as bench/gpu/firefox-load.ts runs it. Scenes, each saved
// SNAPS times (default 3) with Save snapshot: `idle` (the root shell, the login prompt on the screen: no 3D yet),
// `sway` (sway and foot on GLES over virgl), `desktop` (Firefox on bench/gpu/firefox/webgl.html in a window beside
// gtk4-demo's gears on GSK's GL renderer). Each save records the page's numbers (the file's bytes, the machine's pause
// and the devices' state's ms of it, the 3D contents' bytes) and the file's frames by kind, raw and stored, with
// the renderer's state read from it (resources by kind, their bytes, contexts and objects). The last `desktop` file is
// then loaded in a fresh profile (a new browser context, the same disk by URL): the machine must run on with the 3D
// session alive (sway, Firefox, gtk4-demo still there, Firefox's WebGL page still counting frames, the compositor
// still flushing, the screen changing), and a new GL client started after it (es2gears_wayland, or gtk4-widget-factory on GSK's GL renderer: gtk4-demo is one
// instance, so another `--run` opens nothing) must map a window and draw.
//   node bench/gpu/snapshot-3d.ts <image.qcow2> [outdir]
// SNAPS, WARM_S (seconds after the scene starts, 30), GAP_S (between snapshots, 65), SCENES (default idle,sway,desktop);
// KEEP=1 keeps the files. Run it with TMPDIR on a disk (Playwright's downloads go there; /tmp is RAM on the dev VM).
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { chromiumEnv } from '../../tools/nosme.ts';
import { answerAsks } from '../../tests/page-ask.ts';
import { lzCodec } from '../../web/lz.ts';
import { GUEST_USER, openSession } from './guest-session.ts';

const HOME = `/home/${GUEST_USER}`;
const image = process.argv[2];
if (!image) throw new Error('usage: node bench/gpu/snapshot-3d.ts <image.qcow2> [outdir]');
const out = process.argv[3] ?? new URL('../results/local/snapshot-3d/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const SNAPS = Number(process.env.SNAPS ?? 3);
const WARM_S = Number(process.env.WARM_S ?? 30);
const SCENES = (process.env.SCENES ?? 'idle,sway,desktop').split(',');
const lz = await lzCodec(readFileSync(new URL('../../target/wasm32-unknown-unknown/release/waarm64_core.wasm', import.meta.url)));

type Saved = { desc: { target: number; format: number; width: number; height: number; depth: number; arraySize: number; lastLevel: number; nrSamples: number; bind: number }; levels: { how: string; data: { length: number } }[]; lost?: string };
/** The file's frames by kind (count, raw and stored bytes), and the renderer's state from its DEVS (unpacked by the core's codec). */
async function readFile(path: string) {
  const b = readFileSync(path);
  const v = new DataView(b.buffer, b.byteOffset, b.length);
  let p = 16 + v.getUint32(12, true) + 4;
  const tags: Record<string, { frames: number; raw: number; stored: number }> = {};
  const devs: Uint8Array[] = [];
  for (;;) {
    const tag = b.toString('latin1', p, p + 4), codec = v.getUint32(p + 4, true), raw = v.getUint32(p + 16, true), stored = v.getUint32(p + 20, true);
    p += 32;
    if (tag === 'END ') break;
    const t = (tags[tag] ??= { frames: 0, raw: 0, stored: 0 });
    t.frames++; t.raw += raw; t.stored += stored;
    if (tag === 'DEVS') devs.push(codec === 2 ? await lz.decompress(b.subarray(p, p + stored), raw) : b.subarray(p, p + stored));
    p += stored;
  }
  const json = JSON.parse(Buffer.concat(devs).toString('utf8'));
  // The renderer's state: the object with `version`, `resources` and `contexts` (web/virgl-objects.ts `RendererSnapshot`).
  type State = { resources: Saved[]; contexts: { subs: { objects: { kind: string }[] }[] }[] };
  let r: State | undefined;
  const find = (x: unknown) => {
    if (r || !x || typeof x !== 'object') return;
    const y = x as { version?: unknown; resources?: unknown; contexts?: unknown };
    if (y.version === 1 && Array.isArray(y.resources) && Array.isArray(y.contexts) && y.resources.every((z) => Array.isArray((z as Saved)?.levels))) return void (r = x as State);
    for (const y of Object.values(x)) find(y);
  };
  find(json);
  let renderer;
  if (r) {
    const kinds: Record<string, { n: number; bytes: number }> = {};
    const add = (k: string, bytes: number) => { const e = (kinds[k] ??= { n: 0, bytes: 0 }); e.n++; e.bytes += bytes; };
    let largest = { bytes: 0, what: '' };
    for (const x of r.resources) {
      const bytes = x.levels.reduce((n, l) => n + l.data.length, 0);
      const d = x.desc;
      const kind = d.target === 0 ? 'buffer' : x.levels.some((l) => l.how === 'zs') ? 'depth-stencil' : d.nrSamples > 1 ? 'multisampled' : 'texture';
      add(kind, bytes);
      if (bytes > largest.bytes) largest = { bytes, what: `${kind} ${d.width}x${d.height} format ${d.format}` };
    }
    const objects: Record<string, number> = {};
    for (const c of r.contexts) for (const s of c.subs) for (const o of s.objects) objects[o.kind] = (objects[o.kind] ?? 0) + 1;
    renderer = { resources: r.resources.length, lost: r.resources.filter((x) => x.lost).map((x) => x.lost), kinds, largest, contexts: r.contexts.length, subs: r.contexts.reduce((n, c) => n + c.subs.length, 0), objects };
  }
  return { bytes: b.length, tags, devsBytes: Buffer.concat(devs).length, renderer };
}

const s = await openSession({ gpu: 'virgl', image, out, byUrl: true, query: process.env.QUERY });
const { page, log, pasteSerial, onSerial, rootShell, load, run, runLines, asUser } = s;
const results: Record<string, unknown> = { gl: s.gl, chromium: s.browser.version(), snaps: SNAPS, warmS: WARM_S, scenes: {} };
const save = () => writeFileSync(`${out}/results.json`, JSON.stringify({ ...results, warnings: Object.fromEntries(s.warnings) }, null, 1));

/** Save snapshot on the page (a download): the page's numbers, the file's, and where it is. */
async function snapshot(p: typeof page, path: string) {
  const before = await p.evaluate(() => document.getElementById('message')?.dataset.snapshot ?? '');
  const download = p.waitForEvent('download', { timeout: 600_000 });
  const t0 = performance.now();
  await p.locator('#save-snapshot').click();
  await p.waitForFunction((b) => { const m = document.getElementById('message'); return (m?.dataset.snapshot ?? '') !== b || /no file was saved/.test(m?.textContent ?? ''); }, before, { timeout: 600_000, polling: 100 });
  const wallMs = performance.now() - t0;
  const msg = await p.evaluate(() => document.getElementById('message-text')?.textContent ?? '');
  if (!/^Saved the snapshot/.test(msg)) throw new Error(`the snapshot failed: ${msg}`);
  const page_ = JSON.parse(await p.evaluate(() => document.getElementById('message')!.dataset.snapshot!)) as { bytes: number; pausedMs: number; stateMs: number; blobBytes: number };
  const d = await download;
  await d.saveAs(path);
  await d.delete();
  return { ...page_, wallMs: Math.round(wallMs), file: await readFile(path) };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
async function scene(name: string) {
  const snaps = [];
  for (let k = 0; k < SNAPS; k++) {
    const r = await snapshot(page, `${out}/${name}-${k}.waarm64snap`);
    log(name, k, JSON.stringify({ bytes: r.bytes, pausedMs: Math.round(r.pausedMs), stateMs: Math.round(r.stateMs), blobBytes: r.blobBytes, renderer: r.file.renderer && { resources: r.file.renderer.resources, kinds: r.file.renderer.kinds } }));
    snaps.push(r);
    // Only the last file of `desktop` stays (the restore's); KEEP=1 keeps every scene's last.
    if (k < SNAPS - 1 || (name !== 'desktop' && !process.env.KEEP)) rmSync(`${out}/${name}-${k}.waarm64snap`);
    // The page keeps a download's Blob for 60 s (its URL revoked then): a GiB-sized snapshot each few seconds piles up.
    await page.waitForTimeout(Number(process.env.GAP_S ?? 65) * 1000);
  }
  // The machine still runs on after its snapshots: the compositor's frames over 5 s.
  const after = await load(`${name}-after`, 5);
  (results.scenes as Record<string, unknown>)[name] = {
    pausedMs: { median: Math.round(median(snaps.map((x) => x.pausedMs))), all: snaps.map((x) => Math.round(x.pausedMs)) },
    stateMs: { median: Math.round(median(snaps.map((x) => x.stateMs))), all: snaps.map((x) => Math.round(x.stateMs)) },
    fileBytes: { median: median(snaps.map((x) => x.bytes)), all: snaps.map((x) => x.bytes) },
    blobBytes: snaps.map((x) => x.blobBytes), snaps, flushesAfter: after.display.flushes, rendererAfter: after.display.renderer,
  };
  save();
}

await rootShell();
results.info = await run('uname -r; pacman -Q sway mesa firefox gtk4 2>&1 | tr "\\n" " "; free -m | head -2 | tail -1');
log('info', results.info);
if (SCENES.includes('idle')) await scene('idle');

results.sway = await s.startSway('gles2');
log('sway', results.sway);
await run(asUser("swaymsg exec foot"));
await page.waitForTimeout(WARM_S * 1000);
if (SCENES.includes('sway')) await scene('sway');

// Firefox on the WebGL cubes in a window (bench/gpu/firefox-load.ts's files and profile), and gtk4-demo's gears.
const dir = new URL('firefox/', import.meta.url);
await onSerial(`clear; rm -rf ${HOME}/ffbench; mkdir -p ${HOME}/ffbench/profile\n`);
for (const [from, to] of [['bench.js', 'bench.js'], ['webgl.html', 'webgl.html'], ['user.js', 'profile/user.js']]) {
  await pasteSerial(`cat > ${HOME}/ffbench/${to} <<'EOF'\n${readFileSync(new URL(from, dir), 'utf8')}EOF`);
}
await onSerial(`clear; chown -R ${GUEST_USER}:${GUEST_USER} ${HOME}/ffbench\n`);
await run(asUser(`swaymsg exec 'firefox --profile ${HOME}/ffbench/profile file://${HOME}/ffbench/webgl.html > /tmp/ff.log 2>&1'`));
const ready = await run('for i in $(seq 600); do grep -q "FFBENCH .* ready" /tmp/ff.log 2>/dev/null && { echo ready $i; break; }; sleep 0.5; done', 330_000);
log('firefox', ready);
await run(asUser("swaymsg exec 'GSK_RENDERER=gl gtk4-demo --run=gears > /tmp/gtk.log 2>&1'"));
await page.waitForTimeout(WARM_S * 1000);
/** Firefox's frames a second (its page's FFBENCH lines), the last `n`. */
const ffFrames = async (r: typeof run, n: number) => [...(await r(`grep FFBENCH /tmp/ff.log | grep frames= | tail -${n} | sed 's/.*frames=//' | tr "\\n" " "`)).matchAll(/(\d+) maxms/g)].map((x) => +x[1]);
const procs = 'for p in sway foot firefox gtk4-demo; do printf "%s=%s " $p $(pgrep -x $p | wc -l); done';
const before = await load('desktop-before', 10);
results.desktopBefore = { procs: await run(procs), ffFps: await ffFrames(run, 10), flushes: before.display.flushes, renderer: before.display.renderer };
log('desktop before', JSON.stringify(results.desktopBefore));
save();
if (SCENES.includes('desktop')) await scene('desktop');
const file = `${out}/desktop-${SNAPS - 1}.waarm64snap`;
const shot = await page.locator('#screen').screenshot({ path: `${out}/desktop-saved.png` });
await s.close();

// A fresh profile: the same disk by its URL, then Load snapshot… with the last file.
if (SCENES.includes('desktop')) {
  const { chromium } = await import('playwright-core');
  const { startServer } = await import('../../tools/serve.ts');
  const server = await startServer();
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', env: chromiumEnv() });
  const p2 = await (await browser.newContext({ viewport: { width: 1400, height: 1300 } })).newPage();
  await p2.addInitScript(() => localStorage.setItem('waarm64.settings', JSON.stringify({ screen: '1376x762' })));
  await answerAsks(p2);
  const warnings = new Map<string, number>();
  p2.on('console', (m) => { const t = m.text(); if (t.startsWith('virgl')) warnings.set(t.slice(0, 200), (warnings.get(t.slice(0, 200)) ?? 0) + 1); });
  p2.on('pageerror', (e) => console.log('pageerror', String(e)));
  await p2.goto(s.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, base));
  await p2.waitForFunction(() => ['running', 'booting'].includes(document.body.dataset.state!), null, { timeout: 120_000, polling: 250 });
  const t0 = performance.now();
  await p2.setInputFiles('#load-snapshot-input', file);
  await p2.waitForFunction(() => document.getElementById('boot-title')!.textContent!.startsWith('Loading '), null, { timeout: 30_000, polling: 20 });
  await p2.waitForFunction(() => ['running', 'failed', 'crashed'].includes(document.body.dataset.state!), null, { timeout: 600_000, polling: 100 });
  const loadMs = Math.round(performance.now() - t0);
  const state = await p2.evaluate(() => document.body.dataset.state);
  log('restored', state, loadMs, 'ms');
  const terminal = () => p2.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
  let runs = 0;
  const run2 = async (cmd: string, ms = 60_000) => {
    const m = `Q${++runs}`;
    await p2.locator('.xterm').click();
    await p2.keyboard.type(`clear; echo ${m}-be""gin; ${cmd}; echo ${m}-e""nd\n`, { delay: 5 });
    await p2.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), `${m}-end`, { timeout: ms, polling: 200 });
    const t = await terminal();
    return t.slice(t.lastIndexOf(`${m}-begin`) + m.length + 6, t.lastIndexOf(`${m}-end`)).trim();
  };
  const stats = async () => (await p2.evaluate(() => ((window as unknown as { __drawStats?: { busy: Record<string, number> }[] }).__drawStats ?? []).splice(0))).reduce((n, x) => n + (x.busy.flushes ?? 0), 0);
  const errors = async () => (await p2.evaluate(() => ((window as unknown as { __renderStats?: { errors: number }[] }).__renderStats ?? []).at(-1)?.errors ?? -1));
  await p2.waitForTimeout(3000);
  await stats();
  const a = await p2.locator('#screen').screenshot({ path: `${out}/restored-1.png` });
  await p2.waitForTimeout(5000);
  const b = await p2.locator('#screen').screenshot({ path: `${out}/restored-2.png` });
  const flushes = (await stats()) / 5;
  const restoredProcs = await run2(procs);
  await p2.waitForTimeout(5000);
  const ffFps = await ffFrames(run2, 5);
  // Used on: a new GL client after the restore.
  const user = (cmd: string) => `su ${GUEST_USER} -c "export XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-1 SWAYSOCK=$(ls /run/user/1000/sway-ipc.*.sock); ${cmd}"`;
  const windows = async () => Number((await run2(user('swaymsg -t get_tree | grep -c app_id'))).trim().split(/\s+/).at(-1));
  const windowsBefore = await windows();
  const client = (await run2('command -v es2gears_wayland >/dev/null && echo es2gears_wayland || echo gtk4-widget-factory')).trim();
  await run2(user(`swaymsg exec 'GSK_RENDERER=gl ${client} > /tmp/gl2.log 2>&1'`));
  await p2.waitForTimeout(20_000);
  await stats();
  await p2.waitForTimeout(5000);
  const flushes2 = (await stats()) / 5;
  const c = await p2.locator('#screen').screenshot({ path: `${out}/restored-3.png` });
  const newClient = { client, alive: (await run2(`pgrep -x ${client.slice(0, 15)} | wc -l`)).trim() !== '0', windowsBefore, windowsAfter: await windows(), log: await run2('grep -v -i -E "session bus|vulkan|portal|highlight" /tmp/gl2.log | head -3') };
  results.restore = {
    state, loadMs, flushes, flushesWithNewClient: flushes2, procs: restoredProcs, ffFps, newClient,
    screenChanges: Buffer.compare(a, b) !== 0, screenDiffersFromSaved: Buffer.compare(shot, a) !== 0, newClientChangedScreen: Buffer.compare(b, c) !== 0,
    rendererErrors: await errors(), warnings: Object.fromEntries(warnings),
  };
  log('restore', JSON.stringify(results.restore));
  save();
  await browser.close();
  server.close();
  if (!process.env.KEEP) rmSync(file);
  else log('kept', file, statSync(file).size);
}
save();
log('done');
