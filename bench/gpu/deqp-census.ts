// A census of dEQP-GLES2's and GLES3's whole mustpass lists (bench/gpu/REPORT.md "dEQP-GLES's census"): the results of
// bench/gpu/deqp-run.ts runs (any results.json under the directories given, searched recursively, run with PASSED=1 and
// DETAIL), each case's status (a case run twice: its later run's), every case that didn't pass by group and status with
// dEQP's first message for it, and the mustpass cases no run recorded.
//   node bench/gpu/deqp-census.ts <api>=<the mustpass list (/deqp/<api>-main.txt of target/deqp/deqp.ext4)>... --runs <dir>... [--json <out>] [--lists]
// --lists writes tests/deqp/<api>.txt: every case that passed, in the mustpass list's order (the pass lists).
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Run = { api: string; seconds: number; cases: number; counts: Record<string, number>; passed?: string[]; notPassed: string[]; detail?: string[] };

const args = process.argv.slice(2);
const mains = new Map<string, string[]>();
const dirs: string[] = [];
let jsonOut: string | undefined, lists = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--runs') while (args[i + 1] && !args[i + 1].startsWith('--')) dirs.push(args[++i]);
  else if (a === '--json') jsonOut = args[++i];
  else if (a === '--lists') lists = true;
  else if (/^gles[23]=/.test(a)) mains.set(a.slice(0, 5), readFileSync(a.slice(6), 'utf8').split('\n').filter(Boolean));
  else throw new Error(`usage: deqp-census.ts gles2=<list> gles3=<list> --runs <dir>... [--json <out>] [--lists] (not ${a})`);
}

const files = (d: string): string[] => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? files(p) : f === 'results.json' ? [p] : [];
}).sort();
const runs = dirs.flatMap(files).map((f) => ({ f, r: JSON.parse(readFileSync(f, 'utf8')) as Run }));

const root = new URL('../..', import.meta.url).pathname;
const summary: Record<string, unknown> = {};
for (const [api, main] of mains) {
  const status = new Map<string, string>(), detail = new Map<string, string[]>();
  let seconds = 0;
  for (const { f, r } of runs.filter((x) => x.r.api === api)) {
    if (!r.passed) throw new Error(`${f}: run without PASSED=1`);
    seconds += r.seconds;
    for (const c of r.passed) status.set(c, 'Pass');
    for (const l of r.notPassed) { const [c, st] = l.split(' '); status.set(c, st); }
    // DETAIL's lines: `== <case>` then its messages.
    let at: string[] | undefined;
    for (const l of r.detail ?? []) {
      if (l.startsWith('== ')) detail.set(l.slice(3), (at = []));
      else at?.push(l);
    }
  }
  const counts: Record<string, number> = {};
  for (const c of main) { const st = status.get(c) ?? 'NotRun'; counts[st] = (counts[st] ?? 0) + 1; }
  // What didn't pass, by group (the name's second to fourth parts) and status.
  const groups = new Map<string, string[]>();
  for (const c of main) {
    const st = status.get(c) ?? 'NotRun';
    if (st === 'Pass') continue;
    const k = `${st} ${c.split('.').slice(1, 4).join('.')}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(c);
  }
  console.log(`\n${api}: ${main.length} cases, ${Math.round(seconds)} s of runs: ${JSON.stringify(counts)}`);
  for (const [k, cs] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const first = cs.find((c) => detail.has(c));
    console.log(`  ${k}: ${cs.length}${first ? `  [${first.split('.').at(-1)}: ${detail.get(first)!.slice(0, 2).join(' | ').slice(0, 200)}]` : ''}`);
  }
  summary[api] = { cases: main.length, seconds: Math.round(seconds), counts, notPassed: Object.fromEntries([...groups].map(([k, cs]) => [k, cs])),
    detail: Object.fromEntries([...detail].filter(([c]) => status.get(c) !== 'Pass' && status.get(c) !== 'NotSupported')) };
  if (lists) {
    const pass = main.filter((c) => status.get(c) === 'Pass');
    const file = join(root, `tests/deqp/${api}.txt`);
    const head = readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('#'));
    writeFileSync(file, `${[...head, ...pass].join('\n')}\n`);
    console.log(`  ${file}: ${pass.length} cases`);
  }
}
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(summary, null, 1)}\n`);
