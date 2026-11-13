// The FP suite in the guest (docs/testing.md "The FP suite"): images/fptest's
// TestFloat cases through every scalar and vector FP form, on Linux in Node
// under the JIT (its loops compiled, so the inline fast paths run) and, with
// WAARM64_FPTEST_INTERP=1, the interpreter; on 4 parallel vCPUs (a part of the
// forms each), WAARM64_FPTEST_CPUS to change it. Only with WAARM64_FPTEST=1
// (scripts/ci-fp.sh): it isn't part of npm test's or scripts/ci.sh's run.
// WAARM64_FPTEST_ARGS: the suite's options (default: level 1, every form).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fusedFma } from '../web/fma.ts';
import { runToPowerOff } from '../web/vm.ts';

const IMAGES = new URL('../target/images/', import.meta.url);
const has = (rel: string) => existsSync(new URL(rel, IMAGES));
const skip = process.env.WAARM64_FPTEST !== '1' ? 'SKIPPED: scripts/ci-fp.sh runs it (WAARM64_FPTEST=1)'
  : !has('fptest/initramfs.cpio') || !has('linux/Image') ? 'SKIPPED: run images/build.sh linux fptest' : false;
const args = (process.env.WAARM64_FPTEST_ARGS ?? '').trim().split(/\s+/).filter(Boolean).join(',');
const CPUS = Number(process.env.WAARM64_FPTEST_CPUS ?? 4);
const modes: [string, 0 | 1, boolean][] = [['JIT', 1, true], ...(fusedFma() ? [['JIT, FMA emulated', 1, false] as [string, 0 | 1, boolean]] : []), ...(process.env.WAARM64_FPTEST_INTERP === '1' ? [['interpreter', 0, false] as [string, 0 | 1, boolean]] : [])];

for (const [name, jit, fma] of modes) {
  test(`FP suite in the guest (${name})`, { skip }, async () => {
    const wasm = readFileSync(new URL('../target/wasm32-unknown-unknown/release/waarm64_core.wasm', import.meta.url));
    const r = await runToPowerOff(wasm, {
      ramSize: 256 << 20,
      kernel: readFileSync(new URL('linux/Image', IMAGES)),
      initrd: readFileSync(new URL('fptest/initramfs.cpio', IMAGES)),
      cmdline: `console=ttyAMA0 panic=-1${args ? ` waarm64.fptest=${args}` : ''}`,
      jit,
      fma,
      fp16: true, // FEAT_FP16, FEAT_FHM and FEAT_BF16 are off by default: the half, FMLAL and bfloat16 forms need them
      fhm: true,
      bf16: true,
      ncpus: CPUS,
      parallel: CPUS > 1,
      idleLimitMs: 60_000,
    }, 5e12);
    const lines = r.console.split(/\r?\n/).filter((l) => /^(fptest|FAIL|  (got|want))/.test(l));
    // Each part's summary and its forms' failure counts, then the first failures' details.
    const summary = lines.filter((l) => /^fptest: (part|.*failures$)/.test(l));
    const failed = lines.filter((l) => /^(FAIL|  (got|want))/.test(l));
    console.log(`# FP suite (${name}): ${(r.ms / 1000).toFixed(1)} s, ${(r.steps / 1e9).toFixed(1)}G steps\n${[...summary, ...failed.slice(0, 30)].join('\n')}`);
    assert.equal(r.console.match(/fptest: \d+ checks, 0 failures/g)?.length, CPUS, failed.slice(0, 40).join('\n'));
    assert.match(r.console, /waarm64: test ok/);
  });
}
