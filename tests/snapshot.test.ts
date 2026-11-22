// A VM through snapshot files (web/snapshot.ts, docs/platform.md "Snapshots"): the guest runs
// under the JIT, is saved to a file (the core's state, the backends', RAM through the LZ codec),
// closed, and a new VM started from the file runs on. Deterministic round-robin: the run takes
// the steps of tests/steps.txt and prints what an unbroken run prints. Then what is refused (an older file by its
// version, before its frames are read), the codec's CRC-32, and a save's pool.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { lzCodec } from '../web/lz.ts';
import { ramStarts, readSnapshot, runThroughSnapshots, writeSnapshot } from '../web/snapshot.ts';
import { dropSuspend, openOverlay, overlay, overlayMeta, removeOverlay, suspended, suspendWriter } from '../web/overlay.ts';
import { diskIdentity } from '../web/devices.ts';
import { zeroDisk } from '../web/stored.ts';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { applyRam, crc32, frameHeader, openSnapshot, SnapshotError, SnapshotWriter, type LoadPool, type RamPool, type SnapshotHeader } from '../web/snapshot-file.ts';
import { poolSize, startPool } from '../web/snapshot-pool.ts';
import { STEPS } from './steps.ts';
import { ABI, bootVm, type BootOptions } from '../web/vm.ts';
import { Exit, PSCI_SYSTEM_OFF, compileCore } from '../web/core.ts';
import { CONSOLE_INPUT, CONSOLE_INPUT_STEP, CONSOLE_INPUT_WANT, DISTROS, GUEST_CMDLINE, guestDevices, runToPowerOff } from '../web/test-guests.ts';

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
// a new one with new workers started from the file. Not reproducible: WAARM64_PARALLEL_RUNS repeats it. Counted
// (`count`): the snapshots are taken at steps.
const RUNS = Number(process.env.WAARM64_PARALLEL_RUNS ?? 2);
test('parallel: Buildroot on 4 vCPUs (JIT) through snapshot files', { skip }, async () => {
  for (let i = 0; i < RUNS; i++) {
    const at = Array.from({ length: 8 }, (_, k) => (k + 1) * 5_000_000 + i * 1_234_567);
    const r = await runThroughSnapshots(WASM, buildroot({ ncpus: 4, parallel: true, idleLimitMs: 30_000, count: true }), at, 1e12);
    report(`parallel Buildroot on 4 vCPUs, run ${i + 1}`, r);
    poweredOff(r);
    assert.ok(r.files.length >= 6, `${r.files.length} snapshots`);
    assert.match(r.console, /smp: Brought up 1 node, 4 CPUs[^]*waarm64: test ok\r?\nwaarm64: test exit 0\r?\n/);
    assert.equal(r.hvc.replaceAll('\r\n', '\n'), 'waarm64: hvc0 ok\n');
  }
});

const litmusImage = new URL('litmus/initramfs.cpio', IMAGES);
test('parallel: litmus and the atomics stress on 4 vCPUs (JIT) through snapshot files', { skip: skip || (!existsSync(litmusImage) && 'SKIPPED: run images/build.sh linux litmus') }, async () => {
  const o: BootOptions = { ramSize: 256 << 20, kernel: image('linux/Image'), initrd: readFileSync(litmusImage), cmdline: 'console=ttyAMA0 panic=-1 waarm64.litmus=-s,100,-r,1 waarm64.stress=-n,20000', ncpus: 4, parallel: true, idleLimitMs: 30_000, jit: 1, count: true };
  const at = Array.from({ length: 10 }, (_, k) => (k + 1) * 60_000_000);
  const r = await runThroughSnapshots(WASM, o, at, 1e12);
  report('parallel litmus and stress', r);
  poweredOff(r);
  assert.ok(r.files.length >= 5, `${r.files.length} snapshots`);
  assert.match(r.console, /litmus: all ok, 0 skipped\r?\nwaarm64: stress on 4 CPUs[^]*\nwaarm64: test ok\r?\n/);
});

