// The stress test's verdicts (bench/stress/stress.ts writes the log, summarize.ts and the runner's
// end call this): from a run's JSONL records to a list of findings. Pure functions, unit-tested
// with synthetic runs (tests/stress-analyze.test.ts).

export type Vcpu = { cpu: number; chunks: number; runningMs: number; sinceReturnMs: number; maxRunMs: number; maxRunAt: number; maxHostMs: number; maxHostAt: number };
/** web/app/protocol.ts `Status` as the page's `data-status` carries it. */
export type PageStatus = { ncpus: number; ramMiB: number; uptime: number; steps: number; jitBlocks: number; jitFlushes?: number; jitCompileMs: number; jitSteps?: number; jitBytes?: number; irqs: number; loopMaxMs: number; loopAgeMs: number; vcpus: Vcpu[] };
export type Proc = { pid: number; type: string; rssMiB: number; cpuTime: number };

export type Sample = {
  type: 'sample';
  /** Seconds since the run began; `wall` is the epoch ms of the sample. */
  t: number;
  wall: number;
  state?: string;
  message?: string;
  /** The page's main thread didn't answer within the timeout. */
  unresponsive?: boolean;
  status?: PageStatus;
  /** ms since a status message reached the page, and the longest gap between two since the last sample. */
  statusAgeMs?: number;
  statusGapMs?: number;
  /** The main thread's longest timer lag since the last sample. */
  lagMs?: number;
  /** ms since the guest's console last sent output. */
  serialAgeMs?: number;
  /** CDP `Performance.getMetrics` (main thread) in MiB or counts. */
  jsHeapMiB?: number;
  jsHeapTotalMiB?: number;
  /** `performance.measureUserAgentSpecificMemory()`'s last result, MiB, and when it finished (t). */
  uaMemMiB?: number;
  procs?: Proc[];
};
export type Probe = { type: 'probe'; t: number; n: number; answeredMs?: number };
export type Dmesg = { type: 'dmesg'; t: number; line: string };
export type Event = { type: 'event'; t: number; kind: string; text: string };
export type Rec = Sample | Probe | Dmesg | Event | { type: 'meta' | 'end'; [k: string]: unknown };

export type Options = {
  /** A vCPU chunk, host-side handling or loop iteration longer than this is a stall (ms). */
  stallMs: number;
  /** No status for this long with the machine running is a frozen page (ms). */
  freezeMs: number;
  /** Samples before this (s) don't count towards the memory and speed trends. */
  warmupS: number;
  /** Memory growth flagged above this slope (MiB per hour) and this total (MiB) over the trend window. */
  memSlopeMiBH: number;
  memGrowthMiB: number;
  /** The memory trend needs this much run after the warm-up (s): JIT and page-cache warm-up look like growth over minutes. */
  memWindowS: number;
  /** MIPS of the last third below this fraction of the first third's is a slowdown. */
  slowdownRatio: number;
  /** A probe unanswered for this long: the guest's console is unresponsive (s). */
  probeTimeoutS: number;
};
export const DEFAULTS: Options = { stallMs: 2000, freezeMs: 10_000, warmupS: 150, memSlopeMiBH: 200, memGrowthMiB: 200, memWindowS: 600, slowdownRatio: 0.7, probeTimeoutS: 60 };

export type Finding = { kind: 'crash' | 'freeze' | 'vcpu-stall' | 'loop-stall' | 'memory-growth' | 'slowdown' | 'guest-lockup' | 'guest-unresponsive' | 'harness'; t: number; detail: string };

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

/** Least-squares slope of y over x. */
export function slope(x: number[], y: number[]) {
  const n = x.length;
  if (n < 2) return 0;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    den += (x[i] - mx) ** 2;
  }
  return den ? num / den : 0;
}

/** Renderer memory the run watches: the renderer processes' RSS (workers and the wasm memory live there), else the main thread's JS heap. */
export const memoryMiB = (s: Sample) => {
  const r = s.procs?.filter((p) => p.type === 'renderer');
  return r?.length ? r.reduce((a, p) => a + p.rssMiB, 0) : s.uaMemMiB ?? s.jsHeapMiB;
};

/** MIPS between consecutive samples with fresh statuses, at the later sample's `t`. */
export function mipsSeries(samples: Sample[]) {
  const out: { t: number; mips: number }[] = [];
  let prev: Sample | undefined;
  for (const s of samples) {
    if (!s.status) continue;
    if (prev && s.status.uptime > prev.status!.uptime) out.push({ t: s.t, mips: (s.status.steps - prev.status!.steps) / (s.status.uptime - prev.status!.uptime) / 1e3 });
    prev = s;
  }
  return out;
}

