// How promptly something in a cross-origin-isolated page can store 0 in a spinning thread's stop word at a deadline
// (PERF loop 53, bench/boot/REPORT.md): the setter candidates for parallel SMP's code without `acc` (docs/jit.md
// "Preemption"). N spinner workers stand in for vCPUs in compiled code (each polls its word in a loop); one setter
// worker keeps a deadline per spinner ~1 ms apart (a guest tick at HZ=1000) and, by the mechanism under test, wakes at
// the earliest and stores 0 in each word that is due; the spinner answers on an ack word, so the setter times both its
// own wake-up (late against the deadline) and the store seen (its round trip to the spinner and back), on one clock.
//   node bench/run.ts --page bench/boot/timer-setters.html [--query='ms=3000&cpus=4&only=wait,spin']
import type { SetterJob, SetterResult } from './timer-setters-worker.ts';

const params = new URLSearchParams(location.search);
const log = document.getElementById('log')!;
const say = (s: string) => (log.textContent += s + '\n');
const MECHANISMS = ['wait', 'spin', 'halve', 'waitAsync', 'setTimeout'] as const;

async function run() {
  const ms = Number(params.get('ms') ?? 3000);
  const cpus = Number(params.get('cpus') ?? 4);
  const gap = Number(params.get('gap') ?? 1000);
  const only = params.get('only')?.split(',') ?? MECHANISMS;
  const sab = new SharedArrayBuffer(4096);
  const i32 = new Int32Array(sab);
  const spinners = Array.from({ length: cpus }, (_, i) => {
    const w = new Worker(new URL('./timer-setters-worker.ts', import.meta.url), { type: 'module' });
    w.postMessage({ role: 'spin', sab, cpu: i } satisfies SetterJob);
    return w;
  });
  const results: { name: string; unit: string; params: object; samples: number[] }[] = [];
  for (const m of MECHANISMS.filter((x) => only.includes(x))) {
    const w = new Worker(new URL('./timer-setters-worker.ts', import.meta.url), { type: 'module' });
    const r = await new Promise<SetterResult>((done) => {
      w.onmessage = (e: MessageEvent<SetterResult>) => done(e.data);
      w.postMessage({ role: 'set', sab, cpus, ms, gap, mechanism: m } satisfies SetterJob);
    });
    w.terminate();
    for (const [what, xs] of [['wake', r.wake], ['seen', r.seen]] as const) {
      const s = [...xs].sort((a, b) => a - b);
      const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
      const mean = s.reduce((a, b) => a + b, 0) / s.length;
      const st = { n: s.length, mean: +mean.toFixed(1), p50: +q(0.5).toFixed(1), p90: +q(0.9).toFixed(1), p99: +q(0.99).toFixed(1), p999: +q(0.999).toFixed(1), max: +s[s.length - 1].toFixed(1), over1ms: s.filter((x) => x > 1000).length };
      say(`${m} ${what}: ${JSON.stringify(st)}`);
      // The setter's own cost: its share of a core spent spinning before deadlines, and its waits a deadline.
      const cost = { spinShare: +(r.spinUs / r.wallUs).toFixed(4), waitsPerDeadline: +(r.waits / r.wake.length).toFixed(2) };
      if (what === 'wake') say(`${m} cost: ${JSON.stringify(cost)}`);
      results.push({ name: `setter_${m}_${what}_us`, unit: 'µs', params: { cpus, ms, gap, ...st, ...cost }, samples: xs });
    }
  }
  Atomics.store(i32, 0, 1); // the spinners' end
  spinners.forEach((w) => w.terminate());
  return results;
}

run().then(
  (results) => Object.assign(window, { benchResult: { results, crossOriginIsolated, userAgent: navigator.userAgent } }),
  (e) => Object.assign(window, { benchResult: { error: String(e) } }),
);
