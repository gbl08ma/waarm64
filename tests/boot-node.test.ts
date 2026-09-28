// Whole-VM guests on the wasm core in Node, deterministic, under the
// interpreter and the JIT (M5 step 3): each JIT boot must take exactly the
// interpreter's steps and print exactly its console. Buildroot's root
// filesystem is a `file:` virtio-blk (web/devices.ts `fileSource`).
// - Always: the bare-metal tests, kvm-unit-tests (core/tests/kvm_unit_tests.rs
//   `RUN`), the Buildroot boot and its device test, under the JIT; under
//   JIT-stress only the bare-metal tests and kvm-unit-tests `cache` (its IC
//   maintenance), since a 4-block cache compiles on most dispatches (8–20 s
//   per kvm-unit-test, minutes for Buildroot). WEBPC_JIT_STRESS=1 runs them all.
// - Alpine with WEBPC_DISTROS=alpine (as tests/browser.test.ts): under the
//   JIT only, against the interpreter's step count (core/tests/distros.rs runs
//   it natively; the interpreter in Node would add another minute), and under
//   JIT-stress with WEBPC_JIT_STRESS=1 too (hours).
// - The LTP subset and arm64 kselftests (images/build.sh ltp linux; M5 step 9)
//   when the image is there: the interpreter (~50 s), the JIT (~15 s), and
//   JIT-stress with WEBPC_JIT_STRESS=1 (hours).
// Needs the wasm build; the guests that need target/images skip without them.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DISTROS, Exit, GUEST_CMDLINE, PSCI_SYSTEM_OFF, guestDevices, runToPowerOff, testDevices, type BootOptions } from '../web/vm.ts';

const WASM = readFileSync(new URL('../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url));
const IMAGES = new URL('../target/images/', import.meta.url);
const image = (rel: string) => readFileSync(new URL(rel, IMAGES));
const has = (rel: string) => existsSync(new URL(rel, IMAGES));
const STRESS = process.env.WEBPC_JIT_STRESS === '1';
const DISTRO_TESTS = (process.env.WEBPC_DISTROS ?? '').split(',').filter(Boolean);
/** The Buildroot boot's and the device test's steps (PLAN.md §7 M4, and M3 "Run loop" for M6; core/tests/boot.rs). */
const BUILDROOT_STEPS = 40_890_907;
const DEVICES_STEPS = 114_044_960;
const LTP_STEPS = 2_744_982_696; // images/build.sh ltp, on linux/Image-defconfig

type Run = Awaited<ReturnType<typeof runToPowerOff>>;
const boot = (o: BootOptions, jit: 0 | 1 | 2, max = 20e9) => runToPowerOff(WASM, { ...o, jit }, max);
const summary = (r: Run) => ({ kind: r.kind, x0: r.x[0], x1: r.x[1], steps: r.steps, console: r.console, hvc: r.hvc });

/**
 * Boots `o` on the interpreter, checks it with `check`, then under the JIT and
 * JIT-stress (unless `stress` is false) and requires the same run.
 */
function guest(name: string, o: () => BootOptions, check: (r: Run) => void, { skip = false as string | false, stress = true, max = 20e9, steps = 0 } = {}) {
  let want: Run | undefined;
  test(`${name}: interpreter`, { skip }, async () => {
    want = await boot(o(), 0, max);
    check(want);
    if (steps) assert.equal(want.steps, steps);
  });
  for (const [mode, jit] of [['JIT', 1], ['JIT-stress', 2]] as const) {
    const off = skip || (jit === 2 && !stress && 'SKIPPED: set WEBPC_JIT_STRESS=1');
    test(`${name}: ${mode}`, { skip: off }, async () => {
      assert.ok(want, 'the interpreter run failed');
      const r = await boot(o(), jit, max);
      console.log(`# ${name} ${mode}: ${r.steps} steps in ${(r.ms / 1000).toFixed(1)} s (interpreter ${(want.ms / 1000).toFixed(1)} s)`);
      assert.deepEqual(summary(r), summary(want));
    });
  }
}

const poweredOff = (r: Run) => {
  assert.equal(r.kind, Exit.PSCI, r.console);
  assert.equal(r.x[0], PSCI_SYSTEM_OFF, r.console);
};

// Bare-metal EL1 tests (core/tests/baremetal.rs): linked at the start of 16 MiB of RAM; SYSTEM_OFF with x1 = 0 passes.
const BAREMETAL = new URL('baremetal/', import.meta.url);
for (const f of readdirSync(BAREMETAL).filter((f) => f.endsWith('.bin')).sort()) {
  guest(`bare-metal ${f}`, () => ({ ramSize: 16 << 20, kernel: readFileSync(new URL(f, BAREMETAL)), kernelOffset: 0, cmdline: '' }), (r) => {
    poweredOff(r);
    assert.equal(r.x[1], 0n, r.console);
    assert.match(r.console, /exit 0\n$/);
  }, { max: 50e6 });
}

// kvm-unit-tests: (file, arguments, the checks expected to FAIL), from core/tests/kvm_unit_tests.rs `RUN`.
const KUT: [string, string, string[]][] = [
  ['selftest', 'setup smp=1 mem=256', []],
  ['selftest', 'vectors-kernel', []],
  ['selftest', 'vectors-user', []],
  ['gic', 'mmio', ['gicv2: mmio: ITARGETSR: register content preserved', 'gicv2: mmio: ITARGETSR: byte writes successful']],
  ['gic', 'active', []],
  ['timer', '', []],
  ['cache', '', []],
];
for (const [file, args, fails] of KUT) {
  guest(`kvm-unit-tests ${file} ${args}`.trim(), () => ({ ramSize: 256 << 20, kernel: image(`kvm-unit-tests/${file}.flat`), cmdline: args }), (r) => {
    poweredOff(r);
    const lines = r.console.replaceAll('\r\n', '\n').split('\n');
    assert.deepEqual(lines.filter((l) => l.startsWith('FAIL: ')).map((l) => l.slice(6)), fails, r.console);
    assert.ok(lines.includes(`EXIT: STATUS=${fails.length ? 3 : 1}`), r.console);
  }, { skip: !has(`kvm-unit-tests/${file}.flat`) && 'SKIPPED: run images/build.sh kvm-unit-tests', max: 5e9, stress: STRESS || file === 'cache' });
}

const linux = !has('linux/Image') && 'SKIPPED: run images/build.sh linux';
const disk = () => new URL('linux/rootfs.ext4', IMAGES).href;
guest('Buildroot', () => ({ ramSize: 256 << 20, kernel: image('linux/Image'), cmdline: GUEST_CMDLINE, devices: guestDevices(disk()) }), (r) => {
  poweredOff(r);
  assert.match(r.console, /webpc: test ok/);
}, { skip: linux, stress: STRESS, steps: BUILDROOT_STEPS });

guest('Buildroot device test', () => ({
  ramSize: 256 << 20, kernel: image('linux/Image'), cmdline: `${GUEST_CMDLINE} -- /test-devices.sh`, devices: testDevices(disk()), framebuffer: { width: 640, height: 480 },
}), (r) => {
  poweredOff(r);
  for (const want of ['3 packets transmitted, 3 packets received, 0% packet loss', '9p: big 200000 ok', 'fb: 0 simple 640,480', 'webpc: test ok']) assert.ok(r.console.includes(want), `missing ${want}`);
}, { skip: linux, stress: STRESS, steps: DEVICES_STEPS });

// The LTP subset and the arm64 kselftests (images/build.sh ltp linux; M5 step 9):
// core/tests/ltp.rs checks each result natively; here the JIT and JIT-stress
// must print the interpreter's console exactly, in its steps.
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
}, { skip: ltp, stress: STRESS, max: 200e9, steps: LTP_STEPS });

