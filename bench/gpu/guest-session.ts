// A UEFI disk image on the page under load (dev-only, not in tests): what bench/gpu/sway-load.ts and
// bench/gpu/firefox-load.ts share. Headless Chromium, the page with `?displaystats`, a disk opened from a file, root
// on the serial terminal, keys typed on the screen, and `load()`: a phase measured over N s on both sides (the guest's
// /proc/stat and per-thread CPU, the display's and the renderer's stats, the emulator's counters).
import { writeFileSync } from 'node:fs';
import { chromiumEnv } from '../../tools/nosme.ts';
import { chromium, type Page } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';
import type { VideoStats } from '../../web/virgl-video.ts';

const SETTINGS_KEY = 'webpc.settings';

export type SessionOptions = {
  /** The page's `?gpu=` (`virgl`, `virgl-null`, `2d`, with `,capture`). */
  gpu: string;
  image: string;
  out: string;
  /** The screen's fixed size, as the page's Size menu stores it. */
  screen?: string;
  ncpus?: number;
  ramMiB?: number;
  /** The page's `?disk2=` (a read-only second disk, /dev/vdb). */
  disk2?: string;
  /** More of the page's query (e.g. `snd=&avprobe`: bench/audio/avsync.ts). */
  query?: string;
};

type Stat = { n: number; lag: number; busy: Record<string, number> & { commands?: Record<string, number>; fenceBack?: { n: number; ms: number; maxMs: number } } };
/** virtio-gpu's control commands by type. */
const COMMANDS: Record<string, string> = { 100: 'GET_DISPLAY_INFO', 101: 'RESOURCE_CREATE_2D', 102: 'RESOURCE_UNREF', 103: 'SET_SCANOUT', 104: 'RESOURCE_FLUSH', 105: 'TRANSFER_TO_HOST_2D', 106: 'ATTACH_BACKING', 107: 'DETACH_BACKING', 108: 'GET_CAPSET_INFO', 109: 'GET_CAPSET', '10a': 'GET_EDID', 200: 'CTX_CREATE', 201: 'CTX_DESTROY', 202: 'CTX_ATTACH_RESOURCE', 203: 'CTX_DETACH_RESOURCE', 204: 'RESOURCE_CREATE_3D', 205: 'TRANSFER_TO_HOST_3D', 206: 'TRANSFER_FROM_HOST_3D', 207: 'SUBMIT_3D' };
type Video = VideoStats & { ahead: number; maxWaitMs: number };
type VmStats = { steps: number; irqs: number; exceptions: Record<string, number>; tlbMisses: number; tlbFlushes: number; jit: { flushes: number; invalidations: number; compileNs: number } };
type VmStatus = { uptime: number; stats: VmStats };

/** The guest's load script (/root/load.sh <secs> <mark>): /proc/stat's busy, user and system percent per CPU, and each
 * thread's ms of CPU a second (clock ticks are 10 ms; and the CPUs' I/O wait) as `<mark> thr <process>/<thread> user <u> sys <s>` (spaces in
 * names as `_`; the threads that used at least 10 ms a second), over `secs`. */
const LOAD_SH = String.raw`snap() { awk '{c=$0; sub(/^[0-9]+ \(/,"",c); n=c; sub(/\) [^)]*$/,"",n); sub(/^.*\) /,"",c); split(c,f," "); split(FILENAME,p,"/"); gsub(/ /,"_",n); print p[3], p[5], n, f[12], f[13]}' /proc/[0-9]*/task/[0-9]*/stat 2>/dev/null; }
snap > /tmp/pa; cat /proc/stat > /tmp/a; sleep $1; cat /proc/stat > /tmp/b; snap > /tmp/pb
awk -v m=$2 -v s=$1 'NR==FNR{u[$2]=$4;k[$2]=$5;next} ($2 in u){t[$2]=$3; if($1==$2) pn[$1]=$3; pid[$2]=$1; du[$2]=($4-u[$2])*10/s; ds[$2]=($5-k[$2])*10/s} END{for(x in du) if(du[x]+ds[x]>=10) printf "%s thr %s/%s user %d sys %d\n",m,pn[pid[x]]?pn[pid[x]]:pid[x],t[x],du[x],ds[x]}' /tmp/pa /tmp/pb
awk -v m=$2 'NR==FNR&&/^cpu/{for(i=2;i<=9;i++)a[$1,i]=$i;next} /^cpu/{t=0;for(i=2;i<=9;i++){d[i]=$i-a[$1,i];t+=d[i]}; printf "%s %s busy %d user %d sys %d iowait %d\n",m,$1,100*(t-d[5]-d[6])/t,100*(d[2]+d[3])/t,100*(d[4]+d[7]+d[8])/t,100*d[6]/t}' /tmp/a /tmp/b
echo $2-done
`;

