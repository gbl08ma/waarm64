// dEQP on the page (docs/testing.md "dEQP"): GLES2's and GLES3's pass lists (tests/deqp/<api>.txt: cases that pass
// on the page today, every one expected to pass) through bench/gpu/deqp-run.ts, on the guest images/deqp/build.sh makes
// (target/deqp/guest.qcow2: Arch Linux with Mesa's virgl driver; dEQP on target/deqp/deqp.ext4). A machine per API,
// both at once. Opt-in with WAARM64_DEQP=1 (scripts/ci-deqp.sh).
// The lists are sampled unless WAARM64_DEQP_FULL=1 (`ci-deqp.sh --full`): every STRIDE-th case of each group (the name's
// second to fourth parts) from an offset of its own drawn from a seed, at least one a group, in the list's order, so
// runs together cover the lists; the seed is printed, and WAARM64_DEQP_SEED=<n> runs that sample again. A case that
// fails in a sample is looked into at once, or filed as an issue and taken out of the list.
// Timing cases (TIMING: `flush_finish`, whose calibration's draw times jump on a busy host) are taken out of the lists,
// every one run (a group of its own each, a sample takes them all anyway) after the list, alone: one dEQP process, once
// no other machine runs (deqp-run.ts LATE, LATE_GO=stdin).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, test } from 'node:test';
import { cases as listCases, sample, seedFrom } from './deqp-lists.ts';

const root = new URL('..', import.meta.url).pathname;
const skip = process.env.WAARM64_DEQP !== '1' ? 'SKIPPED: scripts/ci-deqp.sh runs it (WAARM64_DEQP=1)' : false;

const FULL = process.env.WAARM64_DEQP_FULL === '1';
const STRIDE = 8;
const SEED = seedFrom(process.env.WAARM64_DEQP_SEED);
// dEQP processes a machine runs at once, the list dealt to them in blocks of 16 cases (bench/gpu/deqp-run.ts JOBS,
// JOBS_BLOCK: contiguous quarters left GLES3's slow precision group to one; the guest has 4 vCPUs): one waits on the device for much of a case. A 448-case GLES3 slice took 48 s at 1, 30 s at 2, 27 s at 4
// (2026-11-09); more processes at once also put the renderer's contexts side by side, which one process never does.
// WAARM64_DEQP_JOBS says otherwise.
const JOBS = Number(process.env.WAARM64_DEQP_JOBS ?? 4);
// The seconds dEQP may run a list: ~3 times what it takes at 4 processes (~0.06 s a case on the dev VM's SwiftShader)
// and a minute, so a hung device (every later fence held: the guest waits for good) fails the test in minutes, with
// the guest's serial log kept.
const limit = (n: number) => Math.round(60 + n * 0.18);

const TIMING = /^dEQP-GLES[23]\.functional\.flush_finish\./;
// A timing list's seconds: ~15 s a case alone (2026-11-13), three times, and a minute.
const lateLimit = (n: number) => 60 + n * 45;

// The machines' runs: `main` while a list runs, `waiting` with its timing cases held, `late` while they run. A machine's
// are let go when no other is in `main` or `late`.
const runs = new Map<string, { state: 'main' | 'waiting' | 'late'; go?: () => void }>();
function pump() {
  if ([...runs.values()].some((r) => r.state !== 'waiting')) return;
  const next = [...runs.values()][0];
  if (!next) return;
  next.state = 'late';
  next.go?.();
}

type Result = { cases: number; counts: Record<string, number>; notPassed: string[]; stoppedAt?: string; detail?: string[] };

/** deqp-run.ts on `file`, then `late`'s timing cases when `runs` lets them go; its result, or an error with its output
 * kept in `out`. */
function run(api: string, file: string, late: string | undefined, out: string, limitS: number, timeoutS: number) {
  return new Promise<Result>((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'bench/gpu/deqp-run.ts', api, 'target/deqp/guest.qcow2', out], {
      cwd: root, env: { ...process.env, CASES: file, ...(late ? { LATE: late, LATE_GO: 'stdin' } : {}), LIMIT_S: String(limitS), JOBS: String(JOBS), JOBS_BLOCK: '16', DETAIL: '20' }, timeout: timeoutS * 1000,
    });
    const me = runs.get(api)!;
    child.stdin.on('error', () => {});
    me.go = () => child.stdin.end('go\n');
    let output = '';
    const keep = (b: Buffer) => {
      output = (output + b.toString()).slice(-4000);
      if (me.state === 'main' && output.includes('deqp-run: late cases waiting')) {
        me.state = 'waiting';
        pump();
      }
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`deqp-run.ts failed (its output, a screenshot and the serial log: ${out}): ${output.slice(-2000)}`));
      resolve(JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')) as Result);
    });
  });
}

// Both machines at once: the two lists' runs are about as long as each other's (GLES3's list is longer, its cases
// faster), and a run is mostly the guest's and SwiftShader's. A run's timing cases may wait for the other's list.
suite('dEQP on the page', { concurrency: 2 }, () => {
  const lists = ['gles2', 'gles3'].map((api) => {
    const all = listCases(readFileSync(join(root, `tests/deqp/${api}.txt`), 'utf8'));
    const timing = all.filter((c) => TIMING.test(c));
    const rest = all.filter((c) => !TIMING.test(c));
    const picked = FULL ? rest : sample(rest, STRIDE, SEED);
    return { api, all, timing, picked, limitS: Math.max(limit(picked.length), lateLimit(timing.length)) };
  });
  // Every machine's list, then each one's timing cases in turn, and the boots and reads around them.
  const timeoutS = Math.max(...lists.map((l) => l.limitS)) + lists.reduce((a, l) => a + lateLimit(l.timing.length), 0) + 300;
  if (!skip) for (const { api } of lists) runs.set(api, { state: 'main' });
  for (const { api, all, timing, picked, limitS } of lists) {
    const cases = [...picked, ...timing];
    test(`dEQP-${api.toUpperCase()}'s pass list passes on the page`, { skip, timeout: (timeoutS + 60) * 1000 }, async (t) => {
      const which = `${FULL ? `all ${cases.length}` : `a sample of ${cases.length} of ${all.length} (WAARM64_DEQP_SEED=${SEED})`}, ${timing.length} timing cases alone`;
      t.diagnostic(which);
      console.log(`dEQP-${api.toUpperCase()}: ${which}`);
      const out = mkdtempSync(join(tmpdir(), `waarm64-deqp-${api}-`));
      let passed = false;
      try {
        const file = join(out, 'cases.txt'), late = join(out, 'late.txt');
        writeFileSync(file, `${picked.join('\n')}\n`);
        if (timing.length) writeFileSync(late, `${timing.join('\n')}\n`);
        const res = await run(api, file, timing.length ? late : undefined, out, limitS, timeoutS);
        assert.equal(res.cases, cases.length, 'the guest read the whole list');
        assert.equal(res.stoppedAt, undefined, `dEQP stopped at ${res.stoppedAt}`);
        assert.deepEqual(res.notPassed.slice(0, 30), [], `${res.notPassed.length} of ${cases.length} didn't pass (${which}): ${(res.detail ?? []).join('\n').slice(0, 3000)}`);
        assert.equal(res.counts.Pass, cases.length);
        passed = true;
      } finally {
        runs.delete(api);
        pump();
        if (passed) rmSync(out, { recursive: true, force: true });
      }
    });
  }
});
