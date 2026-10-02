// Splits a perf profile of bench/boot/userprof.ts by category (guest code by V8 tier, the core's
// dispatcher, interpreter, compiler, V8's own work) and by benchmark phase (docs/benchmarking.md
// "Profiling"). From a scratch directory:
//   perf record -k mono -F 2000 -o x.data env OUT=marks.json node --perf-prof <repo>/bench/boot/userprof.ts
//   perf inject -j -i x.data -o x.jit.data
//   perf script -i x.jit.data -F comm,tid,time,ip,sym,dso > script.txt
//   node <repo>/bench/boot/userprof-perf.ts script.txt marks.json [--top N] [--guest]
// --top: each phase's top symbols; --guest: guest code by page (TurboFan/Liftoff samples).
import { readFileSync } from 'node:fs';
const [file, marksFile] = process.argv.slice(2);
const top = Number(process.argv[process.argv.indexOf('--top') + 1] || 0);
const marks = JSON.parse(readFileSync(marksFile, 'utf8')).marks as { name: string; mono: number }[];
const phases = marks.slice(0, -1).map((m, i) => ({ name: i === 0 ? 'boot' : m.name.replace(/ start$/, '').replace(/^alpine-user.*/, 'init').replace('test ok', 'shutdown'), from: m.mono, to: marks[i + 1].mono })).filter((p) => p.to - p.from > 0.05);
const cat = (comm: string, sym: string) => {
  if (comm !== 'node-MainThread') return comm.startsWith('node-V8Worker') ? 'V8 background (TurboFan)' : 'other threads';
  let m;
  if ((m = /^JS:0x[0-9a-f]+_pa0x[0-9a-f]+-\d+-(\w+)/.exec(sym))) return `guest code: ${m[1]}`;
  if (/webpc_core3jit(5steps|NtB\w+_5Cache(4miss|5enter)|3key)/.test(sym)) return 'core: dispatcher (jit::steps, Cache::miss)';
  if (/webpc_core3jit5block|webpc_core3jit4emit|webpc_core3jit4wasm|Cache(4emit|7install|5flush|10invalidate|6module)|jit_hot/.test(sym)) return 'core: compiling (block, emit)';
  if (/jit_exec_|webpc_core3jit5count|jit_(ldst|load|store|sys|msr|mrs)/.test(sym)) return 'core: helpers\' entry';
  if (/webpc_core3mmu4walk|Mmu4miss/.test(sym)) return 'core: TLB miss and walk';
  if (/webpc_core6interp|webpc_core3mmu|webpc_core3mem|webpc_core2fp|webpc_core6crypto|webpc_core3cpu|webpc_core6decode/.test(sym)) return 'core: interpreter and helper bodies';
  if (/webpc_core2vm|webpc_core6virtio|webpc_core3gic|webpc_core5timer|webpc_core5pl011|vm_run/.test(sym)) return 'core: run loop and devices';
  if (/dlmalloc|hashbrown|alloc|core\d|std\d|memcpy|memset|memmove|compiler_builtins/.test(sym) && sym.startsWith('JS:')) return 'core: allocator, std';
  if (sym.startsWith('JS:')) return `core/JS other`;
  if (sym.startsWith('Builtin:')) return `V8 builtins (${/Liftoff|CallIndirect|Wasm/.test(sym) ? 'wasm' : 'other'})`;
  return 'V8 native (libnode, kernel, unknown)';
};
const by = new Map<string, number[]>();
const syms = new Map<string, number>();
const guest = new Map<string, number[]>();
let n = 0;
for (const l of readFileSync(file, 'utf8').split('\n')) {
  const m = /^\s*(\S+)\s+(\d+)\s+([\d.]+):\s+([0-9a-f]+)\s+(.*?)(?:\s+\((.*)\))?$/.exec(l);
  if (!m) continue;
  const [, comm, , time, , sym] = m;
  const t = Number(time);
  const p = phases.findIndex((x) => t >= x.from && t < x.to);
  if (p < 0) continue;
  n++;
  const c = cat(comm, sym);
  if (!by.has(c)) by.set(c, phases.map(() => 0));
  by.get(c)![p]++;
  if (top && comm === 'node-MainThread') {
    const k = `${phases[p].name}\t${sym.replace(/-\d+-(turbofan|liftoff)$/, ' [$1]')}`;
    syms.set(k, (syms.get(k) ?? 0) + 1);
  }
  const g = /^JS:(0x[0-9a-f]+)_pa0x[0-9a-f]+-\d+-(\w+)/.exec(sym);
  if (g) {
    const k = `${phases[p].name}\t${g[1].slice(0, -3)}`;
    if (!guest.has(k)) guest.set(k, [0, 0]);
    guest.get(k)![g[2] === 'turbofan' ? 0 : 1]++;
  }
}
const main = phases.map((_, i) => [...by].filter(([c]) => !/background|other threads/.test(c)).reduce((a, [, v]) => a + v[i], 0));
console.log(`${n} samples; % of each phase's main-thread samples (background threads: % of the same base)`);
console.log(['category'.padEnd(46), ...phases.map((p) => p.name.padStart(9)), 'all'.padStart(8)].join(' '));
for (const [c, v] of [...by].sort((a, b) => b[1].reduce((x, y) => x + y) - a[1].reduce((x, y) => x + y))) {
  console.log([c.padEnd(46), ...v.map((x, i) => (main[i] ? (100 * x / main[i]).toFixed(1) : '-').padStart(9)), (100 * v.reduce((x, y) => x + y) / main.reduce((x, y) => x + y)).toFixed(1).padStart(8)].join(' '));
}
console.log(['main-thread samples'.padEnd(46), ...main.map((x) => String(x).padStart(9))].join(' '));
console.log(['seconds'.padEnd(46), ...phases.map((p) => (p.to - p.from).toFixed(2).padStart(9))].join(' '));
if (top) {
  for (const p of phases) {
    const rows = [...syms].filter(([k]) => k.startsWith(`${p.name}\t`)).sort((a, b) => b[1] - a[1]).slice(0, top);
    const tot = main[phases.indexOf(p)];
    console.log(`\n== ${p.name}: top symbols (main thread, ${tot} samples)`);
    for (const [k, v] of rows) console.log(`${(100 * v / tot).toFixed(2).padStart(6)}%  ${k.split('\t')[1].slice(0, 150)}`);
  }
}
if (process.argv.includes('--guest')) {
  for (const p of phases) {
    const rows = [...guest].filter(([k]) => k.startsWith(`${p.name}\t`)).sort((a, b) => b[1][0] + b[1][1] - a[1][0] - a[1][1]);
    const tot = rows.reduce((a, [, v]) => a + v[0] + v[1], 0);
    console.log(`\n== ${p.name}: guest code by page (${tot} samples, ${rows.length} pages; turbofan/liftoff)`);
    for (const [k, v] of rows.slice(0, 12)) console.log(`${(100 * (v[0] + v[1]) / tot).toFixed(1).padStart(6)}%  ${k.split('\t')[1]}000  ${v[0]}/${v[1]}`);
  }
}
