// Whole-VM guests on the wasm core in Node, deterministic, under the
// interpreter and the JIT: each JIT run must take exactly the interpreter's
// steps (tests/steps.txt for the guest images) and print exactly its console.
// Buildroot's root filesystem is a `file:` virtio-blk (web/devices.ts
// `fileSource`). docs/testing.md has where each guest runs and why.
// - Short guests (the bare-metal tests, kvm-unit-tests, Buildroot and its
//   device test): the interpreter, then the JIT against it. JIT-stress only for
//   the bare-metal tests and kvm-unit-tests `cache` (its IC maintenance), since
//   a 4-block cache compiles on most dispatches; WEBPC_JIT_STRESS=1 runs the rest.
// - Long guests (LTP and kselftests, the crypto test kernel, Alpine, Alpine's
//   userspace benchmark): the JIT only, against tests/steps.txt. Their
//   interpreter runs are native (core/tests: ltp.rs, distros.rs), or here with
//   WEBPC_INTERP=1 (the crypto kernel has no native runner: ~100 s in Node).
// - Alpine and its userspace benchmark only with WEBPC_DISTROS=alpine,alpine-user
//   (scripts/ci.sh sets it when their images are current).
// - Parallel SMP (a worker per vCPU, realtime: not reproducible): the
//   bare-metal tests, Buildroot and (with WEBPC_DISTROS=alpine) Alpine, each
//   WEBPC_PARALLEL_RUNS times (default 3), every run must pass.
// Needs the wasm build; the guests that need target/images skip without them.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { STEPS } from './steps.ts';
import { DISTROS, Exit, GUEST_CMDLINE, PSCI_SYSTEM_OFF, guestDevices, runToPowerOff, testDevices, type BootOptions } from '../web/vm.ts';

