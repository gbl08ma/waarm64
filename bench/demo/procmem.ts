// A browser's memory from /proc, for bench/demo/run.ts: the Chromium launched with a given profile directory (the
// process whose command line names it) and every process under it (zygotes, renderers, the GPU and utility
// processes), summed: RSS (shared pages counted in each process that maps them, so an overcount) and PSS (shared
// pages split between their processes: the honest total). Linux only.
import { readdirSync, readFileSync } from 'node:fs';

const read = (path: string) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined; // the process exited
  }
};

/** The browser process started with `--user-data-dir=<profile>` (not one of its children, which carry `--type=`). */
export function browserPid(profile: string): number | undefined {
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    const cmd = read(`/proc/${d}/cmdline`)?.split('\0') ?? [];
    if (/chrom/.test(cmd[0] ?? '') && cmd.some((a) => a.includes(profile)) && !cmd.some((a) => a.startsWith('--type='))) return Number(d);
  }
  return undefined;
}

/** `root` and its descendants. */
function tree(root: number): number[] {
  const children = new Map<number, number[]>();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    const stat = read(`/proc/${d}/stat`);
    if (!stat) continue;
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    const list = children.get(ppid) ?? [];
    list.push(Number(d));
    children.set(ppid, list);
  }
  const out: number[] = [];
  const walk = (p: number) => {
    out.push(p);
    for (const c of children.get(p) ?? []) walk(c);
  };
  walk(root);
  return out;
}

export type Mem = { rssMiB: number; pssMiB: number; processes: number; rendererPssMiB: number };

/** The tree's memory now; `rendererPssMiB` is its largest renderer's PSS (the page's, where the guest lives). */
export function treeMemory(root: number): Mem {
  let rss = 0, pss = 0, n = 0, renderer = 0;
  for (const pid of tree(root)) {
    const roll = read(`/proc/${pid}/smaps_rollup`);
    if (!roll) continue;
    const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(roll)?.[1] ?? 0);
    rss += kb('Rss');
    pss += kb('Pss');
    n++;
    if (read(`/proc/${pid}/cmdline`)?.includes('--type=renderer')) renderer = Math.max(renderer, kb('Pss'));
  }
  const mib = (k: number) => Math.round(k / 1024);
  return { rssMiB: mib(rss), pssMiB: mib(pss), processes: n, rendererPssMiB: mib(renderer) };
}

/** Samples the tree every `ms` until stopped: the peaks seen, and the latest sample. */
export function memSampler(root: number, ms = 500) {
  const peak: Mem = { rssMiB: 0, pssMiB: 0, processes: 0, rendererPssMiB: 0 };
  let last = treeMemory(root);
  const take = () => {
    last = treeMemory(root);
    for (const k of Object.keys(peak) as (keyof Mem)[]) peak[k] = Math.max(peak[k], last[k]);
  };
  take();
  const timer = setInterval(take, ms);
  return {
    now: () => (take(), { ...last }),
    stop: () => (clearInterval(timer), take(), { ...peak }),
  };
}
