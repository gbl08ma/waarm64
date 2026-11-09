// The long-running Chromium stress test (docs/testing.md "The stress test"): boots the
// real page on Debian (parallel SMP, JIT), logs in on the serial console, starts a mixed guest load and
// samples the page, the browser's processes and the guest for as long as asked, into a JSONL log.
// It reports (exit code 1) a crash, a frozen page, a stalled vCPU, memory growth, a slowdown and the
// guest's own lockup reports; bench/stress/analyze.ts holds the rules, summarize.ts re-reads a log.
//
//   node bench/stress/stress.ts --seconds 600   (sampling time: the ~45 s boot and login come before it) [--out log.jsonl] [--interval 5] [--ncpus 4]
//     [--guest-cmd '<cmd>']...  extra guest commands, each started in the background as `( cmd ) &`
//     [--disk2 <repo path>]     a read-only second disk, /dev/vdb (images/stress/build-goroot.sh: goroot.ext4)
//     [--no-load]               no built-in load (the --guest-cmd ones still start)
//     [--query <a=b&c=d>]       added to the page's query (e.g. `jit=nocw`)
//     [--stall-ms 2000] [--freeze-ms 10000] [--warmup 90]   thresholds (analyze.ts DEFAULTS)
//     [--inject freeze-main@60:30]  fault injection, to check the detection (main thread busy for 30 s at t=60)
//     [--inject drop-status@60:30]  the machine worker's status messages don't reach the page for 30 s
//     [--core <file.wasm>]      serve this core build instead of target/'s (bench/snapshot-start.ts)
//     [--save-snapshot <file>]  once logged in, save the machine (Save snapshot) to <file> and end: the warm start below
//     [--from-snapshot <file>]  start from that file instead of booting (docs/benchmarking.md "Starting from a snapshot"):
//                               no boot, no login; the load starts at once (`--seconds` counts from there too). The
//                               page's query and --disk2 must be the ones it was saved with (the same devices)
//
// Exit codes: 0 clean, 1 findings, 2 the harness itself failed (no login, no browser).
// Hours long: docs/testing.md gives the detached command (systemd-run, timeout, log).
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium, type CDPSession, type Page } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';
import { unattendedQuery } from '../../tests/debian-unattended.ts';
import { answerAsks } from '../../tests/page-ask.ts';
import { loadSnapshotFile, routeCore, saveSnapshotFile } from '../snapshot-start.ts';
import { analyze, DEFAULTS, report, type Options, type PageStatus, type Proc, type Rec, type Sample } from './analyze.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const values = (name: string) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
const num = (name: string, dflt: number) => Number(values(name)[0] ?? dflt);
const seconds = num('--seconds', 300);
const interval = num('--interval', 5);
const ncpus = num('--ncpus', 4);
const probeEvery = num('--probe', 15);
const machine = values('--machine')[0] ?? 'debian';
const out = values('--out')[0] ?? `bench/results/local/stress-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
const opt: Options = { ...DEFAULTS, stallMs: num('--stall-ms', DEFAULTS.stallMs), freezeMs: num('--freeze-ms', DEFAULTS.freezeMs), warmupS: num('--warmup', DEFAULTS.warmupS) };
const injects = values('--inject').map((s) => {
  const m = /^(freeze-main|drop-status)@(\d+):(\d+)$/.exec(s);
  if (!m) throw new Error(`--inject ${s}: expected freeze-main|drop-status@<t>:<seconds>`);
  return { kind: m[1], at: Number(m[2]), for: Number(m[3]), done: false };
});

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, '');
const epoch = Date.now();
const secs = () => (Date.now() - epoch) / 1000;
const log = (r: Rec) => appendFileSync(out, `${JSON.stringify(r)}\n`);
const say = (s: string) => console.log(`[${secs().toFixed(0).padStart(5)} s] ${s}`);
const records: Rec[] = [];
const emit = (r: Rec) => {
  records.push(r);
  log(r);
};
const event = (kind: string, text: string) => {
  emit({ type: 'event', t: secs(), kind, text });
  say(`${kind}: ${text.slice(0, 300)}`);
};
const stop = (code: number, why?: string): never => {
  if (why) say(why);
  process.exit(code);
};

// What the page keeps for us (injected before the page's scripts): the machine worker's messages by
// arrival, the main thread's timer lag, the serial text not read yet, and the fault injection.
type Hook = {
  state: () => { statusAge: number; statusGap: number; lag: number; serialAge: number; status?: string; uaMem?: number; uaAt?: number };
  drain: () => string;
  inject: (kind: string, ms: number) => void;
};
declare global {
  var __stress: Hook;
}
const installHook = () => {
  const S = { statusAt: performance.now(), gap: 0, lag: 0, serialAt: performance.now(), pending: '', dropUntil: 0, ua: undefined as number | undefined, uaAt: undefined as number | undefined, uaBusy: false };
  const Native = window.Worker;
  window.Worker = class extends Native {
    constructor(...a: ConstructorParameters<typeof Worker>) {
      super(...a);
      this.addEventListener('message', (e: MessageEvent) => {
        const m = e.data;
        if (!m || typeof m !== 'object') return;
        const now = performance.now();
        if (m.type === 'status') {
          if (now < S.dropUntil) return void e.stopImmediatePropagation();
          S.gap = Math.max(S.gap, now - S.statusAt);
          S.statusAt = now;
        } else if (m.type === 'serial') {
          S.serialAt = now;
          S.pending = (S.pending + m.data).slice(-4_000_000);
        }
      });
    }
  };
  let tick = performance.now();
  setInterval(() => {
    const now = performance.now();
    S.lag = Math.max(S.lag, now - tick - 100);
    tick = now;
  }, 100);
  (globalThis as unknown as { __stress: Hook }).__stress = {
    state() {
      const now = performance.now();
      const r = { statusAge: now - S.statusAt, statusGap: S.gap, lag: S.lag, serialAge: now - S.serialAt, status: document.getElementById('status')?.dataset.status, uaMem: S.ua, uaAt: S.uaAt };
      S.gap = S.lag = 0;
      // The next memory measurement (it takes a while and runs a GC: never awaited here).
      const p = performance as unknown as { measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }> };
      if (!S.uaBusy && p.measureUserAgentSpecificMemory) {
        S.uaBusy = true;
        p.measureUserAgentSpecificMemory().then((m) => { S.ua = m.bytes / 1048576; S.uaAt = now; }, () => {}).finally(() => { S.uaBusy = false; });
      }
      return r;
    },
    drain() {
      const p = S.pending;
      S.pending = '';
      return p;
    },
    inject(kind, ms) {
      if (kind === 'drop-status') S.dropUntil = performance.now() + ms;
      else for (const end = performance.now() + ms; performance.now() < end;);
    },
  };
};

const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', downloadsPath: process.env.WEBPC_DOWNLOADS });
process.on('SIGTERM', () => stop(finish(), 'SIGTERM'));
const page = await browser.newPage();
await page.addInitScript(installHook);
// A snapshot saved is a download (not a file picker); the page's confirmations (Load snapshot…) are answered.
await page.addInitScript(() => { (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = undefined; });
await answerAsks(page);
const saveTo = values('--save-snapshot')[0];
const fromFile = values('--from-snapshot')[0];
const core = values('--core')[0];
const served = core ? await routeCore(page, core) : undefined;
page.on('console', (m) => { if (/panic|error|DSB|unreachable/i.test(m.text())) event('console', m.text()); });
page.on('pageerror', (e) => event('pageerror', String(e)));
page.on('crash', () => event('pagecrash', 'the renderer crashed'));
let cdp: CDPSession | undefined;
let browserCdp: CDPSession | undefined;
try {
  cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  browserCdp = await browser.newBrowserCDPSession();
} catch (e) {
  say(`no CDP: ${e}`);
}
emit({ type: 'meta', epoch, args: argv, opt, machine, ncpus, chromium: browser.version(), node: process.version });
say(`log: ${out}`);
const disk2 = values('--disk2')[0];
const query = values('--query')[0];
await page.goto(`${base}/web/app/?machine=${machine}&ncpus=${ncpus}&view=terminal&${unattendedQuery()}${disk2 ? `&disk2=${encodeURIComponent(`/${disk2}`)}` : ''}${query ? `&${query}` : ''}`);

/** Races `p` against a timeout (the main thread may be frozen: Playwright waits for it forever). */
const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> => Promise.race([p, new Promise<undefined>((r) => setTimeout(r, ms))]);
const hook = async <T>(f: () => Promise<T>, ms = 5000) => within(f(), ms);

// The serial text: the tool's copy of what the guest wrote (the page's hook hands it over in pieces).
let serial = '';
let serialTotal = 0;
let scan = '';
const pump = async () => {
  const d = await hook(() => page.evaluate(() => globalThis.__stress?.drain() ?? ''));
  if (d) {
    serial = (serial + d).slice(-200_000);
    serialTotal += d.length;
    // Guest lines a load prints to be counted (images/stress: `GOBUILD rc=<status> <seconds>s`, or `<ms>ms`, per `go build`).
    scan += d;
    let end = Math.max(0, scan.length - 40);
    for (const m of scan.matchAll(/GOBUILD rc=(\d+) (\d+)(m?s)\b/g)) { emit({ type: 'event', t: secs(), kind: 'gobuild', text: `rc=${m[1]} ${m[2]}${m[3]}` }); end = m.index! + m[0].length; }
    scan = scan.slice(end);
  }
  return d ?? '';
};
const stateOf = () => hook(() => page.evaluate(() => [document.body.dataset.state, document.getElementById('message-text')?.textContent] as const));
let typing: Promise<void> = Promise.resolve();
/** Types a line on the serial terminal, one at a time. */
const type = (t: string) => {
  const p = typing.then(async () => {
    await hook(async () => {
      await page.locator('.xterm').click({ timeout: 4000 });
      await page.keyboard.type(t + '\n', { delay: 2 });
    }, 60_000);
  });
  typing = p.catch(() => {});
  return p;
};
const until = async (re: RegExp, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    await pump();
    if (re.test(serial)) return true;
    const st = await stateOf();
    if (st && (st[0] === 'crashed' || st[0] === 'failed')) {
      event('state', `${st[0]}: ${st[1]}`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

let finished = false;
function finish() {
  if (finished) return 0;
  finished = true;
  const r = analyze(records, opt);
  emit({ type: 'end', t: secs(), findings: r.findings, summary: r.summary });
  console.log(`\n${report(r)}`);
  return r.findings.length ? 1 : 0;
}

if (fromFile) {
  const r = await loadSnapshotFile(page, fromFile, core);
  emit({ type: 'event', t: secs(), kind: 'restored', text: JSON.stringify(r) });
  say(`restored ${JSON.stringify(r)}`);
} else if (!(await until(/login: /, 300_000))) {
  // A boot that stops short: say whether the machine still ran (steps, uptime, per-vCPU liveness), twice 10 s apart.
  for (let i = 0; i < 2; i++) {
    if (i) await new Promise((r) => setTimeout(r, 10_000));
    const st = await hook(() => page.evaluate(() => globalThis.__stress?.state())).catch((e) => ({ error: String(e) }));
    event('boot-stall', JSON.stringify({ page: await stateOf().catch(() => null), hook: st }));
    say(`boot stall ${i}: ${JSON.stringify(st).slice(0, 1500)}`);
  }
  finish();
  stop(2, `no login prompt; the console ended: ${JSON.stringify(serial.slice(-3000))}`);
}
if (!fromFile) {
  await type('root');
  if (!(await until(/root@\S+:~# /, 60_000))) {
    finish();
    stop(2, 'no root prompt');
  }
  say('logged in');
}
if (served) {
  if (!served.n) stop(2, `the page didn't load the core ${core}`);
  emit({ type: 'event', t: secs(), kind: 'core', text: `${core} ${served.sha}` });
}
if (saveTo) {
  const made = await saveSnapshotFile(page, saveTo, { scene: 'debian-shell', core, query: query ?? '', disk2: disk2 ?? '', machine, ncpus, bootS: Math.round(secs()) });
  say(`saved ${JSON.stringify(made)}`);
  await within(browser.close(), 10_000);
  server.close();
  process.exit(0);
}

