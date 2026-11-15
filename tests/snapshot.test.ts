// A VM through snapshot files (web/snapshot.ts, docs/platform.md "Snapshots"): the guest runs
// under the JIT, is saved to a file (the core's state, the backends', RAM through the LZ codec),
// closed, and a new VM started from the file runs on. Deterministic round-robin: the run takes
// the steps of tests/steps.txt and prints what an unbroken run prints. Then what is refused, and the codec itself:
// a file its old LZ wrote still loads (tests/fixtures/old-lz.waarm64snap).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { lzCodec } from '../web/lz.ts';
import { readSnapshot, runThroughSnapshots, writeSnapshot } from '../web/snapshot.ts';
import { dropSuspend, removeOverlay, suspended, suspendWriter } from '../web/overlay.ts';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { applyRam, crc32, diskBlocks, openSnapshot, SnapshotError, SnapshotWriter } from '../web/snapshot-file.ts';
import { oldLzContent, OLD_LZ_HEADER } from './old-lz-content.ts';
import { STEPS } from './steps.ts';
import { ABI, CONSOLE_INPUT, CONSOLE_INPUT_STEP, CONSOLE_INPUT_WANT, DISTROS, Exit, GUEST_CMDLINE, PSCI_SYSTEM_OFF, bootVm, compileCore, guestDevices, runToPowerOff, type BootOptions } from '../web/vm.ts';

const WASM = await compileCore(readFileSync(new URL('../target/wasm32-unknown-unknown/release/waarm64_core.wasm', import.meta.url)));
const IMAGES = new URL('../target/images/', import.meta.url);
const image = (rel: string) => readFileSync(new URL(rel, IMAGES));
const skip = !existsSync(new URL('linux/Image', IMAGES)) && 'SKIPPED: run images/build.sh';
const DISTRO_TESTS = (process.env.WAARM64_DISTROS ?? '').split(',').filter(Boolean);
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
  assert.match(r.console, /smp: Brought up 1 node, 4 CPUs[^]*waarm64: test ok\r?\nwaarm64: test exit 0\r?\n/);
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
  // (Not the device test: its in-memory 9p tree isn't saved.)
  const devices = [...guestDevices(disk), { type: 'input', kind: 'keyboard' }, { type: 'input', kind: 'tablet' }, { type: 'net', adapter: 'loopback' }] as BootOptions['devices'];
  const whole = await runToPowerOff(WASM, buildroot({ devices }));
  poweredOff(whole);
  const at = [12_000_000, 20_000_000, 30_000_000, whole.steps - 2_000_000];
  const r = await runThroughSnapshots(WASM, buildroot({ devices }), at);
  report('Buildroot with input and net devices', r);
  assert.equal(r.steps, whole.steps);
  assert.equal(r.console, whole.console);
});

test('the snd guest through 6 snapshot files while its tone plays and while it records: the steps and the console of an unbroken run', { skip: !existsSync(new URL('linux-snd/Image', IMAGES)) && 'SKIPPED: run images/build.sh linux-snd' }, async () => {
  // Saved with a stream started and messages held (playing until ~35.5 M steps, recording from ~35.6 M to ~36.4 M): the restored
  // device starts its sink or source again and the core posts the held messages again, which play or fill once (the
  // guest prints the hashes of what it wrote and read).
  const o = { ramSize: 256 << 20, kernel: image('linux-snd/Image'), initrd: image('linux-snd/initramfs.cpio'), cmdline: 'console=ttyAMA0 panic=-1', devices: [{ type: 'snd' }], jit: 1 } satisfies BootOptions;
  const whole = await runToPowerOff(WASM, o);
  const r = await runThroughSnapshots(WASM, o, [32_540_000, 33_540_000, 34_540_000, 35_040_000, 35_740_000, 36_040_000]);
  report('snd', r);
  poweredOff(r);
  assert.equal(r.files.length, 6);
  assert.equal(r.steps, STEPS.snd);
  assert.equal(r.console, whole.console);
  assert.match(r.console, /snd: wrote 49152 frames fnv1a 5652c745\r?\n[^]*snd: recorded 16384 frames fnv1a [0-9a-f]{8} in \d+ ms, 999 Hz left, 1500 Hz right\r?\nwaarm64: snd test ok/);
});