export async function openSession(o: SessionOptions) {
  const server = await startServer();
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // HEADED=1: a visible window (only on the Mac host, where the user allows it: never on the dev VM).
  // CHROMIUM_ARGS: extra flags (e.g. `--mute-audio` on the Mac host: its sound still renders and keeps time, unheard).
  // A 3D machine decodes its guest's video with WebCodecs: SME hidden where the CPU needs it (tools/nosme.ts).
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: !process.env.HEADED, args: process.env.CHROMIUM_ARGS?.split(' ').filter(Boolean), env: chromiumEnv() });
  const page: Page = await (await browser.newContext({ viewport: { width: 1400, height: 1300 } })).newPage();
  await page.addInitScript(() => { (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = undefined; });
  await page.addInitScript(([key, screen]) => localStorage.setItem(key, JSON.stringify({ screen })), [SETTINGS_KEY, o.screen ?? '1376x762']);
  page.on('dialog', (d) => void d.accept());
  page.on('pageerror', (e) => console.log('pageerror', String(e)));
  /** The renderer's complaints (`virgl: …` warnings from the GPU worker), counted by message. */
  const warnings = new Map<string, number>();
  /** `?gpu=virgl,debug`'s trace (web/gpu-worker.ts). */
  const debugLines: string[] = [];
  page.on('console', (m) => {
    const t = m.text();
    if (t.startsWith('virgl-debug ')) return void debugLines.push(t.slice(12));
    if (t.startsWith('virgl')) warnings.set(t.slice(0, 200), (warnings.get(t.slice(0, 200)) ?? 0) + 1);
  });
  const t0 = performance.now();
  const at = () => ((performance.now() - t0) / 1000).toFixed(1);
  const log = (...a: unknown[]) => console.log(`[${at()}]`, ...a);

  await page.goto(`${base}/web/app/?ncpus=${o.ncpus ?? 4}&ram=${o.ramMiB ?? 2560}&view=both&displaystats&gpu=${o.gpu}${o.disk2 ? `&disk2=${encodeURIComponent(o.disk2)}` : ''}${o.query ? `&${o.query}` : ''}`);
  const gl = await page.evaluate(() => {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2');
    const d = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl ? `${gl.getParameter(d ? d.UNMASKED_RENDERER_WEBGL : gl.RENDERER)}` : 'no WebGL2';
  });
  log('WebGL2:', gl, '|', browser.version());
  await page.setInputFiles('#open-disk-input', o.image);
  await page.waitForFunction(() => document.body.dataset.state === 'running', null, { timeout: 300_000, polling: 250 });
  log('running');

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
    const fences = { n: per('fences'), meanMs: per('fenceMs') / Math.max(1e-9, per('fences')), maxMs: Math.max(0, ...s.map((x) => x.busy.fenceMaxMs ?? 0)), heldMs: per('heldMs'),
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

  /** A command's output on the serial terminal, between markers (rows run together: one screenful at most). */
  let runs = 0;
  const run = async (cmd: string, ms = 60_000) => {
    const m = `R${++runs}`;
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
   * stats over the same time; `during` starts and stops something around it (a sampler). Returns the phase's record
   * (threads sorted by CPU) and screenshots the screen as <out>/<label>.png. */
  const load = async (label: string, secs = 10, during?: { start(): Promise<void>; stop(): Promise<void> }) => {
    await display();
    const m = `L${++mark}`;
    const v0 = await vmStats();
    await during?.start();
    await onSerial(`clear; sh /root/load.sh ${secs} ${m}\n`);
    await shows(new RegExp(`${m}-done`), (secs + 60) * 1000);
    await during?.stop();
    const v1 = await vmStats();
    const d = { ...(await display()), vm: vmDelta(v0, v1) };
    const t = await terminal();
    const cpus = [...t.matchAll(new RegExp(`${m} (cpu\\d?) busy (\\d+) user (\\d+) sys (\\d+) iowait (\\d+)`, 'g'))].map((x) => ({ cpu: x[1], busy: +x[2], user: +x[3], sys: +x[4], iowait: +x[5] }));
    const threads = [...t.matchAll(new RegExp(`${m} thr (\\S+) user (\\d+) sys (\\d+)`, 'g'))].map((x) => ({ thread: x[1], userMs: +x[2], sysMs: +x[3] }))
      .sort((a, b) => b.userMs + b.sysMs - a.userMs - a.sysMs);
    const r = { cpus, threads, display: d };
    log(label, JSON.stringify(cpus.filter((c) => c.cpu === 'cpu')), JSON.stringify(threads.slice(0, 8)), JSON.stringify(d));
    await page.locator('#screen').screenshot({ path: `${o.out}/${label}.png` });
    return r;
  };

  /** The user's session on the screen (alarm/alarm), then sway with `WLR_RENDERER=<renderer>`; returns what sway's log
   * says of its renderer. `asUser(cmd)` runs a command in that session (its environment) from the root shell. */
  const startSway = async (renderer: string) => {
    await onScreen('alarm\n');
    await page.waitForTimeout(3000);
    await onScreen('alarm\n');
    await page.waitForTimeout(6000);
    await onScreen(`WLR_RENDERER=${renderer} sway 2>/tmp/sway.log\n`);
    for (let i = 0; i < 60; i++) {
      if ((await run('ls /run/user/1000/ | grep -c sway-ipc')).trim() === '1') break;
      await page.waitForTimeout(2000);
    }
    await page.waitForTimeout(10_000);
    return run('grep -i -E "renderer|egl|gles|driver" /tmp/sway.log | head -4');
  };
  const asUser = (cmd: string) => `su alarm -c "export XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-1 SWAYSOCK=$(ls /run/user/1000/sway-ipc.*.sock); ${cmd}"`;

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
  const symbolize = async (top = 60) => {
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
    return { samples: total, kernelPct: +((100 * kernel) / total).toFixed(1), userPct: +((100 * user) / total).toFixed(1), kernelPcs: kpcs.length, sent: sent.length, received: lines && +lines / 2, coveredPct: +((100 * covered) / Math.max(1, kernel)).toFixed(1), top: syms };
  };

  const close = async () => { await browser.close(); server.close(); };
  return { page, browser, gl, log, warnings, debugLines, terminal, shows, onSerial, pasteSerial, onScreen, run, runLines, display, vmStats, vmDelta, rootShell, load, startSway, asUser, sampler, symbolize, close };
}
