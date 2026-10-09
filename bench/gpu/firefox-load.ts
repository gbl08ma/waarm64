// Firefox on the page (G4, the kickoff's decision 1; dev-only, not in tests): the user's Arch image with sway and
// Firefox (`bench/results/local/myarch3.qcow2`: login alarm/alarm on the screen, root/root on the serial console),
// headless Chromium, 4 vCPUs, 2.5 GiB, the screen fixed at 1376×762, as bench/gpu/sway-load.ts. sway starts on GLES
// (on Mesa's virgl with 3D, on llvmpipe with `?gpu=2d`, or `WLR_RENDERER=pixman` in mode `pixman`), then Firefox in
// kiosk mode on the pages in bench/gpu/firefox/ (copied into the guest), a profile of their own (user.js; FF_PREFS adds
// lines like `gfx.webrender.software=true`). Phases, 10 s each (bench/gpu/guest-session.ts `load`: every thread's CPU,
// the display's and renderer's stats, the emulator's counters): a still page, the page scrolling 6 px a frame, WebGL 2
// cubes (each after WARM_S s, 30 by default); with the frames Firefox's own animation ran each second (FFBENCH lines from its stdout). Also Firefox's
// start time, which processes map Mesa, about:support's screenshot, and the renderer's warnings.
//   node bench/gpu/firefox-load.ts <virgl|2d|pixman> <image.qcow2> [outdir]
// GUEST_CMD runs a command in sway's session first (results.cmd). PHASES picks the phases (default `still,scroll,webgl,pages,support`; `pages` needs bench/gpu/firefox-pages.sh's disk);
// WARM_S, PHASE_S their times.
// VIRGL_GPU picks the page's `?gpu=` in mode virgl (default `virgl`; `virgl-null` for G2's null renderer).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { openSession } from './guest-session.ts';