const user = 'alpine-user/rootfs-user.ext4';
test('Alpine\'s userspace benchmark (1 GiB) through 3 snapshot files', { skip: !DISTRO_TESTS.includes('alpine-user') ? 'SKIPPED: set WAARM64_DISTROS=alpine-user' : !existsSync(new URL(user, IMAGES)) && 'SKIPPED: run images/build.sh alpine-user' }, async () => {
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
// a new one with new workers started from the file. Not reproducible: WAARM64_PARALLEL_RUNS repeats it.
const RUNS = Number(process.env.WAARM64_PARALLEL_RUNS ?? 2);
test('parallel: Buildroot on 4 vCPUs (JIT) through snapshot files', { skip }, async () => {
  for (let i = 0; i < RUNS; i++) {
    const at = Array.from({ length: 8 }, (_, k) => (k + 1) * 5_000_000 + i * 1_234_567);
    const r = await runThroughSnapshots(WASM, buildroot({ ncpus: 4, parallel: true, idleLimitMs: 30_000 }), at, 1e12);
    report(`parallel Buildroot on 4 vCPUs, run ${i + 1}`, r);
    poweredOff(r);
    assert.ok(r.files.length >= 6, `${r.files.length} snapshots`);
    assert.match(r.console, /smp: Brought up 1 node, 4 CPUs[^]*waarm64: test ok\r?\nwaarm64: test exit 0\r?\n/);
    assert.equal(r.hvc.replaceAll('\r\n', '\n'), 'waarm64: hvc0 ok\n');
  }
});

const litmusImage = new URL('litmus/initramfs.cpio', IMAGES);
test('parallel: litmus and the atomics stress on 4 vCPUs (JIT) through snapshot files', { skip: skip || (!existsSync(litmusImage) && 'SKIPPED: run images/build.sh linux litmus') }, async () => {
  const o: BootOptions = { ramSize: 256 << 20, kernel: image('linux/Image'), initrd: readFileSync(litmusImage), cmdline: 'console=ttyAMA0 panic=-1 waarm64.litmus=-s,100,-r,1 waarm64.stress=-n,20000', ncpus: 4, parallel: true, idleLimitMs: 30_000, jit: 1 };
  const at = Array.from({ length: 10 }, (_, k) => (k + 1) * 60_000_000);
  const r = await runThroughSnapshots(WASM, o, at, 1e12);
  report('parallel litmus and stress', r);
  poweredOff(r);
  assert.ok(r.files.length >= 5, `${r.files.length} snapshots`);
  assert.match(r.console, /litmus: all ok, 0 skipped\r?\nwaarm64: stress on 4 CPUs[^]*\nwaarm64: test ok\r?\n/);
});

test('the core\'s codec: a file the old LZ wrote (before lz4_flex) still loads, and its CRC-32 is zlib\'s', async () => {
  const codec = await lzCodec(WASM);
  // tests/fixtures/old-lz.waarm64snap: written by core/src/lz.rs (SNAPZ loop 1 replaced it), every frame codec 2.
  const file = readFileSync(new URL('fixtures/old-lz.waarm64snap', import.meta.url));
  const want = oldLzContent();
  const s = await openSnapshot(new Blob([file]), { codecs: [codec] });
  assert.deepEqual(s.header, OLD_LZ_HEADER);
  const got = { CORE: [] as Uint8Array[], DEVS: [] as Uint8Array[], ram: new Uint8Array(want.ram.length), disk: new Map<number, Uint8Array>() };
  for await (const f of s.frames()) {
    if (f.tag === 'CORE' || f.tag === 'DEVS') got[f.tag].push(f.data);
    else if (f.tag === 'RAM ') applyRam(got.ram, f.index, f.data);
    else if (f.tag === 'DISK') for (const b of diskBlocks(f.index, f.data)) got.disk.set(b.block, b.data.slice());
  }
  assert.ok(Buffer.compare(Buffer.concat(got.CORE), want.core) === 0, 'CORE differs');
  assert.ok(Buffer.compare(Buffer.concat(got.DEVS), want.devs) === 0, 'DEVS differs');
  assert.ok(Buffer.compare(got.ram, want.ram) === 0, 'RAM differs');
  assert.deepEqual([...got.disk.keys()], want.disk.map((b) => b.block));
  for (const b of want.disk) assert.ok(Buffer.compare(got.disk.get(b.block)!, b.data) === 0, `block ${b.block} differs`);
  assert.equal(s.times.unpack > 0, true);
  // The same content written now (lz4_flex) reads back the same, at about the old size.
  const parts: Uint8Array[] = [];
  const w = new SnapshotWriter((b) => { parts.push(b.slice()); }, OLD_LZ_HEADER, { codec, concurrency: 1 });
  await w.bytes('CORE', want.core);
  await w.bytes('DEVS', want.devs);
  await w.ram(want.ram);
  await w.disk(want.disk);
  await w.end();
  const now = Buffer.concat(parts);
  assert.ok(now.length < file.length * 1.1, `${now.length} bytes against the old ${file.length}`);
  const again = await openSnapshot(new Blob([now]), { codecs: [codec] });
  const ram = new Uint8Array(want.ram.length);
  for await (const f of again.frames()) if (f.tag === 'RAM ') applyRam(ram, f.index, f.data);
  assert.ok(Buffer.compare(ram, want.ram) === 0, 'RAM differs after a round trip');
  // The core's CRC-32 (crc32fast), seeded and across the codec's buffer (a frame at most, so a header goes in parts).
  assert.equal(codec.crc32!(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(codec.crc32!(new Uint8Array(0)), 0);
  const big = new Uint8Array(3 * 2 ** 20 + 777).map((_, i) => (i * 2654435761) >>> 24);
  for (const n of [1, 7, 8, 9, 1000, 2 ** 20 + 32, big.length]) {
    const b = big.subarray(1, 1 + n);
    assert.equal(codec.crc32!(b), zlibCrc32(b), `length ${n}`);
    assert.equal(codec.crc32!(b), crc32(b), `JS's, length ${n}`);
    const k = n >> 1;
    assert.equal(codec.crc32!(b.subarray(k), codec.crc32!(b.subarray(0, k))), zlibCrc32(b), `seeded ${n}`);
  }
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

/** `wasm` with a custom section appended: the same code, other bytes, as another build of the core is. */
function otherBuild(wasm: Uint8Array, name: string) {
  const leb = (n: number) => { const out: number[] = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
  const body = [...leb(name.length), ...new TextEncoder().encode(name), ...new TextEncoder().encode(`built ${name}`)];
  return new Uint8Array([...wasm, 0, ...leb(body.length), ...body]);
}

/** A snapshot file with its header changed by `f` (and its checksum made again). */
function reheaded(file: Uint8Array, f: (h: Record<string, unknown>) => void) {
  const v = new DataView(file.buffer, file.byteOffset, file.length);
  const len = v.getUint32(12, true);
  const h = JSON.parse(new TextDecoder().decode(file.subarray(16, 16 + len))) as Record<string, unknown>;
  f(h);
  const json = new TextEncoder().encode(JSON.stringify(h));
  const out = new Uint8Array(file.length - len + json.length);
  out.set(file.subarray(0, 16));
  new DataView(out.buffer).setUint32(12, json.length, true);
  out.set(json, 16);
  new DataView(out.buffer).setUint32(16 + json.length, crc32(json), true);
  out.set(file.subarray(16 + len + 4), 16 + json.length + 4);
  return out;
}

// Benchmarks start their arms from one warm snapshot (docs/benchmarking.md "Starting from a snapshot"): a file is tied
// to the core's state layout (`snapshot_version`) and the machine, not to the build that made it or the ABI it ran on,
// so a core that differs only in its JIT loads it and the guest runs on exactly; another layout is refused.
test('a snapshot loads into another build of the core (a JIT-only change), and not into another state layout', { skip }, async () => {
  const bytes = readFileSync(new URL('../target/wasm32-unknown-unknown/release/waarm64_core.wasm', import.meta.url));
  const other = await compileCore(otherBuild(bytes, 'waarm64-other-jit'));
  const [codec, otherCodec] = [await lzCodec(WASM), await lzCodec(other)];
  const o = buildroot();
  const whole = await runToPowerOff(WASM, o);
  const vm = await bootVm(WASM, o);
  let [steps, console] = [0, ''];
  for (const at = 12_000_000; steps < at;) {
    const r = await vm.runAsync(at - steps);
    steps += r.steps;
    console += vm.drain();
    if (r.kind === Exit.DEVICE) await vm.settle();
  }
  if (!(await vm.pause())) throw new Error('the machine ended as it was paused');
  const parts: Uint8Array[] = [];
  await writeSnapshot(vm, (b) => { parts.push(b.slice()); }, { machine: 'test' }, codec);
  await vm.close();
  const saved = new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
  // As another build saved it: another ABI in the header, a build name the reader doesn't know.
  const file = new Blob([reheaded(saved, (h) => { h.abi = Number(h.abi) + 7; h.build = 'waarm64-other-jit'; })]);
  const { header, restore } = await readSnapshot(file, otherCodec, otherCodec.snapshotVersion, { devices: o.devices });
  assert.equal(header.abi, ABI + 7);
  const next = await bootVm(other, { ...o, restore });
  let kind: number = Exit.BUDGET;
  while (kind === Exit.BUDGET || kind === Exit.TX_FULL || kind === Exit.DEVICE) {
    const r = await next.runAsync(100_000_000);
    [kind, steps, console] = [r.kind, steps + r.steps, console + next.drain()];
    if (kind === Exit.DEVICE) await next.settle();
  }
  await next.close();
  assert.equal(kind, Exit.PSCI);
  assert.equal(steps, STEPS.buildroot);
  assert.equal(console, whole.console);
  // Another state layout: the version the other core reads (its `snapshot_version`) and the core state's own word.
  await assert.rejects(readSnapshot(file, otherCodec, otherCodec.snapshotVersion + 1), (e: unknown) => e instanceof SnapshotError && e.problem === 'other-version');
  const core = restore.core.slice();
  core[4]++;
  await assert.rejects(bootVm(other, { ...o, restore: { ...restore, core } }), (e: unknown) => e instanceof SnapshotError && e.problem === 'other-version');
  // Another machine (a device more) under the other build: refused too.
  await assert.rejects((async () => { const x = await readSnapshot(file, otherCodec, otherCodec.snapshotVersion); await (await bootVm(other, { ...o, devices: [...o.devices!, { type: 'rng' }], restore: x.restore })).close(); })(), (e: unknown) => e instanceof SnapshotError && e.problem === 'other-machine');
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

// The disk in the file (loop 6). /test-rw.sh writes a file to the root filesystem on its first
// boot (`rw: wrote <hash>`), finds it on the next (`rw: kept <hash>`). Node keeps overlays in memory.
test('a snapshot carries the disk\'s changes: a restore replaces the overlay with them', { skip }, async () => {
  const name = 'snapshot-test-rw';
  await removeOverlay(name);
  const codec = await lzCodec(WASM);
  const o = buildroot({ cmdline: `${GUEST_CMDLINE} -- /test-rw.sh`, devices: guestDevices(disk, name) });
  const line = (c: string, what: string) => c.match(new RegExp(`rw: ${what} (\\S+)`))?.[1];
  // An unbroken first boot says how long it is (the console's lines come out at its end, so
  // they can't time the save). Then boot 1 again, saved 400,000 steps before its power-off: the
  // script has written its file and synced, and the overlay has its blocks.
  const plain = `${name}-plain`;
  await removeOverlay(plain);
  const whole = await runToPowerOff(WASM, { ...o, devices: guestDevices(disk, plain) });
  await removeOverlay(plain);
  assert.ok(line(whole.console, 'wrote'), whole.console);
  let vm = await bootVm(WASM, o);
  let [out, steps] = ['', 0];
  const run = async (to: number) => {
    for (;;) {
      const r = await vm.runAsync(Math.min(100_000_000, to - steps));
      steps += r.steps;
      out += vm.drain();
      if (r.kind === Exit.DEVICE) await vm.settle();
      if (r.kind === Exit.PSCI || steps >= to) return r;
    }
  };
  const at = whole.steps - 400_000;
  assert.equal((await run(at)).kind === Exit.PSCI, false);
  const parts: Uint8Array[] = [];
  const w = await writeSnapshot(vm, (b) => { parts.push(b); }, {}, codec);
  const file = new Blob(parts as BlobPart[]);
  assert.ok(w.diskBlocks > 0, 'no block of the disk in the file');
  poweredOff({ ...(await run(Infinity)), console: out });
  const wrote = line(out, 'wrote');
  assert.equal(wrote, line(whole.console, 'wrote'));
  const total = steps;
  assert.equal(total, whole.steps);
  await vm.close();

  // The overlay now has all of boot 1. From the file, the machine is back at the save, on the
  // disk as it was then: it runs the rest again, in the same steps, to the same hash.
  const again = async () => {
    const { header, restore } = await readSnapshot(file, codec, codec.snapshotVersion, { devices: o.devices });
    assert.equal((header.disks as { blocks: number }[])[0].blocks, w.diskBlocks);
    vm = await bootVm(WASM, { ...o, restore });
    [out, steps] = ['', at];
    poweredOff({ ...(await run(Infinity)), console: out });
    assert.equal(steps, total);
    await vm.close();
  };
  await again();
  // In a fresh profile (no overlay at all) the file is enough.
  await removeOverlay(name);
  await again();
  // And the next boot finds what that run wrote.
  const next = await runToPowerOff(WASM, o);
  assert.equal(line(next.console, 'kept'), wrote, next.console);

  // Refused before the overlay is touched: another disk, a file cut in its disk blocks.
  const other = { ...o, devices: guestDevices(new URL('alpine/rootfs.ext4', IMAGES).href, name) };
  await assert.rejects(readSnapshot(file, codec, codec.snapshotVersion, { devices: other.devices }), (e: unknown) => e instanceof SnapshotError && e.problem === 'other-disk' && e.msg.key === 'snapshots:snapshot.otherDisk');
  await assert.rejects(readSnapshot(file.slice(0, file.size - 5000), codec, codec.snapshotVersion, { devices: o.devices }), (e: unknown) => e instanceof SnapshotError && e.problem === 'truncated');
  const flipped = new Uint8Array(await file.arrayBuffer());
  flipped[flipped.length - 3000] ^= 1;
  await assert.rejects(readSnapshot(new Blob([flipped]), codec, codec.snapshotVersion, { devices: o.devices }), (e: unknown) => e instanceof SnapshotError && e.problem === 'corrupt');
  await assert.rejects(readSnapshot(file, codec, codec.snapshotVersion, { devices: guestDevices(disk) }), (e: unknown) => e instanceof SnapshotError && e.problem === 'other-machine');
  const still = await runToPowerOff(WASM, o);
  assert.equal(line(still.console, 'kept'), wrote, 'a refused snapshot touched the overlay');
  // The same bytes under another name: accepted by the base's hash, where the file has one.
  const hashed: Uint8Array[] = [];
  vm = await bootVm(WASM, o);
  await writeSnapshot(vm, (b) => { hashed.push(b); }, {}, codec, { sha256: () => 'abc123' });
  await vm.close();
  const renamed = { devices: [{ type: 'console' }, { type: 'rng' }, { type: 'blk', url: 'file:///elsewhere/copy.ext4', overlay: name }] as BootOptions['devices'] };
  const hfile = new Blob(hashed as BlobPart[]);
  await assert.rejects(readSnapshot(hfile, codec, codec.snapshotVersion, { ...renamed, sha256: () => 'def456' }), (e: unknown) => e instanceof SnapshotError && e.problem === 'other-disk');
  let asked = 0;
  await readSnapshot(hfile, codec, codec.snapshotVersion, { ...renamed, sha256: () => (asked++, 'abc123') });
  await readSnapshot(hfile, codec, codec.snapshotVersion, { devices: o.devices, sha256: () => (asked++, 'never') });
  assert.equal(asked, 1, 'the hash is only asked for when the cheap identity differs');
  await removeOverlay(name);
});

// Suspend (loop 8): the snapshot without the disk's blocks, kept beside the overlay; it resumes
// onto the overlay as the suspended machine left it.
test('a suspended machine resumes onto its overlay, and its file is no snapshot to load elsewhere', { skip }, async () => {
  const name = 'snapshot-test-suspend';
  await removeOverlay(name);
  const codec = await lzCodec(WASM);
  const o = buildroot({ cmdline: `${GUEST_CMDLINE} -- /test-rw.sh`, devices: guestDevices(disk, name) });
  const plain = `${name}-plain`;
  await removeOverlay(plain);
  const whole = await runToPowerOff(WASM, { ...o, devices: guestDevices(disk, plain) });
  await removeOverlay(plain);
  const wrote = whole.console.match(/rw: wrote (\S+)/)?.[1];
  assert.ok(wrote, whole.console);
  let vm = await bootVm(WASM, o);
  let steps = 0;
  const run = async (to: number) => {
    for (;;) {
      const r = await vm.runAsync(Math.min(100_000_000, to - steps));
      steps += r.steps;
      vm.drain();
      if (r.kind === Exit.DEVICE) await vm.settle();
      if (r.kind === Exit.PSCI || steps >= to) return r;
    }
  };
  // Suspended after the script wrote its file: the machine is closed, not run on.
  await run(whole.steps - 400_000);
  const out = await suspendWriter(name);
  const w = await writeSnapshot(vm, (b) => out.write(b), {}, codec, { suspend: true });
  out.close();
  await vm.close();
  assert.equal(w.diskBlocks, 0, 'a suspended machine carries no disk block');
  const file = (await suspended(name))!;
  assert.equal(file.size, w.bytes);
  // It is not a snapshot to load: it has no disk. And a snapshot is not a suspended machine.
  await assert.rejects(readSnapshot(file, codec, codec.snapshotVersion, { devices: o.devices }), (e: unknown) => e instanceof SnapshotError && e.problem === 'other-disk' && e.msg.key === 'snapshots:snapshot.suspended');
  // Resumed: the overlay is kept, the machine finishes in the unbroken boot's steps.
  const { header, restore } = await readSnapshot(file, codec, codec.snapshotVersion, { devices: o.devices, resume: true });
  assert.equal(header.suspend, true);
  vm = await bootVm(WASM, { ...o, restore });
  await dropSuspend(name); // before it runs: the disk moves on
  assert.equal(await suspended(name), undefined);
  poweredOff({ ...(await run(Infinity)), console: '' });
  assert.equal(steps, whole.steps);
  await vm.close();
  const next = await runToPowerOff(WASM, o);
  assert.equal(next.console.match(/rw: kept (\S+)/)?.[1], wrote, next.console);
  // Resetting the disk drops a suspended machine with it.
  const again = await suspendWriter(name);
  again.write(new Uint8Array(8));
  again.close();
  assert.ok(await suspended(name));
  await removeOverlay(name);
  assert.equal(await suspended(name), undefined);
});

test('a machine with a 9p device says it cannot be saved', { skip }, async () => {
  const vm = await bootVm(WASM, buildroot({ devices: [...guestDevices(disk), { type: '9p', tag: 'host', files: {} }] }));
  await assert.rejects(vm.snapshot(), /9p device can't be saved/);
  await vm.close();
});
