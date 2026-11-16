// The browser's memory by process, sampled finely (SNAPZ loop 2b; dev-only): beside a run of `probe.ts` (or anything
// with a persistent profile), every process of the browser whose `--user-data-dir` is <profile> and its descendants, by
// type (browser, renderer, gpu-process, the utility processes by their sub-type), each sample a JSON line:
// `{ t, at, sum, types: { <type>: [rss, anon, shmem] } }` in KiB from /proc/<pid>/smaps_rollup (`t`: ms since the start, `at` the epoch ms;
// several processes of a type summed). Stops when <stop-file> exists, or after MAX_S (900).
//
//   node bench/snapz/memwatch.ts <profile dir> <out.jsonl> [<stop-file>]   (MS: the interval, default 50)
//
// Only node's own modules: it runs from any checkout, so an A/B's arms share one copy.
import { existsSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [profile, out, stopFile] = process.argv.slice(2);
if (!profile || !out) throw new Error('usage: memwatch.ts <profile dir> <out.jsonl> [<stop-file>]');
const MS = Number(process.env.MS ?? 50);
const MAX_S = Number(process.env.MAX_S ?? 900);
const dir = resolve(profile);
writeFileSync(out, '');

/** The type of a Chromium process from its command line. */
function typeOf(cmd: string) {
  const type = /--type=([\w-]+)/.exec(cmd)?.[1];
  if (!type) return 'browser';
  if (type === 'utility') return `utility:${/--utility-sub-type=([\w.]+)/.exec(cmd)?.[1] ?? '?'}`;
  return type;
}

let root: number | undefined;
function pids(): [number, string][] {
  const all = readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number);
  const parent = new Map<number, number>();
  const cmds = new Map<number, string>();
  for (const p of all) {
    try {
      const stat = readFileSync(`/proc/${p}/stat`, 'utf8');
      parent.set(p, Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
      const cmd = readFileSync(`/proc/${p}/cmdline`, 'utf8').replaceAll('\0', ' ');
      cmds.set(p, cmd);
      if (cmd.includes(`--user-data-dir=${dir}`) && !cmd.includes('--type=') && (root === undefined || !cmds.has(root))) root = p;
    } catch { /* gone */ }
  }
  if (root === undefined || !parent.has(root)) return [];
  const list = [root];
  for (let i = 0; i < list.length; i++) for (const [p, pp] of parent) if (pp === list[i]) list.push(p);
  return list.map((p) => [p, typeOf(cmds.get(p) ?? '')]);
}

const field = (text: string, name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0);
const t0 = performance.now();
const timer = setInterval(() => {
  if ((stopFile && existsSync(stopFile)) || performance.now() - t0 > MAX_S * 1000) {
    clearInterval(timer);
    return;
  }
  const types: Record<string, [number, number, number]> = {};
  let sum = 0;
  for (const [p, type] of pids()) {
    try {
      const r = readFileSync(`/proc/${p}/smaps_rollup`, 'utf8');
      const v = (types[type] ??= [0, 0, 0]);
      const rss = field(r, 'Rss');
      v[0] += rss;
      v[1] += field(r, 'Anonymous');
      v[2] += field(r, 'Pss_Shmem');
      sum += rss;
    } catch { /* gone */ }
  }
  if (sum) appendFileSync(out, JSON.stringify({ t: Math.round(performance.now() - t0), at: Date.now(), sum, types }) + '\n');
}, MS);