// The guest load. Python (Debian has it) does the mmap/mprotect/munmap churn through libc, with threads.
const CHURN = [
  'import ctypes,mmap,os,threading',
  'L=ctypes.CDLL(None,use_errno=True)',
  'def w():',
  ' while 1:',
  '  m=mmap.mmap(-1,1<<22)',
  '  a=ctypes.addressof(ctypes.c_char.from_buffer(m))',
  '  for i in range(64):',
  '   m[i<<12]=1',
  '   L.mprotect(ctypes.c_void_p(a+(i<<12)),4096,1)',
  '   L.mprotect(ctypes.c_void_p(a+(i<<12)),4096,3)',
  '  del a',
  '  try: m.close()',
  '  except BufferError: pass',
  'for i in range(3): threading.Thread(target=w,daemon=True).start()',
  'while 1:',
  ' if os.fork()==0: os._exit(0)',
  ' os.wait()',
];
const builtin = flag('--no-load') ? [] : [
  'for i in 1 2; do (while :; do :; done) & done',
  '(while :; do /bin/true; /bin/ls / >/dev/null; done) &',
  '(while :; do seq 1 300000 | sort -R | tail -1 >/dev/null; done) &',
  '(while :; do dd if=/dev/urandom bs=64k count=64 2>/dev/null | sha256sum >/dev/null; done) &',
  '(while :; do find /usr -xdev 2>/dev/null | wc -l >/dev/null; done) &',
  // disk: write, sync, read back, delete
  '(while :; do dd if=/dev/urandom of=/var/tmp/stress.bin bs=1M count=32 conv=fsync 2>/dev/null; cat /var/tmp/stress.bin >/dev/null; rm -f /var/tmp/stress.bin; done) &',
  // console output
  '(while :; do seq 1 200; sleep 1; done) &',
  `printf '%s\\n' ${CHURN.map((l) => `'${l}'`).join(' ')} > /var/tmp/churn.py; (python3 /var/tmp/churn.py 2>&1 | head -5) &`,
];
const extra = values('--guest-cmd');
const load = builtin.length + extra.length === 0 ? [] : [
  ...builtin,
  ...extra.map((c) => `( ${c} ) &`),
  // Output that the terminal's echo of the command can't match: a shell left at a continuation prompt by a garbled line never prints it.
  'echo LOAD-STARTED-$((6*7))',
];
for (const l of load) await type(l);
if (load.length && !(await until(/LOAD-STARTED-42/, 120_000))) stop(finishAndCode(2), `the load did not start; the console ends ${JSON.stringify(serial.slice(-3000))}`);
function finishAndCode(c: number) {
  finish();
  return c;
}
say(`load started (${load.length} commands); sampling every ${interval} s for ${seconds} s`);

