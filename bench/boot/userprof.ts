// Alpine's userspace benchmark in Node under the JIT, for profiling (docs/benchmarking.md
// "Profiling"): per phase, the time, steps, MIPS and counters, and CLOCK_MONOTONIC times of the
// phase markers so `perf record -k mono` samples can be split by phase (bench/boot/userprof-perf.ts).
//   [WASM=core.wasm] [OUT=marks.json] node [--perf-prof] bench/boot/userprof.ts
//   IN=marks.json node bench/boot/userprof.ts       # print a saved run again
// With a core built with one of bench/boot/results/m8-userprof/*.patch (diagnostics, not for
// commit) it also prints why blocks returned to the dispatcher and the transfers between blocks.
import { readFileSync, writeFileSync } from 'node:fs';
import { bootVm } from '../../web/vm.ts';
import { Exit } from '../../web/core.ts';
import { DISTROS, guestDevices } from '../../web/test-guests.ts';

type Stats = { tlbMisses: number; tlbFlushes: number; jit: { steps: number; dispatches: number; blocks: number; tierUps: number; modules: number; bytes: number; compileNs: number; regionBlocks: number } };
type Mark = { name: string; ms: number; mono: number; steps: number; stats: Stats; report: { op: string; calls: number }[] };
let marks: Mark[] = [];

if (process.env.IN) {
  marks = JSON.parse(readFileSync(process.env.IN, 'utf8')).marks;
} else {
  const IMAGES = new URL('../../target/images/', import.meta.url);
  const wasm = readFileSync(process.env.WASM ?? new URL('../../target/wasm32-unknown-unknown/release/waarm64_core.wasm', import.meta.url));
  const a = DISTROS.alpine;
  const vm = await bootVm(wasm, { ramSize: 1 << 30, kernel: readFileSync(new URL(a.kernel, IMAGES)), initrd: readFileSync(new URL(a.initrd, IMAGES)), cmdline: a.cmdline, devices: guestDevices(new URL('alpine-user/rootfs-user.ext4', IMAGES).href), jit: 1 });
  let out = '', steps = 0, scanned = 0;
  const t0 = performance.now();
  const mark = (name: string) => marks.push({ name, ms: performance.now() - t0, mono: Number(process.hrtime.bigint()) / 1e9, steps, stats: vm.stats() as Stats, report: vm.helperReport() });
  mark('begin');
  for (;;) {
    const r = vm.run(1_000_000);
    steps += r.steps;
    out += vm.drain();
    const end = out.lastIndexOf('\n') + 1;
    for (const m of out.slice(scanned, end).matchAll(/waarm64: ([^\r\n]*)/g)) mark(m[1]);
    scanned = end;
    if (r.kind === Exit.DEVICE) { await vm.settle(); continue; }
    if (r.kind === Exit.BUDGET || r.kind === Exit.TX_FULL) continue;
    break;
  }
  mark('power off');
  vm.close();
  console.log(out.split('\n').filter((l) => /^(compress|binarytrees|fannkuch|nbody|spectralnorm|churn|sqlite):/.test(l)).join('\n'));
  if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify({ date: new Date().toISOString(), node: process.version, marks }, null, 1));
}

/** The phases: consecutive markers more than 50 ms apart. */
const phases = marks.slice(1).map((m, i) => ({ from: marks[i], to: m })).filter((p) => p.to.ms - p.from.ms > 50);
const title = (p: { from: Mark; to: Mark }) => (p.from.name === 'begin' ? 'boot' : p.from.name.replace(/ start$/, '').replace(/^alpine-user.*/, 'init').replace('test ok', 'shutdown'));
for (const p of phases) {
  const d = (f: (s: Stats) => number) => f(p.to.stats) - f(p.from.stats);
  const st = p.to.steps - p.from.steps, ms = p.to.ms - p.from.ms, disp = d((s) => s.jit.dispatches);
  console.log(`${title(p)}: ${(ms / 1000).toFixed(2)} s, ${(st / 1e6).toFixed(0)}M steps, ${(st / ms / 1000).toFixed(0)} MIPS, dispatches ${(disp / 1e6).toFixed(2)}M (1 per ${(st / disp).toFixed(0)}), interpreted ${((st - d((s) => s.jit.steps)) / 1e6).toFixed(2)}M, TLB misses ${(d((s) => s.tlbMisses) / 1e3).toFixed(0)}K, flushes ${d((s) => s.tlbFlushes)}, regions ${d((s) => s.jit.blocks)} (${d((s) => s.jit.regionBlocks)} blocks, ${d((s) => s.jit.tierUps)} tier-ups) in ${d((s) => s.jit.modules)} modules, ${(d((s) => s.jit.bytes) / 1e6).toFixed(1)} MB, ${(d((s) => s.jit.compileNs) / 1e6).toFixed(0)} ms installing`);
}

