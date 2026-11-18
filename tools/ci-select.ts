// The fast lane's selection and the areas map's check (tests/areas.ts; docs/testing.md "Tiers").
//   node tools/ci-select.ts --check              the map against the tree: every tracked file under an area, every glob
//                                                matching, heavy and topic files real; target/ci/timings.json's slow
//                                                smoke files and fully skipped ones as warnings (T0, scripts/ci.sh)
//   node tools/ci-select.ts [--since REV] [--files F...] [--all]
//                                                what the fast lane runs for the changes: shell assignments for
//                                                scripts/ci-fast.sh's eval. The changes: the commits since REV
//                                                (default: the merge base with the upstream, else origin/main), the
//                                                index, the working tree and untracked files; --files names them
//                                                instead; --all selects every area
//   node tools/ci-select.ts --record TIMINGS JS_RC RUST_RC WALL FILE...
//                                                appends the fast lane's run to bench/results/local/ci-history.jsonl
//                                                (the changes, the areas, the files run and failed): a later
//                                                scripts/ci.sh failure on a change whose fast lane passed is a miss
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import { AREAS, HEAVY_SECONDS, TOPIC, type Area } from '../tests/areas.ts';

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(Boolean);
/** matchesGlob's `**` passes over dotfiles: a file matches as it is or with its segments' leading dots dropped. */
const glob = (file: string, g: string) => matchesGlob(file, g) || matchesGlob(file.replace(/(^|\/)\./g, '$1'), g);
const matches = (file: string, globs: readonly string[] = []) => globs.some((g) => glob(file, g));
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const array = (name: string, xs: Iterable<string>) => `${name}=(${[...xs].map(quote).join(' ')})`;

/** Every test file npm test runs (package.json's glob: the files directly in tests/). */
const testFiles = () => readdirSync('tests').filter((f) => f.endsWith('.test.ts')).map((f) => `tests/${f}`).sort();
const heavyOf = (a: Area, tests: string[]) => tests.filter((t) => matches(t, a.heavy));
const allHeavy = (tests: string[]) => new Set(Object.values(AREAS).flatMap((a) => heavyOf(a, tests)));
const isTopic = (t: string) => matches(t, TOPIC);

function check(): number {
  const errors: string[] = [];
  const warnings: string[] = [];
  // Tracked files and new ones not ignored: a new file needs its area before it is committed.
  const tracked = [...git('ls-files'), ...git('ls-files', '--others', '--exclude-standard')].filter((f) => !f.endsWith('.md') && existsSync(f));
  const tests = testFiles();
  for (const [name, a] of Object.entries(AREAS)) {
    for (const g of a.src) if (!tracked.some((f) => glob(f, g))) errors.push(`area ${name}: src ${g} matches no tracked file`);
    for (const g of a.heavy ?? []) if (!tests.some((t) => matchesGlob(t, g))) errors.push(`area ${name}: heavy ${g} matches no test file`);
    for (const s of [...(a.push ?? []), ...(a.end ?? [])]) {
      const script = s.split(' ')[0];
      if (!existsSync(`scripts/${script}`)) errors.push(`area ${name}: scripts/${script} doesn't exist`);
    }
  }
  for (const f of tracked) if (!Object.values(AREAS).some((a) => matches(f, a.src))) errors.push(`${f} is in no area (tests/areas.ts)`);
  const topicScripts = readdirSync('scripts').filter((s) => /^ci-.+\.sh$/.test(s) && s !== 'ci-fast.sh').map((s) => readFileSync(`scripts/${s}`, 'utf8')).join('\n');
  for (const g of TOPIC) {
    const hit = tests.filter((t) => matchesGlob(t, g));
    if (!hit.length) errors.push(`TOPIC ${g} matches no test file`);
    for (const t of hit) if (!topicScripts.includes(t)) errors.push(`TOPIC ${t}: no topic script (scripts/ci-*.sh) runs it`);
  }
  const heavy = allHeavy(tests);
  for (const t of tests) if (heavy.has(t) && isTopic(t)) errors.push(`${t} is both heavy and topic-only`);
  // The timings of the last scripts/ci.sh (tools/test-timings.ts): a smoke file grown slow, a topic file that ran.
  const path = 'target/ci/timings.json';
  if (existsSync(path)) {
    const { date, files } = JSON.parse(readFileSync(path, 'utf8')) as { date: string; files: Record<string, { s: number; tests: number; skipped: number }> };
    for (const [t, { s, tests: n, skipped }] of Object.entries(files)) {
      if (!heavy.has(t) && !isTopic(t) && s > HEAVY_SECONDS) warnings.push(`${t} took ${s.toFixed(0)} s in scripts/ci.sh (${date.slice(0, 10)}): past the smoke set's ${HEAVY_SECONDS} s, make it heavy in its area`);
      if (isTopic(t) && skipped < n) warnings.push(`${t} ran ${n - skipped} test(s) in scripts/ci.sh: not topic-only`);
    }
  }
  for (const w of warnings) console.log(`warning: ${w}`);
  for (const e of errors) console.error(`error: ${e}`);
  if (errors.length) console.error(`\ntests/areas.ts: ${errors.length} error(s) (docs/testing.md "Tiers")`);
  else console.log(`tests/areas.ts: ${Object.keys(AREAS).length} areas, ${tests.length} test files (${heavy.size} heavy, ${tests.filter(isTopic).length} topic-only), ${tracked.length} files: OK`);
  return errors.length ? 1 : 0;
}

