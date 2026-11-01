// dEQP-VK on the page (docs/testing.md "dEQP-VK"): the pass list of the direct set's groups (tests/deqp/vk.txt: cases
// that pass on the page today, every one expected to pass) through bench/gpu/deqp-run.ts, on the guest images/deqp/build.sh
// vk makes (target/deqp/guest-vk.qcow2: Arch Linux with Venus's guest driver; deqp-vk on target/deqp/deqp-vk.ext4), a
// machine with Vulkan on the page's WebGPU (SwiftShader's in the dev VM: `--enable-unsafe-webgpu`), on one machine or, with
// the RAM for it, two at once (`SHARDS`); then tests/deqp/vk-ycbcr.txt (VK3 L7.2: YCbCr conversions, on by default since L7.3), another boot, ~1.5 min.
// Opt-in with WEBPC_DEQP_VK=1 (scripts/ci-deqp-vk.sh); skipped where the page has no WebGPU adapter.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const skip = process.env.WEBPC_DEQP_VK !== '1' ? 'SKIPPED: scripts/ci-deqp-vk.sh runs it (WEBPC_DEQP_VK=1)' : false;

// The seconds dEQP may run the list: ~2 times what it takes, so a hung device (every later fence held: the guest waits
// for good) fails the test in minutes, with the guest's serial log kept.
const LIMIT_S = 2400;

// The direct list runs as this many machines at once, each on its own server, browser and page. One machine peaks at
// 8.9 GiB; two, on the dev VM's 14 GiB under an 11 GiB cap, were killed at 16 minutes (twice, the second with
// SHARD_RAM_MIB): the list's memory-heavy stretch reaches both at once. So two want more RAM than that, and at least 14
// GiB of `MemoryMax` (unmeasured: docs/testing.md "dEQP-VK"). WEBPC_DEQP_VK_SHARDS says otherwise.
const SHARDS = Number(process.env.WEBPC_DEQP_VK_SHARDS ?? (availableParallelism() >= 8 && totalmem() >= 17 * 2 ** 30 ? 2 : 1));
// Cases go to the shards in blocks: alternate ones would have every case follow others than the list's, which some
// failures depend on (docs/testing.md "dEQP-VK"), and a shard of the list's first half would have its slow groups.
const BLOCK = 256;
// A shard's guest RAM: at the default 2,560 MiB its page cache fills it, and two machines pass 11 GiB (and thrash long
// before they're killed), where one peaks at 8.9.
const SHARD_RAM_MIB = 1536;

type Result = { adapter?: string | null; cases: number; counts: Record<string, number>; notPassed: string[]; stoppedAt?: string; detail?: string[] };

/** One machine's run of `file`; its result, or an error with its output kept in `out`. */
function runShard(file: string, out: string, gpu: string | undefined, ramMiB?: number) {
  return new Promise<Result>((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'bench/gpu/deqp-run.ts', 'vk', 'target/deqp/guest-vk.qcow2', out], {
      cwd: root, env: { ...process.env, CHROMIUM_ARGS: `${process.env.CHROMIUM_ARGS ?? ''} --enable-unsafe-webgpu`, CASES: file, LIMIT_S: String(LIMIT_S), DETAIL: '20', ...(gpu ? { VIRGL_GPU: gpu } : {}), ...(ramMiB ? { RAM_MIB: String(ramMiB) } : {}) },
      timeout: (LIMIT_S + 360) * 1000,
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

/** Runs a pass list on the page in `shards` machines (`gpu`: the machine's ?gpu=, e.g. with `vkycbcr=off`); every case must pass. */
async function passList(t: { skip(m: string): void }, list: string, shards: number, gpu?: string) {
  const cases = readFileSync(list, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  const dir = mkdtempSync(join(tmpdir(), 'webpc-deqp-vk-'));
  let passed = false;
  try {
    const parts: string[][] = Array.from({ length: shards }, () => []);
    cases.forEach((c, i) => parts[Math.floor(i / BLOCK) % shards].push(c));
    const results = await Promise.all(parts.map((part, i) => {
      const file = join(dir, `cases-${i}.txt`), out = join(dir, String(i));
      writeFileSync(file, `${part.join('\n')}\n`);
      mkdirSync(out);
      return runShard(file, out, gpu, shards > 1 ? SHARD_RAM_MIB : undefined);
    }));
    if (results.some((r) => !r.adapter)) {
      passed = true;
      return t.skip('SKIPPED: the page has no WebGPU adapter');
    }
    results.forEach((r, i) => {
      assert.equal(r.cases, parts[i].length, 'the guest read the whole list');
      assert.equal(r.stoppedAt, undefined, `dEQP stopped at ${r.stoppedAt} (shard ${i}: ${join(dir, String(i))})`);
    });
    const notPassed = results.flatMap((r) => r.notPassed);
    assert.deepEqual(notPassed.slice(0, 30), [], `${notPassed.length} of ${cases.length} didn't pass: ${results.flatMap((r) => r.detail ?? []).join('\n').slice(0, 3000)}`);
    assert.equal(results.reduce((n, r) => n + (r.counts.Pass ?? 0), 0), cases.length);
    passed = true;
  } finally {
    if (passed) rmSync(dir, { recursive: true, force: true });
  }
}

test('dEQP-VK\'s pass list passes on the page', { skip, timeout: (LIMIT_S + 420) * 1000 }, (t) => {
  return passList(t, join(root, 'tests/deqp/vk.txt'), SHARDS);
});

// VK3 L7.2: YCbCr conversions (on by default since L7.3): a second, small run.
test('dEQP-VK\'s YCbCr pass list passes on the page', { skip, timeout: (LIMIT_S + 420) * 1000 }, (t) => {
  return passList(t, join(root, 'tests/deqp/vk-ycbcr.txt'), 1, 'virgl,vulkan');
});
