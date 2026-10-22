// Image decoding on the desktop guest (README.md "On the desktop guest"): Mozilla's Firefox in sway on a 3D machine
// (images/arch/desktop.sh's disk; desktop-disk.sh's second disk, /dev/vdb), showing desktop.html's rounds of photos.
// The host starts each round with an `n` key on the screen and times it to the last frame the screen presents (no
// present for QUIET_MS): decode, scaling, WebRender's upload and the composite, through the renderer to the host's
// canvas. Per case, ROUNDS rounds; during them bench/gpu/guest-session.ts `load` (the guest's threads, the display's
// and the renderer's stats) with the guest PC sampler, its PCs named: the kernel's by kallsyms, Firefox's libxul by
// Mozilla's symbols (desktop-disk.sh's libxul.funcs), other libraries by name and offset. ASLR is off in the guest.
//   timeout 3000 node bench/imgdecode/desktop.ts [fmt:size:width:n ...]   (default webp:480:320:16)
// Env: GUEST_CMD (a command at the root shell instead of the cases), ROUNDS (12), WARM_S (60, after Firefox's page says ready), QUIET_MS (1500), PROFILE=0 (no sampler),
// QUERY (more of the page's query), FF_PREFS (k=v,... added to the profile), OUT (target/imgpipe/out/<time>).
// PROBE=<lib path>:<symbol>: a uprobe counted over the rounds and over 20 s of idle Firefox (needs PERF's packages: PERF=1 or PERF_PKG=1).
// GECKO=1: Firefox's own profiler from its start (every thread's markers and CPU, no stacks unless GECKO_FEATURES says; every GECKO_MS ms, 20, on GECKO_THREADS; the last
// GECKO_KEEP_S s, 90), saved after the rounds by profiler.cfg, fetched as <case>.gecko.json.xz (gecko.py reads it). PERF=1: `perf record -a -g` in the guest over the
// rounds (PERF_HZ, 199), its data fetched as <case>.perf.data with the guest's kallsyms (perf script on the host reads it).
// Files come out of the guest as base64 on the serial console (the page's serial log).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { GUEST_USER, openSession } from '../gpu/guest-session.ts';

