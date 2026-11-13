// Firefox on the page (G4, the kickoff's decision 1; dev-only, not in tests): the user's Arch image with sway and
// Firefox (`target/arch/desktop.qcow2`, images/arch/desktop.sh: login arch/arch on the screen, WAARM64_GUEST_USER=alarm for an Arch Linux ARM disk, root/root on the serial console),
// headless Chromium, 4 vCPUs, 2.5 GiB, the screen fixed at 1376×762, as bench/gpu/sway-load.ts. sway starts on GLES
// (on Mesa's virgl with 3D, on llvmpipe with `?gpu=2d`, or `WLR_RENDERER=pixman` in mode `pixman`), then Firefox in
// kiosk mode on the pages in bench/gpu/firefox/ (copied into the guest), a profile of their own (user.js; FF_PREFS adds
// lines like `gfx.webrender.software=true`). Phases, 10 s each (bench/gpu/guest-session.ts `load`: every thread's CPU,
// the display's and renderer's stats, the emulator's counters): a still page, the page scrolling 6 px a frame, WebGL 2
// cubes (each after WARM_S s, 30 by default); with the frames Firefox's own animation ran each second (FFBENCH lines from its stdout). Also Firefox's
// start time, which processes map Mesa, about:support's screenshot, and the renderer's warnings.
//   node bench/gpu/firefox-load.ts <virgl|2d|pixman> <image.qcow2> [outdir]
// GUEST_CMD runs a command in sway's session first (results.cmd). PHASES picks the phases (default
// `still,scroll,webgl,pages,support`; `pages` needs bench/gpu/firefox-pages.sh's disk; `startup` measures a launch);
// WARM_S, PHASE_S their times; PAGES picks the sites of `pages` by name (e.g. `wiki,mdn`).
// VIRGL_GPU picks the page's `?gpu=` in mode virgl (default `virgl`; `virgl-null` for G2's null renderer). TIMELINE=1
// records the vCPU timeline over each phase (guest-session.ts `summarizeTimeline`; the rows in <outdir>/<tag>.timeline.json).
// TIMELINE_ALL=1 records it over the whole of `pages` instead (every start and load; <outdir>/pages-all.timeline.json).
// PROFILE=1 samples the guest's PCs over each site's scroll (guest-session.ts `sampler`; the kernel's functions in results.json); SYSCALLS=1 counts syscalls (`load`).
// QUERY adds to the page's query (e.g. `jit=nocw`: the JIT without its compile worker).
// CORE=<file.wasm> serves that core build instead of target/'s (bench/snapshot-start.ts `routeCore`).
// Started from a snapshot (docs/benchmarking.md "Starting from a snapshot"): SAVE_SNAPSHOTS=<dir> boots, sets the guest
// up as above (sway, the pages and the profile), then saves <dir>/pages.waarm64snap (Firefox up on a still page, WARM_S
// after it said ready) and <dir>/webgl.waarm64snap (Firefox on the WebGL cubes, WARM_S after ready), and ends; the disk
// is opened by its URL with bench/gpu/firefox-pages.sh's second disk, as `pages` needs. FROM_SNAPSHOT=<file> loads
// one instead of booting and goes straight to the phases (no login, no files, no sway: they're in the file); `webgl`
// from webgl.waarm64snap measures the Firefox already on it (WARM_S after the restore: the JIT starts cold).
// PHASES=churn: code churn for the JIT's cache (firefox/churn.html; CHURN its query, CHURN_S its time).
// TAILCAT=<address> (opt-in, benchmarks only: tests/net/tailcat.sh up prints it) puts the guest online through that
// exit node: the adapter connected, then IPv4 only in the guest (the dev VM has no IPv6 out: no IPv6 default route,
// DNS at 1.1.1.1, IPv4 preferred, Firefox's network.dns.disableIPv6), checked with a curl. PHASES=sites (needs it):
// real sites in one tab by bot (firefox/sites.html), SITES the URLs (comma separated; a default list of heavy ones),
// DWELL_S seconds each (20), CYCLES times through (1); every visit's URL and host time in results.sites.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { GUEST_USER, openSession } from './guest-session.ts';
import { saveSnapshotFile } from '../snapshot-start.ts';

