// dEQP-VK on the page (docs/testing.md "dEQP-VK"): the pass list of the direct set's groups (tests/deqp/vk.txt: cases
// that pass on the page today, every one expected to pass) through bench/gpu/deqp-run.ts, on the guest images/deqp/build.sh
// vk makes (target/deqp/guest-vk.qcow2: Arch Linux with Venus's guest driver; deqp-vk on target/deqp/deqp-vk.ext4), a
// machine with Vulkan on the page's WebGPU (SwiftShader's in the dev VM: `--enable-unsafe-webgpu`). One boot, ~29 min; then
// tests/deqp/vk-ycbcr.txt (VK3 L7.2: YCbCr conversions, on by default since L7.3), a second boot, ~1.5 min.
// Opt-in with WEBPC_DEQP_VK=1 (scripts/ci-deqp-vk.sh); skipped where the page has no WebGPU adapter.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const skip = process.env.WEBPC_DEQP_VK !== '1' ? 'SKIPPED: scripts/ci-deqp-vk.sh runs it (WEBPC_DEQP_VK=1)' : false;

// The seconds dEQP may run the list: ~2 times what it takes, so a hung device (every later fence held: the guest waits
// for good) fails the test in minutes, with the guest's serial log kept.
const LIMIT_S = 2400;

/** Runs a pass list on the page (`gpu`: the machine's ?gpu=, e.g. with `vkycbcr=off`); every case must pass. */
function passList(t: { skip(m: string): void }, list: string, gpu?: string) {
  const cases = readFileSync(list, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  const out = mkdtempSync(join(tmpdir(), 'webpc-deqp-vk-'));
  let passed = false;
  try {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'bench/gpu/deqp-run.ts', 'vk', 'target/deqp/guest-vk.qcow2', out], {
      cwd: root, env: { ...process.env, CHROMIUM_ARGS: `${process.env.CHROMIUM_ARGS ?? ''} --enable-unsafe-webgpu`, CASES: list, LIMIT_S: String(LIMIT_S), DETAIL: '20', ...(gpu ? { VIRGL_GPU: gpu } : {}) },
      encoding: 'utf8', timeout: (LIMIT_S + 360) * 1000,
    });
    assert.equal(r.status, 0, `deqp-run.ts failed (its output, a screenshot and the serial log: ${out}): ${(r.stdout + r.stderr).slice(-2000)}`);
    const res = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')) as { adapter?: string | null; cases: number; counts: Record<string, number>; notPassed: string[]; stoppedAt?: string; detail?: string[] };
    if (!res.adapter) {
      passed = true;
      return t.skip('SKIPPED: the page has no WebGPU adapter');
    }
    assert.equal(res.cases, cases.length, 'the guest read the whole list');
    assert.equal(res.stoppedAt, undefined, `dEQP stopped at ${res.stoppedAt}`);
    assert.deepEqual(res.notPassed.slice(0, 30), [], `${res.notPassed.length} of ${cases.length} didn't pass: ${(res.detail ?? []).join('\n').slice(0, 3000)}`);
    assert.equal(res.counts.Pass, cases.length);
    passed = true;
  } finally {
    if (passed) rmSync(out, { recursive: true, force: true });
  }
}

test('dEQP-VK\'s pass list passes on the page', { skip, timeout: (LIMIT_S + 420) * 1000 }, (t) => {
  passList(t, join(root, 'tests/deqp/vk.txt'));
});

// VK3 L7.2: YCbCr conversions (on by default since L7.3): a second, small run.
test('dEQP-VK\'s YCbCr pass list passes on the page', { skip, timeout: (LIMIT_S + 420) * 1000 }, (t) => {
  passList(t, join(root, 'tests/deqp/vk-ycbcr.txt'), 'virgl,vulkan');
});
