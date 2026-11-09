// dEQP-VK on the page (docs/testing.md "dEQP-VK"): the pass list of the direct set's groups (tests/deqp/vk.txt: cases
// that pass on the page today, every one expected to pass) through bench/gpu/deqp-run.ts, on the guest images/deqp/build.sh
// vk makes (target/deqp/guest-vk.qcow2: Arch Linux with Venus's guest driver; deqp-vk on target/deqp/deqp-vk.ext4), a
// machine with Vulkan on the page's WebGPU (SwiftShader's in the dev VM: `--enable-unsafe-webgpu`), on one machine or, with
// the RAM for it, two at once (`SHARDS`); then tests/deqp/vk-ycbcr.txt (VK3 L7.2: YCbCr conversions, on by default since L7.3), another boot, ~1.5 min.
// Opt-in with WEBPC_DEQP_VK=1 (scripts/ci-deqp-vk.sh); skipped where the page has no WebGPU adapter.
// The direct list is sampled unless WEBPC_DEQP_VK_FULL=1 (`ci-deqp-vk.sh --full`): every STRIDE-th case of each group
// (the name's first three parts) from an offset of its own drawn from a seed, at least one a group, in the list's
// order, so runs together cover the list; the seed is printed, and WEBPC_DEQP_VK_SEED=<n> runs that sample again. A
// case that fails in a sample is looked into at once, or filed in docs/backlog.md and taken out of the list.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const skip = process.env.WEBPC_DEQP_VK !== '1' ? 'SKIPPED: scripts/ci-deqp-vk.sh runs it (WEBPC_DEQP_VK=1)' : false;

// The seconds dEQP may run the list: ~2 times what it takes (a machine's half of the whole list: 2,113 s at 58,906 cases,
// VK4 T34), so a hung device (every later fence held: the guest waits
// for good) fails the test in minutes, with the guest's serial log kept.
const LIMIT_S = 4200;

// The direct list runs as this many machines at once, each on its own server, browser and page: the script in 28 minutes at ~40,000 cases (54 at 58,906, VK4 T34; 47 with JOBS 2), one machine ~38,
// at 13.7 GiB (one machine: 8.9). The list's memory-heavy stretch reaches both at once, at ~16 minutes: under an 11 GiB
// cap they were killed there. WEBPC_DEQP_VK_SHARDS says otherwise.
// dEQP processes a machine runs at once, each a block of its cases (bench/gpu/deqp-run.ts JOBS): one waits on the device
// for most of a case. On a machine of 1,536 MiB, a 2,032-case slice took 199/201 s at 1, 161/170 s at 2, 176 s at 4,
// where a `synchronization2.timeline_semaphore.device_host` case hung each time (VK4-KICKOFF.md T36); the whole list 2,873 → 2,470 s at 2,
// the browser's memory +0.3 GiB (bench/vulkan/REPORT.md "dEQP-VK's processes a machine"). WEBPC_DEQP_VK_JOBS says otherwise.
const JOBS = Number(process.env.WEBPC_DEQP_VK_JOBS ?? 2);
const SHARDS = Number(process.env.WEBPC_DEQP_VK_SHARDS ?? (availableParallelism() >= 8 && totalmem() >= 17 * 2 ** 30 ? 2 : 1));
// Cases go to the shards in blocks: alternate ones would have every case follow others than the list's, which some
// failures depend on (docs/testing.md "dEQP-VK"), and a shard of the list's first half would have its slow groups.
const BLOCK = 256;
// A shard's guest RAM: at the default 2,560 MiB its page cache fills it, and two machines pass 11 GiB (and thrash long
// before they're killed), where one peaks at 8.9.
const SHARD_RAM_MIB = 1536;

const FULL = process.env.WEBPC_DEQP_VK_FULL === '1';
// `ci-deqp-vk.sh --full --phases M` (docs/testing.md "dEQP-VK"): WEBPC_DEQP_VK_PHASE=N/M runs the Nth of M slices of the
// whole list, cut at whole rounds of the shards' blocks (so each case has the shard and neighbours of a whole run), and
// WEBPC_DEQP_VK_CHECKPOINT=<file> takes its result (counts, the cases that didn't pass, their detail) before the check.
const PHASE = process.env.WEBPC_DEQP_VK_PHASE?.match(/^(\d+)\/(\d+)$/)?.slice(1).map(Number);
const CHECKPOINT = process.env.WEBPC_DEQP_VK_CHECKPOINT;
const STRIDE = 8;
const SEED = process.env.WEBPC_DEQP_VK_SEED !== undefined ? Number(process.env.WEBPC_DEQP_VK_SEED) >>> 0 : (Math.random() * 2 ** 32) >>> 0;

/** A seeded generator of 32-bit integers (mulberry32). */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** Every `stride`-th case of each group, from an offset per group the seed draws (a group shorter than its offset:
 * one case of it), in the list's order. */