const HOME = `/home/${GUEST_USER}`;

const mode = process.argv[2] ?? 'virgl';
const image = process.argv[3];
if (!image) throw new Error('usage: node bench/gpu/firefox-load.ts <virgl|2d|pixman> <image.qcow2> [outdir]');
const out = process.argv[4] ?? new URL(`../results/local/firefox-load/${mode}/`, import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const PHASE_S = Number(process.env.PHASE_S ?? 10);
/** Seconds between Firefox's page saying ready and the phase (its start-up work settles: a fresh profile's first minute is busy). */
const WARM_S = Number(process.env.WARM_S ?? 30);
const PHASES = (process.env.PHASES ?? 'still,scroll,webgl,pages,support').split(',');
/** The session's times (epoch ms): its start, the machine running (booted or restored), set up (the phases begin), each save. */
const times: Record<string, number> = { start: Date.now() };
const SAVE = process.env.SAVE_SNAPSHOTS;
const FROM = process.env.FROM_SNAPSHOT;
const TAILCAT = process.env.TAILCAT;
const s = await openSession({ tailcat: TAILCAT, gpu: mode === 'virgl' ? process.env.VIRGL_GPU ?? 'virgl' : '2d', image, out, screen: process.env.SCREEN, query: process.env.QUERY, disk2: PHASES.includes('pages') || SAVE || FROM ? '/target/ffpages/pages.ext4' : undefined, snapshot: FROM, core: process.env.CORE });
const { page, log, onSerial, pasteSerial, rootShell, load, run, runLines } = s;
times.running = Date.now();
const results: Record<string, unknown> = { mode, gl: s.gl, chromium: s.browser.version(), prefs: process.env.FF_PREFS ?? '', ...(s.restored ? { from: s.restored } : {}), ...(s.coreSha ? { core: s.coreSha } : {}) };
// The JIT's counters and parallel SMP's (DSB waits, the platform lock), for ab-summary.
async function takeStats() {
  const st = (await s.vmStats())?.stats as { jit?: unknown; par?: unknown } | undefined;
  results.jit = st?.jit;
  results.par = st?.par;
}
/** PROFILE's kernel groups (guest-session.ts `symbolGroups`): the 3D driver's paths in the guest's kernel. */
const KERNEL_GROUPS = { virtio_gpu: 'virtio_gpu', virtqueue: 'virtqueue|vring', drm: '^(__)?drm_|\\[drm', shmem: 'shmem', dma: 'dma_resv|dma_fence|dma_buf' };
type During = { start(): Promise<void>; stop(): Promise<void> };
/** `load`'s `during`: `d` and, with TIMELINE=1, the vCPU timeline around it. */
const around = (d?: During): During | undefined => (process.env.TIMELINE ? { start: async () => { await s.timeline.start(); await d?.start(); }, stop: async () => { await d?.stop(); await s.timeline.stop(); } } : d);
const timeline = async (tag: string) => (process.env.TIMELINE ? { timeline: await s.timelineSummary(tag) } : {});
const save = () => {
  writeFileSync(`${out}/results.json`, JSON.stringify({ ...results, times: { ...times, saved: Date.now() }, warnings: Object.fromEntries(s.warnings), slow: s.slow }, null, 1));
  if (s.debugLines.length) writeFileSync(`${out}/virgl-debug.txt`, s.debugLines.join('\n') + '\n');
};

if (!FROM) await setUp();
else results.info = await run('uname -r; free -m | head -2 | tail -1');
if (TAILCAT) {
  // The guest on IPv4 only: the exit node's machine has no IPv6 route out, and the guest's lease is IPv6 first.
  let addr = '';
  for (let i = 0; i < 30 && !/\d+\.\d+\.\d+\.\d+/.test(addr); i++) { addr = await run("ip -4 -br addr | grep -v '^lo' | awk '{print $3}'"); if (!addr) await page.waitForTimeout(2000); }
  await run("ip -6 route del default 2>/dev/null; rm -f /etc/resolv.conf; echo 'nameserver 1.1.1.1' > /etc/resolv.conf; grep -q '::ffff:0:0/96' /etc/gai.conf 2>/dev/null || echo 'precedence ::ffff:0:0/96 100' >> /etc/gai.conf");
  const check = await run("curl -4 -sS -o /dev/null -m 30 -w 'http %{http_code} in %{time_total}s' https://www.youtube.com/ 2>&1 | tail -1", 60_000);
  results.net = { addr, check };
  log('net', addr, check);
  if (!/http [23]\d\d/.test(check)) throw new Error(`the guest isn't online through tailcat: ${addr} ${check}`);
}
times.setUp = Date.now();
/** The root shell, the pages, the profile and Firefox's helpers in the guest, then sway: what a snapshot already has. */
async function setUp() {
  await rootShell();
  // The pages and the profile, in the guest.
  const dir = new URL('firefox/', import.meta.url);
  const prefs = (process.env.FF_PREFS ?? '').split(',').filter(Boolean).map((p) => {
    const [k, v] = p.split('=');
    return `user_pref("${k}", ${/^(true|false|-?\d+)$/.test(v) ? v : JSON.stringify(v)});`;
  });
  const files: [string, string][] = [['bench.js', 'bench.js'], ['scroll.html', 'scroll.html'], ['webgl.html', 'webgl.html'], ['churn.html', 'churn.html'], ['user.js', 'profile/user.js']];
  await onSerial(`clear; rm -rf ${HOME}/ffbench; mkdir -p ${HOME}/ffbench/profile\n`);
  for (const [from, to] of files) {
    const text = readFileSync(new URL(from, dir), 'utf8') + (from === 'user.js' ? prefs.join('\n') + '\n' : '');
    await pasteSerial(`cat > ${HOME}/ffbench/${to} <<'EOF'\n${text}EOF`);
  }
  await onSerial(`clear; chown -R ${GUEST_USER}:${GUEST_USER} ${HOME}/ffbench\n`);
  // The autoconfig that summarizes about:support's graphics section (FFBENCH_SUPPORT=<file>).
  for (const [from, to] of [['autoconfig.js', '/usr/lib/firefox/defaults/pref/autoconfig.js'], ['waarm64.cfg', '/usr/lib/firefox/waarm64.cfg']]) {
    await pasteSerial(`cat > ${to} <<'EOF'\n${readFileSync(new URL(from, dir), 'utf8')}EOF`);
  }
  // Firefox started by sway (as the user; `ffrun <url> <tag> [""]`: in kiosk mode unless a third argument replaces it),
  // its stdout in /tmp/ff-<tag>.log; `ffwait <tag>` prints the seconds until its
  // page says ready (or `timeout`).
  await pasteSerial(String.raw`cat > /root/ff.sh <<'EOF'
ffkill() { pkill -x firefox; for i in $(seq 60); do pgrep -x firefox >/dev/null || return 0; sleep 1; done; pkill -9 -x firefox; sleep 2; }
ffrun() { k=--kiosk; [ $# -ge 3 ] && k=$3; rm -f /tmp/ff-$2.log; date +%s.%N > /tmp/ff-$2.t0; su ${GUEST_USER} -c "swaymsg -s $(ls /run/user/1000/sway-ipc.*.sock) exec 'FFBENCH_SUPPORT=/tmp/ff-$2.support firefox --profile ${HOME}/ffbench/profile $k $1 > /tmp/ff-$2.log 2>&1'" >/dev/null; }
ffwait() { for i in $(seq 600); do grep -q "FFBENCH .* ready" /tmp/ff-$1.log 2>/dev/null && { echo "$(date +%s.%N) $(cat /tmp/ff-$1.t0)" | awk '{printf "started %.1f\n", $1-$2}'; return; }; sleep 0.5; done; echo timeout; }
EOF`);
  results.info = await run('uname -r; pacman -Q firefox sway wlroots0.19 mesa 2>&1 | tr "\\n" " "; free -m | head -2 | tail -1');
  log('info', results.info);

  // The user's session on the screen.
  results.sway = await s.startSway(mode === 'pixman' ? 'pixman' : 'gles2');
  log('sway', results.sway);

  // GUEST_CMD: a command run as the user in sway's session (its environment), its output kept (results.cmd).
  if (process.env.GUEST_CMD) {
    await pasteSerial(`cat > /tmp/cmd.sh <<'EOF'\n${process.env.GUEST_CMD}\nEOF`);
    results.cmd = await runLines(s.asUser('sh /tmp/cmd.sh'), 120_000);
    log('cmd', (results.cmd as string[]).join('\n'));
    save();
  }
}

if (SAVE) {
  // The warm snapshots: Firefox started on a page, WARM_S after it said ready, saved; the pages session's first, then the WebGL page's.
  mkdirSync(SAVE, { recursive: true });
  const made: Record<string, unknown> = {};
  for (const [scene, tag, url] of [['pages', 'still', `file://${HOME}/ffbench/scroll.html?still`], ['webgl', 'webgl', `file://${HOME}/ffbench/webgl.html`]]) {
    await run('. /root/ff.sh; ffkill', 120_000);
    await run(`. /root/ff.sh; ffrun ${url} ${tag}`);
    const started = await run(`. /root/ff.sh; ffwait ${tag}`, 330_000);
    log(scene, started);
    await page.waitForTimeout(WARM_S * 1000);
    await run('clear');
    made[scene] = await saveSnapshotFile(page, `${SAVE}/${scene}.waarm64snap`, { scene, core: process.env.CORE, query: process.env.QUERY, started, warmS: WARM_S, sessionS: Math.round(performance.now() / 1000) });
    log('saved', JSON.stringify(made[scene]));
    // The page keeps a download's Blob for 60 s: the next one beside it would double the renderer's share.
    await page.waitForTimeout(60_000);
  }
  results.saved = made;
  save();
  await s.close();
  process.exit(0);
}

/** Firefox on `url`, waited for (its page's `ready`, or 5 minutes), measured over a phase. */
const firefox = async (tag: string, url: string) => {
  // From a snapshot with Firefox on this page (webgl.waarm64snap): that Firefox, its t=0 put on the host's clock from its last second.
  const lastT = FROM ? Number(/t=(\d+)/.exec(await run(`pgrep -x firefox >/dev/null && grep FFBENCH /tmp/ff-${tag}.log 2>/dev/null | grep frames= | tail -1`))?.[1] ?? NaN) : NaN;
  const reused = Number.isFinite(lastT);
  if (!reused) {
    await run('. /root/ff.sh; ffkill', 120_000);
    await run(`. /root/ff.sh; ffrun ${url} ${tag}`);
  }
  const started = reused ? `restored at t=${lastT}` : await run(`. /root/ff.sh; ffwait ${tag}`, 330_000);
  const readyAt = Date.now() - (reused ? lastT * 1000 : 0); // ~bench.js's t=0 on the host's clock, as the pages'
  log(tag, started);
  await page.waitForTimeout(WARM_S * 1000);
  const r = await load(tag, PHASE_S, around());
  const ff = await run(`grep FFBENCH /tmp/ff-${tag}.log | grep frames= | tail -${PHASE_S} | sed 's/.*frames=//' | tr "\\n" " "`);
  const fps = [...ff.matchAll(/(\d+) maxms=([\d.]+)/g)].map((x) => ({ frames: +x[1], maxms: +x[2] }));
  const sorted = fps.map((x) => x.frames).sort((a, b) => a - b);
  const all = (await runLines(`grep FFBENCH /tmp/ff-${tag}.log | grep frames= | sed 's/.*t=//'`, 300_000)).join(' ');
  const fpsAll = [...all.matchAll(/(\d+) frames=(\d+) maxms=([\d.]+)/g)].map((x) => [+x[1], +x[2], +x[3]]);
  const rec = { started: +(/started ([\d.]+)/.exec(started)?.[1] ?? NaN), ...(reused ? { restoredAtT: lastT } : {}), fps, medianFps: sorted[sorted.length >> 1], readyAt, fpsAll, ...r, ...(await timeline(tag)) };
  log(tag, 'fps', JSON.stringify(sorted), 'renderer', JSON.stringify(r.display.renderer ?? {}));
  results[tag] = rec;
  save();
};

if (PHASES.includes('still')) await firefox('still', `file://${HOME}/ffbench/scroll.html?still`);
if (PHASES.includes('startup')) {
  // Firefox's start (a profile it has used): its threads and the renderer from launch, for STARTUP_S seconds.
  const secs = Number(process.env.STARTUP_S ?? 30);
  await run('. /root/ff.sh; ffkill', 120_000);
  await run(`. /root/ff.sh; ffrun file://${HOME}/ffbench/scroll.html?still startup`);
  const r = await load('startup', secs);
  const started = await run('. /root/ff.sh; ffwait startup', 330_000);
  results.startup = { started: +(/started ([\d.]+)/.exec(started)?.[1] ?? NaN), ...r };
  log('startup', started, 'renderer', JSON.stringify(r.display.renderer ?? {}));
  save();
}
results.mesa = await run('for p in $(pgrep -f firefox); do grep -q libgallium /proc/$p/maps && echo "$p $(cat /proc/$p/comm) $(ls -l /proc/$p/fd 2>/dev/null | grep -c /dev/dri)"; done | tr "\\n" ";"');
log('mesa', results.mesa);
if (PHASES.includes('scroll')) await firefox('scroll', `file://${HOME}/ffbench/scroll.html`);
if (PHASES.includes('webgl')) await firefox('webgl', `file://${HOME}/ffbench/webgl.html`);
if (PHASES.includes('pages')) {
  // Real sites (bench/gpu/firefox-pages.sh): Firefox started on each (its start and the page's load timed), then
  // scrolled by the mouse's wheel as a user does (Firefox's asynchronous scrolling), measured.
  const list = await runLines('mkdir -p /mnt/ffpages; mount -o ro /dev/vdb /mnt/ffpages 2>/dev/null; cat /mnt/ffpages/pages.txt');
  const box = (await page.locator('#screen').boundingBox())!;
  if (process.env.TIMELINE_ALL) await s.timeline.start();
  for (const line of list.filter(Boolean)) {
    const [name, file] = line.split(' ');
    if (process.env.PAGES && !process.env.PAGES.split(',').includes(name)) continue;
    const tag = `page-${name}`;
    await run('. /root/ff.sh; ffkill', 120_000);
    await run(`. /root/ff.sh; ffrun file:///mnt/ffpages/${file} ${tag}`);
    const started = await run(`. /root/ff.sh; ffwait ${tag}`, 330_000);
    // Firefox never became ready: what it printed last, its processes (state, wait channel) and the kernel's messages.
    if (/timeout/.test(started)) log(tag, 'not ready:', await run(`tail -25 /tmp/ff-${tag}.log; echo ---; ps -eo pid,stat,wchan:24,comm | grep -i -E 'firefox|web|socket|isolated|rdd|utility' | head -20; echo ---; dmesg | tail -15`, 60_000));
    const readyAt = Date.now(); // ~bench.js's t=0 (`ready`), on the host's clock: the timeline's
    const loadMs = Number(/FFBENCH load (\d+)/.exec(await run(`grep "FFBENCH load" /tmp/ff-${tag}.log`))?.[1] ?? NaN);
    log(tag, started, 'load', loadMs);
    await page.waitForTimeout(10_000);
    // Wheel steps of 120 (one notch) every 100 ms, down through the page, as the phase runs.
    let wheeling = false;
    // The pointer over the screen each time (typing the phase's command on the serial terminal clicked it away).
    const wheel = async () => { while (wheeling) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, 120); await page.waitForTimeout(100); } };
    let done: Promise<void> = Promise.resolve();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const r = await load(tag, PHASE_S, around({ start: async () => { if (process.env.PROFILE) await s.sampler.start(); wheeling = true; done = wheel(); }, stop: async () => { wheeling = false; await done; if (process.env.PROFILE) await s.sampler.stop(); } }));
    const profile = process.env.PROFILE ? { profile: await s.symbolize(60, KERNEL_GROUPS) } : {};
    const ff = await run(`grep FFBENCH /tmp/ff-${tag}.log | grep frames= | tail -${PHASE_S} | sed 's/.*frames=//' | tr "\\n" " "`);
    const fps = [...ff.matchAll(/(\d+) maxms=([\d.]+)/g)].map((x) => ({ frames: +x[1], maxms: +x[2] }));
    const sorted = fps.map((x) => x.frames).sort((a, b) => a - b);
    // Every second since the page's start ([t, frames, the longest gap in ms]), to line up with TIMELINE_ALL's rows by `readyAt`.
    const all = (await runLines(`grep FFBENCH /tmp/ff-${tag}.log | grep frames= | sed 's/.*t=//'`, 300_000)).join(' ');
    const fpsAll = [...all.matchAll(/(\d+) frames=(\d+) maxms=([\d.]+)/g)].map((x) => [+x[1], +x[2], +x[3]]);
    results[tag] = { started: +(/started ([\d.]+)/.exec(started)?.[1] ?? NaN), loadMs, fps, medianFps: sorted[sorted.length >> 1], readyAt, fpsAll, ...r, ...profile, ...(await timeline(tag)) };
    log(tag, 'fps', JSON.stringify(sorted), 'flushes', r.display.flushes.toFixed(1));
    save();
  }
  if (process.env.TIMELINE_ALL) {
    await s.timeline.stop();
    results.timelineAll = await s.timelineSummary('pages-all');
    await takeStats();
    save();
  }
}
if (PHASES.includes('churn')) {
  // Code churn (bench/gpu/firefox/churn.html, its query from CHURN: `rate=40` by default): Firefox started on it, the
  // guest left to it for CHURN_S seconds (240) with the vCPU timeline over all of it under TIMELINE_ALL=1. The JIT's
  // counters once a second with JITLOG=1 give the flushes' times (bench/gpu/ab-summary.ts: the first flush, flushes a
  // minute, from the page's `ready`). The page is pasted in each time: a snapshot made before it existed works too.
  const query = process.env.CHURN ?? 'rate=40';
  const secs = Number(process.env.CHURN_S ?? 240);
  await pasteSerial(`cat > ${HOME}/ffbench/churn.html <<'EOF'\n${readFileSync(new URL('firefox/churn.html', import.meta.url), 'utf8')}EOF`);
  await run(`chown ${GUEST_USER}:${GUEST_USER} ${HOME}/ffbench/churn.html`);
  await run('. /root/ff.sh; ffkill', 120_000);
  const startAt = Date.now();
  if (process.env.TIMELINE_ALL) await s.timeline.start();
  await run(`. /root/ff.sh; ffrun file://${HOME}/ffbench/churn.html?q=${encodeURIComponent(query)} churn`);
  const started = await run('. /root/ff.sh; ffwait churn', 330_000);
  const readyAt = Date.now();
  log('churn', started, query);
  const v0 = await s.vmStats();
  // With `total` in the query the work is fixed: the phase ends when the page has made them all (or at CHURN_S), and
  // its time is the result (arms compare flushes over the same work); without, it runs CHURN_S.
  const total = Number(new URLSearchParams(query).get('total') ?? NaN);
  const madeNow = async () => +(/made (\d+)/.exec(await run('grep "FFBENCH made" /tmp/ff-churn.log | tail -1'))?.[1] ?? 0);
  let doneS = NaN;
  if (Number.isFinite(total)) {
    while (Date.now() - readyAt < secs * 1000) {
      await page.waitForTimeout(5000);
      if ((await madeNow()) >= total) { doneS = Math.round((Date.now() - readyAt) / 100) / 10; break; }
    }
  } else await page.waitForTimeout(secs * 1000);
  const v1 = await s.vmStats();
  const made = await run('grep "FFBENCH made" /tmp/ff-churn.log | tail -1');
  const fpsAll = [...(await runLines('grep FFBENCH /tmp/ff-churn.log | grep frames= | sed "s/.*t=//"', 300_000)).join(' ').matchAll(/(\d+) frames=(\d+) maxms=([\d.]+)/g)].map((x) => [+x[1], +x[2], +x[3]]);
  if (process.env.TIMELINE_ALL) {
    await s.timeline.stop();
    results.timelineAll = await s.timelineSummary('churn-all');
  }
  results.churn = { query, seconds: Number.isFinite(doneS) ? doneS : secs, doneS, startAt, readyAt, started: +(/started ([\d.]+)/.exec(started)?.[1] ?? NaN), made: +(/made (\d+)/.exec(made)?.[1] ?? NaN), vm: s.vmDelta(v0, v1), fpsAll };
  await takeStats();
  log('churn', JSON.stringify({ made: (results.churn as { made: number }).made, jit: results.jit }));
  save();
}
if (PHASES.includes('sites')) {
  if (!TAILCAT) throw new Error('PHASES=sites needs TAILCAT (the guest online)');
  const urls = (process.env.SITES ?? 'https://www.youtube.com/watch?v=aqz-KE-bpKQ,https://www.theguardian.com/international,https://edition.cnn.com/,https://www.bbc.com/news,https://excalidraw.com/,https://www.google.com/maps').split(',');
  const dwell = Number(process.env.DWELL_S ?? 20), cycles = Number(process.env.CYCLES ?? 1);
  await pasteSerial(`cat > ${HOME}/ffbench/sites.html <<'EOF'\n${readFileSync(new URL('firefox/sites.html', import.meta.url), 'utf8')}EOF`);
  // Popups from the driver page, autoplay, no IPv6 lookups (appended once: user.js is read at each start).
  const prefs = ['user_pref("dom.disable_open_during_load", false);', 'user_pref("dom.popup_maximum", -1);', 'user_pref("media.autoplay.default", 0);', 'user_pref("network.dns.disableIPv6", true);'];
  await pasteSerial(`grep -q disableIPv6 ${HOME}/ffbench/profile/user.js || cat >> ${HOME}/ffbench/profile/user.js <<'EOF'\n${prefs.join('\n')}\nEOF`);
  await run(`chown -R ${GUEST_USER}:${GUEST_USER} ${HOME}/ffbench`);
  await run('. /root/ff.sh; ffkill', 120_000);
  const startAt = Date.now();
  if (process.env.TIMELINE_ALL) await s.timeline.start();
  await run(`. /root/ff.sh; ffrun file://${HOME}/ffbench/sites.html?q=${encodeURIComponent(new URLSearchParams({ dwell: String(dwell), cycles: String(cycles), urls: urls.join(',') }).toString())} sites`);
  const started = await run('. /root/ff.sh; ffwait sites', 330_000);
  const readyAt = Date.now();
  log('sites', started);
  const total = urls.length * cycles * dwell + 10;
  for (const end = Date.now() + (total + 60) * 1000; Date.now() < end;) {
    await page.waitForTimeout(5000);
    if (/done/.test(await run('grep -c "sites done" /tmp/ff-sites.log | sed "s/^[1-9].*/done/"'))) break;
  }
  const doneAt = Date.now();
  const visits = (await runLines('grep "FFBENCH site " /tmp/ff-sites.log', 120_000)).map((l) => { const m = /site (\d+) (\S+) t=(\d+)/.exec(l); return m ? { n: +m[1], url: m[2], atMs: readyAt + +m[3] } : { line: l }; });
  if (process.env.TIMELINE_ALL) {
    await s.timeline.stop();
    results.timelineAll = await s.timelineSummary('sites-all');
  }
  results.sites = { urls, dwell, cycles, startAt, readyAt, seconds: Math.round((doneAt - readyAt) / 1000), started: +(/started ([\d.]+)/.exec(started)?.[1] ?? NaN), visits, at: new Date(readyAt).toISOString() };
  await takeStats();
  log('sites', JSON.stringify({ visits: visits.length, jit: results.jit }));
  save();
}
if (PHASES.includes('menu')) {
  // A context menu (a popup with rounded corners and a shadow: translucent at its edges), in a normal window (kiosk
  // mode has none); the screen shot with the menu open.
  await run('. /root/ff.sh; ffkill', 120_000);
  await run(`. /root/ff.sh; ffrun file://${HOME}/ffbench/scroll.html?still menu ""`);
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
// The JIT's counters at the phases' end (the pages session took them at its own end).
if (!results.jit) await takeStats();
await run('. /root/ff.sh; ffkill', 120_000);
results.log = await runLines('grep -h -v FFBENCH /tmp/ff-*.log | cut -c1-200 | sort | uniq -c | sort -rn | head -30');
log('firefox stderr', (results.log as string[]).join('\n'));
save();
log('done', JSON.stringify(Object.fromEntries(s.warnings)));
await s.close();
