// The CPU counters of a process tree (Chromium under a benchmark's Node harness), for samples quieter than wall
// time (docs/benchmarking.md "Counters"): on macOS instructions retired, cycles, CPU time, their share on performance
// cores and energy, from bench/mac/procstat.c's helper (`PROCSTAT`, default ./procstat: bench/run-mac.sh builds it
// there); on Linux CPU time only, from /proc. Cumulative since each process started: a sample is the difference of
// two reads, so a process that ends between them drops out of it (a renderer lives as long as its page).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';

/** `all`: every process of the tree; `renderer`: its renderers (the page, its workers, the JIT's code). */
export type Counters = { instructions: number; cycles: number; cpuNs: number; pInstructions: number; pCycles: number; pCpuNs: number; energyNj: number };
export type ProcStat = { all: Counters; renderer: Counters; pids: number };

const zero = (): Counters => ({ instructions: 0, cycles: 0, cpuNs: 0, pInstructions: 0, pCycles: 0, pCpuNs: 0, energyNj: 0 });
const helper = () => process.env.PROCSTAT ?? './procstat';

/** Whether this host gives more than CPU time. */
export const hasCounters = () => process.platform === 'darwin' && existsSync(helper());

export function procStat(root: number): ProcStat {
  const kids = new Map<number, number[]>();
  const args = new Map<number, string>();
  for (const l of execFileSync('ps', ['-Axo', 'pid=,ppid=,args='], { encoding: 'utf8', maxBuffer: 16 << 20 }).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    if (!m) continue;
    args.set(Number(m[1]), m[3]);
    kids.set(Number(m[2]), [...(kids.get(Number(m[2])) ?? []), Number(m[1])]);
  }
  const tree: number[] = [];
  for (const q = [...(kids.get(root) ?? [])]; q.length; ) {
    const p = q.pop()!;
    if (/^ps /.test(args.get(p)!)) continue; // this read's own
    tree.push(p);
    q.push(...(kids.get(p) ?? []));
  }
  const out: ProcStat = { all: zero(), renderer: zero(), pids: tree.length };
  const add = (pid: number, c: Counters) => {
    for (const to of args.get(pid)!.includes('--type=renderer') ? [out.all, out.renderer] : [out.all]) {
      for (const k of Object.keys(c) as (keyof Counters)[]) to[k] += c[k];
    }
  };
  if (!tree.length) return out;
  if (hasCounters()) {
    for (const l of execFileSync(helper(), tree.map(String), { encoding: 'utf8' }).split('\n')) {
      const f = l.split(' ').map(Number);
      if (f.length < 10) continue;
      add(f[0], { instructions: f[1], cycles: f[2], cpuNs: f[3] + f[4], pInstructions: f[5], pCycles: f[6], pCpuNs: f[7] + f[8], energyNj: f[9] });
    }
  } else if (process.platform === 'linux') {
    for (const pid of tree) {
      let stat;
      try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { continue; }
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // utime and stime: fields 14 and 15, in 10 ms ticks
      add(pid, { ...zero(), cpuNs: (Number(f[11]) + Number(f[12])) * 1e7 });
    }
  }
  return out;
}

/** A local server whose every GET answers `procStat(root)` as JSON, for a bench page's workers (CORS, so a
 * cross-origin isolated page may fetch it). */
export function procServer(root: number): Promise<Server> {
  const s = createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(procStat(root)));
  });
  return new Promise((ok) => s.listen(0, '127.0.0.1', () => ok(s)));
}