function changedFiles(since: string | undefined): string[] {
  const base = since ?? (() => {
    for (const up of ['@{upstream}', 'origin/main']) {
      try {
        return git('merge-base', 'HEAD', up)[0];
      } catch { /* no such ref */ }
    }
    return 'HEAD';
  })();
  return [...new Set([
    ...git('diff', '--name-only', base),
    ...git('diff', '--name-only', '--cached'),
    ...git('ls-files', '--others', '--exclude-standard'),
  ])].sort();
}

/** The test files that import a test helper (directly), so a helper's change selects them. */
function importersOf(helper: string, tests: string[]): string[] {
  const name = helper.replace(/^tests\//, '');
  return tests.filter((t) => {
    const src = readFileSync(t, 'utf8');
    return src.includes(`'./${name}'`) || src.includes(`"./${name}"`);
  });
}

function select(args: string[]): void {
  const files = args.includes('--files') ? args.slice(args.indexOf('--files') + 1).filter((a) => !a.startsWith('--')) : undefined;
  const since = args.includes('--since') ? args[args.indexOf('--since') + 1] : undefined;
  const changed = files ?? changedFiles(since);
  const tests = testFiles();
  const heavy = allHeavy(tests);
  const areas = new Set<string>();
  const selected = new Set(tests.filter((t) => !heavy.has(t) && !isTopic(t))); // the smoke set
  const smoke = selected.size;
  const own = new Set<string>(); // changed test files and helpers' importers
  const outside: string[] = [];
  let ui = false;
  for (const f of changed) {
    if (f.endsWith('.md')) {
      // A docs change runs nothing but the catalog's check when it quotes the page ([words](ui:key)).
      if (existsSync(f) && readFileSync(f, 'utf8').includes('](ui:')) ui = true;
      continue;
    }
    if (tests.includes(f)) own.add(f);
    else if (/^tests\/[^/]+\.ts$/.test(f) && existsSync(f)) for (const t of importersOf(f, tests)) own.add(t);
    const hit = Object.entries(AREAS).filter(([, a]) => matches(f, a.src));
    if (!hit.length) outside.push(f);
    for (const [name] of hit) areas.add(name);
  }
  if (args.includes('--all')) for (const name of Object.keys(AREAS)) areas.add(name);
  const picked = [...areas].map((n) => AREAS[n]);
  const all = picked.some((a) => a.all);
  for (const t of tests) if ((all || picked.some((a) => matches(t, a.heavy))) && !isTopic(t)) selected.add(t);
  for (const t of own) selected.add(t);
  const code = changed.filter((f) => !f.endsWith('.md'));
  const cargo = new Set(picked.flatMap((a) => a.cargo ?? []));
  const push = new Set(picked.flatMap((a) => a.push ?? []));
  const end = new Set(picked.flatMap((a) => a.end ?? []));
  console.log(array('CHANGED', changed));
  console.log(array('AREAS', [...areas].sort()));
  console.log(array('OUTSIDE', outside));
  console.log(array('CARGO', [...cargo].sort()));
  console.log(array('TESTS', code.length || own.size ? [...selected].sort() : []));
  console.log(`SMOKE=${code.length || own.size ? smoke : 0}`);
  console.log(`DOCS_ONLY=${code.length ? 0 : 1}`);
  console.log(`UI_QUOTES=${ui ? 1 : 0}`);
  console.log(`ALL=${all ? 1 : 0}`);
  console.log(array('PUSH', [...push].sort()));
  console.log(array('END', [...end].sort()));
}

function record([timings, js, rust, wall, ...changed]: string[]): void {
  const files = existsSync(timings) ? (JSON.parse(readFileSync(timings, 'utf8')) as { files: Record<string, { s: number; failed: number }> }).files : {};
  const areas = Object.entries(AREAS).filter(([, a]) => changed.some((f) => matches(f, a.src))).map(([n]) => n);
  const line = {
    date: new Date().toISOString(),
    tier: 'fast',
    commit: git('rev-parse', '--short', 'HEAD')[0],
    dirty: git('status', '--porcelain').length > 0,
    changed,
    areas,
    tests: Object.keys(files).length,
    failed: Object.entries(files).filter(([, f]) => f.failed).map(([t]) => t),
    js: Number(js),
    crates: Number(rust),
    s: Number(wall),
  };
  mkdirSync('bench/results/local', { recursive: true });
  appendFileSync('bench/results/local/ci-history.jsonl', `${JSON.stringify(line)}
`);
}

const args = process.argv.slice(2);
if (args[0] === '--check') process.exitCode = check();
else if (args[0] === '--record') record(args.slice(1));
else select(args);
