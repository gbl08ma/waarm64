// A UEFI disk image on the page under load (dev-only, not in tests): what bench/gpu/sway-load.ts and
// bench/gpu/firefox-load.ts share. Headless Chromium, the page with `?displaystats`, a disk opened from a file, root
// on the serial terminal, keys typed on the screen, and `load()`: a phase measured over N s on both sides (the guest's
// /proc/stat and per-thread CPU, the display's and the renderer's stats, the emulator's counters).
import { appendFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { chromiumEnv } from '../../tools/nosme.ts';
import { chromium, type Page } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';
import type { VideoStats } from '../../web/virgl-video.ts';
import { SYSCALLS } from './arm64-syscalls.ts';
import type { Timeline } from '../../web/profiler.ts';
import { answerAsks } from '../../tests/page-ask.ts';
import { loadSnapshotFile, routeCore, sessionTag } from '../snapshot-start.ts';
import { rendererPid, smapsClasses, uasm } from '../mem/probe.ts';

const SETTINGS_KEY = 'webpc.settings';
/** The guest's desktop user: images/arch/desktop.sh's `arch` (password the same); `alarm` for an Arch Linux ARM disk. */
export const GUEST_USER = process.env.WEBPC_GUEST_USER ?? 'arch';

export type SessionOptions = {
  /** The page's `?gpu=` (`virgl`, `virgl-null`, `2d`, with `,capture`). */
  gpu: string;
  image: string;
  out: string;
  /** The screen's fixed size, as the page's Size menu stores it. */
  screen?: string;
  ncpus?: number;
  ramMiB?: number;
  /** The page's `?disk2=` (a read-only second disk, /dev/vdb); the image is then opened by its URL (`?disk=`): a file opened makes a stored machine, which has no `?disk2=`. */
  disk2?: string;
  /** More of the page's query (e.g. `snd=&avprobe`: bench/audio/avsync.ts). */
  query?: string;
  /** The image opened by its URL (`?disk=`) even without `disk2`: a machine that isn't stored, whose snapshots are files (bench/gpu/snapshot-3d.ts). */
  byUrl?: boolean;
  /** A snapshot file to start from instead of a boot (bench/snapshot-start.ts; the image is then opened by its URL, as when the file was saved). */
  snapshot?: string;
  /** Another core build served as the page's (bench/snapshot-start.ts `routeCore`); default target/'s. */
  core?: string;
  /** A tailcat exit node's address (tests/net/tailcat.sh's WEBPC_TAILCAT_ADDR): the machine's adapter connected to it
   * once it runs (the Network wizard, an ephemeral connection), so the guest reaches the internet. Benchmarks only. */
  tailcat?: string;
};

type Stat = { n: number; lag: number; busy: Record<string, number> & { commands?: Record<string, number>; fenceBack?: { n: number; ms: number; maxMs: number } } };
/** virtio-gpu's control commands by type. */
const COMMANDS: Record<string, string> = { 100: 'GET_DISPLAY_INFO', 101: 'RESOURCE_CREATE_2D', 102: 'RESOURCE_UNREF', 103: 'SET_SCANOUT', 104: 'RESOURCE_FLUSH', 105: 'TRANSFER_TO_HOST_2D', 106: 'ATTACH_BACKING', 107: 'DETACH_BACKING', 108: 'GET_CAPSET_INFO', 109: 'GET_CAPSET', '10a': 'GET_EDID', 200: 'CTX_CREATE', 201: 'CTX_DESTROY', 202: 'CTX_ATTACH_RESOURCE', 203: 'CTX_DETACH_RESOURCE', 204: 'RESOURCE_CREATE_3D', 205: 'TRANSFER_TO_HOST_3D', 206: 'TRANSFER_FROM_HOST_3D', 207: 'SUBMIT_3D' };
type Video = VideoStats & { ahead: number; maxWaitMs: number };
type VmStats = { steps: number; irqs: number; exceptions: Record<string, number>; tlbMisses: number; tlbFlushes: number; jit: { flushes: number; invalidations: number; compileNs: number } };
type VmStatus = { uptime: number; stats: VmStats };

/** The guest's load script (/root/load.sh <secs> <mark> [sys]), over `secs`: /proc/stat's busy, user and system percent
 * per CPU (and the CPUs' I/O wait) on the terminal; in /tmp/load.out, every process's ms of CPU a second (its
 * /proc/<pid>/stat, so threads that exited count) with its live threads' runs and run-queue wait, and every thread
 * that used at least 2 ms a second (/proc/<pid>/task/<tid>/stat's user and system ticks of 10 ms; schedstat's ns on
 * the CPU, ns waiting to run and runs), as
 *   P <process> cpu <ms> user <ms> sys <ms> threads <n> runs <n> wait <ms>
 *   T <process>/<thread> cpu <ms> user <ms> sys <ms> runs <n> wait <ms>
 * (a second each; spaces in names as `_`; read through grep, which goes on past a thread that exits mid-read where
 * awk stops); with `sys`, the syscalls (Arch's kernel has no syscall tracepoints: a kprobe event on do_el0_svc, the
 * number from regs[8], into a 16 MiB-a-CPU ring buffer) as `S <process>/<thread> <nr> <n>` (the top 60), `Y <nr> <n>`
 * and `Q <process> <n>` a second, and `O <events lost>` (the buffer's overruns). */
const LOAD_SH = String.raw`snap() { grep -H '' /proc/[0-9]*/stat /proc/[0-9]*/task/[0-9]*/stat /proc/[0-9]*/task/[0-9]*/schedstat 2>/dev/null | awk '{i=index($0,":"); split(substr($0,1,i-1),p,"/"); $0=substr($0,i+1); k=p[4]=="task"?(p[6]=="stat"?"T":"R"):"P"}
k=="R"{print "R", p[5], $1, $2, $3; next}
{c=$0; sub(/^[0-9]+ \(/,"",c); n=c; sub(/\) [^)]*$/,"",n); sub(/^.*\) /,"",c); split(c,f," "); gsub(/ /,"_",n); print k, k=="T"?p[5]:p[3], p[3], n, f[12], f[13]}'; }
K=/sys/kernel/tracing
[ "$3" = sys ] && { echo 'p:webpc/sc do_el0_svc nr=+64(%x0):u32' >> $K/kprobe_events; echo 16384 > $K/buffer_size_kb; echo > $K/trace; }
snap > /tmp/pa; cat /proc/stat > /tmp/a
[ "$3" = sys ] && echo 1 > $K/events/webpc/sc/enable
sleep $1
[ "$3" = sys ] && echo 0 > $K/events/webpc/sc/enable
cat /proc/stat > /tmp/b; snap > /tmp/pb
[ "$3" = sys ] && { cat $K/per_cpu/cpu*/stats | awk '/^overrun/{o+=$2} END{print "O", o}' > /tmp/sc.out; awk '/ sc: /{t=$0; sub(/ +\[[0-9]+\].*/,"",t); sub(/^.*-/,"",t); n=$NF; sub(/^nr=/,"",n); print t, n}' $K/trace >> /tmp/sc.out; echo 1408 > $K/buffer_size_kb; echo '-:webpc/sc' >> $K/kprobe_events; }
awk -v s=$1 '
NR==FNR{ if($1=="R"){r0[$2]=$3; w0[$2]=$4; n0[$2]=$5} else {u0[$1,$2]=$5; k0[$1,$2]=$6}; next }
$1=="P"{ if(($1,$2) in u0){pn[$2]=$4; pu[$2]=($5-u0["P",$2])*10/s; ps[$2]=($6-k0["P",$2])*10/s}; next }
$1=="T"{ tp[$2]=$3; tn[$2]=$4; if(($1,$2) in u0){tu[$2]=($5-u0["T",$2])*10/s; ts[$2]=($6-k0["T",$2])*10/s}; next }
$1=="R"{ if($2 in r0){rr[$2]=($3-r0[$2])/1e6/s; rw[$2]=($4-w0[$2])/1e6/s; rn[$2]=($5-n0[$2])/s}; next }
END{
  for(t in tp){p=tp[t]; nt[p]++; pr[p]+=rn[t]; pw[p]+=rw[t]}
  for(p in pn) if(pu[p]+ps[p]>=1) printf "P %s cpu %d user %d sys %d threads %d runs %d wait %d\n", pn[p], pu[p]+ps[p], pu[p], ps[p], nt[p], pr[p], pw[p] | "sort -k4 -rn"
  close("sort -k4 -rn")
  for(t in tp) if(rr[t]>=2) printf "T %s/%s cpu %d user %d sys %d runs %d wait %d\n", pn[tp[t]]?pn[tp[t]]:tp[t], tn[t], rr[t], tu[t], ts[t], rn[t], rw[t] | "sort -k4 -rn"
}' /tmp/pa /tmp/pb > /tmp/load.out
[ "$3" = sys ] && awk -v s=$1 'NR==FNR{if($1=="T"){tp[$2]=$3; tn[$2]=$4} if($1=="P") pn[$2]=$4; next}
$1=="O"{print "O", $2; next}
{ t=$1; c=$2; p=t in tp?(pn[tp[t]]?pn[tp[t]]:tp[t]):"?"; th=t in tn?tn[t]:t; st[p "/" th " " c]+=1/s; sy[c]+=1/s; sp[p]+=1/s }
END{ for(x in st) printf "S %s %d\n", x, st[x] | "sort -k4 -rn | head -60"; close("sort -k4 -rn | head -60")
  for(x in sy) if(sy[x]>=1) printf "Y %s %d\n", x, sy[x] | "sort -k3 -rn"; close("sort -k3 -rn")
  for(x in sp) if(sp[x]>=1) printf "Q %s %d\n", x, sp[x] | "sort -k3 -rn" }' /tmp/pb /tmp/sc.out >> /tmp/load.out
awk -v m=$2 'NR==FNR&&/^cpu/{for(i=2;i<=9;i++)a[$1,i]=$i;next} /^cpu/{t=0;for(i=2;i<=9;i++){d[i]=$i-a[$1,i];t+=d[i]}; printf "%s %s busy %d user %d sys %d iowait %d\n",m,$1,100*(t-d[5]-d[6])/t,100*(d[2]+d[3])/t,100*(d[4]+d[7]+d[8])/t,100*d[6]/t}' /tmp/a /tmp/b
echo $2-done
`;

export async function openSession(o: SessionOptions) {
  const server = await startServer();
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // HEADED=1: a visible window (only on the Mac host, where the user allows it: never on the dev VM).
  // CHROMIUM_ARGS: extra flags (e.g. `--mute-audio` on the Mac host: its sound still renders and keeps time, unheard).
  // CHROMIUM_JS_FLAGS: V8's flags, spaces and all (`--js-flags`; e.g. `--perf-basic-prof --perf-basic-prof-path=<dir>`).
  // A 3D machine decodes its guest's video with WebCodecs: SME hidden where the CPU needs it (tools/nosme.ts).
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: !process.env.HEADED, downloadsPath: process.env.WEBPC_DOWNLOADS, args: [...(process.env.CHROMIUM_ARGS?.split(' ').filter(Boolean) ?? []), ...(process.env.CHROMIUM_JS_FLAGS ? [`--js-flags=${process.env.CHROMIUM_JS_FLAGS}`] : [])], env: chromiumEnv() });
  const page: Page = await (await browser.newContext({ viewport: { width: 1400, height: 1300 }, ignoreHTTPSErrors: !!o.tailcat })).newPage(); // the tailcat rig's relay has a self-signed certificate
  await page.addInitScript(() => { (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = undefined; });
  await page.addInitScript(([key, screen]) => localStorage.setItem(key, JSON.stringify({ screen })), [SETTINGS_KEY, o.screen ?? '1376x762']);
  await answerAsks(page);
  page.on('pageerror', (e) => console.log('pageerror', String(e)));
  /** The renderer's complaints (`virgl: …` warnings from the GPU worker), counted by message. */
  const warnings = new Map<string, number>();
  /** `?gpu=virgl,debug`'s trace (web/gpu-worker.ts). */
  const debugLines: string[] = [];
  /** The host's slow events (`webpc-slow` lines: web/vm.ts's installs), with their epoch-ms times. */
  const slow: string[] = [];
  page.on('console', (m) => {
    const t = m.text();
    if (t.startsWith('virgl-debug ')) return void debugLines.push(t.slice(12));
    if (t.startsWith('webpc-slow ')) return void slow.push(t.slice(11));
    if (t.startsWith('virgl')) warnings.set(t.slice(0, 200), (warnings.get(t.slice(0, 200)) ?? 0) + 1);
  });
  const t0 = performance.now();
  const at = () => ((performance.now() - t0) / 1000).toFixed(1);
  const log = (...a: unknown[]) => console.log(`[${at()}]`, ...a);

  // The image under the repository, as the server serves it.
  const served = relative(resolve(new URL('../..', import.meta.url).pathname), resolve(o.image));
  const byUrl = !!o.disk2 || !!o.byUrl || !!o.snapshot;
  if (byUrl && served.startsWith('..')) throw new Error(`an image opened by its URL must be under the repository (${o.image})`);
  const url = `${base}/web/app/?ncpus=${o.ncpus ?? 4}&ram=${o.ramMiB ?? 2560}&view=both&displaystats&gpu=${o.gpu}${byUrl ? `&disk=/${served}` : ''}${o.disk2 ? `&disk2=${encodeURIComponent(o.disk2)}` : ''}${o.query ? `&${o.query}` : ''}`;
  const coreServed = o.core ? await routeCore(page, o.core) : undefined;
  await page.goto(url);
  const gl = await page.evaluate(() => {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2');
    const d = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl ? `${gl.getParameter(d ? d.UNMASKED_RENDERER_WEBGL : gl.RENDERER)}` : 'no WebGL2';
  });
  log('WebGL2:', gl, '|', browser.version());
  if (!byUrl) await page.setInputFiles('#open-disk-input', o.image);
  /** Where the machine came from when it started from a snapshot (`loadSnapshotFile`'s record). */
  const restored = o.snapshot ? await loadSnapshotFile(page, o.snapshot, o.core) : undefined;
  if (restored) log('restored', JSON.stringify(restored));
  else await page.waitForFunction(() => document.body.dataset.state === 'running', null, { timeout: 300_000, polling: 250 });
  if (coreServed && !coreServed.n) throw new Error(`the page didn't load the core ${o.core}`);
  if (coreServed) log('core', o.core, coreServed.sha);
  log('running');
  if (o.tailcat) {
    // The Network menu's wizard: tailcat through an exit node, not kept (tests/page-network.test.ts drives it the same way).
    if (!(await page.evaluate(() => (document.getElementById('network') as HTMLDetailsElement).open))) await page.locator('#network summary').click();
    await page.click('#net-setup');
    if (await page.locator('#net-step-pick').isVisible()) await page.click('#net-pick-new');
    await page.click('#net-pick-tailcat');
    await page.check('#net-tc-exit');
    await page.fill('#net-tailcat', o.tailcat);
    await page.uncheck('#net-keep');
    await page.click('#net-connect');
    await page.waitForFunction(() => ['connected', 'error'].includes(document.getElementById('network')!.dataset.phase!), null, { timeout: 60_000, polling: 250 });
    const net = await page.evaluate(() => [document.getElementById('network')!.dataset.phase, document.getElementById('net-status')?.textContent]);
    if (net[0] !== 'connected') throw new Error(`tailcat didn't connect: ${net[1]}`);
    await page.keyboard.press('Escape');
    log('tailcat', net[1]);
  }
  // JITLOG=1: the JIT's counters (`__status.stats.jit`, summed over the vCPUs) once a second, as JSON lines in
  // <out>/jit.jsonl ({t: epoch ms, steps, jit}): the flushes, the wasm compiled and alive (bench/boot/results/m8-replay/counts.ts reads it).
  const jitLog = process.env.JITLOG ? setInterval(async () => {
    try {
      const st = await page.evaluate(() => (window as unknown as { __status?: { stats: { steps: number; jit: unknown } } }).__status?.stats);
      if (st) appendFileSync(`${o.out}/jit.jsonl`, JSON.stringify({ t: Date.now(), steps: st.steps, jit: st.jit }) + '\n');
    } catch {}
  }, 1000) : undefined;

  // MEMLOG=<s>: every that many seconds, the renderer's smaps by class, `measureUserAgentSpecificMemory` by realm and
  // type (bench/mem/probe.ts; CHROMIUM_ARGS=--enable-blink-features=ForceEagerMeasureMemory makes it answer at once) and
  // the page's own accounting (`__status.memory`) into <out>/mem.jsonl.
  let memBusy = false;
  const memLog = process.env.MEMLOG ? setInterval(async () => {
    if (memBusy) return;
    memBusy = true;
    try {
      const st = await page.evaluate(() => (window as unknown as { __status?: { memory: unknown; stats: { jit: unknown } } }).__status);
      const pid = rendererPid();
      const smaps = pid ? smapsClasses(pid) : undefined;
      const u = process.env.MEMLOG_UASM === '0' ? undefined : await uasm(page).catch((e) => String(e).slice(0, 200));
      appendFileSync(`${o.out}/mem.jsonl`, JSON.stringify({ t: Date.now(), smaps, uasm: u, memory: st?.memory, jit: st?.stats.jit }) + '\n');
    } catch {} finally { memBusy = false; }
  }, Number(process.env.MEMLOG) * 1000) : undefined;

  const terminal = () => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
  const shows = (re: RegExp, ms = 60_000) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: ms, polling: 200 })
    .catch(async (e) => {
      await page.screenshot({ path: `${o.out}/fail.png` });
      // The serial console's whole output (the page's log), for what scrolled off: a hung task's stack, say.
      writeFileSync(`${o.out}/serial.txt`, await page.evaluate(() => (window as unknown as { __serialLog?: () => string }).__serialLog?.() ?? ''));
      throw new Error(`${e}; the terminal shows: ${await terminal()} (all of it: ${o.out}/serial.txt)`);
    });
  const onSerial = async (text: string) => { await page.locator('.xterm').click(); await page.keyboard.type(text, { delay: 5 }); };
  /** Many lines on the serial terminal: pasted (typing kilobytes takes minutes), each line with an Enter (insertText sends none for a `\n`). */
  const pasteSerial = async (text: string) => {
    await page.locator('.xterm').click();
    for (const line of text.split('\n')) {
      if (line) await page.keyboard.insertText(line);
      await page.keyboard.press('Enter');
    }
  };
  const SHIFTED: Record<string, string> = { '|': 'Backslash', '>': 'Period', '<': 'Comma', _: 'Minus', '"': 'Quote', '&': 'Digit7', '*': 'Digit8', '(': 'Digit9', ')': 'Digit0', $: 'Digit4', ':': 'Semicolon', '?': 'Slash', '~': 'Backquote', '+': 'Equal', '{': 'BracketLeft', '}': 'BracketRight', '!': 'Digit1', '%': 'Digit5', '^': 'Digit6', '#': 'Digit3', '@': 'Digit2' };
  const PLAIN: Record<string, string> = { ' ': 'Space', '\n': 'Enter', '-': 'Minus', '=': 'Equal', '/': 'Slash', '.': 'Period', ',': 'Comma', ';': 'Semicolon', "'": 'Quote', '\\': 'Backslash', '[': 'BracketLeft', ']': 'BracketRight', '`': 'Backquote' };
  const onScreen = async (text: string, gap = 40) => {
    await page.locator('#screen').click();
    for (const c of text) {
      await page.keyboard.press(SHIFTED[c] ? `Shift+${SHIFTED[c]}` : PLAIN[c] ?? (/[A-Z]/.test(c) ? `Shift+Key${c}` : /[a-z]/.test(c) ? `Key${c.toUpperCase()}` : /[0-9]/.test(c) ? `Digit${c}` : c));
      await page.waitForTimeout(gap);
    }
  };
  /** The display's stats since the last call, per second (flushes are the compositor's frames), and the GPU worker's
   * (web/gpu-worker.ts `render-stats`: its busy time, of which running submits and presenting, the GL draws, the bytes uploaded and read back,
   * and the video decoded for the guest). */
  let lastVideo: Video | undefined;
  const display = async () => {
    const s = await page.evaluate(() => ((window as unknown as { __drawStats?: unknown[] }).__drawStats ?? []).splice(0)) as Stat[];
    const per = (k: string) => s.reduce((n, x) => n + (x.busy[k] ?? 0), 0) / Math.max(1, s.length);
    const r = await page.evaluate(() => ((window as unknown as { __renderStats?: unknown[] }).__renderStats ?? []).splice(0)) as Record<string, number>[];
    const rper = (k: string) => r.reduce((n, x) => n + (x[k] ?? 0), 0) / Math.max(1, r.length);
    // The video totals (web/gpu-worker.ts): pictures a second over the span, the mean and longest END_FRAME-to-written
    // and write ms a picture, calls run ahead of waiting ones a second, and the longest wait for a picture.
    const vs = r.map((x) => (x as unknown as { video?: Video }).video).filter((x): x is Video => !!x);
    let video;
    if (vs.length) {
      const a = lastVideo ?? vs[0], b = vs.at(-1)!, n = b.decoded - a.decoded;
      lastVideo = b;
      video = { frames: (b.frames - a.frames) / vs.length, decoded: n / vs.length, dropped: (b.dropped - a.dropped) / vs.length, errors: b.errors - a.errors, latencyMs: n ? (b.latencyMs - a.latencyMs) / n : 0,
        latencyMaxMs: Math.max(0, ...vs.map((x) => x.latencyMaxMs)), writeMs: n ? (b.writeMs - a.writeMs) / n : 0, ahead: (b.ahead - a.ahead) / vs.length, maxWaitMs: Math.max(0, ...vs.map((x) => x.maxWaitMs)) };
    }
    const renderer = r.length ? { seconds: r.length, busyMs: rper('busyMs'), submitMs: rper('submitMs'), drawMs: rper('drawMs'), presents: rper('presents'), glDraws: rper('draws'), commands: rper('commands'), uploadKB: rper('uploadBytes') / 1024, readbacks: rper('readbacks'), readbackKB: rper('readbackBytes') / 1024, compileMs: rper('compileMs'), programs: r.at(-1)!.programs, errors: r.at(-1)!.errors, ...(video ? { video } : {}) } : undefined;
    const commands: Record<string, number> = {};
    for (const x of s) for (const [k, n] of Object.entries(x.busy.commands ?? {})) commands[COMMANDS[k] ?? k] = (commands[COMMANDS[k] ?? k] ?? 0) + n / Math.max(1, s.length);
    // Fenced replies a second, the mean and longest wait for the host; every held reply's time held (ms a second).
    const fences = { n: per('fences'), meanMs: per('fenceMs') / Math.max(1e-9, per('fences')), maxMs: Math.max(0, ...s.map((x) => x.busy.fenceMaxMs ?? 0)), heldMs: per('heldMs'), behindMs: per('behindMs'), fullMs: per('fullMs'), heldMax: Math.max(0, ...s.map((x) => x.busy.heldMax ?? 0)),
      // Of a fence's round trip: to the GPU worker (its event loop's backlog) and back to the device worker.
      toGpuMs: rper('fenceMs') / Math.max(1e-9, rper('fences')), toGpuMaxMs: Math.max(0, ...r.map((x) => x.fenceMaxMs ?? 0)),
      backMs: s.reduce((n, x) => n + (x.busy.fenceBack?.ms ?? 0), 0) / Math.max(1, s.reduce((n, x) => n + (x.busy.fenceBack?.n ?? 0), 0)), backMaxMs: Math.max(0, ...s.map((x) => x.busy.fenceBack?.maxMs ?? 0)) };
    return { seconds: s.length, requests: per('requests'), commands, fences, flushes: per('flushes'), submits: per('submits'), submitKB: per('submitBytes') / 1024, transfers: per('transfers'), Mpx: per('pixels') / 1e6, requestMs: per('request'), draws: s.reduce((n, x) => n + x.n, 0) / Math.max(1, s.length), ...(renderer ? { renderer } : {}) };
  };
  const vmStats = () => page.evaluate(() => { const s = (window as unknown as { __status?: VmStatus }).__status; return s && { uptime: s.uptime, stats: s.stats }; }) as Promise<VmStatus | undefined>;
  /** The emulator's counters a second between two status reads (all vCPUs): guest exceptions by class (0x15 a syscall, 0x24 a data abort), IRQs, TLB, the JIT. */
  const vmDelta = (a?: VmStatus, b?: VmStatus) => {
    if (!a || !b || b.uptime <= a.uptime) return undefined;
    const per = (x: number, y: number) => Math.round(((y - x) * 1000) / (b.uptime - a.uptime));
    const exceptions = Object.fromEntries(Object.keys(b.stats.exceptions).map((k) => [k, per(a.stats.exceptions[k] ?? 0, b.stats.exceptions[k])]).filter(([, n]) => n));
    return { seconds: (b.uptime - a.uptime) / 1000, Msteps: per(a.stats.steps, b.stats.steps) / 1e6, irqs: per(a.stats.irqs, b.stats.irqs), exceptions, tlbMisses: per(a.stats.tlbMisses, b.stats.tlbMisses), tlbFlushes: per(a.stats.tlbFlushes, b.stats.tlbFlushes), jitFlushes: per(a.stats.jit.flushes, b.stats.jit.flushes), jitInvalidations: per(a.stats.jit.invalidations, b.stats.jit.invalidations), jitCompileMs: per(a.stats.jit.compileNs, b.stats.jit.compileNs) / 1e6 };
  };

  /** Root on the serial terminal, and the load script. */
  const rootShell = async () => {
    await shows(/login:\s*$/, 120_000);
    await onSerial('root\n');
    await shows(/Password:\s*$|\]#\s*$/);
    if (/Password:\s*$/.test(await terminal())) await onSerial('root\n');
    await shows(/\]#\s*$/);
    await pasteSerial(`cat > /root/load.sh <<'EOF'\n${LOAD_SH}EOF`);
  };

  /** A command's output on the serial terminal, between markers (rows run together: one screenful at most). The
   * markers carry the session's tag: a terminal restored from a snapshot shows the saving session's. */
  const tag = sessionTag();
  let runs = 0;
  const run = async (cmd: string, ms = 60_000) => {
    const m = `R${tag}${++runs}`;
    await onSerial(`clear; echo ${m}-be""gin; ${cmd}; echo ${m}-e""nd\n`);
    await shows(new RegExp(`${m}-end`), ms);
    const t = await terminal();
    return t.slice(t.lastIndexOf(`${m}-begin`) + m.length + 6, t.lastIndexOf(`${m}-end`)).trim();
  };
  /** A command's output as lines, however long: 6 lines a screenful (a long line wraps over several rows), each marked. */
  const runLines = async (cmd: string, ms = 60_000) => {
    const total = Number(await run(`${cmd} > /tmp/run.out 2>&1; wc -l < /tmp/run.out`, ms));
    const lines: string[] = [];
    for (let a = 1; a <= total; a += 6) lines.push(...(await run(`sed -n "${a},${a + 5}p" /tmp/run.out | cut -c1-400 | sed "s/^/@@/"`)).split('@@').slice(1).map((l) => l.trim()));
    if (lines.length !== total) console.log(`runLines: ${lines.length} of ${total} lines read`);
    return lines;
  };

  let mark = 0;
  /** A phase: `secs` of the guest's /proc on the serial side, with the display's, the renderer's and the emulator's
   * stats over the same time; `during` starts and stops something around it (a sampler), and `then` runs as the time ends
   * (before the guest's file is read back, which takes seconds: what the caller counts over the phase). Returns the phase's record
   * (threads sorted by CPU) and screenshots the screen as <out>/<label>.png. */
  const load = async (label: string, secs = 10, during?: { start(): Promise<void>; stop(): Promise<void> }, then?: () => Promise<void>) => {
    await display();
    const m = `L${tag}${++mark}`;
    const v0 = await vmStats();
    await during?.start();
    await onSerial(`clear; sh /root/load.sh ${secs} ${m}${process.env.SYSCALLS ? ' sys' : ''}\n`);
    await shows(new RegExp(`${m}-done`), (secs + 60) * 1000);
    await during?.stop();
    const v1 = await vmStats();
    const d = { ...(await display()), vm: vmDelta(v0, v1) };
    const t = await terminal();
    await then?.();
    const cpus = [...t.matchAll(new RegExp(`${m} (cpu\\d?) busy (\\d+) user (\\d+) sys (\\d+) iowait (\\d+)`, 'g'))].map((x) => ({ cpu: x[1], busy: +x[2], user: +x[3], sys: +x[4], iowait: +x[5] }));
    // LOAD_SH's file (a second each): processes, threads, and with SYSCALLS=1 the syscalls by thread, by call, by process.
    const out = await runLines('cat /tmp/load.out');
    const fields = (l: string) => { const w = l.split(' '); return Object.fromEntries(w.slice(2).flatMap((x, i, a) => (i % 2 ? [] : [[x, +a[i + 1]]]))); };
    const processes = out.filter((l) => l.startsWith('P ')).map((l) => ({ process: l.split(' ')[1], ...fields(l) }));
    const threads = out.filter((l) => l.startsWith('T ')).map((l) => ({ thread: l.split(' ')[1], ...fields(l) }));
    const name = (nr: string) => SYSCALLS[+nr] ?? nr;
    const syscalls = process.env.SYSCALLS ? {
      lost: +(out.find((l) => l.startsWith('O '))?.split(' ')[1] ?? 0),
      byThread: out.filter((l) => l.startsWith('S ')).map((l) => { const [, thread, nr, n] = l.split(' '); return { thread, call: name(nr), n: +n }; }),
      byCall: Object.fromEntries(out.filter((l) => l.startsWith('Y ')).map((l) => { const [, nr, n] = l.split(' '); return [name(nr), +n]; })),
      byProcess: Object.fromEntries(out.filter((l) => l.startsWith('Q ')).map((l) => { const [, p, n] = l.split(' '); return [p, +n]; })),
    } : undefined;
    const r = { cpus, processes, threads, ...(syscalls ? { syscalls } : {}), display: d };
    log(label, JSON.stringify(cpus.filter((c) => c.cpu === 'cpu')), JSON.stringify(processes.slice(0, 8)), JSON.stringify(d));
    await page.locator('#screen').screenshot({ path: `${o.out}/${label}.png` });
    return r;
  };

  /** The user's session on the screen (GUEST_USER, its password the same), then sway with `WLR_RENDERER=<renderer>`; returns what sway's log
   * says of its renderer. `asUser(cmd)` runs a command in that session (its environment) from the root shell. */
  const startSway = async (renderer: string) => {
    await onScreen(`${GUEST_USER}\n`);
    await page.waitForTimeout(3000);
    await onScreen(`${GUEST_USER}\n`);
    await page.waitForTimeout(6000);
    await onScreen(`WLR_RENDERER=${renderer} sway 2>/tmp/sway.log\n`);
    for (let i = 0; i < 60; i++) {
      if ((await run('ls /run/user/1000/ | grep -c sway-ipc')).trim() === '1') break;
      await page.waitForTimeout(2000);
    }
    await page.waitForTimeout(10_000);
    return run('grep -i -E "renderer|egl|gles|driver" /tmp/sway.log | head -4');
  };
  const asUser = (cmd: string) => `su ${GUEST_USER} -c "export XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-1 SWAYSOCK=$(ls /run/user/1000/sway-ipc.*.sock); ${cmd}"`;

  /**
   * The guest PC sampler (web/profiler.ts: every vCPU's published PC, every 50 µs; while it runs the vCPUs publish
   * their PC every 256 steps, `vm_set_chunk`) as `load`'s `during`; then `symbolize` names the kernel's PCs in the
   * guest against /proc/kallsyms (the image has no System.map), by function: the top `top`, with the kernel's and
   * user space's shares.
   */
  type Hooks = { __webpcProfile?: (on: boolean) => void; __profile?: [string, number][] };
  const sampler = {
    start: async () => { await page.evaluate(() => { const w = window as unknown as Hooks; delete w.__profile; w.__webpcProfile!(true); }); },
    stop: async () => {
      await page.evaluate(() => (window as unknown as Hooks).__webpcProfile!(false));
      await page.waitForFunction(() => (window as unknown as Hooks).__profile, null, { timeout: 30_000 });
    },
  };
  /**
   * The vCPU timeline (web/profiler.ts `startTimeline`: every vCPU's counters and liveness every 10 ms) as `load`'s
   * `during`; `timelineSummary(label)` then saves its rows as <out>/<label>.timeline.json and returns `summarizeTimeline`'s.
   */
  type TimelineHooks = { __webpcTimeline?: (on: boolean) => void; __timeline?: Timeline };
  const timeline = {
    start: async () => { await page.evaluate(() => { const w = window as unknown as TimelineHooks; delete w.__timeline; w.__webpcTimeline!(true); }); },
    stop: async () => {
      await page.evaluate(() => (window as unknown as TimelineHooks).__webpcTimeline!(false));
      await page.waitForFunction(() => (window as unknown as TimelineHooks).__timeline, null, { timeout: 30_000 });
    },
  };
  const timelineSummary = async (label: string) => {
    const t = await page.evaluate(() => (window as unknown as TimelineHooks).__timeline!);
    writeFileSync(`${o.out}/${label}.timeline.json`, JSON.stringify(t));
    return summarizeTimeline(t);
  };
  const symbolize = async (top = 60, groups?: Record<string, string>) => {
    const samples = await page.evaluate(() => (window as unknown as Hooks).__profile!);
    let kernel = 0, user = 0, total = 0;
    const kpcs: [string, number][] = [];
    for (const [pc, n] of samples) {
      total += n;
      if (BigInt(`0x${pc}`) >= 0xffff000000000000n) { kernel += n; kpcs.push([pc.padStart(16, '0'), n]); } else user += n;
    }
    kpcs.sort((a, b) => b[1] - a[1]);
    const sent = kpcs.slice(0, 4000);
    const covered = sent.reduce((n, [, k]) => n + k, 0);
    await onSerial(`cat > /tmp/sym.sh <<'EOF'
sysctl -qw kernel.kptr_restrict=0
(awk '$2 ~ /^[tT]$/ {print $1, "A", $3}' /proc/kallsyms; awk '{for (i = 1; i < NF; i += 2) print $i, "B", $(i + 1)}' /tmp/pcs) | sort | awk '$2=="A"{s=$3;next} {c[s]+=$3} END{for(k in c) print c[k], k}' | sort -rn | head -${top} | awk 'BEGIN{printf "SY""MS: "} {printf "%s:%s ", $2, $1} END{print "SY""MS-done"}'
EOF
clear; cat > /tmp/pcs <<'EOF'
`);
    // Pasted (typing 80 KB would take minutes) as lines of pairs under the tty's 4096-byte line, each with an Enter.
    for (let k = 0; k < sent.length; k += 150) {
      await page.keyboard.insertText(sent.slice(k, k + 150).map(([pc, n]) => `${pc} ${n}`).join(' '));
      await page.keyboard.press('Enter');
    }
    await onSerial('EOF\nclear; wc -w < /tmp/pcs; sh /tmp/sym.sh\n');
    await shows(/SYMS-done/, 120_000);
    const t = await terminal();
    const lines = /(\d+)\s*SYMS:/.exec(t)?.[1];
    const body = t.slice(t.lastIndexOf('SYMS: ') + 6, t.lastIndexOf('SYMS-done'));
    const syms = [...body.matchAll(/(\S+):(\d+)/g)].map((x) => ({ sym: x[1], samples: +x[2], pct: +((100 * +x[2]) / total).toFixed(1) }));
    return { samples: total, kernelPct: +((100 * kernel) / total).toFixed(1), userPct: +((100 * user) / total).toFixed(1), kernelPcs: kpcs.length, sent: sent.length, received: lines && +lines / 2, coveredPct: +((100 * covered) / Math.max(1, kernel)).toFixed(1), top: syms, ...(groups ? { groups: await symbolGroups(kpcs, total, groups) } : {}) };
  };
  /**
   * Every kernel sample (not only the top PCs `symbolize` sends) summed by group: `groups` names awk regexes on a
   * symbol's name and module (`name [module]`; the first that matches counts); the guest prints each group's address ranges (runs of adjacent
   * symbols that match it, few: a driver's or a file's functions sit together), the host sums the samples in them.
   */
  const symbolGroups = async (kpcs: [string, number][], total: number, groups: Record<string, string>) => {
    const names = Object.keys(groups);
    const match = names.map((g, i) => `if (g < 0 && $0 ~ /${groups[g]}/) g = ${i};`).join(' ');
    await pasteSerial(`cat > /tmp/groups.sh <<'EOF'
awk '$2 ~ /^[tT]$/ {print $1, $3, $4}' /proc/kallsyms | sort | awk 'BEGIN { cur = -1 } { a = $1; $0 = $2 " " $3; g = -1; ${match} if (g != cur) { if (cur >= 0) print "G", cur, start, a; cur = g; start = a } }'
EOF`);
    const lines = await runLines('sh /tmp/groups.sh', 120_000);
    const ranges = lines.filter((l) => l.startsWith('G ')).map((l) => { const [, g, a, b] = l.split(' '); return { g: +g, a: BigInt(`0x${a}`), b: BigInt(`0x${b}`) }; });
    const sums = names.map(() => 0);
    for (const [pc, n] of kpcs) {
      const x = BigInt(`0x${pc}`);
      const r = ranges.find((r) => x >= r.a && x < r.b);
      if (r) sums[r.g] += n;
    }
    return Object.fromEntries(names.map((g, i) => [g, { samples: sums[i], pct: +((100 * sums[i]) / total).toFixed(2), ranges: ranges.filter((r) => r.g === i).length }]));
  };

  const close = async () => { clearInterval(jitLog); clearInterval(memLog); await browser.close(); server.close(); };
  return { page, browser, url, gl, restored, coreSha: coreServed?.sha, log, warnings, debugLines, slow, terminal, shows, onSerial, pasteSerial, onScreen, run, runLines, display, vmStats, vmDelta, rootShell, load, startSway, asUser, sampler, symbolize, timeline, timelineSummary, close };
}