export function analyze(recs: Rec[], opt: Options = DEFAULTS) {
  const samples = recs.filter((r): r is Sample => r.type === 'sample');
  const probes = recs.filter((r): r is Probe => r.type === 'probe');
  const findings: Finding[] = [];
  const add = (kind: Finding['kind'], t: number, detail: string) => findings.push({ kind, t, detail });
  const meta = recs.find((r) => r.type === 'meta') as { epoch?: number } | undefined;
  const t0 = meta?.epoch ?? samples[0]?.wall ?? 0;
  const tOf = (wall: number) => (wall - t0) / 1000;

  // A crash: the page's state, or an event that says so.
  for (const s of samples) {
    if (s.state === 'crashed' || s.state === 'failed') {
      add('crash', s.t, `page state ${s.state}: ${s.message ?? '(no message)'}`);
      break;
    }
  }
  for (const e of recs) if (e.type === 'event' && /panic|pageerror|RuntimeError|unreachable/i.test(`${(e as Event).kind} ${(e as Event).text}`)) add('crash', (e as Event).t, `${(e as Event).kind}: ${(e as Event).text.slice(0, 400)}`);

  // Frozen page: runs of samples with no answer or no fresh status while the machine ran.
  let run: { from: Sample; to: Sample; main: boolean } | undefined;
  const frozenSpans: [number, number][] = []; // a probe typed into a frozen page is lost, not the guest's fault
  const closeRun = (end?: Sample) => {
    if (!run) return;
    if (end) run.to = end; // the first sample that heard again
    const answered = probes.filter((p) => p.answeredMs !== undefined && p.t + p.answeredMs / 1000 >= run!.from.t && p.t + p.answeredMs / 1000 <= run!.to.t + 1);
    const guest = run.main ? "the main thread doesn't answer, so the guest's console can't be read" : answered.length ? `the guest's console answered ${answered.length} probe(s) meanwhile: a live guest behind a frozen display` : "no probe answered meanwhile (the console goes through the same worker, so the guest's state is unknown)";
    frozenSpans.push([run.from.t, run.to.t]);
    add('freeze', run.from.t, `${run.main ? 'main thread' : 'machine worker or status path'} silent for ${(run.to.t - run.from.t).toFixed(0)} s${end ? '' : ' and still'} (t ${run.from.t.toFixed(0)} to ${run.to.t.toFixed(0)}); ${guest}`);
    run = undefined;
  };
  for (const s of samples) {
    const frozen = s.unresponsive || (s.state === 'running' && (s.statusAgeMs ?? 0) > opt.freezeMs);
    if (frozen) {
      const main = !!s.unresponsive;
      if (run && run.main !== main) closeRun(s);
      run = run ? { ...run, to: s } : { from: s, to: s, main };
    } else closeRun(s);
  }
  closeRun();

  // vCPU and loop stalls: cumulative maxima and a chunk in progress, each reported once.
  const seen = new Set<string>();
  const longest = new Map<number, { run: number; host: number }>();
  let loopMax = 0;
  for (const s of samples) {
    const st = s.status;
    if (!st) continue;
    loopMax = Math.max(loopMax, st.loopMaxMs, st.loopAgeMs);
    if (st.loopMaxMs > opt.stallMs || st.loopAgeMs > opt.stallMs) {
      const key = `loop${Math.round(s.t / 30)}`;
      if (!seen.has(key)) add('loop-stall', s.t, `the machine worker's run loop: ${Math.max(st.loopMaxMs, st.loopAgeMs).toFixed(0)} ms between iterations`), seen.add(key);
    }
    for (const v of st.vcpus ?? []) {
      const l = longest.get(v.cpu) ?? { run: 0, host: 0 };
      l.run = Math.max(l.run, v.maxRunMs, v.runningMs);
      l.host = Math.max(l.host, v.maxHostMs);
      longest.set(v.cpu, l);
      const once = (key: string, text: string, t: number) => {
        if (!seen.has(key)) add('vcpu-stall', t, `vCPU ${v.cpu}: ${text}`), seen.add(key);
      };
      if (v.maxRunMs > opt.stallMs) once(`run${v.cpu}@${v.maxRunAt}`, `one vm_run_cpu call took ${v.maxRunMs.toFixed(0)} ms (ended at t ${tOf(v.maxRunAt).toFixed(0)})`, tOf(v.maxRunAt));
      if (v.maxHostMs > opt.stallMs) once(`host${v.cpu}@${v.maxHostAt}`, `${v.maxHostMs.toFixed(0)} ms of host-side handling after an exit (from t ${tOf(v.maxHostAt).toFixed(0)})`, tOf(v.maxHostAt));
      if (v.runningMs > opt.stallMs) once(`now${v.cpu}@${Math.round(s.t / 30)}`, `inside one vm_run_cpu call for ${v.runningMs.toFixed(0)} ms and counting (t ${s.t.toFixed(0)})`, s.t);
    }
  }

  // Memory: the trend after the warm-up.
  const mem = samples.filter((s) => s.t >= opt.warmupS && memoryMiB(s) !== undefined).map((s) => ({ t: s.t, m: memoryMiB(s)! }));
  let memSlope = 0;
  if (mem.length >= 5) {
    memSlope = slope(mem.map((p) => p.t), mem.map((p) => p.m)) * 3600;
    const growth = memSlope * ((mem.at(-1)!.t - mem[0].t) / 3600);
    if (memSlope > opt.memSlopeMiBH && growth > opt.memGrowthMiB && mem.at(-1)!.t - mem[0].t >= opt.memWindowS) add('memory-growth', mem.at(-1)!.t, `${memSlope.toFixed(0)} MiB/h (${mem[0].m.toFixed(0)} to ${mem.at(-1)!.m.toFixed(0)} MiB over ${(mem.at(-1)!.t - mem[0].t).toFixed(0)} s)`);
  }

  // Speed: the first third against the last after the warm-up, and dips.
  const mips = mipsSeries(samples).filter((p) => p.t >= opt.warmupS);
  let mipsFirst = NaN;
  let mipsLast = NaN;
  if (mips.length >= 9) {
    const k = Math.floor(mips.length / 3);
    mipsFirst = median(mips.slice(0, k).map((p) => p.mips));
    mipsLast = median(mips.slice(-k).map((p) => p.mips));
    if (mipsLast < opt.slowdownRatio * mipsFirst) add('slowdown', mips.at(-1)!.t, `median ${mipsFirst.toFixed(0)} MIPS in the first third of the run, ${mipsLast.toFixed(0)} in the last`);
  }
  if (mips.length >= 5) {
    const med = median(mips.map((p) => p.mips));
    let dip = 0;
    for (const p of mips) {
      dip = p.mips < 0.1 * med ? dip + 1 : 0;
      if (dip === 3) add('slowdown', p.t, `MIPS under 10% of the median (${med.toFixed(0)}) for 3 samples in a row`);
    }
  }

  // The guest's own reports and its console's liveness.
  const lock = /watchdog|lockup|rcu.*(stall|detected)|blocked for more than|hung task|soft lockup|kernel panic|BUG:|Oops|Call trace/i;
  for (const r of recs) if (r.type === 'dmesg' && lock.test((r as Dmesg).line)) add('guest-lockup', (r as Dmesg).t, (r as Dmesg).line.slice(0, 300));
  const lastT = samples.at(-1)?.t ?? 0;
  for (const p of probes) {
    if (frozenSpans.some(([a, b]) => p.t >= a - 1 && p.t <= b)) continue;
    if (p.answeredMs === undefined && lastT - p.t > opt.probeTimeoutS) add('guest-unresponsive', p.t, `probe ${p.n}: no answer on the console within ${opt.probeTimeoutS} s`);
    else if (p.answeredMs !== undefined && p.answeredMs > opt.probeTimeoutS * 1000) add('guest-unresponsive', p.t, `probe ${p.n}: answered after ${(p.answeredMs / 1000).toFixed(0)} s`);
  }

  const last = samples.at(-1);
  const summary = {
    samples: samples.length,
    seconds: lastT,
    state: last?.state,
    mips: { median: median(mipsSeries(samples).map((p) => p.mips)), first: mipsFirst, last: mipsLast },
    memoryMiB: { first: mem[0]?.m, last: mem.at(-1)?.m, slopePerHour: memSlope },
    jitBlocks: last?.status?.jitBlocks,
    longestChunkMs: Object.fromEntries([...longest].map(([c, l]) => [c, l])),
    loopMaxMs: loopMax,
    maxStatusGapMs: Math.max(0, ...samples.map((s) => s.statusGapMs ?? 0)),
    maxMainLagMs: Math.max(0, ...samples.map((s) => s.lagMs ?? 0)),
    probes: { sent: probes.length, answered: probes.filter((p) => p.answeredMs !== undefined).length, maxLatencyMs: Math.max(0, ...probes.map((p) => p.answeredMs ?? 0)) },
  };
  findings.sort((a, b) => a.t - b.t);
  return { findings, summary };
}

