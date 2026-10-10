// dEQP on the page (docs/testing.md "dEQP"): GLES2's and GLES3's pass lists (tests/deqp/<api>.txt: cases that pass
// on the page today, every one expected to pass) through bench/gpu/deqp-run.ts, on the guest images/deqp/build.sh makes
// (target/deqp/guest.qcow2: Arch Linux ARM with Mesa's virgl driver; dEQP on target/deqp/deqp.ext4). A boot per API,
// ~6 min in all. Opt-in with WEBPC_DEQP=1 (scripts/ci-deqp.sh).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const skip = process.env.WEBPC_DEQP !== '1' ? 'SKIPPED: scripts/ci-deqp.sh runs it (WEBPC_DEQP=1)' : false;

// The seconds dEQP may run a list: ~1.7 times what it takes (GLES2 ~50 s, GLES3 ~280 s), so a hung device (every
// later fence held: the guest waits for good) fails the test in minutes, with the guest's serial log kept.
const LIMIT_S: Record<string, number> = { gles2: 120, gles3: 480 };

for (const api of ['gles2', 'gles3']) {
  test(`dEQP-${api.toUpperCase()}'s pass list passes on the page`, { skip, timeout: (LIMIT_S[api] + 360) * 1000 }, () => {
    const list = join(root, `tests/deqp/${api}.txt`);
    const cases = readFileSync(list, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
    const out = mkdtempSync(join(tmpdir(), `webpc-deqp-${api}-`));
    let passed = false;
    try {
      const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'bench/gpu/deqp-run.ts', api, 'target/deqp/guest.qcow2', out], {
        cwd: root, env: { ...process.env, CASES: list, LIMIT_S: String(LIMIT_S[api]) }, encoding: 'utf8', timeout: (LIMIT_S[api] + 300) * 1000,
      });
      assert.equal(r.status, 0, `deqp-run.ts failed (its output, a screenshot and the serial log: ${out}): ${(r.stdout + r.stderr).slice(-2000)}`);
      const res = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')) as { cases: number; counts: Record<string, number>; notPassed: string[]; stoppedAt?: string };
      assert.equal(res.cases, cases.length, 'the guest read the whole list');
      assert.equal(res.stoppedAt, undefined, `dEQP stopped at ${res.stoppedAt}`);
      assert.deepEqual(res.notPassed.slice(0, 30), [], `${res.notPassed.length} of ${cases.length} didn't pass`);
      assert.equal(res.counts.Pass, cases.length);
      passed = true;
    } finally {
      if (passed) rmSync(out, { recursive: true, force: true });
    }
  });
}