// The guest's console liveness and its dmesg, from a probe typed every `probeEvery` s.
const seenDmesg = new Set<string>();
let probeN = 0;
// (The marker is split in the command so that the terminal's echo of it doesn't match.)
const DMESG = 'dmesg | grep -iE "watchdog|lockup|stall|blocked for|hung task|panic|BUG:|Oops|Call trace" | tail -n 8 | sed "s/^/D""M> /"';
const probeLoop = async () => {
  while (!finished) {
    await new Promise((r) => setTimeout(r, probeEvery * 1000));
    const n = ++probeN;
    const sent = Date.now();
    const rec = { type: 'probe' as const, t: secs(), n, answeredMs: undefined as number | undefined };
    void type(`${DMESG}; echo PROBE${n}=$((${n}*7+1))`);
    for (; !finished && Date.now() - sent < 60_000;) {
      await new Promise((r) => setTimeout(r, 500));
      await pump();
      if (serial.includes(`PROBE${n}=${n * 7 + 1}`)) {
        rec.answeredMs = Date.now() - sent;
        break;
      }
    }
    emit(rec); // settled: the log has the answer (or none), not the record as sent
    for (const m of serial.matchAll(/DM> (.*)/g)) {
      const line = m[1].trim();
      if (!seenDmesg.has(line)) {
        seenDmesg.add(line);
        emit({ type: 'dmesg', t: secs(), line });
        say(`guest: ${line.slice(0, 200)}`);
      }
    }
    if (rec.answeredMs === undefined) {
      // What the console shows instead (a shell stuck at a continuation prompt, a flood of output, nothing).
      const tail = serial.slice(-300);
      emit({ type: 'event', t: secs(), kind: 'probe-unanswered', text: tail });
      say(`probe ${n} unanswered; console ends ${JSON.stringify(tail)}`);
    }
  }
};
void probeLoop();