export function sample(cases: string[], stride: number, seed: number): string[] {
  const groups = new Map<string, number[]>();
  cases.forEach((c, i) => {
    const g = c.split('.').slice(1, 4).join('.');
    let at = groups.get(g);
    if (!at) groups.set(g, (at = []));
    at.push(i);
  });
  const next = random(seed), keep = new Set<number>();
  for (const at of groups.values()) {
    const offset = next() % stride;
    if (offset >= at.length) keep.add(at[next() % at.length]);
    for (let k = offset; k < at.length; k += stride) keep.add(at[k]);
  }
  return cases.filter((_, i) => keep.has(i));
}

type Result = { adapter?: string | null; cases: number; counts: Record<string, number>; notPassed: string[]; stoppedAt?: string; detail?: string[] };

/** One machine's run of `file`; its result, or an error with its output kept in `out`. */
function runShard(file: string, out: string, gpu: string | undefined, ramMiB?: number) {
  return new Promise<Result>((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'bench/gpu/deqp-run.ts', 'vk', 'target/deqp/guest-vk.qcow2', out], {
      cwd: root, env: { ...process.env, CHROMIUM_ARGS: `${process.env.CHROMIUM_ARGS ?? ''} --enable-unsafe-webgpu`, CASES: file, LIMIT_S: String(LIMIT_S), JOBS: String(JOBS), DETAIL: '20', ...(gpu ? { VIRGL_GPU: gpu } : {}), ...(ramMiB ? { RAM_MIB: String(ramMiB) } : {}) },
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

/** The `n`th (from 1) of `m` slices of `cases`, cut at multiples of `round` cases. */
export function phase(cases: string[], n: number, m: number, round: number): string[] {
  const rounds = Math.ceil(cases.length / round);
  const at = (k: number) => Math.round((rounds * k) / m) * round;
  return cases.slice(at(n - 1), at(n));
}

/** Runs a pass list on the page in `shards` machines (`gpu`: the machine's ?gpu=, e.g. with `vkycbcr=off`); every case must pass. */
async function passList(t: { skip(m: string): void; diagnostic(m: string): void }, list: string, shards: number, gpu?: string, sampled = false, slice?: number[]) {
  const all = readFileSync(list, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  const cases = sampled ? sample(all, STRIDE, SEED) : slice ? phase(all, slice[0], slice[1], BLOCK * shards) : all;
  const which = sampled ? `a sample of ${cases.length} of ${all.length} (WEBPC_DEQP_VK_SEED=${SEED})` : slice ? `phase ${slice[0]}/${slice[1]}: ${cases.length} of ${all.length}` : `all ${cases.length}`;
  const start = Date.now();
  t.diagnostic(which);
  console.log(`dEQP-VK: ${list.split('/').pop()}: ${which}`);
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
    if (slice && CHECKPOINT) {
      const counts: Record<string, number> = {};
      for (const r of results) for (const [k, v] of Object.entries(r.counts)) counts[k] = (counts[k] ?? 0) + v;
      writeFileSync(CHECKPOINT, `${JSON.stringify({ phase: `${slice[0]}/${slice[1]}`, date: new Date().toISOString(), adapter: results[0].adapter, seconds: Math.round((Date.now() - start) / 1000),
        cases: cases.length, first: cases[0], last: cases.at(-1), counts, stoppedAt: results.map((r) => r.stoppedAt ?? null), notPassed: results.flatMap((r) => r.notPassed), detail: results.flatMap((r) => r.detail ?? []) }, null, 1)}\n`);
    }
    results.forEach((r, i) => {
      assert.equal(r.cases, parts[i].length, 'the guest read the whole list');
      assert.equal(r.stoppedAt, undefined, `dEQP stopped at ${r.stoppedAt} (shard ${i}: ${join(dir, String(i))})`);
    });
    const notPassed = results.flatMap((r) => r.notPassed);
    assert.deepEqual(notPassed.slice(0, 30), [], `${notPassed.length} of ${cases.length} didn't pass (${which}): ${results.flatMap((r) => r.detail ?? []).join('\n').slice(0, 3000)}`);
    assert.equal(results.reduce((n, r) => n + (r.counts.Pass ?? 0), 0), cases.length);
    passed = true;
  } finally {
    if (passed) rmSync(dir, { recursive: true, force: true });
  }
}

test('dEQP-VK\'s pass list passes on the page', { skip, timeout: (LIMIT_S + 420) * 1000 }, (t) => {
  return passList(t, join(root, 'tests/deqp/vk.txt'), SHARDS, undefined, !FULL && !PHASE, PHASE);
});

// VK3 L7.2: YCbCr conversions (on by default since L7.3): a second, small run.
test('dEQP-VK\'s YCbCr pass list passes on the page', { skip, timeout: (LIMIT_S + 420) * 1000 }, (t) => {
  return passList(t, join(root, 'tests/deqp/vk-ycbcr.txt'), 1, 'virgl,vulkan');
});
