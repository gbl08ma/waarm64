// Boot time of the Buildroot guest (target/images/linux, images/build.sh) on the
// wasm core in a worker, deterministic mode, root filesystem on virtio-blk over
// HTTP ranges: time to /init ("waarm64: init" on the console) and to power-off
// after /test.sh.
// Cold: a freshly compiled module per boot (V8 starts on Liftoff code).
// Warm: one module, reused after warm-up boots.
// `--only boot_defconfig`: the same with the arm64 defconfig kernel (Image-defconfig).
// `--only boot_alpine`: Alpine (target/images/alpine) as its boot test runs it:
// 1 GiB, the test devices and a framebuffer; to its local.d script and to power-off.
// `--only boot_jit`, `--only boot_alpine_jit`: the Buildroot and Alpine boots under the JIT (VmConfig.jit = 1);
// `--only coremark_vm_jit`: CoreMark as init under Buildroot's kernel, realtime mode (its own score);
// `--query=growcore`: the core imports the memory growable (web/core.ts `exactCore`), for an A/B.
// `--query=vyield=N`: the vCPU workers' event-loop visits every N ms (`VmOptions.vcpuYieldMs`; 0 never). `vspin=N`: an
// idle vCPU's poll of its wake word before it sleeps, N µs (`VmOptions.vcpuSpinUs`).
// `--query=tallies` with the diagnostic core (`--features diag`) on `smp_*`: also each boot's timer line seen late in
// WFI and running (bench/boot/preempt-counts.ts's latencies, in the browser), µs mean and max.
// `--only alpine_user_jit`: Alpine's userspace phases after its boot (images/alpine/user), ms per phase;
// `--only alpine_user_spill_jit` the same with 192 MiB in memory 0 and the rest in a spill memory;
// `--only alpine_crypto_jit`: `openssl speed` in the same image (waarm64.phase=crypto), realtime, MB/s, the crypto extensions off (the NEON-only paths);
// `--only alpine_crypto_ce_jit`: the same with them on (every other benchmark's default since M6.5 loop 7), SHA512 and
// SHA3 too (since ABI 51); `--only alpine_crypto_nosha3_jit`: the v8.0 ones without SHA512 and SHA3;
// `--only alpine_crypto_eor3_jit`: all of them, with OpenSSL told to use its SHA-3 and EOR3 AES-GCM code.
// `--only gl_llvmpipe_jit`: a compositor's GLES frames on Mesa's llvmpipe (images/alpine/gl), 1 vCPU,
// rasterizing on the calling thread; `gl_llvmpipe_jit_4`: 4 parallel vCPUs, llvmpipe's 4 threads. ms a frame.
// `--only gl_virgl_jit`, `gl_virgl_jit_4`: the same frames through virgl (images/alpine-virgl's Mesa) on the
// device's null renderer (G2: the guest's cost alone); `gl_virgl_llvmpipe_jit[_4]`: llvmpipe from that same build.
// I/O, realtime mode, a fresh boot per sample, timed by the host between the
// guest script's "waarm64: … start/end" markers unless fio times itself:
// `--only dd`: /bench-dd.sh reads all of /dev/vda (sync-XHR block backend);
// `--only fio`: /bench-fio.sh, fio random 4 KiB and sequential 1 MiB O_DIRECT reads;
// `--only p9`: /bench-9p.sh, 9p file operations on the in-memory tree;
// `--only net`: /bench-net.sh, ping-pong with the loopback adapter.
import type { Options, Sample } from '../spike/benchmarks.ts';
import type { DeviceSpec } from '../../web/devices.ts';
import { bootVm } from '../../web/vm.ts';
import { compileCore, Exit, PSCI_SYSTEM_OFF } from '../../web/core.ts';
import { Counter } from '../../web/counters.ts';
import type { Counters, ProcStat } from '../procstat.ts';
import { DISTROS, GUEST_CMDLINE as CMDLINE, guestDevices, testDevices } from '../../web/test-guests.ts';

const CHUNK = 1_000_000; // steps per vm_run, so console markers are timed to ~a chunk
/** The bench page's query: the spike worker's name (bench/spike/page.ts); none in Node. */
const pageQuery = () => new URLSearchParams((globalThis as { name?: string }).name);

/** A path under the repository as a URL. (A template literal written in `new URL(…, import.meta.url)` itself is
 * Vite's asset pattern: its dev server rewrites it, to `undefined` for files outside its globs.) */
const url = (rel: string) => new URL(rel, import.meta.url).href;

