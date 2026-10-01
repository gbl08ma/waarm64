// A VM through snapshot files (web/snapshot.ts, docs/plans/snapshots.md loop 3): the guest runs
// under the JIT, is saved to a file (the core's state, the backends', RAM through the LZ codec),
// closed, and a new VM started from the file runs on. Deterministic round-robin: the run takes
// the steps of tests/steps.txt and prints what an unbroken run prints. Then what is refused.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { lzCodec } from '../web/lz.ts';
import { readSnapshot, runThroughSnapshots, writeSnapshot } from '../web/snapshot.ts';
import { SnapshotError } from '../web/snapshot-file.ts';
import { STEPS } from './steps.ts';
import { CONSOLE_INPUT, CONSOLE_INPUT_STEP, CONSOLE_INPUT_WANT, DISTROS, Exit, GUEST_CMDLINE, PSCI_SYSTEM_OFF, bootVm, guestDevices, runToPowerOff, type BootOptions } from '../web/vm.ts';

const WASM = await WebAssembly.compile(readFileSync(new URL('../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url)));
const IMAGES = new URL('../target/images/', import.meta.url);
const image = (rel: string) => readFileSync(new URL(rel, IMAGES));
const skip = !existsSync(new URL('linux/Image', IMAGES)) && 'SKIPPED: run images/build.sh';
const DISTRO_TESTS = (process.env.WEBPC_DISTROS ?? '').split(',').filter(Boolean);
const disk = new URL('buildroot/rootfs.ext4', IMAGES).href;
const buildroot = (more: Partial<BootOptions> = {}): BootOptions => ({ ramSize: 256 << 20, kernel: image('linux/Image'), cmdline: GUEST_CMDLINE, devices: guestDevices(disk), jit: 1, ...more });
const MiB = (n: number) => (n / 2 ** 20).toFixed(1);
type Run = Awaited<ReturnType<typeof runThroughSnapshots>>;
const report = (name: string, r: Run) => {
  const f = r.files;
  const mid = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1];
  console.log(`# ${name}: ${r.steps} steps through ${f.length} snapshots; files ${MiB(Math.min(...f.map((x) => x.bytes)))} to ${MiB(Math.max(...f.map((x) => x.bytes)))} MiB, save ${mid(f.map((x) => x.saveMs)).toFixed(0)} ms, start from one ${mid(f.map((x) => x.restoreMs)).toFixed(0)} ms (medians)`);
};
const poweredOff = (r: { kind: number; x: bigint[]; console: string }) => assert.deepEqual([r.kind, r.x[0]], [Exit.PSCI, PSCI_SYSTEM_OFF], r.console);

test('Buildroot under the JIT through 9 snapshot files: the steps and console of an unbroken boot', { skip }, async () => {
  const whole = await runToPowerOff(WASM, buildroot());
  const at = [500_000, 4_000_000, 9_000_000, 15_000_000, 22_222_222, 27_000_000, 31_000_000, 36_000_000, 40_000_000];
  const r = await runThroughSnapshots(WASM, buildroot(), at);
  report('Buildroot', r);
  poweredOff(r);
  assert.equal(r.files.length, at.length);
  assert.equal(r.steps, STEPS.buildroot);
  assert.equal(r.console, whole.console);
  assert.equal(r.hvc, whole.hvc);
});

test('Buildroot on 4 vCPUs (round-robin) through 6 snapshot files, the tier changing at each', { skip }, async () => {
  // A state is the same machine under either tier: the interpreter, the JIT and JIT-check take turns.
  const total = STEPS['buildroot-4cpu'];
  const at = Array.from({ length: 6 }, (_, k) => Math.floor(((k + 1) * total) / 7) + k);
  const r = await runThroughSnapshots(WASM, buildroot({ ncpus: 4 }), at, 20e9, undefined, (k) => ({ jit: ([0, 1, 3] as const)[k % 3] }));
  report('Buildroot on 4 vCPUs', r);
  poweredOff(r);
  assert.equal(r.steps, total);
  assert.match(r.console, /smp: Brought up 1 node, 4 CPUs[^]*webpc: test ok\r?\nwebpc: test exit 0\r?\n/);
});

test('console input waiting in the RX ring and in the host goes through a snapshot', { skip }, async () => {
  // Saved right after the 5.5 KB of input was sent: 4 KiB are in the PL011's RX ring, the rest queued.
  const o = buildroot({ cmdline: `${GUEST_CMDLINE} -- /bin/sh` });
  const r = await runThroughSnapshots(WASM, o, [CONSOLE_INPUT_STEP, CONSOLE_INPUT_STEP + 3_000_000], 200e6, { step: CONSOLE_INPUT_STEP, data: CONSOLE_INPUT });
  poweredOff(r);
  assert.ok(r.console.replaceAll('\r\n', '\n').includes(CONSOLE_INPUT_WANT), r.console);
  assert.equal(r.steps, STEPS['console-input']);
});

test('held receive and event buffers are the new backends\' after a restore', { skip }, async () => {
  // Input devices fill their event queues at probe; the buffers are held by the backends for good.
  // (Not the device test: its 9p server's state isn't saved yet.)
  const devices = [...guestDevices(disk), { type: 'input', kind: 'keyboard' }, { type: 'input', kind: 'tablet' }, { type: 'net', adapter: 'loopback' }] as BootOptions['devices'];
  const whole = await runToPowerOff(WASM, buildroot({ devices }));
  poweredOff(whole);
  const at = [12_000_000, 20_000_000, 30_000_000, whole.steps - 2_000_000];
  const r = await runThroughSnapshots(WASM, buildroot({ devices }), at);
  report('Buildroot with input and net devices', r);
  assert.equal(r.steps, whole.steps);
  assert.equal(r.console, whole.console);
});

const user = 'alpine-user/rootfs-user.ext4';
test('Alpine\'s userspace benchmark (1 GiB) through 3 snapshot files', { skip: !DISTRO_TESTS.includes('alpine-user') ? 'SKIPPED: set WEBPC_DISTROS=alpine-user' : !existsSync(new URL(user, IMAGES)) && 'SKIPPED: run images/build.sh alpine-user' }, async () => {
  const a = DISTROS.alpine;
  const o: BootOptions = { ramSize: 1 << 30, kernel: image(a.kernel), initrd: image(a.initrd), cmdline: a.cmdline, devices: guestDevices(new URL(user, IMAGES).href), jit: 1 };
  const total = STEPS['alpine-user'];
  const r = await runThroughSnapshots(WASM, o, [Math.floor(total / 4), Math.floor(total / 2) + 1, Math.floor((3 * total) / 4) + 2], 50e9);
  report('Alpine userspace', r);
  poweredOff(r);
  // Not `total`: a restored VM's TLBs are empty, and this guest can tell (tests/steps.txt).
  assert.equal(r.steps, STEPS['alpine-user-snapshots']);
});

// Parallel SMP (a worker per vCPU, realtime): the VM is paused (web/vm.ts `pause`), saved, closed, and
// a new one with new workers started from the file. Not reproducible: WEBPC_PARALLEL_RUNS repeats it.
const RUNS = Number(process.env.WEBPC_PARALLEL_RUNS ?? 2);
test('parallel: Buildroot on 4 vCPUs (JIT) through snapshot files', { skip }, async () => {
  for (let i = 0; i < RUNS; i++) {
    const at = Array.from({ length: 8 }, (_, k) => (k + 1) * 5_000_000 + i * 1_234_567);
    const r = await runThroughSnapshots(WASM, buildroot({ ncpus: 4, parallel: true, idleLimitMs: 30_000 }), at, 1e12);
    report(`parallel Buildroot on 4 vCPUs, run ${i + 1}`, r);
    poweredOff(r);
    assert.ok(r.files.length >= 6, `${r.files.length} snapshots`);
    assert.match(r.console, /smp: Brought up 1 node, 4 CPUs[^]*webpc: test ok\r?\nwebpc: test exit 0\r?\n/);
    assert.equal(r.hvc.replaceAll('\r\n', '\n'), 'webpc: hvc0 ok\n');
  }
});

const litmusImage = new URL('litmus/initramfs.cpio', IMAGES);
test('parallel: litmus and the atomics stress on 4 vCPUs (JIT) through snapshot files', { skip: skip || (!existsSync(litmusImage) && 'SKIPPED: run images/build.sh linux litmus') }, async () => {
  const o: BootOptions = { ramSize: 256 << 20, kernel: image('linux/Image'), initrd: readFileSync(litmusImage), cmdline: 'console=ttyAMA0 panic=-1 webpc.litmus=-s,100,-r,1 webpc.stress=-n,20000', ncpus: 4, parallel: true, idleLimitMs: 30_000, jit: 1 };
  const at = Array.from({ length: 10 }, (_, k) => (k + 1) * 60_000_000);
  const r = await runThroughSnapshots(WASM, o, at, 1e12);
  report('parallel litmus and stress', r);
  poweredOff(r);
  assert.ok(r.files.length >= 5, `${r.files.length} snapshots`);
  assert.match(r.console, /litmus: all ok, 0 skipped\r?\nwebpc: stress on 4 CPUs[^]*\nwebpc: test ok\r?\n/);
});

test('a snapshot of another machine, another version or with a damaged state is refused', { skip }, async () => {
  const codec = await lzCodec(WASM);
  const o = buildroot();
  const vm = await bootVm(WASM, o);
  for (let steps = 0; steps < 5_000_000;) {
    const r = await vm.runAsync(5_000_000 - steps);
    steps += r.steps;
    if (r.kind === Exit.DEVICE) await vm.settle();
  }
  const parts: Uint8Array[] = [];
  const w = await writeSnapshot(vm, (b) => { parts.push(b); }, { machine: 'test' }, codec);
  await vm.close();
  const file = new Blob(parts as BlobPart[]);
  assert.equal(w.bytes, file.size);
  const refused = async (o: BootOptions, f: Blob = file, version = codec.snapshotVersion) => {
    try {
      const { restore } = await readSnapshot(f, codec, version);
      await (await bootVm(WASM, { ...o, restore })).close();
    } catch (e) {
      assert.ok(e instanceof SnapshotError, String(e));
      return e.problem;
    }
    return 'accepted';
  };
  assert.equal(await refused(o), 'accepted');
  assert.equal(await refused({ ...o, ncpus: 2 }), 'other-machine');
  assert.equal(await refused({ ...o, ramSize: 128 << 20 }), 'other-machine');
  assert.equal(await refused({ ...o, devices: [...o.devices!, { type: 'rng' }] }), 'other-machine');
  assert.equal(await refused({ ...o, crypto: false }), 'other-machine');
  assert.equal(await refused(o, file, codec.snapshotVersion + 1), 'other-version');
  assert.equal(await refused(o, file.slice(0, file.size - 40)), 'truncated');
  // The core's state changed under a valid checksum: a file written with the core's version word bumped.
  const { header, restore } = await readSnapshot(file, codec, codec.snapshotVersion);
  assert.equal(header.ramSize, o.ramSize);
  const core = restore.core.slice();
  core[4]++;
  await assert.rejects(bootVm(WASM, { ...o, restore: { ...restore, core } }), (e: unknown) => e instanceof SnapshotError && e.problem === 'other-version');
  const cut = { ...restore, core: restore.core.slice(0, restore.core.length - 9) };
  await assert.rejects(bootVm(WASM, { ...o, restore: cut }), (e: unknown) => e instanceof SnapshotError && e.problem === 'corrupt');
});

test('a VM started from a snapshot saves the same state: the core\'s bytes and the backends\'', { skip }, async () => {
  // At 39 M steps the deterministic rng has given bytes: its position is the backend's state. The
  // input devices' config spaces hold their backends' last answers, their queues the event buffers.
  const codec = await lzCodec(WASM);
  const o = buildroot({ devices: [...guestDevices(disk), { type: 'input', kind: 'keyboard' }, { type: 'input', kind: 'tablet' }] });
  let vm = await bootVm(WASM, o);
  for (let steps = 0; steps < 39_000_000;) {
    const r = await vm.runAsync(39_000_000 - steps);
    steps += r.steps;
    vm.drain();
    if (r.kind === Exit.DEVICE) await vm.settle();
  }
  const before = await vm.snapshot();
  assert.notDeepEqual(before.host.devices[1], { s: '0', word: '0', left: 0 }, 'the rng was never read');
  const parts: Uint8Array[] = [];
  await writeSnapshot(vm, (b) => { parts.push(b); }, {}, codec);
  await vm.close();
  const { restore } = await readSnapshot(new Blob(parts as BlobPart[]), codec, codec.snapshotVersion);
  vm = await bootVm(WASM, { ...o, restore });
  const after = await vm.snapshot();
  await vm.close();
  assert.deepEqual(after.host, before.host);
  assert.equal(Buffer.compare(after.core, before.core), 0, "the core's state differs");
});

test('a machine with a 9p device says it cannot be saved', { skip }, async () => {
  const vm = await bootVm(WASM, buildroot({ devices: [...guestDevices(disk), { type: '9p', tag: 'host', files: {} }] }));
  await assert.rejects(vm.snapshot(), /9p device can't be saved/);
  await vm.close();
});
