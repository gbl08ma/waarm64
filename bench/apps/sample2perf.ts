// macOS `sample` output (its call graph) as `perf script -F comm,tid,ip,sym` lines, one per sample at the top of
// a stack, so bench/apps/perf.ts splits a profile taken on the Mac host as one taken in the dev VM. Stacks whose
// top is a wait (the kernel's waits, `sample` counts wall time) are left out: what remains is time on a CPU.
//   sample <renderer pid> <s> <ms> -file sample.txt   (the page with --js-flags=--perf-basic-prof; V8 writes the map on macOS too)
//   node bench/apps/sample2perf.ts sample.txt > script.txt
//   node bench/apps/perf.ts script.txt --map perf-<pid>.map
import { readFileSync } from 'node:fs';
const WAIT = /^(__psynch_cvwait|__psynch_mutexwait|semaphore_wait_trap|semaphore_timedwait_trap|kevent|kevent64|kevent_id|__semwait_signal|mach_msg2_trap|__workq_kernreturn|__ulock_wait2?|__select|poll|__recvmsg|read|__wait4)\b/;
const lines = readFileSync(process.argv[2], 'utf8').split('\n');
type Node = { depth: number; count: number; kids: number; name: string; ip: string; lib: string };
let thread = '', comm = '';
const stack: Node[] = [];
const out: string[] = [];
const flush = (n: Node) => {
  const self = n.count - n.kids;
  if (self <= 0 || WAIT.test(n.name)) return;
  const sym = n.name === '???' ? '[unknown]' : n.name;
  const line = `${comm} ${thread} ${n.ip} ${sym}`;
  for (let i = 0; i < self; i++) out.push(line);
};
let inGraph = false;
for (const l of lines) {
  if (l.startsWith('Call graph:')) { inGraph = true; continue; }
  if (!inGraph) continue;
  if (/^\S/.test(l) || l.trim() === '') { if (l.trim() !== '' || stack.length) { while (stack.length) flush(stack.pop()!); } if (/^\S/.test(l)) break; continue; }
  const m = /^([\s+!:|]*?)(\d+) (.*)$/.exec(l);
  if (!m) continue;
  const depth = m[1].length, count = Number(m[2]), rest = m[3];
  while (stack.length && stack[stack.length - 1].depth >= depth) flush(stack.pop()!);
  const t = /^Thread_(\d+)(?::?\s+(.*))?/.exec(rest);
  if (t) { thread = t[1]; comm = (t[2] ?? 'thread').replace(/\s+/g, '_').slice(0, 15) || 'thread'; stack.length = 0; continue; }
  if (stack.length) stack[stack.length - 1].kids += count;
  const f = /^(.*?)\s+\(in ([^)]*)\)(?:\s+\+\s+\d+)?\s+\[0x([0-9a-f]+)/.exec(rest);
  stack.push({ depth, count, kids: 0, name: f ? f[1].trim() : rest.trim(), lib: f?.[2] ?? '', ip: f?.[3] ?? '0' });
}
process.stdout.write(out.join('\n') + '\n');
