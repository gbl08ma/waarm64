// Boot time of the Buildroot guest (target/images/linux, images/build.sh) on the
// wasm core in a worker, deterministic mode, root filesystem on virtio-blk over
// HTTP ranges: time to /init ("webpc: init" on the console) and to power-off
// after /test.sh.
// Cold: a freshly compiled module per boot (V8 starts on Liftoff code).
// Warm: one module, reused after warm-up boots.
// `--only boot_defconfig`: the same with the arm64 defconfig kernel (Image-defconfig).
// `--only boot_alpine`: Alpine (target/images/alpine) as its boot test runs it:
// 1 GiB, the test devices and a framebuffer; to its local.d script and to power-off.
// `--only boot_jit`, `--only boot_alpine_jit`: the Buildroot and Alpine boots under the JIT (VmConfig.jit = 1);
// `--only boot_debian_jit`: Debian 13's (one cold and one warm boot, several minutes; not in the default set);
// `--only coremark_vm_jit`: CoreMark as init under Buildroot's kernel, realtime mode (its own score);
// `--only alpine_user_jit`: Alpine's userspace phases after its boot (images/alpine/user), ms per phase;
// `--only alpine_crypto_jit`: `openssl speed` in the same image (webpc.phase=crypto), realtime, MB/s, the crypto extensions off (the NEON-only paths);
// `--only alpine_crypto_ce_jit`: the same with them on (every other benchmark's default since M6.5 loop 7).
// I/O, realtime mode, a fresh boot per sample, timed by the host between the
// guest script's "webpc: … start/end" markers unless fio times itself:
// `--only dd`: /bench-dd.sh reads all of /dev/vda (sync-XHR block backend);
// `--only fio`: /bench-fio.sh, fio random 4 KiB and sequential 1 MiB O_DIRECT reads;
// `--only p9`: /bench-9p.sh, 9p file operations on the in-memory tree;
// `--only net`: /bench-net.sh, ping-pong with the loopback adapter.
import type { Options, Sample } from '../spike/benchmarks.ts';
import { bootVm, DISTROS, Exit, GUEST_CMDLINE as CMDLINE, guestDevices, PSCI_SYSTEM_OFF, testDevices } from '../../web/vm.ts';

const CHUNK = 1_000_000; // steps per vm_run, so console markers are timed to ~a chunk

