// The stress test's verdicts (bench/stress/analyze.ts) on synthetic runs: each fault is found, a clean run isn't flagged.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, type Options, type PageStatus, type Rec, type Sample, type Vcpu } from '../bench/stress/analyze.ts';

const EPOCH = 1_000_000_000_000;
const OPT: Options = { stallMs: 2000, freezeMs: 10_000, warmupS: 60, memSlopeMiBH: 200, memGrowthMiB: 200, memWindowS: 600, slowdownRatio: 0.7, probeTimeoutS: 60 };
const vcpu = (cpu: number, over: Partial<Vcpu> = {}): Vcpu => ({ cpu, chunks: 100, runningMs: 0, sinceReturnMs: 5, maxRunMs: 300, maxRunAt: EPOCH + 5000, maxHostMs: 2, maxHostAt: EPOCH + 5000, ...over });
/** `n` samples 5 s apart: 1000 MIPS (1e6 steps per ms of uptime), flat memory, no faults; `mod` plants the fault. */
function run(n: number, mod: (s: Sample, i: number) => void = () => {}): Rec[] {
  const recs: Rec[] = [{ type: 'meta', epoch: EPOCH }];
  for (let i = 1; i <= n; i++) {
    const status: PageStatus = { ncpus: 4, ramMiB: 1024, uptime: i * 5000, steps: i * 5000 * 1e6, jitBlocks: 1000, jitCompileMs: 1, irqs: 1, loopMaxMs: 50, loopAgeMs: 10, vcpus: [0, 1, 2, 3].map((c) => vcpu(c)) };
    const s: Sample = { type: 'sample', t: i * 5, wall: EPOCH + i * 5000, state: 'running', status, statusAgeMs: 300, statusGapMs: 1100, lagMs: 5, procs: [{ pid: 1, type: 'renderer', rssMiB: 2500, cpuTime: i }] };
    mod(s, i);
    recs.push(s);
  }
  return recs;
}
const kinds = (recs: Rec[]) => [...new Set(analyze(recs, OPT).findings.map((f) => f.kind))].sort();

test('a clean run has no findings', () => {
  assert.deepEqual(kinds(run(200)), []);
});

test('a crashed page and a panic event', () => {
  assert.deepEqual(kinds(run(20, (s, i) => { if (i > 10) { s.state = 'crashed'; s.message = 'vCPU 1: unreachable: core panic: DSB waited'; } })), ['crash']);
  assert.deepEqual(kinds([...run(5), { type: 'event', t: 26, kind: 'pageerror', text: 'RuntimeError: unreachable' }]), ['crash']);
});

test('a frozen main thread, and a frozen status path with a live guest', () => {
  const main = analyze(run(40, (s, i) => { if (i >= 20 && i < 30) { s.unresponsive = true; delete s.status; } }), OPT);
  const lost = run(40, (s, i) => { if (i >= 20 && i < 30) { s.unresponsive = true; delete s.status; } });
  lost.push({ type: 'probe', t: 110, n: 1 }); // typed into the frozen page: not the guest's silence
  assert.deepEqual(kinds(lost), ['freeze']);
  assert.equal(main.findings.filter((f) => f.kind === 'freeze').length, 1);
  assert.match(main.findings[0].detail, /main thread/);
  const recs = run(40, (s, i) => { if (i >= 20 && i < 30) s.statusAgeMs = 12_000 + (i - 20) * 5000; });
  recs.push({ type: 'probe', t: 110, n: 1, answeredMs: 3000 });
  const worker = analyze(recs, OPT);
  assert.equal(worker.findings.length, 1);
  assert.match(worker.findings[0].detail, /live guest behind a frozen display/);
});

test('a stalled vCPU: a long chunk, host handling, one in progress; a stalled loop', () => {
  assert.deepEqual(kinds(run(20, (s, i) => { if (i >= 10) s.status!.vcpus[2] = vcpu(2, { maxRunMs: 4200, maxRunAt: EPOCH + 50_000 }); })), ['vcpu-stall']);
  assert.deepEqual(kinds(run(20, (s, i) => { if (i >= 10) s.status!.vcpus[1] = vcpu(1, { maxHostMs: 3000 }); })), ['vcpu-stall']);
  assert.deepEqual(kinds(run(20, (s, i) => { if (i === 10) s.status!.vcpus[0] = vcpu(0, { runningMs: 2600 }); })), ['vcpu-stall']);
  assert.deepEqual(kinds(run(20, (s) => { s.status!.loopMaxMs = 2500; })), ['loop-stall']);
});

test('memory growth over a long window, not over a short one', () => {
  const grow = (s: Sample, i: number) => { s.procs![0].rssMiB = 2500 + i * 2; }; // 1440 MiB/h
  assert.deepEqual(kinds(run(400, grow)), ['memory-growth']);
  assert.deepEqual(kinds(run(60, grow)), []);
});

test('a slowdown, and a dip', () => {
  assert.deepEqual(kinds(run(200, (s, i) => { s.status!.steps = i < 100 ? i * 5000 * 1e6 : 100 * 5000 * 1e6 + (i - 100) * 5000 * 4e5; })), ['slowdown']);
  assert.deepEqual(kinds(run(100, (s, i) => { s.status!.steps = i < 50 || i > 60 ? i * 5000 * 1e6 : 50 * 5000 * 1e6 + (i - 50) * 5000 * 1e3; })), ['slowdown']);
});

test("the guest's lockup reports and a silent console", () => {
  const recs = run(30);
  recs.push({ type: 'dmesg', t: 60, line: '[ 61.0] watchdog: Watchdog detected hard LOCKUP on cpu 1' }, { type: 'probe', t: 10, n: 1 });
  assert.deepEqual(kinds(recs), ['guest-lockup', 'guest-unresponsive']);
});