const WASM = readFileSync(new URL('../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url));
const IMAGES = new URL('../target/images/', import.meta.url);
const image = (rel: string) => readFileSync(new URL(rel, IMAGES));
const has = (rel: string) => existsSync(new URL(rel, IMAGES));
const STRESS = process.env.WEBPC_JIT_STRESS === '1';
const INTERP = process.env.WEBPC_INTERP === '1';
const DISTRO_TESTS = (process.env.WEBPC_DISTROS ?? '').split(',').filter(Boolean);

type Run = Awaited<ReturnType<typeof runToPowerOff>>;
const boot = (o: BootOptions, jit: 0 | 1 | 2 | 3, max = 20e9) => runToPowerOff(WASM, { ...o, jit }, max);
const summary = (r: Run) => ({ kind: r.kind, x0: r.x[0], x1: r.x[1], steps: r.steps, console: r.console, hvc: r.hvc });

/**
 * Boots `o` on the interpreter, checks it with `check`, then under the JIT and
 * JIT-stress (unless `stress` is false) and requires the same run. A long guest
 * (`interp: false`) skips the interpreter unless WEBPC_INTERP=1: its JIT runs
 * are checked with `check` and against `steps` alone.
 */
function guest(name: string, o: () => BootOptions, check: (r: Run) => void, { skip = false as string | false, stress = true, max = 20e9, steps = 0, interp = true } = {}) {
  let want: Run | undefined;
  test(`${name}: interpreter`, { skip: skip || (!interp && !INTERP && 'SKIPPED: set WEBPC_INTERP=1') }, async () => {
    want = await boot(o(), 0, max);
    check(want);
    if (steps) assert.equal(want.steps, steps);
  });
  for (const [mode, jit] of [['JIT', 1], ['JIT-stress', 2]] as const) {
    const off = skip || (jit === 2 && !stress && 'SKIPPED: set WEBPC_JIT_STRESS=1');
    test(`${name}: ${mode}`, { skip: off }, async () => {
      const r = await boot(o(), jit, max);
      const ref = want ? ` (interpreter ${(want.ms / 1000).toFixed(1)} s)` : '';
      console.log(`# ${name} ${mode}: ${r.steps} steps in ${(r.ms / 1000).toFixed(1)} s${ref}`);
      if (want) assert.deepEqual(summary(r), summary(want));
      else {
        assert.ok(!interp && !INTERP, 'the interpreter run failed');
        check(r);
        if (steps) assert.equal(r.steps, steps);
      }
    });
  }
}

const poweredOff = (r: Run) => {
  assert.equal(r.kind, Exit.PSCI, r.console);
  assert.equal(r.x[0], PSCI_SYSTEM_OFF, r.console);
};

// Bare-metal EL1 tests (core/tests/baremetal.rs): linked at the start of 16 MiB of RAM; SYSTEM_OFF with x1 = 0 passes.
const BAREMETAL = new URL('baremetal/', import.meta.url);
// The vCPUs from its `// smp: N` marker (core/tests/baremetal.rs `smp_of`).
const smpOf = (f: string) => Number(readFileSync(new URL(f.replace(/\.bin$/, '.c'), BAREMETAL), 'utf8').match(/^\/\/ smp: (\d+)$/m)?.[1] ?? 1);
for (const f of readdirSync(BAREMETAL).filter((f) => f.endsWith('.bin')).sort()) {
  guest(`bare-metal ${f}`, () => ({ ramSize: 16 << 20, kernel: readFileSync(new URL(f, BAREMETAL)), kernelOffset: 0, cmdline: '', ncpus: smpOf(f) }), (r) => {
    poweredOff(r);
    assert.equal(r.x[1], 0n, r.console);
    assert.match(r.console, /exit 0\n$/);
  }, { max: 50e6 });
}

// Parallel SMP (M7 loop 5): each bare-metal test under the JIT and JIT-check
// (whose checker tolerates the legal cross-modification window here: a stale
// block is dropped and counted, not a trap).
const RUNS = Number(process.env.WEBPC_PARALLEL_RUNS ?? 3);
const parallel = async (o: BootOptions, jit: 0 | 1 | 2 | 3, check: (r: Run) => void) => {
  for (let i = 0; i < RUNS; i++) {
    const r = await boot({ ...o, parallel: true, idleLimitMs: 30_000 }, jit, 1e12);
    try {
      check(r);
    } catch (e) {
      throw new Error(`run ${i + 1} of ${RUNS} (${(r.ms / 1000).toFixed(1)} s): ${(e as Error).message}`);
    }
  }
};
for (const f of readdirSync(BAREMETAL).filter((f) => f.endsWith('.bin')).sort()) {
  for (const [mode, jit] of [['JIT', 1], ['JIT-check', 3]] as const) {
    test(`parallel: bare-metal ${f} (${mode})`, () => parallel({ ramSize: 16 << 20, kernel: readFileSync(new URL(f, BAREMETAL)), kernelOffset: 0, cmdline: '', ncpus: smpOf(f) }, jit, (r) => {
      poweredOff(r);
      assert.equal(r.x[1], 0n, r.console);
    }));
  }
}

// The stale-code checker across vCPUs (M7 loop 4): maint.bin with its one
// `IC IVAU` planted out (a NOP), so CPU 0 rewrites code the secondaries have
// compiled without invalidating it. The interpreter has no code cache and
// passes; the JIT runs the old code on CPU 1 (allowed without the IC: check
// 401); JIT-check's checker traps (JIT-stress's 4-region cache has evicted the
// block by then). With the IC, JIT-check passes.
test('bare-metal maint.bin without its IC IVAU: the JIT keeps the old code, the checker traps', async () => {
  const img = new Uint8Array(readFileSync(new URL('maint.bin', BAREMETAL)));
  const words = new Uint32Array(img.buffer);
  const ic = words.findIndex((w) => (w & ~31) >>> 0 === 0xd50b7520);
  assert.ok(ic >= 0 && words.findLastIndex((w) => (w & ~31) >>> 0 === 0xd50b7520) === ic, 'one IC IVAU');
  const o = { ramSize: 16 << 20, kernel: img, kernelOffset: 0, cmdline: '', ncpus: 4 };
  assert.equal((await boot({ ...o, kernel: readFileSync(new URL('maint.bin', BAREMETAL)) }, 3, 50e6)).x[1], 0n);
  words[ic] = 0xd503201f;
  assert.equal((await boot(o, 0, 50e6)).x[1], 0n);
  assert.equal((await boot(o, 1, 50e6)).x[1], 401n);
  await assert.rejects(boot(o, 3, 50e6), WebAssembly.RuntimeError);
});

// kvm-unit-tests: (file, arguments, the checks expected to FAIL, vCPUs), from core/tests/kvm_unit_tests.rs `RUN`.
const KUT: [string, string, string[], number?][] = [
  ['selftest', 'setup smp=1 mem=256', []],
  ['selftest', 'smp', [], 4],
  ['selftest', 'vectors-kernel', []],
  ['selftest', 'vectors-user', []],
  ['psci', '', [], 4],
  ['gic', 'ipi', [], 4],
  ['gic', 'active', [], 4],
  ['timer', '', []],
  ['cache', '', []],
];
// psci's environment (an initrd) enables its concurrent cpu-on check.
const PSCI_ENV = new TextEncoder().encode('ERRATA_6c7a5dce22b3=y\n');
for (const [file, args, fails, ncpus] of KUT) {
  guest(`kvm-unit-tests ${file} ${args}${ncpus ? ` (${ncpus} vCPUs)` : ''}`.replace('  ', ' '), () => ({ ramSize: 256 << 20, kernel: image(`kvm-unit-tests/${file}.flat`), cmdline: args, ncpus, initrd: file === 'psci' ? PSCI_ENV : undefined }), (r) => {
    poweredOff(r);
    const lines = r.console.replaceAll('\r\n', '\n').split('\n');
    assert.deepEqual(lines.filter((l) => l.startsWith('FAIL: ')).map((l) => l.slice(6)), fails, r.console);
    assert.ok(lines.includes(`EXIT: STATUS=${fails.length ? 3 : 1}`), r.console);
    assert.ok(!lines.some((l) => l.startsWith('SKIP: ')), r.console);
  }, { skip: !has(`kvm-unit-tests/${file}.flat`) && 'SKIPPED: run images/build.sh kvm-unit-tests', max: 5e9, stress: STRESS || file === 'cache' });
}

// kvm-unit-tests' SMP set in parallel (M7 loop 5).
for (const [file, args, fails, ncpus] of KUT.filter((k) => k[3])) {
  test(`parallel: kvm-unit-tests ${file} ${args} (${ncpus} vCPUs, JIT)`.replace('  ', ' '), { skip: !has(`kvm-unit-tests/${file}.flat`) && 'SKIPPED: run images/build.sh kvm-unit-tests' }, () => parallel({ ramSize: 256 << 20, kernel: image(`kvm-unit-tests/${file}.flat`), cmdline: args, ncpus, initrd: file === 'psci' ? PSCI_ENV : undefined }, 1, (r) => {
    poweredOff(r);
    const lines = r.console.replaceAll('\r\n', '\n').split('\n');
    assert.deepEqual(lines.filter((l) => l.startsWith('FAIL: ')).map((l) => l.slice(6)), fails, r.console);
    assert.ok(lines.includes(`EXIT: STATUS=${fails.length ? 3 : 1}`), r.console);
  }));
}

const linux = (!has('linux/Image') || !has('buildroot/rootfs.ext4')) && 'SKIPPED: run images/build.sh linux buildroot';
const disk = () => new URL('buildroot/rootfs.ext4', IMAGES).href;
guest('Buildroot', () => ({ ramSize: 256 << 20, kernel: image('linux/Image'), cmdline: GUEST_CMDLINE, devices: guestDevices(disk()) }), (r) => {
  poweredOff(r);
  assert.match(r.console, /webpc: test ok/);
}, { skip: linux, stress: STRESS, steps: STEPS.buildroot });

// On 2 and 4 vCPUs, deterministic round-robin (M7): the same steps interpreted and under the JIT.
for (const n of [2, 4]) {
  guest(`Buildroot on ${n} vCPUs`, () => ({ ramSize: 256 << 20, kernel: image('linux/Image'), cmdline: GUEST_CMDLINE, devices: guestDevices(disk()), ncpus: n }), (r) => {
    poweredOff(r);
    assert.match(r.console, new RegExp(`smp: Brought up 1 node, ${n} CPUs[^]*webpc: test ok`));
  }, { skip: linux, stress: STRESS, steps: STEPS[`buildroot-${n}cpu`] });
}

// In parallel, a worker per vCPU (M7 loop 5).
for (const n of [2, 4]) {
  test(`parallel: Buildroot on ${n} vCPUs (JIT)`, { skip: linux }, () => parallel({ ramSize: 256 << 20, kernel: image('linux/Image'), cmdline: GUEST_CMDLINE, devices: guestDevices(disk()), ncpus: n }, 1, (r) => {
    poweredOff(r);
    assert.match(r.console, new RegExp(`smp: Brought up 1 node, ${n} CPUs[^]*webpc: test ok`));
  }));
}

// The litmus tests (images/build.sh litmus) on 4 parallel vCPUs under the
// JIT (M7 loop 6): no final state herd7's aarch64.cat forbids. 20K outcomes
// per test (5 s); a DMB emitted as nothing fails MP+dmb.sys and SB+dmb.sys here.
test('parallel: litmus on 4 vCPUs (JIT)', { skip: !has('litmus/initramfs.cpio') && 'SKIPPED: run images/build.sh linux litmus' }, async () => {
  const r = await boot({ ramSize: 256 << 20, kernel: image('linux/Image'), initrd: image('litmus/initramfs.cpio'), cmdline: 'console=ttyAMA0 panic=-1 webpc.litmus=-s,1000,-r,10', ncpus: 4, parallel: true, idleLimitMs: 30_000 }, 1, 1e12);
  poweredOff(r);
  assert.match(r.console, /webpc: litmus on 4 CPUs[^]*litmus: all ok, 0 skipped\r?\nwebpc: test ok/, r.console);
});

guest('Buildroot device test', () => ({
  ramSize: 256 << 20, kernel: image('linux/Image'), cmdline: `${GUEST_CMDLINE} -- /test-devices.sh`, devices: testDevices(disk()), framebuffer: { width: 640, height: 480 },
}), (r) => {
  poweredOff(r);
  for (const want of ['3 packets transmitted, 3 packets received, 0% packet loss', '9p: big 200000 ok', 'fb: 0 simple 640,480', 'webpc: test ok']) assert.ok(r.console.includes(want), `missing ${want}`);
}, { skip: linux, stress: STRESS, steps: STEPS.devices });

// The LTP subset and the arm64 kselftests (images/build.sh ltp linux):
// core/tests/ltp.rs checks each result against its table natively.
const ltp = (!has('ltp/rootfs.ext4') || !has('linux/Image-defconfig')) && 'SKIPPED: run images/build.sh ltp linux';
guest('LTP and kselftests', () => ({
  ramSize: 512 << 20, kernel: image('linux/Image-defconfig'), cmdline: `${GUEST_CMDLINE} -- /ltp.sh`, devices: guestDevices(new URL('ltp/rootfs.ext4', IMAGES).href),
}), (r) => {
  poweredOff(r);
  assert.match(r.console, /webpc: test ok\r?\n/);
  // Every test passes or skips (ltp.rs has which, and why).
  const failed = [...r.console.matchAll(/^(ltp|kselftest): (\S+) (\d+)\r?$/gm)]
    .filter(([, suite, , code]) => !(code === '0' || code === (suite === 'ltp' ? '32' : '4')));
  assert.deepEqual(failed.map((m) => m[0].trim()), []);
  assert.ok(r.console.split('\n').filter((l) => /^(ltp|kselftest): /.test(l)).length > 100, 'too few results');
}, { skip: ltp, stress: STRESS, max: 200e9, steps: STEPS.ltp, interp: false });

// The crypto extensions' test kernel (images/build.sh linux-crypto)
// with them on: the arm64 CE drivers pass the full crypto self-tests, and
// lib/crypto's SHA KUnit suites (on the CE code) pass.
const CE_DRIVERS = ['aes-ce', 'ecb-aes-ce', 'cbc-aes-ce', 'ctr-aes-ce', 'xctr-aes-ce', 'xts-aes-ce', 'cts-cbc-aes-ce', 'essiv-cbc-aes-sha256-ce', 'cmac-aes-ce', 'xcbc-aes-ce', 'cbcmac-aes-ce', 'ccm-aes-ce', 'gcm-aes-ce', 'rfc4106-gcm-aes-ce', 'polyval-ce'];
guest('crypto test kernel', () => ({
  ramSize: 256 << 20, kernel: image('linux-crypto/Image'), initrd: image('linux-crypto/initramfs.cpio'), cmdline: 'console=ttyAMA0 panic=-1', crypto: true,
}), (r) => {
  poweredOff(r);
  assert.match(r.console, /webpc: test ok \(0 failed, 0 pending\)/);
  assert.match(r.console, /cpuinfo: Features\t: fp asimd aes pmull sha1 sha2 /);
  for (const d of CE_DRIVERS) assert.match(r.console, new RegExp(`^crypto: ${d} \\S+ passed\r?$`, 'm'), d);
  const totals = [...r.console.matchAll(/# Totals: pass:(\d+) fail:(\d+)/g)];
  assert.deepEqual(totals.map((m) => m[2]), ['0', '0', '0'], 'the sha1, sha224 and sha256 KUnit suites');
  assert.doesNotMatch(r.console, /alg: .*(failed|error)/i);
}, { skip: !has('linux-crypto/Image') && 'SKIPPED: run images/build.sh linux-crypto', stress: STRESS, max: 60e9, steps: STEPS.crypto, interp: false });

const a = DISTROS.alpine;
const alpineSkip = !DISTRO_TESTS.includes('alpine') ? 'SKIPPED: set WEBPC_DISTROS=alpine' : !has(a.kernel) && 'SKIPPED: run images/build.sh alpine';
guest('Alpine', () => ({
  ramSize: 1 << 30, kernel: image(a.kernel), initrd: image(a.initrd), cmdline: a.cmdline, devices: testDevices(new URL(a.disk, IMAGES).href), framebuffer: { width: 640, height: 480 },
}), (r) => {
  poweredOff(r);
  assert.match(r.console, /webpc: alpine [^]*webpc: test ok\r?\n/);
}, { skip: alpineSkip, stress: STRESS, steps: STEPS.alpine, interp: false });

test('parallel: Alpine on 4 vCPUs (JIT)', { skip: alpineSkip }, () => parallel({
  ramSize: 1 << 30, kernel: image(a.kernel), initrd: image(a.initrd), cmdline: a.cmdline, devices: testDevices(new URL(a.disk, IMAGES).href), framebuffer: { width: 640, height: 480 }, ncpus: 4,
}, 1, (r) => {
  poweredOff(r);
  assert.match(r.console, /smp: Brought up 1 node, 4 CPUs[^]*webpc: alpine [^]*webpc: test ok\r?\n/);
}));

// Alpine's userspace benchmark (images/alpine/user): its image under the JIT
// only (10.7G steps: minutes interpreted), with its phases' check lines.
const userSkip = !DISTRO_TESTS.includes('alpine-user') ? 'SKIPPED: set WEBPC_DISTROS=alpine-user' : !has('alpine-user/rootfs-user.ext4') && 'SKIPPED: run images/build.sh alpine-user';
guest('Alpine userspace', () => ({
  ramSize: 1 << 30, kernel: image(a.kernel), initrd: image(a.initrd), cmdline: a.cmdline, devices: guestDevices(new URL('alpine-user/rootfs-user.ext4', IMAGES).href),
}), (r) => {
  poweredOff(r);
  for (const l of ['compress: ok 3', 'binarytrees: 649904 8191', 'fannkuch: 1616 22', 'nbody: -0.169075164 -0.169078071', 'spectralnorm: 1.274222587', 'churn: 1069 files', 'sqlite: 85715 2470168', 'webpc: test ok']) {
    assert.ok(r.console.includes(l), `no "${l}"`);
  }
}, { skip: userSkip, stress: false, steps: STEPS['alpine-user'], interp: false, max: 50e9 });