async function get(rel: string): Promise<Uint8Array<ArrayBuffer>> {
  const r = await fetch(new URL(rel, import.meta.url));
  if (!r.ok) throw new Error(`${rel}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** `jit`: `VmConfig.jit` (0 interpreter, 1 JIT). */
type Img = { kernel: Uint8Array; initrd?: Uint8Array; disk: string; cmdline: string; ramSize: number; spill?: number[]; test?: boolean; jit?: 0 | 1 | 4 };

export async function images(image = 'Image'): Promise<Img & { wasm: Uint8Array<ArrayBuffer> }> {
  const [wasm, kernel] = await Promise.all([
    get('../../target/wasm32-unknown-unknown/release/waarm64_core.wasm'),
    get(`../../target/images/linux/${image}`),
  ]);
  return { wasm, kernel, disk: new URL('../../target/images/buildroot/rootfs.ext4', import.meta.url).href, cmdline: CMDLINE, ramSize: 256 << 20 };
}

/** The browser's CPU counters now (bench/procstat.ts, through bench/run.ts's `?proc=<port>`); none without it. */
const procNow = async (): Promise<ProcStat | undefined> => {
  const port = pageQuery().get('proc');
  return port ? ((await (await fetch(`http://127.0.0.1:${port}/`)).json()) as ProcStat) : undefined;
};
const procDelta = (a: ProcStat, b: ProcStat): Counters => Object.fromEntries(Object.keys(b.renderer).map((k) => [k, b.renderer[k as keyof Counters] - a.renderer[k as keyof Counters]])) as Counters;

/**
 * A run's samples from the renderer's counters over each boot (docs/benchmarking.md "Counters"): CPU time, and
 * where the host counts them (macOS) instructions and cycles, each also per guest step, and the cycles' share on
 * performance cores.
 */
function procSamples(name: string, params: Record<string, unknown>, procs: (Counters | undefined)[], steps: number[]): Sample[] {
  const p = procs.filter((x) => x !== undefined);
  if (!p.length || p.length !== steps.length) return [];
  const s = (suffix: string, unit: string, f: (c: Counters, i: number) => number) => ({ name: `${name}_${suffix}`, unit, params, samples: p.map(f) });
  const out = [s('cpu_ms', 'ms', (c) => c.cpuNs / 1e6), s('cpu_ns_step', 'ns/step', (c, i) => c.cpuNs / steps[i])];
  if (!p[0].cycles) return out;
  return [...out, s('ginstr', 'G instructions', (c) => c.instructions / 1e9), s('gcycles', 'G cycles', (c) => c.cycles / 1e9), s('instr_step', 'instructions/step', (c, i) => c.instructions / steps[i]), s('cycles_step', 'cycles/step', (c, i) => c.cycles / steps[i]), s('pshare', 'share of cycles on P cores', (c) => c.pCycles / c.cycles), s('joules', 'J', (c) => c.energyNj / 1e9)];
}

/**
 * One boot to power-off: ms to each "waarm64: …" console line (`marks`, keyed
 * by the text after "waarm64: ") and to the end, and the counters. `test`: the
 * device tests' devices and a 640×480 framebuffer (web/test-guests.ts `testDevices`).
 */
export async function boot(module: WebAssembly.Module, img: Img, onVm?: (vm: Awaited<ReturnType<typeof bootVm>>) => void | Promise<void>, o: { cmdline?: string; realtime?: boolean; crypto?: boolean; sha3?: boolean; rng?: boolean; ncpus?: number; parallel?: boolean; devices?: DeviceSpec[]; onMark?: (mark: string, vm: Awaited<ReturnType<typeof bootVm>>) => void } = {}) {
  const devices = o.devices ?? (img.test ? testDevices(img.disk) : guestDevices(img.disk));
  const framebuffer = img.test ? { width: 640, height: 480 } : undefined;
  const vm = await bootVm(module, { ramSize: img.ramSize, spill: img.spill, kernel: img.kernel, initrd: img.initrd, cmdline: o.cmdline ?? img.cmdline, devices, realtime: o.realtime, framebuffer, jit: img.jit, crypto: o.crypto, sha3: o.sha3, rng: o.rng, ncpus: o.ncpus, parallel: o.parallel, idleLimitMs: 30_000, compileWorker: !pageQuery().has('nocw'), fma: pageQuery().get('fma') !== 'emul', exactCore: !pageQuery().has('growcore'), vcpuYieldMs: pageQuery().has('vyield') ? Number(pageQuery().get('vyield')) : undefined, vcpuSpinUs: pageQuery().has('vspin') ? Number(pageQuery().get('vspin')) : undefined });
  await onVm?.(vm);
  const proc0 = await procNow();
  let console = '';
  let scanned = 0;
  const marks: Record<string, number> = {};
  const t0 = performance.now();
  for (;;) {
    // Parallel mode returns at least every 50 ms (web/vm.ts `runAsync`).
    const r = o.parallel ? await vm.runAsync(CHUNK) : vm.run(CHUNK);
    console += vm.drain();
    const now = performance.now() - t0;
    const end = console.lastIndexOf('\n') + 1; // whole lines only
    // Not in the kernel's echo of its command line.
    for (const m of console.slice(scanned, end).replace(/^.*Kernel command line:.*$/gm, '').matchAll(/waarm64: ([^\r\n]*)/g)) {
      if (m[1] in marks) continue;
      marks[m[1]] = now;
      o.onMark?.(m[1], vm);
    }
    scanned = Math.max(scanned, end);
    if (r.kind === Exit.DEVICE) await vm.settle(); // backends inline (Node)
    if (r.kind === Exit.BUDGET || r.kind === Exit.TX_FULL || r.kind === Exit.DEVICE) continue;
    const total = performance.now() - t0;
    const proc1 = await procNow();
    const closed = vm.close();
    // The guest's counter read 0 at boot (a vCPU worker's clock behind the VM's; web/core.ts `clockOffset`).
    if (/Missing cycle counter/.test(console)) throw new Error(`the counter didn't run at boot:\n${console}`);
    if (r.kind !== Exit.PSCI || r.x[0] !== PSCI_SYSTEM_OFF || !/waarm64: test (exit 0|ok)/.test(console)) {
      throw new Error(`boot failed: exit ${r.kind} at pc 0x${vm.pc().toString(16)}\n${console}`);
    }
    return { init: marks['init'], total, marks, closed, console, proc: proc0 && proc1 && procDelta(proc0, proc1), stats: vm.stats(), cpus: vm.cpuStats(), helpers: vm.helperReport().slice(0, 30) };
  }
}

export async function runAll(o: Options, image = 'Image', jit: 0 | 1 = 0): Promise<Sample[]> {
  const s = await bootTimes(o, { ...(await images(image)), jit }, 'init', { kernel: image, cmdline: CMDLINE, ramMiB: 256, jit });
  return jit ? s.map((x) => ({ ...x, name: x.name.replace('boot_', 'boot_jit_') })) : s;
}

/**
 * A full GC before each timed boot (bench/run.ts runs Chromium with
 * --expose-gc): V8 reuses the compiled code of a wasm module whose bytes match
 * one still alive, and a deterministic boot generates the same JIT modules
 * (and loads the same core) every time, so without it a boot is fast or slow
 * (Buildroot under the JIT 710 vs 920 ms) by whether the previous one's
 * modules were collected yet (M5 step 7). A first boot compiles everything.
 */
const fresh = () => (globalThis as { gc?: () => void }).gc?.();

/** Cold and warm boots of `img`: ms to the `first` marker and to power-off. */
async function bootTimes(o: Options, img: Img & { wasm: Uint8Array<ArrayBuffer> }, first: string, params: Record<string, unknown>, n = { cold: 5, warmup: 3, warm: 10 }): Promise<Sample[]> {
  if (o.quick) n = { cold: 2, warmup: 1, warm: 3 };
  const cold = { init: [] as number[], total: [] as number[] };
  const warm = { init: [] as number[], total: [] as number[] };
  let stats, helpers: { op: string; calls: number }[] | undefined;
  const procs: (Counters | undefined)[] = [], steps: number[] = [];
  for (let i = 0; i < n.cold; i++) {
    fresh();
    const t = performance.now();
    const module = await compileCore(img.wasm);
    const r = await boot(module, img);
    // Cold includes compiling the core: it's part of a first boot.
    cold.init.push(r.marks[first] + (performance.now() - t - r.total));
    cold.total.push(performance.now() - t);
  }
  const module = await compileCore(img.wasm);
  for (let i = 0; i < n.warmup; i++) await boot(module, img);
  for (let i = 0; i < n.warm; i++) {
    fresh();
    const r = await boot(module, img);
    warm.init.push(r.marks[first]);
    warm.total.push(r.total);
    procs.push(r.proc);
    steps.push(r.stats.steps);
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
    ...procSamples('boot_total', params, procs, steps),
  ];
}

/** Realtime sequential read of /dev/vda (the 32 MiB root image) over the synchronous-XHR block backend. */
async function dd(o: Options): Promise<Sample[]> {
  const img = await images();
  const module = await compileCore(img.wasm);
  const size = Number((await fetch(img.disk, { method: 'HEAD' })).headers.get('content-length'));
  const cmdline = `${CMDLINE} -- /bench-dd.sh`;
  const mibs: number[] = [];
  for (let i = 0; i < (o.quick ? 3 : 10); i++) {
    const r = await boot(module, img, undefined, { cmdline, realtime: true });
    const ms = r.marks['dd end'] - r.marks['dd start'];
    if (!(ms > 0)) throw new Error(`no dd markers:\n${r.console}`);
    mibs.push(size / 2 ** 20 / (ms / 1000));
    o.log?.(`dd: ${ms.toFixed(0)} ms; guest: ${JSON.stringify(r.console.split('waarm64: dd start')[1]?.split('waarm64: dd end')[0].trim())}`);
  }
  return [{ name: 'blk_dd_read', unit: 'MiB/s', params: { cmdline, bytes: size, bs: '1M', realtime: true, backend: 'sync XHR, one request at a time' }, samples: mibs }];
}

/** Alpine's boot test (core/tests/distros.rs): time to its local.d script and to power-off. */
async function bootAlpine(o: Options, jit: 0 | 1 = 0): Promise<Sample[]> {
  const a = DISTROS.alpine;
  const [base, initrd, kernel] = await Promise.all([images(), get(`../../target/images/${a.initrd}`), get(`../../target/images/${a.kernel}`)]);
  const img = { ...base, kernel, initrd, disk: url(`../../target/images/${a.disk}`), cmdline: a.cmdline, ramSize: 1 << 30, test: true, jit };
  const s = await bootTimes(o, img, 'alpine 3.24.2 6.18.52-0-virt', { distro: 'alpine', cmdline: a.cmdline, ramMiB: 1024, devices: 'test', jit }, { cold: 3, warmup: 1, warm: 5 });
  const pre = jit ? 'alpine_jit' : 'alpine';
  return s.map((x) => ({ ...x, name: x.name.replace('boot_init', `${pre}_script`).replace('boot_total', `${pre}_total`) }));
}

/**
 * A boot's speed as MIPS (steps over the whole boot, power-off included), and its steps, which match
 * tests/steps.txt: `jit` 4 runs it all in the block interpreter (the dispatcher never compiling: the
 * interpreter's yardstick, M8-INTERP), `jit` 1 under the JIT (with `--config liftoff-only`, the reference
 * the interpreter closes in on). One warm-up boot, then `n` timed, each after a GC; one compiled core.
 */
async function bootMips(o: Options, distro: 'buildroot' | 'alpine', jit: 1 | 4): Promise<Sample[]> {
  const base = await images();
  let img: Img & { wasm: Uint8Array<ArrayBuffer> } = { ...base, jit };
  if (distro === 'alpine') {
    const a = DISTROS.alpine;
    const [initrd, kernel] = await Promise.all([get(`../../target/images/${a.initrd}`), get(`../../target/images/${a.kernel}`)]);
    img = { ...base, kernel, initrd, disk: url(`../../target/images/${a.disk}`), cmdline: a.cmdline, ramSize: 1 << 30, test: true, jit };
  }
  const module = await compileCore(img.wasm);
  const n = o.quick ? 2 : distro === 'alpine' ? 3 : 7;
  const mips: number[] = [], ms: number[] = [];
  const procs: (Counters | undefined)[] = [];
  let stats;
  for (let i = 0; i <= n; i++) {
    fresh();
    const r = await boot(module, img);
    if (stats && r.stats.steps !== stats.steps) throw new Error(`steps ${r.stats.steps}, before ${stats.steps}`);
    stats = r.stats;
    o.log?.(`${distro} jit ${jit}: ${r.stats.steps} steps in ${r.total.toFixed(0)} ms, ${(r.stats.steps / r.total / 1000).toFixed(1)} MIPS${i ? '' : ' (warm-up)'}`);
    if (i === 0) continue;
    ms.push(r.total);
    mips.push(r.stats.steps / r.total / 1000);
    procs.push(r.proc);
  }
  const name = `${distro === 'alpine' ? 'boot_alpine' : 'boot'}_${jit === 4 ? 'dec' : 'jit'}`;
  const params = { distro, jit, steps: stats!.steps, counters: stats };
  return [{ name: `${name}_mips`, unit: 'MIPS', params, samples: mips }, { name: `${name}_total`, unit: 'ms', params, samples: ms }, ...procSamples(`${name}_total`, params, procs, procs.map(() => stats!.steps))];
}

/** The userspace phases after Alpine's boot, under the JIT (M6's end; docs/benchmarking.md). */
const USER_PHASES = ['compress', 'lua', 'churn', 'sqlite'];

/**
 * Alpine's userspace benchmark: the boot image's kernel and initramfs with
 * rootfs-user.ext4, whose local.d script runs timed phases after booting
 * (images/alpine/user). Deterministic, the root disk only; ms per phase from
 * its "waarm64: <phase> start/end" lines, and to power-off.
 */
async function alpineUser(o: Options, spill = false): Promise<Sample[]> {
  const a = DISTROS.alpine;
  const [base, initrd, kernel] = await Promise.all([images(), get(`../../target/images/${a.initrd}`), get(`../../target/images/${a.kernel}`)]);
  // `spill`: 192 MiB in memory 0 (the initrd is at +128 MiB) and the rest of the GiB in a spill memory (docs/spill-memories.md), so the phases'
  // pages land in node 1: what a spill access costs the JIT.
  const ram = spill ? { ramSize: 192 << 20, spill: [832 << 20] } : { ramSize: 1 << 30 };
  const name = spill ? 'alpine_user_spill_jit' : 'alpine_user_jit';
  const img = { ...base, kernel, initrd, disk: new URL('../../target/images/alpine-user/rootfs-user.ext4', import.meta.url).href, cmdline: a.cmdline, ...ram, jit: 1 as const };
  const module = await compileCore(img.wasm);
  const phases: Record<string, number[]> = Object.fromEntries([...USER_PHASES, 'total'].map((p) => [p, []]));
  const procs: (Counters | undefined)[] = [];
  let stats;
  for (let i = 0; i < (o.quick ? 1 : 3); i++) {
    fresh();
    const r = await boot(module, img);
    for (const p of USER_PHASES) phases[p].push(between(r, p));
    phases.total.push(r.total);
    procs.push(r.proc);
    stats = r.stats;
    o.log?.(`${name}: ${USER_PHASES.map((p) => `${p} ${between(r, p).toFixed(0)}`).join(', ')}, total ${r.total.toFixed(0)} ms`);
  }
  const params = { distro: 'alpine', disk: 'rootfs-user.ext4', cmdline: a.cmdline, ramMiB: 1024, spillMiB: spill ? [832] : undefined, jit: 1, steps: stats!.steps, counters: stats };
  return [...Object.entries(phases).map(([p, samples]) => ({ name: `${name}_${p}`, unit: 'ms', params, samples })), ...procSamples(`${name}_total`, params, procs, procs.map(() => stats!.steps))];
}

/**
 * `openssl speed` in Alpine's user image under the JIT (M6.5 loop 0): its
 * `waarm64.phase=crypto` path (images/alpine/user) after the boot, in realtime
 * mode, since `openssl speed` times itself with the guest clock. MB/s (10^6
 * bytes) per algorithm and block size, and the helper calls made during the
 * phase. `extra` adds to Alpine's command line (`waarm64.armcap=…` sets
 * OPENSSL_armcap); `crypto` gives the vCPU the crypto extensions (ABI 19),
 * `sha3` SHA512 and SHA3 with them (ABI 51).
 */
async function alpineCrypto(o: Options, extra = '', crypto = false, sha3 = true): Promise<Sample[]> {
  const a = DISTROS.alpine;
  const [base, initrd, kernel] = await Promise.all([images(), get(`../../target/images/${a.initrd}`), get(`../../target/images/${a.kernel}`)]);
  const img = { ...base, kernel, initrd, disk: new URL('../../target/images/alpine-user/rootfs-user.ext4', import.meta.url).href, cmdline: a.cmdline, ramSize: 1 << 30, jit: 1 as const };
  const cmdline = `${a.cmdline} waarm64.phase=crypto${extra && ` ${extra}`}`;
  const module = await compileCore(img.wasm);
  const out = new Map<string, Sample>();
  const params = { distro: 'alpine', disk: 'rootfs-user.ext4', cmdline, ramMiB: 1024, jit: 1, realtime: true, seconds: 1, crypto, sha3: crypto && sha3 };
  let helpers: { op: string; calls: number }[] = [];
  let check = '';
  for (let i = 0; i < (o.quick ? 1 : 5); i++) {
    fresh();
    let before = new Map<string, number>();
    const r = await boot(module, img, undefined, { cmdline, realtime: true, crypto, sha3, onMark: (m, vm) => { if (m === 'crypto start') before = new Map(vm.helperReport().map((h) => [h.op, h.calls])); } });
    helpers = r.helpers.map((h) => ({ op: h.op, calls: h.calls - (before.get(h.op) ?? 0) })).filter((h) => h.calls > 0).sort((x, y) => y.calls - x.calls);
    check = r.console.match(/crypto: [0-9a-f]{16} [^\r\n]*/)?.[0] ?? '';
    const phase = r.console.split('waarm64: crypto start')[1]?.split('waarm64: crypto end')[0] ?? '';
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

/** glcomp's check line by frame count, from llvmpipe natively (the dev VM, any thread count). */
const GL_CHECK: Record<number, string> = { 10: '285f8eb1', 30: 'a26ac0b1' };

/**
 * llvmpipe (docs/benchmarking.md): images/alpine/gl's glcomp after Alpine's boot, `frames`
 * frames of 3 blended quads at 1376×762 plus a 64-row texture upload. One vCPU: deterministic,
 * LP_NUM_THREADS=0 (the shaders' code alone); N vCPUs: parallel, realtime, Mesa's default of a
 * rasterizer thread per CPU. ms a frame (host-timed), and the warm phase (LLVM compiling the
 * shaders, 3 frames).
 */
async function glLlvmpipe(o: Options, ncpus: number, renderer: 'llvmpipe' | 'virgl' | 'virgl-llvmpipe' = 'llvmpipe'): Promise<Sample[]> {
  const a = DISTROS.alpine;
  const [base, initrd, kernel] = await Promise.all([images(), get(`../../target/images/${a.initrd}`), get(`../../target/images/${a.kernel}`)]);
  const frames = ncpus === 1 ? 10 : 30;
  const virgl = renderer === 'virgl';
  // virgl's client is one thread; llvmpipe on 1 vCPU rasterizes on the calling thread.
  const cmdline = `${a.cmdline} waarm64.gl=${frames},3,1376,762${ncpus === 1 && !virgl ? ' waarm64.lp=0' : ''}${virgl ? ' waarm64.gpu=1' : ''}`;
  const disk = renderer === 'llvmpipe' ? 'alpine-gl/rootfs-gl.ext4' : 'alpine-virgl/rootfs-virgl.ext4';
  const img = { ...base, kernel, initrd, disk: url(`../../target/images/${disk}`), cmdline, ramSize: 1 << 30, jit: 1 as const };
  // The display the page's machine has for the same size (G2: a virtio-gpu with virgl on the null renderer).
  const devices: DeviceSpec[] | undefined = virgl ? [...guestDevices(img.disk), { type: 'gpu', width: 1376, height: 762, virgl: true }] : undefined;
  const module = await compileCore(img.wasm);
  const parallel = ncpus > 1;
  const name = `gl_${renderer.replace('-', '_')}_jit${parallel ? `_${ncpus}` : ''}`;
  const out = { frame: [] as number[], warm: [] as number[], steps: [] as number[] };
  let stats, check0: string | undefined;
  for (let i = 0; i < (o.quick ? 1 : 3); i++) {
    fresh();
    const at: Record<string, number> = {};
    const r = await boot(module, img, undefined, { ncpus, parallel, realtime: parallel, devices, onMark: (m, vm) => { at[m] = vm.stats().steps; } });
    const check = r.console.match(/glcomp: check ([0-9a-f]{8})/)?.[1];
    // The null renderer draws nothing, so virgl's read-backs aren't llvmpipe's pixels: the check is only held to itself.
    if (virgl ? check !== (check0 ??= check) || !/glcomp: virgl/.test(r.console) : check !== GL_CHECK[frames]) throw new Error(`glcomp check ${check}, expected ${virgl ? check0 : GL_CHECK[frames]}\n${r.console}`);
    out.frame.push(between(r, 'frames') / frames);
    out.warm.push(between(r, 'warm'));
    out.steps.push((at['frames end'] - at['frames start']) / frames);
    stats = r.stats;
    o.log?.(`${name}: ${out.frame.at(-1)!.toFixed(1)} ms a frame (${(out.steps.at(-1)! / 1e6).toFixed(2)}M steps), warm ${out.warm.at(-1)!.toFixed(0)} ms, total ${r.total.toFixed(0)} ms`);
  }
  const params = { distro: 'alpine', disk: disk.split('/')[1], cmdline, ramMiB: 1024, jit: 1, ncpus, parallel, realtime: parallel, frames, renderer, check: check0, steps: stats!.steps, counters: stats };
  return [{ name: `${name}_frame`, unit: 'ms', params, samples: out.frame }, { name: `${name}_warm`, unit: 'ms', params, samples: out.warm }, { name: `${name}_frame_steps`, unit: 'steps', params, samples: out.steps }];
}

/** The crypto phase's check line (SHA-1, SHA-256, AES-128-CBC, AES-256-CTR, AES-128-CBC decrypt), from arm64 hardware. */
const CRYPTO_CHECK = 'crypto: 82a2bffdaeb5d862 0e66434871168f25 9705ef3ce219893e 5aa8ca270a880d01 63bd397e0cc0e537 fc136488924032ae d48c89f81da2114e';

/**
 * M7's scaling curve (docs/benchmarking.md "SMP"): parallel SMP (a worker per
 * vCPU, realtime) under the JIT on N vCPUs, the Ns alternated within each
 * round so session drift hits them alike. `alpine`: Alpine's boot test to
 * power-off and to its local.d script; `user`: Alpine's userspace phases with
 * `waarm64.threads=N` (N copies of each phase's work), ms per phase. One untimed
 * boot at each N first (the page's caches, V8's code for the core). Per-vCPU
 * counters of the last sample go into the params.
 */
async function smp(o: Options, what: 'alpine' | 'user', ns: number[], rounds: number): Promise<Sample[]> {
  const d = DISTROS.alpine;
  const [base, initrd, kernel] = await Promise.all([images(), get(`../../target/images/${d.initrd}`), get(`../../target/images/${d.kernel}`)]);
  const disk = what === 'user' ? '../../target/images/alpine-user/rootfs-user.ext4' : `../../target/images/${d.disk}`;
  const img = { ...base, kernel, initrd, disk: new URL(disk, import.meta.url).href, cmdline: d.cmdline, ramSize: 1 << 30, test: what !== 'user', jit: 1 as const };
  const module = await compileCore(img.wasm);
  // Boots: also to the distro's first marker (its local.d script), since realtime power-off includes busybox init's 2 s of sleeps.
  const phases = what === 'user' ? [...USER_PHASES, 'total'] : ['script', 'total'];
  const out = new Map<string, Sample>();
  // `?chunk=N`: the vCPUs' chunk (`vm_set_chunk`; PERF loop 32's ceiling of longer chunks).
  const chunk = pageQuery().has('chunk') ? Number(pageQuery().get('chunk')) : undefined;
  let vm: Awaited<ReturnType<typeof bootVm>> | undefined;
  const onVm = (v: Awaited<ReturnType<typeof bootVm>>) => { vm = v; if (chunk) v.setChunk(chunk); };
  const one = (n: number) => boot(module, img, onVm, { cmdline: what === 'user' ? `${d.cmdline} waarm64.threads=${n}` : d.cmdline, ncpus: n, parallel: true });
  // `?tallies`: core/src/tally.rs's timer latencies past each vCPU's counters (count, sum, max; 16 ns ticks): the
  // timer line seen running (48) and in WFI (51), summed over the vCPUs.
  const tallies = pageQuery().has('tallies');
  const late = (at: number) => {
    const t = vm!.counterBlocks.map((b) => Array.from(new BigUint64Array(vm!.memory.buffer, b + Counter.LEN * 8 + at * 8, 3), Number));
    const c = t.reduce((s, x) => s + x[0], 0);
    if (!t.some((x) => x[0])) throw new Error('?tallies: no tallies (not a diagnostic core: build it with --features diag)');
    return { count: c, meanUs: (t.reduce((s, x) => s + x[1], 0) * 0.016) / c, maxUs: Math.max(...t.map((x) => x[2])) * 0.016 };
  };
  const procs = new Map<number, { proc: Counters | undefined; steps: number }[]>();
  for (const n of ns) await one(n);
  for (let i = 0; i < (o.quick ? 1 : rounds); i++) {
    for (const n of ns) {
      fresh();
      const r = await one(n);
      const ms: Record<string, number> = { total: r.total };
      for (const p of USER_PHASES) if (what === 'user') ms[p] = between(r, p);
      if (what !== 'user') ms.script = Object.entries(r.marks).find(([m]) => m.startsWith(what))![1];
      if (tallies) {
        const [run, wfi] = [late(48), late(51)];
        for (const [k, v] of Object.entries({ wfi_late_us: wfi.meanUs, wfi_late_max_us: wfi.maxUs, wfi_wakes: wfi.count, run_late_us: run.meanUs, run_late_max_us: run.maxUs })) {
          const name = `smp_${what}_jit_n${n}_${k}`;
          if (!out.has(name)) out.set(name, { name, unit: k.endsWith('us') ? 'µs' : 'count', params: { ncpus: n, vcpuYieldMs: pageQuery().get('vyield') ?? undefined }, samples: [] });
          out.get(name)!.samples.push(v);
        }
        o.log?.(`smp_${what} n=${n}: timer in WFI ${wfi.count} late ${wfi.meanUs.toFixed(1)} µs (max ${wfi.maxUs.toFixed(0)}), running ${run.meanUs.toFixed(1)} µs`);
      }
      for (const p of phases) {
        const name = `smp_${what}_jit_n${n}_${p}`;
        if (!out.has(name)) out.set(name, { name, unit: 'ms', params: {}, samples: [] });
        const s = out.get(name)!;
        s.samples.push(ms[p]);
        s.params = { distro: 'alpine', cmdline: d.cmdline, threads: what === 'user' ? n : undefined, ncpus: n, parallel: true, jit: 1, chunk, steps: r.stats.steps, counters: r.stats, cpus: r.cpus };
      }
      procs.set(n, [...(procs.get(n) ?? []), { proc: r.proc, steps: r.stats.steps }]);
      const cpus = r.cpus.map((c) => `${(c.steps / 1e6).toFixed(0)}M/${c.jit.blocks}b/${(c.jit.compileNs / 1e6).toFixed(0)}ms`).join(' ');
      o.log?.(`smp_${what} n=${n}: ${phases.map((p) => `${p} ${ms[p].toFixed(0)}`).join(', ')} ms; per vCPU steps/regions/compile: ${cpus}`);
    }
  }
  return [...out.values(), ...[...procs].flatMap(([n, p]) => procSamples(`smp_${what}_jit_n${n}_total`, { ncpus: n }, p.map((x) => x.proc), p.map((x) => x.steps)))];
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
  const module = await compileCore(base.wasm);
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
  // `?jit=1` on the page boots them under the JIT (the interpreter otherwise, as the early reports measured).
  // `?ncpus=N`: parallel SMP on N vCPUs (a worker each, as the page runs); `?chunk=N`: its chunk (`vm_set_chunk`);
  // `?disk=`/`?script=`: another root disk and script (ad hoc experiments).
  const q = pageQuery();
  const jit = q.get('jit') === '1' ? (1 as const) : undefined;
  const ncpus = q.has('ncpus') ? Number(q.get('ncpus')) : undefined;
  const chunk = q.has('chunk') ? Number(q.get('chunk')) : undefined;
  const base = await images();
  const img = { ...base, test: true, jit, disk: q.has('disk') ? new URL(q.get('disk')!, location.href).href : base.disk };
  const module = await compileCore(img.wasm);
  const cmdline = `${CMDLINE} -- ${q.get('script') ?? script}`;
  const runs = [];
  const onVm = chunk ? (vm: Awaited<ReturnType<typeof bootVm>>) => vm.setChunk(chunk) : undefined;
  // `?stats=1`: the counters between each phase's markers, as what the phase spent in the guest (steps) and out of
  // it (parallel mode's time out of the core: idle, the host's exits). How bench/boot/REPORT.md split a ping.
  type Stats = ReturnType<Awaited<ReturnType<typeof bootVm>>['stats']> & { t: number };
  const at: Record<string, Stats> = {};
  const onMark = q.has('stats') ? (m: string, vm: Awaited<ReturnType<typeof bootVm>>) => { at[m] = { ...vm.stats(), t: performance.now() }; } : undefined;
  for (let i = 0; i < (o.quick ? Math.min(n, 2) : n); i++) {
    runs.push(await boot(module, img, onVm, { cmdline, realtime: true, ncpus, parallel: ncpus ? true : undefined, onMark }));
    for (const [m, b] of Object.entries(at)) {
      const a = m.endsWith(' end') && at[m.replace(/ end$/, ' start')];
      if (a) o.log?.(`${m.slice(0, -4)}: ${(b.t - a.t).toFixed(0)} ms, ${((b.steps - a.steps) / 1e6).toFixed(1)}M steps, out ${((b.par.outNs - a.par.outNs) / 1e6).toFixed(1)} ms, ${b.irqs - a.irqs} IRQs, ${b.par.idles - a.par.idles} idles, ${((b.jit.decSteps - a.jit.decSteps) / 1e6).toFixed(2)}M interpreted`);
    }
  }
  return { runs, params: { cmdline, realtime: true, jit: jit ?? 0, ncpus, chunk } };
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
    const s = r.console.split(`waarm64: net ${what} start`)[1];
    const m = s?.match(/round-trip min\/avg\/max = [\d.]+\/([\d.]+)\//);
    if (!m) throw new Error(`no ping summary:\n${r.console}`);
    return Number(m[1]);
  };
  o.log?.(`net: ${runs[0].console.match(/waarm64: net big start[^]*/)?.[0]}`);
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
  boot_jit: (o: Options) => runAll(o, 'Image', 1), boot_alpine_jit: (o: Options) => bootAlpine(o, 1), coremark_vm_jit: coremarkVm, alpine_user_jit: (o: Options) => alpineUser(o), alpine_user_spill_jit: (o: Options) => alpineUser(o, true),
  gl_llvmpipe_jit: (o: Options) => glLlvmpipe(o, 1), gl_llvmpipe_jit_4: (o: Options) => glLlvmpipe(o, 4),
  gl_virgl_jit: (o: Options) => glLlvmpipe(o, 1, 'virgl'), gl_virgl_jit_4: (o: Options) => glLlvmpipe(o, 4, 'virgl'),
  gl_virgl_llvmpipe_jit: (o: Options) => glLlvmpipe(o, 1, 'virgl-llvmpipe'), gl_virgl_llvmpipe_jit_4: (o: Options) => glLlvmpipe(o, 4, 'virgl-llvmpipe'),
  // MIPS over a boot: in the block interpreter alone (`jit` 4) and under the JIT (M8-INTERP's yardstick and,
  // with `--config liftoff-only`, its reference).
  boot_dec: (o: Options) => bootMips(o, 'buildroot', 4), boot_alpine_dec: (o: Options) => bootMips(o, 'alpine', 4),
  boot_mips_jit: (o: Options) => bootMips(o, 'buildroot', 1), boot_alpine_mips_jit: (o: Options) => bootMips(o, 'alpine', 1),
  // Realtime (M6.5).
  alpine_crypto_jit: (o: Options) => alpineCrypto(o),
  alpine_crypto_ce_jit: (o: Options) => alpineCrypto(o, '', true), // the crypto extensions on (VmConfig.features)
  alpine_crypto_nosha3_jit: (o: Options) => alpineCrypto(o, '', true, false), // with them, but not SHA512 and SHA3
  // OpenSSL's SHA-3 (Keccak) and EOR3 AES-GCM paths, which it picks only on CPUs it knows by MIDR (bit 15, bit 12):
  // its armcap on our vCPU (0x9fd) with those two bits.
  alpine_crypto_eor3_jit: (o: Options) => alpineCrypto(o, 'waarm64.armcap=0x99fd', true),
  // M7: parallel SMP at N = 1, 2, 4 vCPUs, alternated; `…_8` once as a check (N + 2 threads: more than the dev VM's 8).
  smp_alpine_jit: (o: Options) => smp(o, 'alpine', [1, 2, 4], 5),
  smp_user_jit: (o: Options) => smp(o, 'user', [1, 2, 4], 2),
  smp_user_jit_4: (o: Options) => smp(o, 'user', [4], 2), // one N, for A/B sessions
  smp_alpine_jit_8: (o: Options) => smp(o, 'alpine', [8], 2),
  smp_user_jit_8: (o: Options) => smp(o, 'user', [8], 1),
};