export function report(r: ReturnType<typeof analyze>) {
  const { summary: s, findings } = r;
  const f = (n: number | undefined, d = 0) => (n === undefined || Number.isNaN(n) ? '-' : n.toFixed(d));
  const lines = [
    `samples ${s.samples} over ${f(s.seconds)} s, final page state ${s.state ?? '?'}`,
    `MIPS median ${f(s.mips.median)} (first third ${f(s.mips.first)}, last third ${f(s.mips.last)}); JIT blocks ${s.jitBlocks ?? '-'}`,
    `renderer memory ${f(s.memoryMiB.first)} to ${f(s.memoryMiB.last)} MiB after warm-up, slope ${f(s.memoryMiB.slopePerHour)} MiB/h`,
    `longest vm_run_cpu / host handling per vCPU (ms): ${Object.entries(s.longestChunkMs).map(([c, l]) => `${c}: ${f(l.run)}/${f(l.host)}`).join('  ') || '-'}`,
    `run loop max ${f(s.loopMaxMs)} ms, status gap max ${f(s.maxStatusGapMs)} ms, main-thread lag max ${f(s.maxMainLagMs)} ms`,
    `guest console probes: ${s.probes.answered}/${s.probes.sent} answered, slowest ${f(s.probes.maxLatencyMs)} ms`,
    findings.length ? `FINDINGS (${findings.length}):` : 'no findings',
    ...findings.map((x) => `  [${x.kind}] t=${x.t.toFixed(0)} s: ${x.detail}`),
  ];
  return lines.join('\n');
}
