// dEQP on the page (docs/testing.md "dEQP"): GLES2's and GLES3's pass lists (tests/deqp/<api>.txt: cases that pass
// on the page today, every one expected to pass) through bench/gpu/deqp-run.ts, on the guest images/deqp/build.sh makes
// (target/deqp/guest.qcow2: Arch Linux with Mesa's virgl driver; dEQP on target/deqp/deqp.ext4). A machine per API,
// both at once. Opt-in with WEBPC_DEQP=1 (scripts/ci-deqp.sh).
// The lists are sampled unless WEBPC_DEQP_FULL=1 (`ci-deqp.sh --full`): every STRIDE-th case of each group (the name's
// second to fourth parts) from an offset of its own drawn from a seed, at least one a group, in the list's order, so
// runs together cover the lists; the seed is printed, and WEBPC_DEQP_SEED=<n> runs that sample again. A case that
// fails in a sample is looked into at once, or filed in docs/backlog.md and taken out of the list.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, test } from 'node:test';
import { cases as listCases, sample, seedFrom } from './deqp-lists.ts';

const root = new URL('..', import.meta.url).pathname;
const skip = process.env.WEBPC_DEQP !== '1' ? 'SKIPPED: scripts/ci-deqp.sh runs it (WEBPC_DEQP=1)' : false;

const FULL = process.env.WEBPC_DEQP_FULL === '1';
const STRIDE = 8;
const SEED = seedFrom(process.env.WEBPC_DEQP_SEED);
// dEQP processes a machine runs at once, the list dealt to them in blocks of 16 cases (bench/gpu/deqp-run.ts JOBS,
// JOBS_BLOCK: contiguous quarters left GLES3's slow precision group to one; the guest has 4 vCPUs): one waits on the device for much of a case. A 448-case GLES3 slice took 48 s at 1, 30 s at 2, 27 s at 4
// (2026-11-09); more processes at once also put the renderer's contexts side by side, which one process never does.
// WEBPC_DEQP_JOBS says otherwise.
const JOBS = Number(process.env.WEBPC_DEQP_JOBS ?? 4);
// The seconds dEQP may run a list: ~3 times what it takes at 4 processes (~0.06 s a case on the dev VM's SwiftShader)
// and a minute, so a hung device (every later fence held: the guest waits for good) fails the test in minutes, with
// the guest's serial log kept.
const limit = (n: number) => Math.round(60 + n * 0.18);

type Result = { cases: number; counts: Record<string, number>; notPassed: string[]; stoppedAt?: string; detail?: string[] };

/** deqp-run.ts on `file`; its result, or an error with its output kept in `out`. */
function run(api: string, file: string, out: string, limitS: number) {
  return new Promise<Result>((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'bench/gpu/deqp-run.ts', api, 'target/deqp/guest.qcow2', out], {
      cwd: root, env: { ...process.env, CASES: file, LIMIT_S: String(limitS), JOBS: String(JOBS), JOBS_BLOCK: '16', DETAIL: '20' }, timeout: (limitS + 300) * 1000,
    });
    let output = '';
    const keep = (b: Buffer) => { output = (output + b.toString()).slice(-4000); };
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
// faster), and a run is mostly the guest's and SwiftShader's.
suite('dEQP on the page', { concurrency: 2 }, () => {
  for (const api of ['gles2', 'gles3']) {
    const all = listCases(readFileSync(join(root, `tests/deqp/${api}.txt`), 'utf8'));
    const cases = FULL ? all : sample(all, STRIDE, SEED);
    const limitS = limit(cases.length);
    test(`dEQP-${api.toUpperCase()}'s pass list passes on the page`, { skip, timeout: (limitS + 360) * 1000 }, async (t) => {
      const which = FULL ? `all ${cases.length}` : `a sample of ${cases.length} of ${all.length} (WEBPC_DEQP_SEED=${SEED})`;
      t.diagnostic(which);
      console.log(`dEQP-${api.toUpperCase()}: ${which}`);
      const out = mkdtempSync(join(tmpdir(), `webpc-deqp-${api}-`));
      let passed = false;
      try {
        const file = join(out, 'cases.txt');
        writeFileSync(file, `${cases.join('\n')}\n`);
        const res = await run(api, file, out, limitS);
        assert.equal(res.cases, cases.length, 'the guest read the whole list');
        assert.equal(res.stoppedAt, undefined, `dEQP stopped at ${res.stoppedAt}`);
        assert.deepEqual(res.notPassed.slice(0, 30), [], `${res.notPassed.length} of ${cases.length} didn't pass (${which}): ${(res.detail ?? []).join('\n').slice(0, 3000)}`);
        assert.equal(res.counts.Pass, cases.length);
        passed = true;
      } finally {
        if (passed) rmSync(out, { recursive: true, force: true });
      }
    });
  }
});