// The helper calls per phase, and the diagnostic lines a patched core adds to the report:
// D (dispatches by reason), L and B (the block that returned), W, P (PCs), X (transfers).
const rep = (m: Mark) => new Map(m.report.map((h) => [h.op, h.calls]));
const REASONS = ['start of a run', 'after interpreted steps', 'instruction TLB: empty', 'instruction TLB: another page', 'jump cache: empty', 'jump cache: another block', 'other (a block returned although its successor was ready)'];
const NEXT: Record<string, string> = { 0: 'no static successor', 1: 'one successor', 2: 'two successors', 9: 'unknown' };
const XFER = ['direct, same page', 'direct, next page (physically contiguous)', 'direct, through the jump cache (successor compiled later)', 'BR', 'BLR', 'RET', 'direct, another page by its VA', 'region edge, forward', 'region back-edge'];
for (const p of phases) {
  const [a, b] = [rep(p.from), rep(p.to)];
  const d = [...b].map(([k, n]) => [k, n - (a.get(k) ?? 0)] as [string, number]).filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1]);
  const of = (c: string) => d.filter(([k]) => k.startsWith(`${c}:`));
  const sum = (c: string) => of(c).reduce((s, [, n]) => s + n, 0);
  const st = p.to.stats.jit.steps - p.from.stats.jit.steps;
  console.log(`\n== ${title(p)}`);
  console.log(`  helper calls: ${d.filter(([k]) => !/^[A-Z]:/.test(k)).slice(0, 8).map(([k, n]) => `${k} ${(n / 1e6).toFixed(2)}M`).join(', ')}`);
  if (sum('X')) {
    const x = (i: number) => (b.get(`X:${i}`) ?? 0) - (a.get(`X:${i}`) ?? 0);
    const blocks = x(9) + x(7) + x(8) - (x(10) || 0);
    console.log(`  ${(blocks / 1e6).toFixed(0)}M block executions (${(st / blocks).toFixed(1)} instructions each); transfers per 1000 instructions:`);
    XFER.forEach((name, i) => console.log(`  ${(1000 * x(i) / st).toFixed(1).padStart(7)}  ${name}`));
    console.log(`  ${(1000 * (p.to.stats.jit.dispatches - p.from.stats.jit.dispatches) / st).toFixed(1).padStart(7)}  from the dispatcher`);
    if (x(11) + x(12)) console.log(`  leaving a function: calls ${(1000 * x(11) / st).toFixed(1)} to the same page, ${(1000 * x(12) / st).toFixed(1)} to another; returns ${(1000 * x(13) / st).toFixed(1)} within the page, ${(1000 * x(14) / st).toFixed(1)} to another; other direct branches to another page ${(1000 * x(15) / st).toFixed(1)}`);
    if (x(10)) console.log(`  ${(1000 * x(10) / st).toFixed(1).padStart(7)}  through a head compiled alone to its region (a second tail call)`);
  }
  const tot = sum('D');
  if (!tot) continue;
  console.log(`  ${(tot / 1e6).toFixed(2)}M dispatches into compiled blocks, by reason:`);
  for (const [k, n] of of('D')) {
    const [, r, el, ret] = k.split(':');
    if (n / tot > 0.003) console.log(`  ${(100 * n / tot).toFixed(1).padStart(6)}%  EL${el} ${REASONS[+r]}${+ret ? ', pc == x30' : ''}`);
  }
  for (const [, n] of of('W')) console.log(`  ${(100 * n / tot).toFixed(1).padStart(6)}%  of all: the target isn't at the PA the returning block's static successor was assumed at`);
  const lt = sum('L');
  for (const [k, n] of of('L').slice(0, 8)) {
    const [, op, kind] = k.split(':');
    if (n / lt > 0.01) console.log(`  "other", by the returning block's last instruction: ${op.padEnd(10)} ${(100 * n / lt).toFixed(1).padStart(5)}%  (${NEXT[kind]})`);
  }
  for (const [k, n] of of('P').slice(0, Number(process.env.PCS ?? 5))) {
    const [, r, el, , pc] = k.split(':');
    console.log(`  ${(n / 1e6).toFixed(2).padStart(7)}M  at ${pc}  EL${el} ${REASONS[+r]}`);
  }
}