// The crypto extensions' test kernel (images/build.sh linux-crypto; M6.5 loop 3)
// with them on: the arm64 CE drivers pass the full crypto self-tests, and
// lib/crypto's SHA KUnit suites (on the CE code) pass.
const CRYPTO_STEPS = 4_415_427_994;
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
}, { skip: !has('linux-crypto/Image') && 'SKIPPED: run images/build.sh linux-crypto', stress: STRESS, max: 60e9, steps: CRYPTO_STEPS });

const a = DISTROS.alpine;
const ALPINE_STEPS = 2_856_603_825; // PLAN.md §7 M3 "Run loop" (moved in M6, and in M6.5 with the crypto extensions on)
const alpineSkip = !DISTRO_TESTS.includes('alpine') ? 'SKIPPED: set WEBPC_DISTROS=alpine' : !has(a.kernel) && 'SKIPPED: run images/build.sh alpine';
for (const [mode, jit] of [['JIT', 1], ['JIT-stress', 2]] as const) {
  test(`Alpine: ${mode}`, { skip: alpineSkip || (jit === 2 && !STRESS && 'SKIPPED: set WEBPC_JIT_STRESS=1') }, async () => {
    const devices = testDevices(new URL(a.disk, IMAGES).href);
    const r = await boot({ ramSize: 1 << 30, kernel: image(a.kernel), initrd: image(a.initrd), cmdline: a.cmdline, devices, framebuffer: { width: 640, height: 480 } }, jit);
    console.log(`# Alpine ${mode}: ${r.steps} steps in ${(r.ms / 1000).toFixed(1)} s`);
    poweredOff(r);
    assert.match(r.console, /webpc: alpine [^]*webpc: test ok\r?\n/);
    assert.equal(r.steps, ALPINE_STEPS);
  });
}

// Alpine's userspace benchmark (M6's end, images/alpine/user): its image under
// the JIT only (10.9G steps: minutes interpreted), with its phases' check lines.
const ALPINE_USER_STEPS = 10_746_996_638;
const userSkip = !DISTRO_TESTS.includes('alpine-user') ? 'SKIPPED: set WEBPC_DISTROS=alpine-user' : !has('alpine-user/rootfs-user.ext4') && 'SKIPPED: run images/build.sh alpine-user';
test('Alpine userspace: JIT', { skip: userSkip }, async () => {
  const r = await boot({ ramSize: 1 << 30, kernel: image(a.kernel), initrd: image(a.initrd), cmdline: a.cmdline, devices: guestDevices(new URL('alpine-user/rootfs-user.ext4', IMAGES).href) }, 1);
  console.log(`# Alpine userspace JIT: ${r.steps} steps in ${(r.ms / 1000).toFixed(1)} s`);
  poweredOff(r);
  for (const l of ['compress: ok 3', 'binarytrees: 649904 8191', 'fannkuch: 1616 22', 'nbody: -0.169075164 -0.169078071', 'spectralnorm: 1.274222587', 'churn: 1069 files', 'sqlite: 85715 2470168', 'webpc: test ok']) {
    assert.ok(r.console.includes(l), `no "${l}"`);
  }
  assert.equal(r.steps, ALPINE_USER_STEPS);
});