async function get(rel: string): Promise<Uint8Array<ArrayBuffer>> {
  const r = await fetch(new URL(rel, import.meta.url));
  if (!r.ok) throw new Error(`${rel}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** `jit`: `VmConfig.jit` (0 interpreter, 1 JIT). */
type Img = { kernel: Uint8Array; initrd?: Uint8Array; disk: string; cmdline: string; ramSize: number; test?: boolean; jit?: 0 | 1; gic?: 2 | 3 };

export async function images(image = 'Image'): Promise<Img & { wasm: Uint8Array<ArrayBuffer> }> {
  const [wasm, kernel] = await Promise.all([
    get('../../target/wasm32-unknown-unknown/release/webpc_core.wasm'),
    get(`../../target/images/linux/${image}`),
  ]);
  return { wasm, kernel, disk: new URL('../../target/images/buildroot/rootfs.ext4', import.meta.url).href, cmdline: CMDLINE, ramSize: 256 << 20 };
}

/**
 * One boot to power-off: ms to each "webpc: …" console line (`marks`, keyed
 * by the text after "webpc: ") and to the end, and the counters. `test`: the
 * device tests' devices and a 640×480 framebuffer (web/vm.ts `testDevices`).
 */
export async function boot(module: WebAssembly.Module, img: Img, onVm?: (vm: Awaited<ReturnType<typeof bootVm>>) => void | Promise<void>, o: { cmdline?: string; realtime?: boolean; crypto?: boolean; onMark?: (mark: string, vm: Awaited<ReturnType<typeof bootVm>>) => void } = {}) {
  const devices = img.test ? testDevices(img.disk) : guestDevices(img.disk);
  const framebuffer = img.test ? { width: 640, height: 480 } : undefined;
  const vm = await bootVm(module, { ramSize: img.ramSize, kernel: img.kernel, initrd: img.initrd, cmdline: o.cmdline ?? img.cmdline, devices, realtime: o.realtime, framebuffer, jit: img.jit, crypto: o.crypto, gic: img.gic, idleLimitMs: 30_000 });
  await onVm?.(vm);
  let console = '';
  let scanned = 0;
  const marks: Record<string, number> = {};
  const t0 = performance.now();
  for (;;) {
    const r = vm.run(CHUNK);
    console += vm.drain();
    const now = performance.now() - t0;
    const end = console.lastIndexOf('\n') + 1; // whole lines only
    for (const m of console.slice(scanned, end).matchAll(/webpc: ([^\r\n]*)/g)) {
      if (m[1] in marks) continue;
      marks[m[1]] = now;
      o.onMark?.(m[1], vm);
    }
    scanned = Math.max(scanned, end);
    if (r.kind === Exit.DEVICE) await vm.settle(); // backends inline (Node)
    if (r.kind === Exit.BUDGET || r.kind === Exit.TX_FULL || r.kind === Exit.DEVICE) continue;
    const total = performance.now() - t0;
    vm.close();
    if (r.kind !== Exit.PSCI || r.x[0] !== PSCI_SYSTEM_OFF || !/webpc: test (exit 0|ok)/.test(console)) {
      throw new Error(`boot failed: exit ${r.kind} at pc 0x${vm.pc().toString(16)}\n${console}`);
    }
    return { init: marks['init'], total, marks, console, stats: vm.stats(), helpers: vm.helperReport().slice(0, 30) };
  }
}

export async function runAll(o: Options, image = 'Image', jit: 0 | 1 = 0): Promise<Sample[]> {
  const s = await bootTimes(o, { ...(await images(image)), jit }, 'init', { kernel: image, cmdline: CMDLINE, ramMiB: 256, jit });
  return jit ? s.map((x) => ({ ...x, name: x.name.replace('boot_', 'boot_jit_') })) : s;
}

/** Cold and warm boots of `img`: ms to the `first` marker and to power-off. */
/**
 * A full GC before each timed boot (bench/run.ts runs Chromium with
 * --expose-gc): V8 reuses the compiled code of a wasm module whose bytes match
 * one still alive, and a deterministic boot generates the same JIT modules
 * (and loads the same core) every time, so without it a boot is fast or slow
 * (Buildroot under the JIT 710 vs 920 ms) by whether the previous one's
 * modules were collected yet (M5 step 7). A first boot compiles everything.
 */
const fresh = () => (globalThis as { gc?: () => void }).gc?.();

async function bootTimes(o: Options, img: Img & { wasm: Uint8Array<ArrayBuffer> }, first: string, params: Record<string, unknown>, n = { cold: 5, warmup: 3, warm: 10 }): Promise<Sample[]> {
  if (o.quick) n = { cold: 2, warmup: 1, warm: 3 };
  const cold = { init: [] as number[], total: [] as number[] };
  const warm = { init: [] as number[], total: [] as number[] };
  let stats, helpers: { op: string; calls: number }[] | undefined;
  for (let i = 0; i < n.cold; i++) {
    fresh();
    const t = performance.now();
    const module = await WebAssembly.compile(img.wasm);
    const r = await boot(module, img);
    // Cold includes compiling the core: it's part of a first boot.
    cold.init.push(r.marks[first] + (performance.now() - t - r.total));
    cold.total.push(performance.now() - t);
  }
  const module = await WebAssembly.compile(img.wasm);
  for (let i = 0; i < n.warmup; i++) await boot(module, img);
  for (let i = 0; i < n.warm; i++) {
    fresh();
    const r = await boot(module, img);
    warm.init.push(r.marks[first]);
    warm.total.push(r.total);
    stats = r.stats;
    helpers = r.helpers;
  }
  o.log?.(`warm total: ${warm.total.map((x) => x.toFixed(0)).join(' ')} ms; counters ${JSON.stringify(stats)}`);
  params = { ...params, first, steps: stats!.steps, counters: stats, ...(helpers?.length && { helpers }) };
  return [
    { name: 'boot_init_cold', unit: 'ms', params, samples: cold.init },
    { name: 'boot_total_cold', unit: 'ms', params, samples: cold.total },
    { name: 'boot_init', unit: 'ms', params, samples: warm.init },
    { name: 'boot_total', unit: 'ms', params, samples: warm.total },
  ];
}

/** Realtime sequential read of /dev/vda (the 32 MiB root image) over the synchronous-XHR block backend. */
async function dd(o: Options): Promise<Sample[]> {
  const img = await images();
  const module = await WebAssembly.compile(img.wasm);
  const size = Number((await fetch(img.disk, { method: 'HEAD' })).headers.get('content-length'));
  const cmdline = `${CMDLINE} -- /bench-dd.sh`;
  const mibs: number[] = [];
  for (let i = 0; i < (o.quick ? 3 : 10); i++) {
    const r = await boot(module, img, undefined, { cmdline, realtime: true });
    const ms = r.marks['dd end'] - r.marks['dd start'];
    if (!(ms > 0)) throw new Error(`no dd markers:\n${r.console}`);
    mibs.push(size / 2 ** 20 / (ms / 1000));
    o.log?.(`dd: ${ms.toFixed(0)} ms; guest: ${JSON.stringify(r.console.split('webpc: dd start')[1]?.split('webpc: dd end')[0].trim())}`);
  }
  return [{ name: 'blk_dd_read', unit: 'MiB/s', params: { cmdline, bytes: size, bs: '1M', realtime: true, backend: 'sync XHR, one request at a time' }, samples: mibs }];
}

/** Alpine's boot test (core/tests/distros.rs): time to its local.d script and to power-off. */
async function bootAlpine(o: Options, jit: 0 | 1 = 0, gic?: 2): Promise<Sample[]> {
  const a = DISTROS.alpine;
  const [base, initrd, kernel] = await Promise.all([images(), get(`../../target/images/${a.initrd}`), get(`../../target/images/${a.kernel}`)]);
  const img = { ...base, kernel, initrd, disk: new URL(`../../target/images/${a.disk}`, import.meta.url).href, cmdline: a.cmdline, ramSize: 1 << 30, test: true, jit, gic };
  const s = await bootTimes(o, img, 'alpine 3.24.2 6.18.53-0-virt', { distro: 'alpine', cmdline: a.cmdline, ramMiB: 1024, devices: 'test', jit, ...(gic && { gic }) }, { cold: 3, warmup: 1, warm: 5 });
  const pre = (jit ? 'alpine_jit' : 'alpine') + (gic ? `_gicv${gic}` : '');
  return s.map((x) => ({ ...x, name: x.name.replace('boot_init', `${pre}_script`).replace('boot_total', `${pre}_total`) }));
}

/** The userspace phases after Alpine's boot, under the JIT (M6's end; docs/benchmarking.md). */
const USER_PHASES = ['compress', 'lua', 'churn', 'sqlite'];

/**
 * Alpine's userspace benchmark: the boot image's kernel and initramfs with
 * rootfs-user.ext4, whose local.d script runs timed phases after booting
 * (images/alpine/user). Deterministic, the root disk only; ms per phase from
 * its "webpc: <phase> start/end" lines, and to power-off.
 */
async function alpineUser(o: Options, gic?: 2): Promise<Sample[]> {
  const a = DISTROS.alpine;
  const [base, initrd, kernel] = await Promise.all([images(), get(`../../target/images/${a.initrd}`), get(`../../target/images/${a.kernel}`)]);
  const img = { ...base, kernel, initrd, disk: new URL('../../target/images/alpine-user/rootfs-user.ext4', import.meta.url).href, cmdline: a.cmdline, ramSize: 1 << 30, jit: 1 as const, gic };
  const module = await WebAssembly.compile(img.wasm);
  const phases: Record<string, number[]> = Object.fromEntries([...USER_PHASES, 'total'].map((p) => [p, []]));
  let stats;
  for (let i = 0; i < (o.quick ? 1 : 3); i++) {
    fresh();
    const r = await boot(module, img);
    for (const p of USER_PHASES) phases[p].push(between(r, p));
    phases.total.push(r.total);
    stats = r.stats;
    o.log?.(`alpine_user_jit: ${USER_PHASES.map((p) => `${p} ${between(r, p).toFixed(0)}`).join(', ')}, total ${r.total.toFixed(0)} ms`);
  }
  const params = { distro: 'alpine', disk: 'rootfs-user.ext4', cmdline: a.cmdline, ramMiB: 1024, jit: 1, ...(gic && { gic }), steps: stats!.steps, counters: stats };
  return Object.entries(phases).map(([p, samples]) => ({ name: `alpine_user_jit${gic ? `_gicv${gic}` : ''}_${p}`, unit: 'ms', params, samples }));
}

/**
 * `openssl speed` in Alpine's user image under the JIT (M6.5 loop 0): its
 * `webpc.phase=crypto` path (images/alpine/user) after the boot, in realtime
 * mode, since `openssl speed` times itself with the guest clock. MB/s (10^6
 * bytes) per algorithm and block size, and the helper calls made during the
 * phase. `extra` adds to Alpine's command line (`webpc.armcap=…` sets
 * OPENSSL_armcap); `crypto` gives the vCPU the crypto extensions (ABI 19).
 */
async function alpineCrypto(o: Options, extra = '', crypto = false): Promise<Sample[]> {
  const a = DISTROS.alpine;
  const [base, initrd, kernel] = await Promise.all([images(), get(`../../target/images/${a.initrd}`), get(`../../target/images/${a.kernel}`)]);
  const img = { ...base, kernel, initrd, disk: new URL('../../target/images/alpine-user/rootfs-user.ext4', import.meta.url).href, cmdline: a.cmdline, ramSize: 1 << 30, jit: 1 as const };
  const cmdline = `${a.cmdline} webpc.phase=crypto${extra && ` ${extra}`}`;
  const module = await WebAssembly.compile(img.wasm);
  const out = new Map<string, Sample>();
  const params = { distro: 'alpine', disk: 'rootfs-user.ext4', cmdline, ramMiB: 1024, jit: 1, realtime: true, seconds: 1, crypto };
  let helpers: { op: string; calls: number }[] = [];
  let check = '';
  for (let i = 0; i < (o.quick ? 1 : 5); i++) {
    fresh();
    let before = new Map<string, number>();
    const r = await boot(module, img, undefined, { cmdline, realtime: true, crypto, onMark: (m, vm) => { if (m === 'crypto start') before = new Map(vm.helperReport().map((h) => [h.op, h.calls])); } });
    helpers = r.helpers.map((h) => ({ op: h.op, calls: h.calls - (before.get(h.op) ?? 0) })).filter((h) => h.calls > 0).sort((x, y) => y.calls - x.calls);
    check = r.console.match(/crypto: [0-9a-f]{16} [^\r\n]*/)?.[0] ?? '';
    const phase = r.console.split('webpc: crypto start')[1]?.split('webpc: crypto end')[0] ?? '';
    let bytes = 0;
    for (const [, kind, rest] of phase.matchAll(/\+([HF]):([^\r\n]*)/g)) {
      const f = rest.split(':');
      if (kind === 'H') { bytes = Number(f[0]); continue; }
      const name = `crypto_${f[1].toLowerCase()}_${bytes}`;
      if (!out.has(name)) out.set(name, { name, unit: 'MB/s', params: { ...params, algorithm: f[1], bytes }, samples: [] });
      out.get(name)!.samples.push(Number(f[2]) / 1e6);
    }
    o.log?.(`alpine_crypto${crypto ? '_ce' : ''}_jit: ${r.console.match(/crypto: CPUINFO[^\r\n]*/)?.[0]}; ${[...out.values()].map((s) => `${s.name} ${s.samples.at(-1)!.toFixed(1)}`).join(', ')}; phase ${between(r, 'crypto').toFixed(0)} ms`);
  }
  if (check !== CRYPTO_CHECK) throw new Error(`OpenSSL check: "${check}", expected "${CRYPTO_CHECK}"`);
  o.log?.(`helpers in the phase: ${helpers.slice(0, 15).map((h) => `${h.op} ${h.calls}`).join(', ')}`);
  // The phase's helper calls go with the first sample only.
  return [...out.values()].map((s, i) => (i ? s : { ...s, params: { ...s.params, helpers: helpers.slice(0, 30) } }));
}

/** The crypto phase's check line (SHA-1, SHA-256, AES-128-CBC, AES-256-CTR, AES-128-CBC decrypt), from arm64 hardware. */
const CRYPTO_CHECK = 'crypto: 82a2bffdaeb5d862 0e66434871168f25 9705ef3ce219893e 5aa8ca270a880d01 63bd397e0cc0e537';

/** Debian 13 under the JIT to power-off (M6: timed once; long, so one cold and one warm boot). */
async function bootDebian(o: Options): Promise<Sample[]> {
  const d = DISTROS.debian;
  const [base, initrd, kernel] = await Promise.all([images(), get(`../../target/images/${d.initrd}`), get(`../../target/images/${d.kernel}`)]);
  const img = { ...base, kernel, initrd, disk: new URL(`../../target/images/${d.disk}`, import.meta.url).href, cmdline: d.cmdline, ramSize: 1 << 30, test: true, jit: 1 as const };
  const s = await bootTimes(o, img, 'debian', { distro: 'debian', cmdline: d.cmdline, ramMiB: 1024, devices: 'test', jit: 1 }, { cold: 1, warmup: 0, warm: 1 });
  return s.map((x) => ({ ...x, name: x.name.replace('boot_init', 'debian_jit_first').replace('boot_total', 'debian_jit_total') }));
}

/** A newc cpio archive of `[path, mode, data?, [major, minor]?]` entries. */
function cpio(entries: [string, number, Uint8Array?, [number, number]?][]): Uint8Array<ArrayBuffer> {
  const bytes: number[] = [];
  const align = () => { while (bytes.length % 4) bytes.push(0); };
  let ino = 1;
  for (const [name, mode, data = new Uint8Array(), [maj, min] = [0, 0]] of [...entries, ['TRAILER!!!', 0] as [string, number]]) {
    const n = new TextEncoder().encode(`${name}\0`);
    const fields = [ino++, mode, 0, 0, 1, 0, data.length, 0, 0, maj, min, n.length, 0];
    bytes.push(...new TextEncoder().encode(`070701${fields.map((v) => v.toString(16).padStart(8, '0')).join('')}`), ...n);
    align();
    for (const b of data) bytes.push(b);
    align();
  }
  return new Uint8Array(bytes);
}

/**
 * CoreMark in the whole VM under the JIT (M6 exit table): `coremark-linux`
 * (bench/interp/build-coremark.sh) as the init of a minimal initramfs under
 * Buildroot's kernel, MMU on, in realtime mode so CoreMark's own timing (the
 * kernel's clock) is the host's; the same initramfs runs under QEMU for
 * comparison. The guest panics when CoreMark exits (panic=-1: a reset).
 */
async function coremarkVm(o: Options): Promise<Sample[]> {
  const [base, cm] = await Promise.all([images(), get('../../target/bench/coremark-linux')]);
  const initrd = cpio([['dev', 0o40755], ['dev/console', 0o20600, undefined, [5, 1]], ['init', 0o100755, cm]]);
  const module = await WebAssembly.compile(base.wasm);
  const cmdline = 'console=ttyAMA0 panic=-1 rdinit=/init';
  const samples: number[] = [];
  for (let i = 0; i < (o.quick ? 1 : 3); i++) {
    fresh();
    const vm = await bootVm(module, { ramSize: 256 << 20, kernel: base.kernel, initrd, cmdline, devices: [], realtime: true, jit: 1, idleLimitMs: 30_000 });
    let out = '';
    for (;;) {
      const r = vm.run(CHUNK);
      out += vm.drain();
      if (r.kind === Exit.DEVICE) await vm.settle();
      if (r.kind === Exit.BUDGET || r.kind === Exit.TX_FULL || r.kind === Exit.DEVICE || r.kind === Exit.IDLE) continue;
      break;
    }
    vm.close();
    // A CRC mismatch is "ERROR! … crc"; a run under 10 s (CoreMark sizes it
    // from a calibration run, which a cold JIT slows) is its own "ERROR!" and
    // is still a correct run.
    const m = out.match(/Iterations\/Sec\s*:\s*([\d.]+)/);
    if (!m || /ERROR!(?! Must execute for at least 10 secs)/.test(out)) throw new Error(`CoreMark failed:\n${out}`);
    samples.push(Number(m[1]));
    o.log?.(`coremark_vm_jit: ${m[1]} iterations/s${out.includes('Correct operation validated') ? '' : ' (under 10 s)'}`);
  }
  return [{ name: 'coremark_vm_jit', unit: 'iterations/s', params: { kernel: 'Image', cmdline, realtime: true, jit: 1 }, samples }];
}

/** Realtime boots of the Buildroot guest with the test devices running `script`, `n` of them. */
async function scriptBoots(o: Options, script: string, n: number) {
  const img = { ...(await images()), test: true };
  const module = await WebAssembly.compile(img.wasm);
  const cmdline = `${CMDLINE} -- ${script}`;
  const runs = [];
  for (let i = 0; i < (o.quick ? Math.min(n, 2) : n); i++) runs.push(await boot(module, img, undefined, { cmdline, realtime: true }));
  return { runs, params: { cmdline, realtime: true } };
}

/** ms between the markers "<what> start" and "<what> end". */
function between(r: { marks: Record<string, number>; console: string }, what: string) {
  const ms = r.marks[`${what} end`] - r.marks[`${what} start`];
  if (!(ms > 0)) throw new Error(`no ${what} markers:\n${r.console}`);
  return ms;
}

/** fio's own numbers ("BENCH <name> <value> <unit>" lines). */
async function fio(o: Options): Promise<Sample[]> {
  const { runs, params } = await scriptBoots(o, '/bench-fio.sh', 5);
  const out = new Map<string, Sample>();
  for (const r of runs) {
    for (const [, name, v, unit] of r.console.matchAll(/BENCH (\S+) (\S+) (\S+)/g)) {
      if (!out.has(name)) out.set(name, { name, unit, params: { ...params, job: 'psync, O_DIRECT, 3 s' }, samples: [] });
      out.get(name)!.samples.push(Number(v));
    }
  }
  o.log?.(`fio: ${runs[0].console.match(/BENCH[^]*/)?.[0]}`);
  return [...out.values()];
}

/** 9p: 16 MiB written and read, 200 files created, listed with stat, removed. */
async function p9(o: Options): Promise<Sample[]> {
  const { runs, params } = await scriptBoots(o, '/bench-9p.sh', 10);
  const per = (f: (r: (typeof runs)[0]) => number) => runs.map(f);
  o.log?.(`9p ms: ${JSON.stringify(Object.fromEntries(['write', 'read', 'create', 'stat', 'unlink'].map((w) => [w, between(runs[0], `9p ${w}`).toFixed(0)])))}`);
  return [
    { name: 'p9_write', unit: 'MiB/s', params: { ...params, bytes: 16 << 20, bs: '1M' }, samples: per((r) => 16 / (between(r, '9p write') / 1000)) },
    { name: 'p9_read', unit: 'MiB/s', params: { ...params, bytes: 16 << 20, bs: '1M' }, samples: per((r) => 16 / (between(r, '9p read') / 1000)) },
    { name: 'p9_create', unit: 'files/s', params: { ...params, files: 200 }, samples: per((r) => 200 / (between(r, '9p create') / 1000)) },
    { name: 'p9_ls_l', unit: 'ms', params: { ...params, files: 200 }, samples: per((r) => between(r, '9p stat')) },
    { name: 'p9_unlink', unit: 'files/s', params: { ...params, files: 200 }, samples: per((r) => 200 / (between(r, '9p unlink') / 1000)) },
  ];
}

/** virtio-net ping-pong with the loopback adapter: full-size and small frames. */
async function net(o: Options): Promise<Sample[]> {
  const { runs, params } = await scriptBoots(o, '/bench-net.sh', 10);
  const rtt = (r: (typeof runs)[0], what: string) => {
    const s = r.console.split(`webpc: net ${what} start`)[1];
    const m = s?.match(/round-trip min\/avg\/max = [\d.]+\/([\d.]+)\//);
    if (!m) throw new Error(`no ping summary:\n${r.console}`);
    return Number(m[1]);
  };
  o.log?.(`net: ${runs[0].console.match(/webpc: net big start[^]*/)?.[0]}`);
  const p = { ...params, pings: 1000, adapter: 'loopback (device worker)' };
  return [
    { name: 'net_big_pps', unit: 'round trips/s', params: { ...p, frame: 1514 }, samples: runs.map((r) => 1000 / (between(r, 'net big') / 1000)) },
    { name: 'net_big_mibs', unit: 'MiB/s each way', params: { ...p, frame: 1514 }, samples: runs.map((r) => (1000 * 1514) / 2 ** 20 / (between(r, 'net big') / 1000)) },
    { name: 'net_big_rtt', unit: 'ms', params: { ...p, frame: 1514, source: "ping's average" }, samples: runs.map((r) => rtt(r, 'big')) },
    { name: 'net_small_pps', unit: 'round trips/s', params: { ...p, frame: 98 }, samples: runs.map((r) => 1000 / (between(r, 'net small') / 1000)) },
    { name: 'net_small_rtt', unit: 'ms', params: { ...p, frame: 98, source: "ping's average" }, samples: runs.map((r) => rtt(r, 'small')) },
  ];
}

export const suite = {
  boot: runAll, boot_defconfig: (o: Options) => runAll(o, 'Image-defconfig'), boot_alpine: bootAlpine, dd, fio, p9, net,
  // Under the JIT (VmConfig.jit = 1), deterministic.
  boot_jit: (o: Options) => runAll(o, 'Image', 1), boot_alpine_jit: (o: Options) => bootAlpine(o, 1), boot_debian_jit: bootDebian, coremark_vm_jit: coremarkVm, alpine_user_jit: alpineUser,
  // Realtime (M6.5).
  alpine_crypto_jit: (o: Options) => alpineCrypto(o),
  alpine_crypto_ce_jit: (o: Options) => alpineCrypto(o, '', true), // the crypto extensions on (VmConfig.features)
  // On a GICv2 (VmConfig.gic = 2; M7 loop 2's A/B against the GICv3 default).
  boot_alpine_jit_gicv2: (o: Options) => bootAlpine(o, 1, 2), alpine_user_jit_gicv2: (o: Options) => alpineUser(o, 2),
};
