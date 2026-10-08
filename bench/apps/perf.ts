// Splits a perf profile of the page's renderer (bench/apps/chromium.ts --perf N) by thread and category:
// guest code by V8 tier, the core's dispatcher, interpreter, compiler, TLB, V8's own work.
//   perf script -i perf.data -F comm,tid,ip,sym > script.txt
//   node bench/apps/perf.ts script.txt [--map /tmp/perf-<pid>.map] [--top N]
// --map: resolve the samples perf leaves [unknown] in V8's code space against V8's map itself (perf gives up on
// its overlapping entries: code space reused after a flush, the same module's code logged by every worker).
// Threads: the DedicatedWorkers with guest code are the vCPU workers; V8's background compiles
// (TurboFan tier-up, module compiles) run on ThreadPoolForegroundWorker.
import { readFileSync } from 'node:fs';
const file = process.argv[2];
const top = Number(process.argv[process.argv.indexOf('--top') + 1] || 0);
const mapFile = process.argv.includes('--map') ? process.argv[process.argv.indexOf('--map') + 1] : undefined;
// The map's entries by start, each with its order in the file: an address takes the latest entry that covers it.
const entries: { start: number; end: number; name: string; seq: number }[] = [];
if (mapFile) {
  let seq = 0;
  for (const l of readFileSync(mapFile, 'utf8').split('\n')) {
    const m = /^([0-9a-f]+) ([0-9a-f]+) (.*)$/.exec(l);
    if (m) { const start = parseInt(m[1], 16); entries.push({ start, end: start + parseInt(m[2], 16), name: m[3], seq: seq++ }); }
  }
  entries.sort((a, b) => a.start - b.start);
}
const maxLen = entries.reduce((x, e) => Math.max(x, e.end - e.start), 0);
const resolve = (ip: number) => {
  let lo = 0, hi = entries.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (entries[mid].start <= ip) lo = mid + 1; else hi = mid; }
  let best: (typeof entries)[0] | undefined;
  for (let i = lo - 1; i >= 0 && entries[i].start > ip - maxLen; i--) if (ip < entries[i].end && (!best || entries[i].seq > best.seq)) best = entries[i];
  return best?.name;
};
const cat = (sym: string) => {
  let m;
  if ((m = /^JS:0x([0-9a-f]+)_pa0x[0-9a-f]+-\d+-(\w+)/.exec(sym))) return `guest code (${BigInt('0x' + m[1]) >> 63n ? 'kernel' : 'user'}): ${m[2]}`;
  if (/webpc_core3jit(5steps|NtB\w+_5Cache(4miss|5enter)|3key)|xmiss/.test(sym)) return 'core: dispatcher (jit::steps, Cache::miss)';
  if (/webpc_core3jit5block|webpc_core3jit4emit|webpc_core3jit4wasm|Cache(4emit|7install|5flush|10invalidate|6module|4plan|4sync)|Table4sync|jit_hot/.test(sym)) return 'core: compiling (block, emit)';
  if (/jit_exec_|webpc_core3jit5count|jit_(ldst|load|store|sys|msr|mrs)/.test(sym)) return 'core: helpers\' entry';
  if (/webpc_core3mmu4walk|Mmu4miss|Tlb\d+(fill|flush|drop)/.test(sym)) return 'core: TLB miss, walk, flush';
  if (/webpc_core6interp|webpc_core3mmu|webpc_core3mem|webpc_core2fp|webpc_core6crypto|webpc_core3cpu|webpc_core6decode/.test(sym)) return 'core: interpreter and helper bodies';
  if (/webpc_core2vm|webpc_core6virtio|webpc_core3gic|webpc_core5timer|webpc_core5pl011|vm_run/.test(sym)) return 'core: run loop and devices';
  if (/dlmalloc|hashbrown|alloc|core\d|std\d|memcpy|memset|memmove|compiler_builtins/.test(sym) && sym.startsWith('JS:')) return 'core: allocator, std';
  if (sym.startsWith('JS:')) return 'core/JS other';
  if (sym.startsWith('Builtin:')) return `V8 builtins (${/Liftoff|CallIndirect|Wasm/.test(sym) ? 'wasm' : 'other'})`;
  if (sym === '[unknown]') return 'unknown (V8 native, Chromium, kernel)';
  return 'native (V8, Chromium)';
};
type Row = { comm: string; n: number; cats: Map<string, number>; syms: Map<string, number> };
const threads = new Map<string, Row>();
for (const l of readFileSync(file, 'utf8').split('\n')) {
  const m = /^\s*(\S+)\s+(\d+)\s+([0-9a-f]+)\s+(.*)$/.exec(l);
  if (!m) continue;
  const [, comm, tid, ip] = m;
  let sym = m[4];
  if (sym.trim() === '[unknown]' && entries.length) sym = resolve(parseInt(ip, 16)) ?? sym;
  const t = threads.get(tid) ?? threads.set(tid, { comm, n: 0, cats: new Map(), syms: new Map() }).get(tid)!;
  t.n++;
  const c = cat(sym.trim());
  t.cats.set(c, (t.cats.get(c) ?? 0) + 1);
  const s = /_pa0x/.test(sym) ? `guest ${/-(\w+)$/.exec(sym)?.[1]}` : sym.trim();
  t.syms.set(s, (t.syms.get(s) ?? 0) + 1);
}
const pct = (a: number, b: number) => ((a / b) * 100).toFixed(1).padStart(5);
const vcpus = [...threads.entries()].filter(([, t]) => [...t.cats.keys()].some((c) => c.startsWith('guest code')) && t.n > 1000);
const rest = [...threads.entries()].filter(([k]) => !vcpus.some(([v]) => v === k));
const sum = (rows: [string, Row][]) => {
  const cats = new Map<string, number>(), syms = new Map<string, number>();
  let n = 0;
  for (const [, t] of rows) {
    n += t.n;
    for (const [k, v] of t.cats) cats.set(k, (cats.get(k) ?? 0) + v);
    for (const [k, v] of t.syms) syms.set(k, (syms.get(k) ?? 0) + v);
  }
  return { n, cats, syms };
};
const all = sum(vcpus);
console.log(`vCPU threads ${vcpus.map(([k, t]) => `${k} (${t.n})`).join(', ')}: ${all.n} samples`);
for (const [c, v] of [...all.cats].sort((a, b) => b[1] - a[1])) console.log(`${pct(v, all.n)}%  ${c}`);
if (top) {
  console.log(`\ntop ${top} symbols on the vCPU threads:`);
  for (const [s, v] of [...all.syms].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${pct(v, all.n)}%  ${s.slice(0, 140)}`);
}
const other = new Map<string, number>();
for (const [, t] of rest) other.set(t.comm, (other.get(t.comm) ?? 0) + t.n);
console.log(`\nother threads (samples): ${[...other].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(', ')}`);
const bg = sum(rest.filter(([, t]) => t.comm.startsWith('ThreadPoolFore')));
if (top && bg.n) {
  console.log(`top symbols on ThreadPoolForegroundWorker:`);
  for (const [s, v] of [...bg.syms].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`${pct(v, bg.n)}%  ${s.slice(0, 140)}`);
}