const rss = async (): Promise<Proc[] | undefined> => {
  const info = await within(browserCdp!.send('SystemInfo.getProcessInfo'), 3000);
  if (!info) return undefined;
  return info.processInfo.map((p) => {
    let kb = 0;
    try {
      kb = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${p.id}/status`, 'utf8'))?.[1] ?? 0);
    } catch { /* gone */ }
    return { pid: p.id, type: p.type, rssMiB: kb / 1024, cpuTime: p.cpuTime };
  });
};

let lastMips = '';
const began = Date.now(); // `--seconds` counts from here: the boot and the load's start aren't in it
for (let n = 0; Date.now() - began < seconds * 1000; n++) {
  await new Promise((r) => setTimeout(r, Math.max(0, began + (n + 1) * interval * 1000 - Date.now())));
  const t = secs();
  for (const inj of injects) {
    if (!inj.done && t >= inj.at) {
      inj.done = true;
      event('inject', `${inj.kind} for ${inj.for} s`);
      void page.evaluate(([k, ms]) => globalThis.__stress.inject(k, ms), [inj.kind, inj.for * 1000] as const).catch(() => {});
    }
  }
  const s: Sample = { type: 'sample', t, wall: Date.now() };
  const st = await stateOf();
  if (!st) s.unresponsive = true;
  else [s.state, s.message] = [st[0], st[1] ?? undefined];
  if (st) {
    const h = await hook(() => page.evaluate(() => globalThis.__stress.state()));
    if (!h) s.unresponsive = true;
    else {
      s.statusAgeMs = h.statusAge;
      s.statusGapMs = h.statusGap;
      s.lagMs = h.lag;
      s.serialAgeMs = h.serialAge;
      if (h.status) s.status = JSON.parse(h.status) as PageStatus;
      if (h.uaMem !== undefined) s.uaMemMiB = h.uaMem;
    }
    await pump();
  }
  if (cdp && !s.unresponsive) {
    const m = await within(cdp.send('Performance.getMetrics'), 3000);
    const get = (name: string) => m?.metrics.find((x) => x.name === name)?.value;
    if (get('JSHeapUsedSize') !== undefined) [s.jsHeapMiB, s.jsHeapTotalMiB] = [get('JSHeapUsedSize')! / 1048576, get('JSHeapTotalSize')! / 1048576];
  }
  if (browserCdp) s.procs = await rss();
  emit(s);
  const rate = records.filter((r): r is Sample => r.type === 'sample').slice(-2);
  const mips = rate.length === 2 && rate[0].status && rate[1].status && rate[1].status.uptime > rate[0].status.uptime ? ((rate[1].status.steps - rate[0].status.steps) / (rate[1].status.uptime - rate[0].status.uptime) / 1e3).toFixed(0) : '-';
  const [a, b] = rate.length === 2 ? [rate[0].status, rate[1].status] : [undefined, undefined];
  // Over the last interval: the share of steps interpreted, flushes, ms of compiling per second.
  const jit = a && b && b.jitSteps !== undefined && b.steps > a.steps
    ? `, interp ${((1 - (b.jitSteps - a.jitSteps!) / (b.steps - a.steps)) * 100).toFixed(1)}%, flushes +${b.jitFlushes! - a.jitFlushes!} (${b.jitFlushes}), compiling ${((b.jitCompileMs - a.jitCompileMs) / ((b.uptime - a.uptime) / 1000)).toFixed(0)} ms/s, ${(b.jitBytes! / 1048576).toFixed(0)} MiB compiled`
    : '';
  lastMips = `${s.state ?? '?'}${s.unresponsive ? ' UNRESPONSIVE' : ''}, ${mips} MIPS${jit}, JIT ${s.status?.jitBlocks ?? '-'}, status age ${(s.statusAgeMs ?? NaN).toFixed(0)} ms, renderer ${s.procs?.filter((p) => p.type === 'renderer').reduce((a, p) => a + p.rssMiB, 0).toFixed(0) ?? '-'} MiB, vCPU longest ${Math.max(0, ...(s.status?.vcpus ?? []).map((v) => v.maxRunMs)).toFixed(0)} ms`;
  if (n % 6 === 5) say(lastMips);
  if (s.state === 'crashed' || s.state === 'failed') {
    event('state', `${s.state}: ${s.message}`);
    break;
  }
}
const code = finish();
await within(browser.close(), 10_000);
server.close();
process.exit(code);