const mode = process.argv[2] ?? 'virgl';
const image = process.argv[3];
if (!image) throw new Error('usage: node bench/gpu/firefox-load.ts <virgl|2d|pixman> <image.qcow2> [outdir]');
const out = process.argv[4] ?? new URL(`../results/local/firefox-load/${mode}/`, import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const PHASE_S = Number(process.env.PHASE_S ?? 10);
/** Seconds between Firefox's page saying ready and the phase (its start-up work settles: a fresh profile's first minute is busy). */
const WARM_S = Number(process.env.WARM_S ?? 30);
const PHASES = (process.env.PHASES ?? 'still,scroll,webgl,pages,support').split(',');
const s = await openSession({ gpu: mode === 'virgl' ? process.env.VIRGL_GPU ?? 'virgl' : '2d', image, out, screen: process.env.SCREEN, disk2: PHASES.includes('pages') ? '/target/ffpages/pages.ext4' : undefined });
const { page, log, terminal, shows, onSerial, pasteSerial, onScreen, rootShell, load } = s;
const results: Record<string, unknown> = { mode, gl: s.gl, chromium: s.browser.version(), prefs: process.env.FF_PREFS ?? '' };
const save = () => {
  writeFileSync(`${out}/results.json`, JSON.stringify({ ...results, warnings: Object.fromEntries(s.warnings) }, null, 1));
  if (s.debugLines.length) writeFileSync(`${out}/virgl-debug.txt`, s.debugLines.join('\n') + '\n');
};
/** A command's output on the serial terminal, between markers. */
let n = 0;
const run = async (cmd: string, ms = 60_000) => {
  const m = `R${++n}`;
  await onSerial(`clear; echo ${m}-be""gin; ${cmd}; echo ${m}-e""nd\n`);
  await shows(new RegExp(`${m}-end`), ms);
  const t = await terminal();
  return t.slice(t.lastIndexOf(`${m}-begin`) + m.length + 6, t.lastIndexOf(`${m}-end`)).trim();
};
/** A command's output as lines, however long (the terminal shows a screenful: read 15 lines at a time, each marked). */
const runLines = async (cmd: string, ms = 60_000) => {
  const total = Number(await run(`${cmd} > /tmp/run.out 2>&1; wc -l < /tmp/run.out`, ms));
  const lines: string[] = [];
  for (let a = 1; a <= total; a += 15) lines.push(...(await run(`sed -n "${a},${a + 14}p" /tmp/run.out | sed "s/^/@@/"`)).split('@@').slice(1).map((l) => l.trim()));
  return lines;
};

await rootShell();
// The pages and the profile, in the guest.
const dir = new URL('firefox/', import.meta.url);
const prefs = (process.env.FF_PREFS ?? '').split(',').filter(Boolean).map((p) => {
  const [k, v] = p.split('=');
  return `user_pref("${k}", ${/^(true|false|-?\d+)$/.test(v) ? v : JSON.stringify(v)});`;
});
const files: [string, string][] = [['bench.js', 'bench.js'], ['scroll.html', 'scroll.html'], ['webgl.html', 'webgl.html'], ['user.js', 'profile/user.js']];
await onSerial('clear; rm -rf /home/alarm/ffbench; mkdir -p /home/alarm/ffbench/profile\n');
for (const [from, to] of files) {
  const text = readFileSync(new URL(from, dir), 'utf8') + (from === 'user.js' ? prefs.join('\n') + '\n' : '');
  await pasteSerial(`cat > /home/alarm/ffbench/${to} <<'EOF'\n${text}EOF`);
}
await onSerial('clear; chown -R alarm:alarm /home/alarm/ffbench\n');
// The autoconfig that summarizes about:support's graphics section (FFBENCH_SUPPORT=<file>).
for (const [from, to] of [['autoconfig.js', '/usr/lib/firefox/defaults/pref/autoconfig.js'], ['webpc.cfg', '/usr/lib/firefox/webpc.cfg']]) {
  await pasteSerial(`cat > ${to} <<'EOF'\n${readFileSync(new URL(from, dir), 'utf8')}EOF`);
}
// Firefox started by sway (as the user; `ffrun <url> <tag> [""]`: in kiosk mode unless a third argument replaces it),
// its stdout in /tmp/ff-<tag>.log; `ffwait <tag>` prints the seconds until its
// page says ready (or `timeout`).
await pasteSerial(String.raw`cat > /root/ff.sh <<'EOF'
ffkill() { pkill -x firefox; for i in $(seq 60); do pgrep -x firefox >/dev/null || return 0; sleep 1; done; pkill -9 -x firefox; sleep 2; }
ffrun() { k=--kiosk; [ $# -ge 3 ] && k=$3; rm -f /tmp/ff-$2.log; date +%s.%N > /tmp/ff-$2.t0; su alarm -c "swaymsg -s $(ls /run/user/1000/sway-ipc.*.sock) exec 'FFBENCH_SUPPORT=/tmp/ff-$2.support firefox --profile /home/alarm/ffbench/profile $k $1 > /tmp/ff-$2.log 2>&1'" >/dev/null; }
ffwait() { for i in $(seq 600); do grep -q "FFBENCH .* ready" /tmp/ff-$1.log 2>/dev/null && { echo "$(date +%s.%N) $(cat /tmp/ff-$1.t0)" | awk '{printf "started %.1f\n", $1-$2}'; return; }; sleep 0.5; done; echo timeout; }
EOF`);
results.info = await run('uname -r; pacman -Q firefox sway wlroots0.19 mesa 2>&1 | tr "\\n" " "; free -m | head -2 | tail -1');
log('info', results.info);

// The user's session on the screen.
await onScreen('alarm\n');
await page.waitForTimeout(3000);
await onScreen('alarm\n');
await page.waitForTimeout(6000);
await onScreen(`${mode === 'pixman' ? 'WLR_RENDERER=pixman' : 'WLR_RENDERER=gles2'} sway 2>/tmp/sway.log\n`);
for (let i = 0; i < 60; i++) {
  if ((await run('ls /run/user/1000/ | grep -c sway-ipc')).trim() === '1') break;
  await page.waitForTimeout(2000);
}
await page.waitForTimeout(10_000);
results.sway = await run('grep -i -E "renderer|egl|gles|driver" /tmp/sway.log | head -4');
log('sway', results.sway);

// GUEST_CMD: a command run as the user in sway's session (its environment), its output kept (results.cmd).
if (process.env.GUEST_CMD) {
  await pasteSerial(`cat > /tmp/cmd.sh <<'EOF'\n${process.env.GUEST_CMD}\nEOF`);
  results.cmd = await runLines('su alarm -c "export XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-1 SWAYSOCK=$(ls /run/user/1000/sway-ipc.*.sock); sh /tmp/cmd.sh"', 120_000);
  log('cmd', (results.cmd as string[]).join('\n'));
  save();
}

/** Firefox on `url`, waited for (its page's `ready`, or 5 minutes), measured over a phase. */
const firefox = async (tag: string, url: string) => {
  await run('. /root/ff.sh; ffkill', 120_000);
  await run(`. /root/ff.sh; ffrun ${url} ${tag}`);
  const started = await run(`. /root/ff.sh; ffwait ${tag}`, 330_000);
  log(tag, started);
  await page.waitForTimeout(WARM_S * 1000);
  const r = await load(tag, PHASE_S);
  const ff = await run(`grep FFBENCH /tmp/ff-${tag}.log | grep frames= | tail -${PHASE_S} | sed 's/.*frames=//' | tr "\\n" " "`);
  const fps = [...ff.matchAll(/(\d+) maxms=([\d.]+)/g)].map((x) => ({ frames: +x[1], maxms: +x[2] }));
  const sorted = fps.map((x) => x.frames).sort((a, b) => a - b);
  const rec = { started: +(/started ([\d.]+)/.exec(started)?.[1] ?? NaN), fps, medianFps: sorted[sorted.length >> 1], ...r };
  log(tag, 'fps', JSON.stringify(sorted), 'renderer', JSON.stringify(r.display.renderer ?? {}));
  results[tag] = rec;
  save();
};

if (PHASES.includes('still')) await firefox('still', 'file:///home/alarm/ffbench/scroll.html?still');
results.mesa = await run('for p in $(pgrep -f firefox); do grep -q libgallium /proc/$p/maps && echo "$p $(cat /proc/$p/comm) $(ls -l /proc/$p/fd 2>/dev/null | grep -c /dev/dri)"; done | tr "\\n" ";"');
log('mesa', results.mesa);
if (PHASES.includes('scroll')) await firefox('scroll', 'file:///home/alarm/ffbench/scroll.html');
if (PHASES.includes('webgl')) await firefox('webgl', 'file:///home/alarm/ffbench/webgl.html');
if (PHASES.includes('pages')) {
  // Real sites (bench/gpu/firefox-pages.sh): Firefox started on each (its start and the page's load timed), then
  // scrolled by the mouse's wheel as a user does (Firefox's asynchronous scrolling), measured.
  const list = await runLines('mkdir -p /mnt/ffpages; mount -o ro /dev/vdb /mnt/ffpages 2>/dev/null; cat /mnt/ffpages/pages.txt');
  const box = (await page.locator('#screen').boundingBox())!;
  for (const line of list.filter(Boolean)) {
    const [name, file] = line.split(' ');
    const tag = `page-${name}`;
    await run('. /root/ff.sh; ffkill', 120_000);
    await run(`. /root/ff.sh; ffrun file:///mnt/ffpages/${file} ${tag}`);
    const started = await run(`. /root/ff.sh; ffwait ${tag}`, 330_000);
    const loadMs = Number(/FFBENCH load (\d+)/.exec(await run(`grep "FFBENCH load" /tmp/ff-${tag}.log`))?.[1] ?? NaN);
    log(tag, started, 'load', loadMs);
    await page.waitForTimeout(10_000);
    // Wheel steps of 120 (one notch) every 100 ms, down through the page, as the phase runs.
    let wheeling = false;
    // The pointer over the screen each time (typing the phase's command on the serial terminal clicked it away).
    const wheel = async () => { while (wheeling) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, 120); await page.waitForTimeout(100); } };
    let done: Promise<void> = Promise.resolve();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const r = await load(tag, PHASE_S, { start: async () => { wheeling = true; done = wheel(); }, stop: async () => { wheeling = false; await done; } });
    const ff = await run(`grep FFBENCH /tmp/ff-${tag}.log | grep frames= | tail -${PHASE_S} | sed 's/.*frames=//' | tr "\\n" " "`);
    const fps = [...ff.matchAll(/(\d+) maxms=([\d.]+)/g)].map((x) => ({ frames: +x[1], maxms: +x[2] }));
    const sorted = fps.map((x) => x.frames).sort((a, b) => a - b);
    results[tag] = { started: +(/started ([\d.]+)/.exec(started)?.[1] ?? NaN), loadMs, fps, medianFps: sorted[sorted.length >> 1], ...r };
    log(tag, 'fps', JSON.stringify(sorted), 'flushes', r.display.flushes.toFixed(1));
    save();
  }
}
if (PHASES.includes('menu')) {
  // A context menu (a popup with rounded corners and a shadow: translucent at its edges), in a normal window (kiosk
  // mode has none); the screen shot with the menu open.
  await run('. /root/ff.sh; ffkill', 120_000);
  await run(`. /root/ff.sh; ffrun file:///home/alarm/ffbench/scroll.html?still menu ""`);
  log('menu', await run('. /root/ff.sh; ffwait menu', 330_000));
  await page.waitForTimeout(WARM_S * 1000);
  const box = (await page.locator('#screen').boundingBox())!;
  s.debugLines.push('--- the right click');
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.5, { button: 'right' });
  await page.waitForTimeout(8000);
  await page.locator('#screen').screenshot({ path: `${out}/menu.png` });
  await page.keyboard.press('Escape');
  save();
}
if (PHASES.includes('support')) {
  // about:support, its graphics section.
  await run('. /root/ff.sh; ffkill', 120_000);
  await run('. /root/ff.sh; ffrun about:support#graphics support');
  await page.waitForTimeout(60_000);
  await page.locator('#screen').screenshot({ path: `${out}/about-support.png` });
  results.support = await runLines('cat /tmp/ff-support.support');
  log('support', (results.support as string[]).join('\n'));
}
await run('. /root/ff.sh; ffkill', 120_000);
results.log = await runLines('grep -h -v FFBENCH /tmp/ff-*.log | cut -c1-200 | sort | uniq -c | sort -rn | head -30');
log('firefox stderr', (results.log as string[]).join('\n'));
save();
log('done', JSON.stringify(Object.fromEntries(s.warnings)));
await s.close();