const cases = process.argv.slice(2).length ? process.argv.slice(2) : ['webp:480:320:16'];
const ROUNDS = Number(process.env.ROUNDS ?? 12), WARM_S = Number(process.env.WARM_S ?? 60), QUIET_MS = Number(process.env.QUIET_MS ?? 1500);
const out = process.env.OUT ?? `target/imgpipe/out/${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(out, { recursive: true });
const HOME = `/home/${GUEST_USER}`;
const s = await openSession({ gpu: 'virgl', image: 'target/arch/desktop.qcow2', out, disk2: '/target/imgpipe/disk.ext4', query: process.env.QUERY });
const { page, log, run, runLines, pasteSerial, onSerial } = s;
const GECKO = !!process.env.GECKO, PERF = !!process.env.PERF;
const results: Record<string, unknown> = { chromium: s.browser.version(), gl: s.gl, cases: {} };
const save = () => writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 1));

await s.rootShell();
await keyProbe('root shell');
// GUEST_CMD: only that command at the root shell (with /dev/vdb at /mnt/i), its output printed, then the end.
if (process.env.GUEST_CMD) {
  log('cmd', await run('mkdir -p /mnt/i; mount -o ro /dev/vdb /mnt/i; ' + process.env.GUEST_CMD, 600_000));
  await s.close();
  process.exit(0);
}
results.info = await run('echo 0 > /proc/sys/kernel/randomize_va_space; sysctl -qw kernel.kptr_restrict=0; mkdir -p /mnt/i; mount -o ro /dev/vdb /mnt/i; uname -r; pacman -Q sway mesa | tr "\\n" " "');
const prefs = (process.env.FF_PREFS ?? '').split(',').filter(Boolean).map((p) => {
  const [k, v] = p.split('=');
  return `user_pref("${k}", ${/^(true|false|-?\d+)$/.test(v) ? v : JSON.stringify(v)});`;
});
await onSerial(`clear; rm -rf ${HOME}/ffimg; mkdir -p ${HOME}/ffimg/profile; cp /mnt/i/user.js ${HOME}/ffimg/profile/\n`);
if (prefs.length) await pasteSerial(`cat >> ${HOME}/ffimg/profile/user.js <<'EOF'\n${prefs.join('\n')}\nEOF`);
await onSerial(`clear; chown -R ${GUEST_USER}:${GUEST_USER} ${HOME}/ffimg\n`);
if (PERF || process.env.PERF_PKG) results.perf = await run('pacman -U --noconfirm --needed /mnt/i/pkg/*.pkg.tar.zst >/tmp/pacman.log 2>&1; echo -1 > /proc/sys/kernel/perf_event_paranoid; perf --version', 600_000);
results.sway = await s.startSway('gles2');
await keyProbe('sway');
/** The guest's wall clock against the host's: the guest prints its time on the serial console every 100 ms; the
 * smallest (host's arrival - guest's time) bounds the offset plus the console's latency (desktop.html's Date.now()
 * then maps onto the host's axis). */
const clockOffset = async () => {
  await onSerial('clear; for i in $(seq 40); do echo CLK$(date +%s%3N); sleep 0.1; done\n');
  const seen = new Map<string, number>();
  for (const end = Date.now() + 15_000; Date.now() < end && seen.size < 40;) {
    const [l, now] = await page.evaluate(() => [(window as unknown as SerialLog).__serialLog().slice(-8000), performance.timeOrigin + performance.now()] as const);
    for (const m of l.matchAll(/CLK(\d{13})/g)) if (!seen.has(m[1])) seen.set(m[1], now);
    await page.waitForTimeout(20);
  }
  return Math.min(...[...seen].map(([g, h]) => h - Number(g)));
};
results.clockOffsetMs = await clockOffset();
log('clock: host - guest <=', results.clockOffsetMs, 'ms');
log('sway', results.sway);

/** A Shift press and release on the screen: ms from its dispatch to the device worker's injecting it into the guest
 * (the device's `key` events), and the device worker's event loop lag over the last stats seconds. */
async function keyProbe(label: string) {
  const r: number[] = [];
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => ((window as unknown as { __devEvents?: number[] }).__devEvents ?? []).splice(0));
    const t0 = await page.evaluate(() => {
      const el = document.getElementById('screen')!;
      const t = performance.timeOrigin + performance.now();
      for (const type of ['keydown', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { code: 'ShiftLeft', key: 'Shift', bubbles: true }));
      return t;
    });
    let d = NaN;
    for (const end = Date.now() + 15_000; Date.now() < end && Number.isNaN(d);) {
      await page.waitForTimeout(250);
      const ev = await page.evaluate(() => (window as unknown as { __devEvents?: number[] }).__devEvents ?? []);
      for (let k = 0; k < ev.length; k += 2) if (ev[k + 1] === 1 && ev[k] >= t0 - 5) { d = Math.round(ev[k] - t0); break; }
    }
    r.push(d);
    await page.waitForTimeout(1500);
  }
  const lags = await page.evaluate(() => ((window as unknown as { __drawStats?: { lag: number }[] }).__drawStats ?? []).slice(-5).map((x) => Math.round(x.lag)));
  log('key probe', label, JSON.stringify(r), 'device worker lag ms (last 5 s)', JSON.stringify(lags));
  ((results.keyProbe ??= {}) as Record<string, unknown>)[label] = { ms: r, lags };
}

/** Each round: an `n` on the screen (dispatched to the screen's element: `load` types on the serial terminal meanwhile),
 * then the last present after it once QUIET_MS pass with none (the presents come in batches a second). Every time is
 * the page's and its workers' `performance.timeOrigin + now()`: never Date.now(), which the dev VM's unsynchronized
 * wall clock lets drift ~1% from the monotonic clock (the first version's rounds grew 11 ms a second of session).
 * `ms` is from the dispatch, `keyMs` from the device worker's injecting the key into the guest. */
type W = { __presents?: number[] };
const roundsOf = async (n: number, key = 'n') => {
  const rs: { t0: number; ms: number; keyMs: number; presents: number; at: number[]; ev: [number, string][] }[] = [];
  const NAMES: Record<number, string> = { 1: 'key', 0x104: 'flush', 0x207: 'submit', 0x204: 'create3d', 0x106: 'attach', 0x102: 'unref', 0x103: 'scanout', 0x10104: 'flush-reply', 0x10207: 'submit-reply' };
  for (let k = 0; k < n; k++) {
    const t0 = await page.evaluate((key) => {
      const el = document.getElementById('screen')!;
      const t = performance.timeOrigin + performance.now();
      for (const type of ['keydown', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { code: key === 'n' ? 'KeyN' : 'Digit0', key, bubbles: true }));
      return t;
    }, key);
    let last = t0, n = 0;
    const at: number[] = [];
    for (;;) {
      await page.waitForTimeout(200);
      const [ps, now] = await page.evaluate(() => [((window as unknown as W).__presents ?? []).splice(0), performance.timeOrigin + performance.now()] as const);
      for (const p of ps) if (p > t0) { n++; last = Math.max(last, p); at.push(Math.round(p - t0)); }
      if (n && now - last > QUIET_MS + 1100) break;
      if (!n && now - t0 > 20_000) break; // the key didn't reach the page
      if (now - t0 > 120_000) break;
    }
    // The device's events in the round (web/gpu.ts `busy.events`: they come a second at a time).
    await page.waitForTimeout(1200);
    const evs = await page.evaluate(() => ((window as unknown as { __devEvents?: number[] }).__devEvents ?? []).splice(0));
    const ev: [number, string][] = [];
    for (let i = 0; i < evs.length; i += 2) if (evs[i] > t0 - 50) ev.push([Math.round(evs[i] - t0), NAMES[evs[i + 1]] ?? evs[i + 1].toString(16)]);
    const key0 = ev.find(([, w]) => w === 'key')?.[0];
    rs.push({ t0, ms: Math.round(last - t0), keyMs: key0 === undefined ? NaN : Math.round(last - t0 - key0), presents: n, at, ev });
  }
  return rs;
};

/** A guest file, through the serial console as base64, in pieces of 600 KB (the page keeps the last 1-2 MB of the console's log). */
type SerialLog = { __serialLog: () => string };
const fetchFile = async (path: string) => {
  const n = Number(await run(`rm -f /tmp/fx.*; split -b 600000 -d -a 4 ${path} /tmp/fx.; ls /tmp/fx.* | wc -l`));
  const t0 = Date.now(), parts: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const m = `F${Date.now()}`;
    await onSerial(`clear; echo ${m}-be""gin; base64 -w 0 /tmp/fx.${String(i).padStart(4, '0')}; echo; echo ${m}-e""nd\n`);
    for (const end = Date.now() + 300_000; ;) {
      await page.waitForTimeout(500);
      const l = await page.evaluate((m) => { const t = (window as unknown as SerialLog).__serialLog(); const i = t.lastIndexOf(`${m}-begin`), j = t.lastIndexOf(`${m}-end`); return i >= 0 && j > i ? t.slice(i + m.length + 6, j) : ''; }, m);
      if (l) { parts.push(Buffer.from(l.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')); break; }
      if (Date.now() > end) throw new Error(`${path}'s piece ${i} didn't come through the serial console`);
    }
  }
  const b = Buffer.concat(parts);
  log('fetched', path, Math.round(b.length / 1024), 'KiB in', ((Date.now() - t0) / 1000).toFixed(0), 's');
  return b;
};

/** Executable mappings of every process (deduplicated), and each file's base (its offset-0 mapping). */
const mappings = async () => {
  const lines = await runLines("cat /proc/[0-9]*/maps 2>/dev/null | awk '$6 ~ /^\\// && ($2 ~ /x/ || $3 == \"00000000\") {print $1, $2, $3, $6}' | sort -u");
  const files = new Map<string, { base: bigint; x: [bigint, bigint][] }>();
  for (const l of lines) {
    const [range, perm, off, path] = l.split(' ');
    if (!path) continue;
    const [a, b] = range.split('-').map((x) => BigInt(`0x${x}`));
    const f = files.get(path) ?? { base: -1n, x: [] };
    if (off === '00000000') {
      if (f.base >= 0n && a !== f.base && path.endsWith('libxul.so')) log('warning: libxul at two bases', f.base.toString(16), a.toString(16), '(its PCs are named from the lower)');
      if (f.base < 0n || a < f.base) f.base = a;
    }
    if (perm.includes('x')) f.x.push([a, b]);
    files.set(path, f);
  }
  return files;
};
let xul: { a: number; size: number; name: string }[] | undefined;
const xulSym = (rel: number) => {
  xul ??= readFileSync('target/imgpipe/libxul.funcs', 'utf8').split('\n').filter(Boolean).map((l) => {
    const i = l.indexOf(' '), j = l.indexOf(' ', i + 1);
    return { a: parseInt(l.slice(0, i), 16), size: parseInt(l.slice(i + 1, j), 16), name: l.slice(j + 1) };
  }).sort((x, y) => x.a - y.a);
  let lo = 0, hi = xul.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (xul[m].a <= rel) lo = m; else hi = m - 1; }
  return xul[lo] && xul[lo].a <= rel ? xul[lo].name : '?';
};
/** The user PCs by function (libxul) or library+offset (4 KiB granules elsewhere), and by library. */
const userProfile = async () => {
  const samples = await page.evaluate(() => (window as unknown as { __profile?: [string, number][] }).__profile ?? []);
  const files = await mappings();
  const fx = [...files.entries()].flatMap(([path, f]) => f.x.map(([a, b]) => ({ path, a, b, base: f.base })));
  let total = 0, user = 0, unmapped = 0;
  const byLib = new Map<string, number>(), byFn = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);
  for (const [pcs, n] of samples) {
    total += n;
    const pc = BigInt(`0x${pcs}`);
    if (pc >= 0xffff000000000000n) continue;
    user += n;
    const hits = fx.filter((m) => pc >= m.a && pc < m.b);
    if (!hits.length) { unmapped += n; add(byLib, '(unmapped: JIT code or anonymous)', n); continue; }
    const m = hits[0];
    const lib = m.path.split('/').pop()! + (new Set(hits.map((h) => `${h.path} ${h.base}`)).size > 1 ? ' (ambiguous)' : '');
    add(byLib, lib, n);
    const rel = Number(pc - m.base);
    add(byFn, lib === 'libxul.so' ? `xul ${xulSym(rel)}` : `${lib}+0x${(rel & ~0xfff).toString(16)}`, n);
  }
  const top = (m: Map<string, number>, k: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([name, n]) => ({ name, n, pct: +((100 * n) / total).toFixed(2) }));
  return { total, userPct: +((100 * user) / total).toFixed(1), unmapped, libs: top(byLib, 40), fns: top(byFn, 600) };
};

for (const c of cases) {
  const [fmt, size, w, n] = c.split(':');
  const url = `file:///mnt/i/desktop.html?fmt=${fmt}&size=${size}&w=${w}&n=${n}`;
  // Mozilla's build runs as firefox-bin (a launch beside a running one only hands it the URL).
  await run('pkill -x firefox-bin; for i in $(seq 30); do pgrep -x firefox-bin >/dev/null || break; sleep 1; done; pkill -9 -x firefox-bin; sleep 1; true', 60_000);
  const env = GECKO ? `MOZ_PROFILER_STARTUP=1 MOZ_PROFILER_STARTUP_INTERVAL=${process.env.GECKO_MS ?? 20} MOZ_PROFILER_STARTUP_DURATION=${process.env.GECKO_KEEP_S ?? 90} MOZ_PROFILER_STARTUP_FILTERS=${process.env.GECKO_THREADS ?? 'GeckoMain,Renderer,WRRenderBackend,WRSceneBuilder,Compositor,TaskController,ImageIO,Canvas'} MOZ_PROFILER_STARTUP_FEATURES=${process.env.GECKO_FEATURES ?? 'markersallthreads,processcpu,nostacksampling,nomarkerstacks'} FFBENCH_DUMP=/tmp/ffprof.json ` : '';
  // Started by sway from a script: sway's command parser splits on commas.
  // With the sampler, no fork server: its children map libxul 8 MB from the parent's base (PCs carry no process), while
  // processes exec'd afresh map it where the parent does (ASLR is off).
  const fork = process.env.PROFILE === '0' ? '' : 'MOZ_DISABLE_FORKSERVER=1 ';
  await pasteSerial(`cat > /tmp/ffrun.sh <<'EOF'\n${fork}${env}FFBENCH_SUPPORT=/tmp/ff.support exec /mnt/i/firefox/firefox --profile ${HOME}/ffimg/profile --kiosk '${url}' > /tmp/ff.log 2>&1\nEOF`);
  await run(`rm -f /tmp/ff.log /tmp/ffprof.json*; su ${GUEST_USER} -c "swaymsg -s $(ls /run/user/1000/sway-ipc.*.sock) exec 'sh /tmp/ffrun.sh'" >/dev/null`);
  const t0 = Date.now();
  for (;;) {
    if ((await run('grep -c "FFBENCH imgdecode ready" /tmp/ff.log 2>/dev/null')).trim() === '1') break;
    if (Date.now() - t0 > 300_000) throw new Error(`Firefox didn't start: ${await run('tail -5 /tmp/ff.log')}`);
    await page.waitForTimeout(2000);
  }
  log(c, 'ready after', ((Date.now() - t0) / 1000).toFixed(0), 's; warming', WARM_S, 's');
  await keyProbe('firefox ready');
  await page.waitForTimeout(WARM_S * 1000);
  await keyProbe('firefox warm');
  await page.locator('#screen').screenshot({ path: `${out}/${c.replace(/:/g, '-')}-ready.png` });
  // The baseline: a key that changes only the round's number on the page (key to screen, no image).
  const base = await roundsOf(Math.max(4, ROUNDS >> 1), '0');
  const bms = base.map((r) => r.ms).sort((a, b) => a - b);
  log(c, 'baseline (key to screen) ms', JSON.stringify(bms), 'from the key in the device', JSON.stringify(base.map((r) => r.keyMs)));
  await roundsOf(2); // the first decodes of a format load its decoder's code: not timed
  let rounds: Awaited<ReturnType<typeof roundsOf>> = [];
  const during = process.env.PROFILE === '0' ? undefined : s.sampler;
  const t1 = Date.now();
  // The load phase covers the rounds; its time is a guess at them, the rounds go on until done.
  const est = Math.max(10, Math.round((ROUNDS * (QUIET_MS + 1100 + 3000)) / 1000));
  // PROBE=<lib>:<symbol>: a uprobe on it, counted over the rounds (`perf stat -a`), and over as long with Firefox idle after them.
  const PROBE = process.env.PROBE;
  if (PROBE) {
    const [lib, sym] = PROBE.split(':');
    log('probe', await run(`perf probe -q -d 'probe_*:*' 2>/dev/null; perf probe -x ${lib} --add ${sym} 2>&1 | tail -2; perf list 'probe_*:*' 2>/dev/null | grep probe_ | head -2`, 120_000));
    await run(`(perf stat -a -x, -e 'probe_*:*' -o /tmp/probe-rounds.txt -- sleep ${est + 5} > /dev/null 2>&1 &)`);
  }
  if (PERF) await run(`(perf record -a -g -F ${process.env.PERF_HZ ?? 199} -o /tmp/perf.data -- sleep ${est + 5} > /tmp/perf.log 2>&1 &)`);
  const roundsDone = roundsOf(ROUNDS).then((r) => { rounds = r; });
  const loadRec = await s.load(c.replace(/:/g, '-'), est, during);
  await roundsDone;
  const wall = (Date.now() - t1) / 1000;
  await keyProbe('after rounds');
  if (PROBE) {
    await run('while pgrep -x perf >/dev/null; do sleep 1; done', 300_000);
    const idle = await run(`perf stat -a -x, -e 'probe_*:*' -o /tmp/probe-idle.txt -- sleep 20 >/dev/null 2>&1; cat /tmp/probe-idle.txt | grep -v '^#' | grep .`, 120_000);
    const busy = await run(`cat /tmp/probe-rounds.txt | grep -v '^#' | grep .`);
    log('probe counts: rounds', busy, `(${est + 5} s); idle Firefox`, idle, '(20 s)');
    results.probe = { rounds: busy, roundsS: est + 5, idle, idleS: 20 };
  }
  const ms = rounds.map((r) => r.ms).sort((a, b) => a - b);
  const rec: Record<string, unknown> = { url, baseline: base, baselineMedianMs: bms[bms.length >> 1], rounds, medianMs: ms[ms.length >> 1], p10: ms[Math.floor(ms.length / 10)], p90: ms[Math.floor((ms.length * 9) / 10)], wallS: wall, load: loadRec };
  log(c, 'round ms', JSON.stringify(ms), 'median', rec.medianMs, 'from the key in the device', JSON.stringify(rounds.map((r) => r.keyMs)));
  if (during) {
    rec.kernel = await s.symbolize(60);
    rec.user = await userProfile();
    log(c, 'user', JSON.stringify((rec.user as { libs: unknown[] }).libs.slice(0, 10)));
  }
  const tag = c.replace(/:/g, '-');
  rec.guestTimes = await runLines('grep "^IMG" /tmp/ff.log | tail -' + 2 * ROUNDS);
  if (PERF) {
    await run('while pgrep -x perf >/dev/null; do sleep 1; done; tail -2 /tmp/perf.log', 300_000);
    await run('xz -T4 -3 -k -f /tmp/perf.data; cat /proc/kallsyms | xz -T4 -3 > /tmp/kallsyms.xz; ls -l /tmp/perf.data*', 600_000);
    writeFileSync(`${out}/${tag}.perf.data.xz`, await fetchFile('/tmp/perf.data.xz'));
    writeFileSync(`${out}/${tag}.kallsyms.xz`, await fetchFile('/tmp/kallsyms.xz'));
  }
  rec.support = await runLines('cat /tmp/ff.support 2>/dev/null | grep -E "^(feature|webgl|Window|AzureCanvas|isHeadless|supportsHardwareH264|compositor|Adapter|Driver)" | head -40');
  (results.cases as Record<string, unknown>)[c] = rec;
  save();
  if (GECKO) {
    // profiler.cfg in Firefox's autoconfig saves the profile when asked (a release build writes no shutdown profile).
    log('profile', await run('touch /tmp/ffprof.json.go; for i in $(seq 280); do [ -f /tmp/ffprof.json.done ] && break; sleep 1; done; cat /tmp/ffprof.json.done; ls -l /tmp/ffprof.json', 300_000));
    await run('xz -T4 -6 /tmp/ffprof.json; ls -l /tmp/ffprof.json.xz', 600_000);
    writeFileSync(`${out}/${tag}.gecko.json.xz`, await fetchFile('/tmp/ffprof.json.xz'));
  }
}
await s.close();
log('done', out);
process.exit(0);