const pctl = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
/**
 * A vCPU timeline (web/profiler.ts) summed up per vCPU: millions of guest instructions a second (mean, and the 10 ms
 * bins' p10/p50/p90 while inside `vm_run_cpu`), ms a second outside it (idle or the host's) and compiling, and the
 * host's **stalls**: bins inside one call that retired nothing (a compile, V8's GC, a lock or a wait on the host:
 * the guest's clock runs on meanwhile), their ms a second and the longest run of them with the compile time in it;
 * and the calls longer than 50 ms (their start, ms from the timeline's start, ms, steps, compile ms).
 */
export function summarizeTimeline(t: Timeline) {
  const w = 1 + t.ncpus * t.fields.length, nrows = t.rows.length / w, f = (k: string) => t.fields.indexOf(k);
  const [S, C, OUT, IN, SYS] = [f('steps'), f('compileNs'), f('outNs'), f('enteredAt'), f('syscalls')];
  const at = (r: number, c: number, k: number) => t.rows[r * w + 1 + c * t.fields.length + k];
  const time = (r: number) => t.rows[r * w];
  const secs = nrows > 1 ? (time(nrows - 1) - time(0)) / 1000 : 0;
  const cpus = Array.from({ length: t.ncpus }, (_, c) => {
    const bins: number[] = [];
    let stallMs = 0, run = 0, runCompile = 0, worst = { ms: 0, compileMs: 0, at: 0 };
    const calls: { atMs: number; ms: number; Msteps: number; compileMs: number }[] = [];
    let call = { entered: 0, r: 0 };
    for (let r = 1; r < nrows; r++) {
      const dt = time(r) - time(r - 1), ds = at(r, c, S) - at(r - 1, c, S), dc = (at(r, c, C) - at(r - 1, c, C)) / 1e6;
      const same = at(r, c, IN) !== 0 && at(r, c, IN) === at(r - 1, c, IN);
      if (same) bins.push((ds / dt) / 1e3);
      if (same && ds === 0) {
        stallMs += dt; run += dt; runCompile += dc;
        if (run > worst.ms) worst = { ms: run, compileMs: runCompile, at: time(r) - run - time(0) };
      } else { run = 0; runCompile = 0; }
      // A call ends when its entry time changes (or the vCPU left it): calls seen whole, over 50 ms.
      if (at(r, c, IN) !== call.entered) {
        if (call.entered && at(r - 1, c, IN) === call.entered && call.r > 0) {
          const ms = time(r) - call.entered;
          if (ms > 50) calls.push({ atMs: Math.round(call.entered - time(0)), ms: Math.round(ms), Msteps: +((at(r, c, S) - at(call.r - 1, c, S)) / 1e6).toFixed(1), compileMs: +((at(r, c, C) - at(call.r - 1, c, C)) / 1e6).toFixed(1) });
        }
        call = { entered: at(r, c, IN), r };
      }
    }
    const d = (k: number) => at(nrows - 1, c, k) - at(0, c, k);
    return {
      cpu: c, mips: +(d(S) / secs / 1e6).toFixed(1), binMips: { p10: +pctl(bins, 0.1).toFixed(1), p50: +pctl(bins, 0.5).toFixed(1), p90: +pctl(bins, 0.9).toFixed(1) },
      outMs: +(d(OUT) / 1e6 / secs).toFixed(1), compileMs: +(d(C) / 1e6 / secs).toFixed(1), syscalls: Math.round(d(SYS) / secs),
      stallMs: +(stallMs / secs).toFixed(1), worstStall: { ms: Math.round(worst.ms), compileMs: +worst.compileMs.toFixed(1), atMs: Math.round(worst.at) }, longCalls: calls.slice(0, 20),
    };
  });
  return { seconds: +secs.toFixed(1), rows: nrows, cpus };
}