const HEADER: SnapshotHeader = { format: 1, coreVersion: 6, abi: 69, created: '2026-11-15T00:00:00Z', machine: 'pool' };

test('the core\'s codec: its CRC-32 is zlib\'s', async () => {
  const codec = await lzCodec(WASM);
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

/** RAM on shared memory for the pool's tests: zero chunks and pages, incompressible chunks, compressible pages. */
function poolRam(chunks: number) {
  const ram = new Uint8Array(new SharedArrayBuffer(chunks << 20));
  let s = 7;
  const rand = () => ((s ^= s << 13), (s ^= s >>> 17), (s ^= s << 5), s & 255);
  for (let c = 0; c < chunks; c++) {
    if (c % 5 === 1) continue; // all zero: no frame
    for (let p = 0; p < 256; p++) {
      const page = ram.subarray((c * 256 + p) * 4096, (c * 256 + p + 1) * 4096);
      if (c % 5 === 3) page.forEach((_, i) => (page[i] = rand())); // incompressible: stored, codec 0
      else if ((p * 7 + c) % 3 === 0) page.fill(c + p);
      else if ((p + c) % 3 === 1) for (let i = 0; i < 4096; i += 64) page[i] = rand();
    }
  }
  return ram;
}

/**
 * A file of RAM (`views`, memory 0's then a spill memory's, numbered on), through `pool` or this thread; its progress.
 * `later`: the sink takes each frame's bytes a task later (a written frame's buffer goes back to its worker only then).
 */
async function poolFile(views: Uint8Array[], codec: Awaited<ReturnType<typeof lzCodec>>, pool?: RamPool, later = false) {
  const parts: Uint8Array[] = [];
  const sink = later ? async (b: Uint8Array) => { await new Promise((r) => setTimeout(r, 0)); parts.push(b.slice()); } : (b: Uint8Array) => { parts.push(b.slice()); };
  const w = new SnapshotWriter(sink, HEADER, { codec, concurrency: 1 });
  await w.bytes('CORE', new Uint8Array(3000).fill(9));
  const seen: number[] = [];
  const counts = [];
  for (const [k, v] of views.entries()) counts.push(await w.ram(v, (done) => seen.push(done), k * 64, pool));
  await w.disk([{ block: 3, data: new Uint8Array(4096).fill(1) }]);
  await w.end();
  return { file: Buffer.concat(parts), seen, counts, pooled: w.pooled, times: w.times };
}

test('a save\'s pool: the file is byte-identical for any pool size and for none, a failed pool or worker falls back to this thread', async () => {
  const codec = await lzCodec(WASM);
  const views = [poolRam(23), poolRam(9).subarray(65536 * 16)]; // a spill memory's view starts past its memory's start
  const one = await poolFile(views, codec);
  assert.equal(one.pooled, 0);
  // Read back: every page where it was.
  const back = views.map((v) => new Uint8Array(v.length));
  for await (const f of (await openSnapshot(new Blob([one.file]), { codec })).frames()) {
    if (f.tag === 'RAM ') applyRam(back[f.index >= 64 ? 1 : 0], f.index % 64, f.data);
  }
  for (const [k, v] of views.entries()) assert.ok(Buffer.compare(back[k], v) === 0, `view ${k} differs after a round trip`);
  const same = (r: Awaited<ReturnType<typeof poolFile>>, what: string) => {
    assert.ok(Buffer.compare(r.file, one.file) === 0, `${what}: the file differs (${r.file.length} bytes against ${one.file.length})`);
    assert.deepEqual(r.counts, one.counts, `${what}: pages and frames`);
    // The progress: each chunk once, in order, to the end of each view.
    assert.deepEqual(r.seen, one.seen, `${what}: the progress`);
  };
  for (const n of [1, 2, 3, 6]) {
    const pool = await startPool(WASM, n);
    assert.ok(pool, `a pool of ${n} starts`);
    try {
      const r = await poolFile(views, codec, pool, n === 2);
      assert.equal(r.pooled, n);
      assert.ok(r.times.compress > 0 && r.times.scan > 0, `${n}: the workers' times are counted`);
      same(r, `a pool of ${n}`);
      // A written frame's buffer goes back to its worker: a few a worker (three in flight, and those written since its
      // last job), not one a frame.
      const frames = r.counts.reduce((a, c) => a + c.frames, 0);
      assert.ok(pool.buffers() <= n * 5 && (n > 2 || pool.buffers() < frames / 2), `a pool of ${n} made ${pool.buffers()} buffers for ${frames} frames`);
    } finally {
      pool.close();
    }
  }
  // A pool that can't start (a failed instance: a module without the codec) is none: the save runs here, the same.
  const empty = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  assert.equal(await startPool(empty, 2), undefined);
  assert.equal(await startPool(WASM, 0), undefined);
  assert.equal(poolSize(8), 6);
  assert.equal(poolSize(4), 3);
  assert.equal(poolSize(1), 0);
  // Workers that fail chunks (every third), and a pool closed (its workers ended) halfway: those are made here.
  const pool = await startPool(WASM, 3);
  assert.ok(pool);
  try {
    let asked = 0;
    const flaky: RamPool = { size: 3, ram: (b, o, l, i) => (i % 3 === 2 ? Promise.reject(new Error('planted')) : pool.ram(b, o, l, i)) };
    same(await poolFile(views, codec, flaky), 'a pool failing every third chunk');
    const closing: RamPool = { size: 3, ram: (b, o, l, i) => { if (++asked === 10) pool.close(); return pool.ram(b, o, l, i); } };
    same(await poolFile(views, codec, closing), 'a pool closed halfway');
  } finally {
    pool.close();
  }
  // A view not on shared memory is written here (the pool reads shared memory only).
  const plain = await poolFile(views.map((v) => v.slice()), codec, { size: 2, ram: () => Promise.reject(new Error('asked')) });
  assert.ok(Buffer.compare(plain.file, one.file) === 0, 'a plain view through a pool');
  assert.equal(plain.pooled, 0);
});

/**
 * A file of RAM `views` (memory 0's, then a spill memory's) as `readSnapshot` restores one: CORE, DEVS, RAM, END (and
 * with `disk`, a DISK frame before it).
 */
async function loadFile(views: Uint8Array[], codec: Awaited<ReturnType<typeof lzCodec>>, disk = false) {
  const header: SnapshotHeader = { ...HEADER, coreVersion: codec.snapshotVersion, ramSize: views[0].length, spill: views.slice(1).map((v) => v.length), disks: [] };
  const parts: Uint8Array[] = [];
  const w = new SnapshotWriter((b) => { parts.push(b.slice()); }, header, { codec, concurrency: 1 });
  await w.bytes('CORE', new Uint8Array(3000).fill(9));
  await w.bytes('DEVS', new TextEncoder().encode(JSON.stringify({ devices: [], input: [] })));
  const starts = ramStarts(views.map((v) => v.length));
  for (const [k, v] of views.entries()) await w.ram(v, undefined, starts[k]);
  if (disk) await w.disk([{ block: 5, data: new Uint8Array(4096).fill(3) }]);
  await w.end();
  return Buffer.concat(parts);
}

/** The file's frames: each one's tag, where its stored bytes start and their length. */
function framesOf(file: Buffer) {
  const out: { tag: string; at: number; len: number }[] = [];
  for (let at = 20 + file.readUInt32LE(12); at < file.length; at += 32 + file.readUInt32LE(at + 20)) {
    out.push({ tag: file.toString('latin1', at, at + 4), at: at + 32, len: file.readUInt32LE(at + 20) });
  }
  return out;
}

test('a load\'s pool: RAM placed as on one thread for any pool size, a failing worker\'s frames done here, a damaged frame refused before RAM is touched', async () => {
  const codec = await lzCodec(WASM);
  const views = [poolRam(23), poolRam(9).subarray(65536 * 16)];
  const file = await loadFile(views, codec);
  /** RAM of `views`' sizes, zero, on shared memory (or not: `plain`), the spill memory's view at an offset of its buffer. */
  const fresh = (plain = false) => plain
    ? views.map((v) => new Uint8Array(v.length))
    : [new Uint8Array(new SharedArrayBuffer(views[0].length)), new Uint8Array(new SharedArrayBuffer(views[1].length + (65536 * 16))).subarray(65536 * 16)];
  /** `file` restored into fresh RAM through `pool`: the RAM and the phases. */
  const restore = async (pool?: LoadPool, plain = false) => {
    const ram = fresh(plain);
    const r = await readSnapshot(new Blob([file]), codec, codec.snapshotVersion, { pool });
    await r.restore.fill(ram[0], [ram[1]]);
    return { ram, phases: r.phases };
  };
  const same = (ram: Uint8Array[], what: string) => {
    for (const [k, v] of views.entries()) assert.ok(Buffer.compare(ram[k], v) === 0, `${what}: memory ${k}'s RAM differs`);
  };
  const one = await restore();
  same(one.ram, 'on one thread');
  assert.equal(one.phases.pool, 0);
  for (const n of [1, 2, 3, 6]) {
    const pool = await startPool(WASM, n);
    assert.ok(pool, `a pool of ${n} starts`);
    try {
      const r = await restore(pool);
      same(r.ram, `a pool of ${n}`);
      assert.equal(r.phases.pool, n);
      assert.ok(r.phases.checkCrc > 0 && r.phases.crc > 0 && r.phases.unpack > 0 && r.phases.apply > 0, `${n}: the workers' times are counted: ${JSON.stringify(r.phases)}`);
      // RAM not on shared memory: placed here.
      same((await restore(pool, true)).ram, `a pool of ${n}, RAM not shared`);
    } finally {
      pool.close();
    }
  }
  const pool = await startPool(WASM, 3);
  assert.ok(pool);
  try {
    // A worker failing every third piece, one saying it failed each piece's first frame, and a pool closed halfway:
    // those frames are read again and done here.
    let asked = 0;
    const flaky: LoadPool = { size: 3, frames: (piece, jobs) => (++asked % 3 === 0 ? Promise.reject(new Error('planted')) : pool.frames(piece, jobs)) };
    same((await restore(flaky)).ram, 'a pool failing every third piece');
    const firsts: LoadPool = { size: 3, frames: (piece, jobs) => pool.frames(piece, jobs).then((r) => ({ ...r, failed: [...new Set([0, ...r.failed])].sort((a, b) => a - b) })) };
    same((await restore(firsts)).ram, 'a pool failing each piece\'s first frame');
    asked = 0;
    const closing: LoadPool = { size: 3, frames: (piece, jobs) => { if (++asked === 4) pool.close(); return pool.frames(piece, jobs); } };
    same((await restore(closing)).ram, 'a pool closed halfway');
  } finally {
    pool.close();
  }

  // Small pieces: frames and their headers across pieces (each such frame given alone), the frames in pieces of several;
  // a DISK frame after RAM's, in the piece of its last frames: once it comes, `placed` has every RAM frame in.
  const starts = ramStarts(views.map((v) => v.length));
  const withDisk = await loadFile(views, codec, true);
  const ramOf = framesOf(withDisk).filter((f) => f.tag === 'RAM ');
  const broken = Buffer.from(withDisk);
  broken[ramOf[ramOf.length >> 1].at + 1000] ^= 1;
  const small = await startPool(WASM, 2);
  assert.ok(small);
  try {
    for (const piece of [4099, 65536 + 7, (1 << 20) + 17, 3 << 20, undefined]) {
      const check = await openSnapshot(new Blob([withDisk]), { codec, check: true, pool: small, piece });
      let n = 0;
      for await (const _ of check.frames()) n++;
      assert.ok(n === framesOf(withDisk).length - 1 && check.pooled === 2, `pieces of ${piece}: ${n} frames checked`);
      await assert.rejects(async () => {
        for await (const _ of (await openSnapshot(new Blob([broken]), { codec, check: true, pool: small, piece })).frames()) void _;
      }, (e: unknown) => e instanceof SnapshotError && e.problem === 'corrupt', `pieces of ${piece}: a damaged frame is refused`);
      const s = await openSnapshot(new Blob([withDisk]), { codec, pool: small, piece });
      const ram = fresh();
      const tags: string[] = [];
      for await (const f of s.frames()) {
        tags.push(f.tag);
        if (f.tag === 'RAM ') {
          const k = f.index >= starts[1] ? 1 : 0;
          f.place!(ram[k], f.index - starts[k]);
        } else assert.ok(f.data.length > 0, `pieces of ${piece}: a ${f.tag} frame's data`);
        if (f.tag === 'DISK') {
          await s.placed();
          same(ram, `pieces of ${piece}, at the DISK frame`);
        }
      }
      await s.placed();
      assert.deepEqual([...new Set(tags)], ['CORE', 'DEVS', 'RAM ', 'DISK'], `pieces of ${piece}: the frames`);
      same(ram, `pieces of ${piece}`);
    }
  } finally {
    small.close();
  }

  // A byte flipped in a RAM frame: refused as damaged by the check pass, with or without a pool, before RAM is given.
  const ramFrames = framesOf(file).filter((f) => f.tag === 'RAM ');
  const hit = ramFrames[ramFrames.length >> 1];
  const damaged = Buffer.from(file);
  damaged[hit.at + (hit.len >> 1)] ^= 0x40;
  for (const n of [0, 3]) {
    const p = n ? await startPool(WASM, n) : undefined;
    const ram = fresh();
    try {
      await assert.rejects(async () => {
        const r = await readSnapshot(new Blob([damaged]), codec, codec.snapshotVersion, { pool: p });
        await r.restore.fill(ram[0], [ram[1]]); // only reached if the check pass let it through
      }, (e: unknown) => e instanceof SnapshotError && e.problem === 'corrupt' && (e.msg.params?.what as { key?: string })?.key === 'snapshots:snapshot-file.damage.checksum', `a pool of ${n}: a damaged RAM frame is refused by its checksum`);
    } finally {
      p?.close();
    }
    for (const [k, v] of ram.entries()) assert.ok(v.every((b) => b === 0), `a pool of ${n}: memory ${k} untouched`);
  }
  // The restore's own pass refuses it too through the pool (its workers' refusal, the frame done again here), and
  // `placed` says so before anything after RAM is read; a stream (no check pass first) is read on one thread.
  const p = await startPool(WASM, 2);
  try {
    const s = await openSnapshot(new Blob([damaged]), { codec, pool: p });
    const ram = fresh();
    await assert.rejects(async () => {
      for await (const f of s.frames()) {
        if (f.tag === 'RAM ') f.place!(ram[f.index >= starts[1] ? 1 : 0], f.index - (f.index >= starts[1] ? starts[1] : 0));
      }
      await s.placed();
    }, (e: unknown) => e instanceof SnapshotError && (e.msg.params?.what as { key?: string })?.key === 'snapshots:snapshot-file.damage.checksum', 'the restore pass refuses a damaged RAM frame');
    const r = await readSnapshot(new Blob([damaged]).stream(), codec, codec.snapshotVersion, { pool: p });
    await assert.rejects(async () => r.restore.fill(ram[0], [ram[1]]), (e: unknown) => e instanceof SnapshotError && e.problem === 'corrupt', 'a stream\'s restore refuses it');
  } finally {
    p?.close();
  }
});

test('through a pool, a frame\'s bad CRC is refused before a later frame\'s bad structure in the same piece, as on one thread', async () => {
  const codec = await lzCodec(WASM);
  const file = await loadFile([poolRam(23)], codec);
  const ram = framesOf(file).filter((f) => f.tag === 'RAM ');
  const [k, next] = [ram[ram.length >> 1], ram[(ram.length >> 1) + 1]];
  const damaged = Buffer.from(file);
  damaged[k.at + (k.len >> 1)] ^= 0x40; // frame k's payload
  damaged.write('XXXX', next.at - 32, 'latin1'); // frame k + 1's tag
  for (const n of [0, 3]) {
    const p = n ? await startPool(WASM, n) : undefined;
    try {
      // Both in one piece (the default's 16 MiB holds the whole file).
      const s = await openSnapshot(new Blob([damaged]), { codec, check: true, pool: p });
      await assert.rejects(async () => { for await (const _ of s.frames()) void _; },
        (e: unknown) => e instanceof SnapshotError && (e.msg.params?.what as { key?: string })?.key === 'snapshots:snapshot-file.damage.checksum', `a pool of ${n}: the earlier frame's checksum`);
    } finally {
      p?.close();
    }
  }
});

test('a restore writes a disk\'s blocks in runs: every block, its zeros without slots, across leaves and up to a short last block', async () => {
  const codec = await lzCodec(WASM);
  const name = 'snapshot-test-runs';
  // A disk of two leaves and 10 blocks, its last block 1,000 bytes; the file's blocks: data and zeros alternating in
  // runs, a run across the leaves' boundary (1,024), a frame of 256, lone blocks, and the last block.
  const size = (2 * 1024 + 10) * 4096 + 1000;
  const last = Math.ceil(size / 4096) - 1;
  const spec = { type: 'blk', url: 'file:///runs/disk.img', overlay: name } as const;
  const kinds = new Map<number, 'data' | 'zero'>();
  const mark = (from: number, to: number, k: 'data' | 'zero') => { for (let b = from; b < to; b++) kinds.set(b, k); };
  mark(0, 3, 'data'); mark(3, 5, 'zero'); mark(5, 6, 'data'); mark(7, 8, 'zero'); mark(100, 356, 'data');
  mark(1015, 1020, 'zero'); mark(1020, 1030, 'data'); mark(1030, 1031, 'zero'); mark(1031, 1033, 'data'); mark(2000, 2040, 'zero');
  kinds.set(last, 'data');
  const bytesOf = (b: number) => {
    const d = new Uint8Array(4096);
    if (kinds.get(b) === 'data') d.fill((b % 251) + 1, 0, b === last ? size % 4096 : 4096);
    return d;
  };
  const blocks = [...kinds.keys()].sort((x, y) => x - y);
  const header: SnapshotHeader = { ...HEADER, coreVersion: codec.snapshotVersion, ramSize: 65536, disks: [{ slot: 0, identity: diskIdentity(spec, size), size, blocks: blocks.length }] };
  const parts: Uint8Array[] = [];
  const w = new SnapshotWriter((b) => { parts.push(b.slice()); }, header, { codec, concurrency: 1 });
  await w.bytes('CORE', new Uint8Array(3000).fill(9));
  await w.bytes('DEVS', new TextEncoder().encode(JSON.stringify({ devices: [], input: [] })));
  await w.disk(blocks.map((b) => ({ block: b, data: bytesOf(b) })));
  await w.end();
  const file = new Blob(parts as BlobPart[]);
  // The overlay had other blocks: emptied first.
  await removeOverlay(name);
  {
    const f = await openOverlay(name, diskIdentity(spec, size));
    const o = overlay(zeroDisk(size), f.data, f.map, f.meta);
    assert.ok(await o.write(6 * 4096, new Uint8Array(3 * 4096).fill(7)));
    assert.ok(await o.write(1500 * 4096, new Uint8Array(4096).fill(8)));
    o.flush();
    f.close();
  }
  const r = await readSnapshot(file, codec, codec.snapshotVersion, { devices: [spec] });
  await r.restore.fill(new Uint8Array(65536));
  // Read back by a new opening (its map read from the file).
  const f = await openOverlay(name, diskIdentity(spec, size));
  try {
    const o = overlay(zeroDisk(size), f.data, f.map);
    assert.deepEqual([...o.written()], blocks, 'the overlay holds the file\'s blocks, and only those');
    for (const b of blocks) {
      assert.equal(o.zeroed(b), kinds.get(b) === 'zero', `block ${b}: ${kinds.get(b)}`);
      assert.ok(Buffer.compare(o.block(b)!, bytesOf(b)) === 0, `block ${b}'s bytes`);
    }
    const data = blocks.filter((b) => kinds.get(b) === 'data').length;
    assert.equal(f.data.getSize(), data * 4096, 'a slot for each data block, none for the zeros');
    assert.ok(Buffer.compare((await o.read(0, size))!, Buffer.concat(Array.from({ length: last + 1 }, (_, b) => bytesOf(b))).subarray(0, size)) === 0, 'the whole disk');
  } finally {
    f.close();
  }
  // A frame past the disk's end is refused.
  const past: Uint8Array[] = [];
  const wp = new SnapshotWriter((b) => { past.push(b.slice()); }, { ...header, disks: [{ slot: 0, identity: diskIdentity(spec, size), size, blocks: 2 }] }, { codec, concurrency: 1 });
  await wp.bytes('CORE', new Uint8Array(3000).fill(9));
  await wp.bytes('DEVS', new TextEncoder().encode(JSON.stringify({ devices: [], input: [] })));
  await wp.disk([{ block: last, data: bytesOf(last) }, { block: last + 1, data: new Uint8Array(4096) }]);
  await wp.end();
  await assert.rejects(async () => {
    const rp = await readSnapshot(new Blob(past as BlobPart[]), codec, codec.snapshotVersion, { devices: [spec] });
    await rp.restore.fill(new Uint8Array(65536));
  }, (e: unknown) => e instanceof SnapshotError && e.problem === 'corrupt');
  await removeOverlay(name);
});

test('a file whose DISK frames say impossible things is refused before the overlay is touched', async () => {
  const codec = await lzCodec(WASM);
  const name = 'snapshot-test-disk-damage';
  const size = 64 * 4096;
  const spec = { type: 'blk', url: 'file:///damage/disk.img', overlay: name } as const;
  const header: SnapshotHeader = { ...HEADER, coreVersion: codec.snapshotVersion, ramSize: 65536, disks: [{ slot: 0, identity: diskIdentity(spec, size), size, blocks: 3 }] };
  const parts: Uint8Array[] = [];
  const w = new SnapshotWriter((b) => { parts.push(b.slice()); }, header, { codec, concurrency: 1 });
  await w.bytes('CORE', new Uint8Array(3000).fill(9));
  await w.bytes('DEVS', new TextEncoder().encode(JSON.stringify({ devices: [], input: [] })));
  // Two DISK frames (blocks 1 and 40 apart), compressed (a repeating pattern).
  await w.disk([1, 40, 41].map((b) => ({ block: b, data: new Uint8Array(4096).map((_, i) => (i * 7 + b) & 0xff) })));
  await w.end();
  const file = Buffer.concat(parts);
  const disks = framesOf(file).filter((f) => f.tag === 'DISK');
  assert.equal(disks.length, 2, 'two DISK frames');
  /** `file` with DISK frame `k`'s header and stored bytes changed by `edit`, its CRC made right again. */
  const edited = (k: number, edit: (head: Buffer, stored: Buffer) => void): Uint8Array<ArrayBuffer> => {
    const out = Buffer.from(file);
    const f = disks[k];
    const head = out.subarray(f.at - 32, f.at);
    const stored = out.subarray(f.at, f.at + f.len);
    edit(head, stored);
    head.writeUInt32LE(crc32(stored, crc32(head.subarray(0, 24))), 24);
    return new Uint8Array(out);
  };
  const cases: [string, Uint8Array<ArrayBuffer>, string][] = [
    ['a DISK frame of a slot the header doesn\'t pin', edited(1, (h) => h.writeUInt32LE(h.readUInt32LE(12) + 7 * 256, 12)), 'snapshots:snapshot.damage.unlistedDisk'],
    ['a DISK frame whose bytes don\'t unpack', edited(1, (h, s) => { assert.notEqual(h.readUInt32LE(4), 0, 'compressed'); s.fill(0xff); }), 'snapshots:snapshot-file.damage.unpack'],
    ['a frame past the disk\'s end', edited(1, (h) => h.writeUInt32LE(64, 8)), 'snapshots:snapshot.damage.pastDisk'],
    ['a RAM frame after a DISK frame', edited(1, (h) => h.write('RAM ', 0, 'latin1')), 'snapshots:snapshot.damage.unexpected'],
  ];
  // The CRCs are right: the restore passes refuse what the check pass let through.
  for (const [what, damaged, key] of cases) {
    await removeOverlay(name);
    {
      const f = await openOverlay(name, diskIdentity(spec, size));
      const o = overlay(zeroDisk(size), f.data, f.map, f.meta);
      assert.ok(await o.write(6 * 4096, new Uint8Array(3 * 4096).fill(7)));
      o.flush();
      f.close();
    }
    const was = await overlayMeta(name);
    for (const n of [0, 2]) {
      const p = n ? await startPool(WASM, n) : undefined;
      try {
        await assert.rejects(async () => {
          const r = await readSnapshot(new Blob([damaged]), codec, codec.snapshotVersion, { devices: [spec], pool: p });
          await r.restore.fill(new Uint8Array(65536));
        }, (e: unknown) => e instanceof SnapshotError && e.problem === 'corrupt' && (e.msg.params?.what as { key?: string })?.key === key, `${what}, a pool of ${n}: refused as ${key}`);
      } finally {
        p?.close();
      }
      assert.deepEqual(await overlayMeta(name), was, `${what}, a pool of ${n}: the overlay's generation unchanged`);
      const f = await openOverlay(name, diskIdentity(spec, size));
      try {
        const o = overlay(zeroDisk(size), f.data, f.map);
        assert.deepEqual([...o.written()], [6, 7, 8], `${what}, a pool of ${n}: the overlay holds its own blocks`);
        assert.ok(o.block(7)!.every((b) => b === 7), `${what}, a pool of ${n}: its bytes`);
      } finally {
        f.close();
      }
    }
  }
  await removeOverlay(name);
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
  const w = await writeSnapshot(vm, (b) => { parts.push(b.slice()); }, { machine: 'test' }, codec);
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
  // An older file (docs/platform.md "The snapshot file": not read) is refused by its version, before its frames are read: here
  // one of codec 1 (deflate-raw, which the reader no longer takes), which a check pass would call damage.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const old = reheaded(bytes, (h) => { h.coreVersion = codec.snapshotVersion - 1; });
  const at = 20 + new DataView(old.buffer).getUint32(12, true);
  old.set(frameHeader('CORE', 1, 0, 4, 4).subarray(0, 24), at); // the first frame says codec 1 (its CRC now fails too)
  await assert.rejects(readSnapshot(new Blob([old]), codec, codec.snapshotVersion), (e: unknown) => e instanceof SnapshotError && e.problem === 'other-version' && e.msg.key === 'snapshots:snapshot.otherVersion');
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
  await writeSnapshot(vm, (b) => { parts.push(b.slice()); }, {}, codec);
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
  const w = await writeSnapshot(vm, (b) => { parts.push(b.slice()); }, {}, codec);
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
