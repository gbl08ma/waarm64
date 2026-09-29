// Host side of the whole-VM ABI (docs/abi.md): instantiates the core on
// shared memory, places guest RAM after the core's heap (layout A), boots an
// arm64 Image and runs it, draining the console. virtio backends run in a
// device worker (web/device-worker.ts) when this runs in a worker, and inline
// otherwise (Node, a page's main thread). Runs in a worker or in Node.
// Time is deterministic unless `realtime` is set (the host clock, and idle
// WFIs sleep on the signal word). With `parallel` (M7), every vCPU runs in
// its own worker (web/vcpu-worker.ts) and this thread coordinates them.
import { Devices, EV_CONFIG, deviceEntry, fileSource, ring, specPorts, type DeviceSpec, type DevicesInit } from './devices.ts';
import { isQcow2, qcow2Size } from './qcow2.ts';
import type { VcpuClock, VcpuEnd, VcpuJob } from './vcpu-worker.ts';

export const ABI = 27;
const RAM_BASE = 0x4000_0000;
const RING = 4096;

/** Exit kinds (core/src/vm.rs `exit`). */
export const Exit = { BUDGET: 0, PSCI: 1, IDLE: 2, TX_FULL: 3, UNIMPLEMENTED: 4, STOP: 5, DEVICE: 6 } as const;
export const PSCI_SYSTEM_OFF = 0x8400_0008n;

type Exports = {
  abi_version(): number;
  vm_new(ram: number, size: bigint, cfg: number): number;
  vm_boot(vm: number, kernel: bigint, initrd: bigint, initrdLen: bigint, cmdline: number, cmdlineLen: number): number;
  vm_run(vm: number, budget: bigint): number;
  vm_exit(vm: number): number;
  vm_console(vm: number): number;
  vm_cpu(vm: number, i: number): number;
  vm_counters(vm: number, i: number): number;
  vm_cpu_signal(vm: number, i: number): number;
  jit_helper_report(v: number): number;
  vm_signal(vm: number): number;
  vm_device(vm: number, i: number): number;
  vm_framebuffer(vm: number): bigint;
  panic_message(): number;
};

/**
 * The core's imports: the shared memory, the host clock for realtime mode, and
 * `jit_install` (core/src/jit). The JIT works once `jit.bind` has the core's
 * instance; until then `jit_install` fails and the core only interprets.
 */
export function coreImports(memory: WebAssembly.Memory, clock = performance.timeOrigin) {
  const jit = jitHost(memory);
  const now_ms = () => clock + performance.now();
  return { env: { memory, now_ms, jit_install: jit.install }, jit };
}

/**
 * The core's clock (`env.now_ms`) is `performance.timeOrigin + performance.now()`
 * on the thread that creates the VM. Another thread's `timeOrigin` doesn't agree
 * with it: Chromium derives a new context's from a wall clock, which drifted
 * ~1% from the monotonic one in the dev VM, so a worker started a minute into a
 * page ran ~0.6 s behind it and the guest's counter read 0 for as long (M7
 * loop 8). So a vCPU worker measures the creator's clock instead, through
 * `ask` (a round trip to it), and keeps the estimate with the shortest round
 * trip; the result is what to add to its own `performance.now()`.
 */
export async function clockOffset(ask: () => Promise<number>, rounds = 16) {
  let best = { rtt: Infinity, clock: performance.timeOrigin };
  for (let i = 0; i < rounds; i++) {
    const t1 = performance.now();
    const theirs = await ask();
    const t2 = performance.now();
    if (t2 - t1 < best.rtt) best = { rtt: t2 - t1, clock: theirs - (t1 + t2) / 2 };
  }
  return best.clock;
}

/**
 * The exports that return addresses in the memory. wasm32 pointers are u32,
 * but JS sees an i32, negative past 2 GiB of memory (a guest with 2 GiB of
 * RAM puts the core's later allocations there, M8 loop 0).
 */
const POINTERS = ['thread_alloc', 'vm_new', 'vm_cpu', 'vm_exit', 'vm_exit_cpu', 'vm_console', 'vm_signal', 'vm_cpu_signal', 'vm_device', 'vm_counters', 'jit_helper_report', 'panic_message'];

/** `exports` with the address-returning functions ({@link POINTERS}) made unsigned. */
export function unsigned(exports: WebAssembly.Exports): WebAssembly.Exports {
  const ex = { ...exports };
  for (const name of POINTERS) {
    const f = ex[name];
    if (typeof f === 'function') ex[name] = (...args: unknown[]) => (f as (...a: unknown[]) => number)(...args) >>> 0;
  }
  return ex;
}

/**
 * The message of the core's first panic (ABI 27, core/src/diag.rs), if it had
 * one: a panic reaches the host as a bare `RuntimeError: unreachable`, this is
 * what the core's panic hook wrote before it.
 */
export function panicMessage(ex: WebAssembly.Exports, memory: WebAssembly.Memory): string | undefined {
  const at = (unsigned(ex).panic_message as () => number)();
  const len = Atomics.load(new Int32Array(memory.buffer, at, 1), 0);
  if (len <= 0 || len > 4096) return undefined;
  return new TextDecoder().decode(new Uint8Array(memory.buffer.slice(at + 4, at + 4 + len)));
}

/** `err`, with the core's panic message (if there is one) put in front of its stack. */
export function withPanic(err: unknown, ex: WebAssembly.Exports, memory: WebAssembly.Memory): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  let m: string | undefined;
  try {
    m = panicMessage(ex, memory);
  } catch {}
  if (m) e.message = `${e.message}: core panic: ${m}`;
  return e;
}

/** Each extra core instance's stack (docs/abi.md "Many core instances on one memory"). */
export const THREAD_STACK = 1 << 20;
/** A stack and a TLS block for another core instance on the same memory. */
export type ThreadBlock = { stack: number; tls: number };

/**
 * Allocates a {@link ThreadBlock} through `ex`, an instance that's already set
 * up (instance 0, or one made by {@link instantiateThread}). Blocks are never freed.
 */
export function threadAlloc(ex: WebAssembly.Exports): ThreadBlock {
  const alloc = unsigned(ex).thread_alloc as (size: number, align: number) => number;
  const g = (name: string) => (ex[name] as WebAssembly.Global).value as number;
  const tls = alloc(g('__tls_size'), g('__tls_align'));
  const stack = alloc(THREAD_STACK, 16);
  if (!tls || !stack) throw new Error('thread_alloc failed');
  return { stack, tls };
}

/**
 * Instantiates the core on `memory` for another thread (a worker): its start
 * function finds the memory initialized, then, before any other call, the
 * instance gets its own stack and TLS from `block`. Its JIT is bound to it.
 * `clock`: see {@link clockOffset}.
 */
export function instantiateThread(module: WebAssembly.Module, memory: WebAssembly.Memory, block: ThreadBlock, clock?: number) {
  const imports = coreImports(memory, clock);
  const instance = new WebAssembly.Instance(module, imports);
  (instance.exports.__stack_pointer as WebAssembly.Global).value = block.stack + THREAD_STACK;
  (instance.exports.__wasm_init_tls as (tls: number) => void)(block.tls);
  imports.jit.bind(instance);
  return instance;
}

/**
 * The host half of the JIT: compiles a module the core generated,
 * synchronously, and puts its exports f0, f1, … into the core's function table
 * at JIT slot `slot` on (after the core's own entries). The modules import the
 * memory, the table and the core's exports (its helpers) from `env`, and
 * already-installed blocks they chain to from `t`, by table index.
 */
function jitHost(memory: WebAssembly.Memory) {
  let table: WebAssembly.Table | undefined;
  let base = 0;
  let imports: WebAssembly.Imports = {};
  return {
    bind(core: WebAssembly.Instance) {
      table = core.exports.__indirect_function_table as WebAssembly.Table;
      base = table.length;
      imports = { env: { ...core.exports, memory, table } };
    },
    install(ptr: number, len: number, slot: number): number {
      if (!table) return -1;
      const bytes = new Uint8Array(memory.buffer, ptr >>> 0, len).slice(); // a non-shared copy (`ptr` is a u32 the i32 import signs)
      const module = new WebAssembly.Module(bytes);
      // Blocks it chains to that are already compiled (M5 step 7): `t.<table index>`.
      const t: Record<string, WebAssembly.ExportValue> = {};
      for (const i of WebAssembly.Module.imports(module)) if (i.module === 't') t[i.name] = table.get(Number(i.name));
      const f = new WebAssembly.Instance(module, { ...imports, t }).exports;
      const n = Object.keys(f).length;
      const at = base + slot;
      if (table.length < at + n) table.grow(at + n - table.length);
      for (let k = 0; k < n; k++) table.set(at + k, f[`f${k}`] as WebAssembly.ExportValue as never);
      return at;
    },
  };
}

/** u64 word indexes in `vm::Counters` (core/src/vm.rs). */
export const Counter = {
  STEPS: 0, EXCEPTIONS: 1, IRQS: 65, TLB_HITS: 66, TLB_MISSES: 67, TLB_WALKS: 68, TLB_FLUSHES: 69, PC: 70,
  // The JIT's (ABI 10, `jit::Stats`).
  JIT_BLOCKS: 71, JIT_MODULES: 72, JIT_BYTES: 73, JIT_COMPILE_NS: 74, JIT_STEPS: 75, JIT_DISPATCHES: 76, JIT_INVALIDATIONS: 77, JIT_FLUSHES: 78,
  // ABI 12: instructions compiled inline and as helper calls, inline instructions run.
  JIT_INLINE: 79, JIT_HELPERS: 80, JIT_INLINE_STEPS: 81,
  // ABI 13 (static): lazy flag setters stored and elided; conditions direct, computed and from memory.
  JIT_FLAGS_STORED: 82, JIT_FLAGS_ELIDED: 83, JIT_COND_DIRECT: 84, JIT_COND_COMPUTED: 85, JIT_COND_MEMORY: 86,
  // ABI 15: blocks in the compiled regions (JIT_BLOCKS counts regions).
  JIT_REGION_BLOCKS: 87,
  // ABI 16: edges back to a region's head (static).
  JIT_BACK_EDGES: 88,
  // ABI 17: loop regions compiled for a hot head compiled alone.
  JIT_TIER_UPS: 89,
  // ABI 25: stale blocks a parallel vCPU's checker tolerated.
  JIT_STALE: 90,
  // ABI 26 (parallel SMP): DSBs that waited for TLBI IS and their ns, TLBI IS and IC broadcasts,
  // queue drains, IDLE exits, contended platform-lock acquisitions and their ns, WFEs.
  PAR_DSB_WAITS: 91, PAR_DSB_WAIT_NS: 92, PAR_TLBI_IS: 93, PAR_IC: 94, PAR_DRAINS: 95, PAR_IDLES: 96, PAR_LOCK_CONTENDED: 97, PAR_LOCK_WAIT_NS: 98, PAR_WFES: 99,
  // ns out of vm_run_cpu between runs (idle, or in the host).
  PAR_OUT_NS: 100,
  LEN: 101,
} as const;

/**
 * `framebuffer`: a simple-framebuffer of that many pixels (x8r8g8b8) at the top
 * of RAM, which `bootVm`'s `framebuffer` locates for web/display.ts.
 */
export type BootOptions = {
  ramSize: number;
  kernel: Uint8Array;
  initrd?: Uint8Array;
  cmdline: string;
  devices?: DeviceSpec[];
  realtime?: boolean;
  framebuffer?: { width: number; height: number };
  /** Where in RAM the kernel goes (default 2 MiB); 0 for the bare-metal tests, linked at the start of RAM. */
  kernelOffset?: number;
  /** `VmConfig.jit`: 0 interpreter only (the default), 1 JIT, 2 JIT-stress, 3 JIT-check (ABI 24). */
  jit?: 0 | 1 | 2 | 3;
  /** `VmConfig.features` bit 0 (ABI 19): the crypto extensions (AES, PMULL, SHA1, SHA256), advertised and implemented; on unless false (M6.5 loop 7). */
  crypto?: boolean;
  /** `VmConfig.ncpus` (ABI 21): vCPUs (default 1), round-robin on this thread unless `parallel`. */
  ncpus?: number;
  /**
   * `VmConfig.smp` 1 (ABI 25): a worker per vCPU (web/vcpu-worker.ts),
   * realtime only (it implies `realtime`). Drive it with `runAsync`.
   */
  parallel?: boolean;
  /**
   * Realtime mode: throw if the vCPU sleeps this long with no timer deadline
   * and nothing signaled (a lost wake-up would otherwise hang the run).
   * Benchmarks set it; unset, an idle guest may sleep forever.
   */
  idleLimitMs?: number;
  /**
   * Input for the PL011 (the serial console): each message, a string or bytes,
   * goes to `send`. It's handled on this thread between runs: at once while
   * `runAsync` awaits (parallel mode), at the next `run` otherwise.
   */
  serialIn?: MessagePort;
};

/**
 * The devices the test and benchmark guests expect: the root filesystem at
 * `disk` (a URL) is /dev/vda, read-only, or writable through the OPFS overlay
 * directory `overlay`.
 */
export const guestDevices = (disk: string, overlay?: string): DeviceSpec[] => [{ type: 'console' }, { type: 'rng' }, { type: 'blk', url: disk, overlay }];
/**
 * The Buildroot guest's device tests (`/test-devices.sh`, `/test-input.sh`):
 * its devices plus net on the loopback adapter, 9p (tag `host`, with
 * /hello.txt), a keyboard and a tablet (core/tests/common `test_devices`).
 */
export const testDevices = (disk: string, keyboard?: MessagePort, tablet?: MessagePort): DeviceSpec[] => [
  ...guestDevices(disk),
  { type: 'net', adapter: 'loopback' },
  { type: '9p', tag: 'host', files: { 'hello.txt': 'hello from the host\n' } },
  { type: 'input', kind: 'keyboard', port: keyboard },
  { type: 'input', kind: 'tablet', port: tablet },
];
/** What the test agents inject when the guest sets a keyboard LED (core/tests/common `KEY_EVENTS`, `TABLET_EVENTS`). */
export const KEY_EVENTS = [[1, 30, 1], [0, 0, 0], [1, 30, 0], [0, 0, 0]];
export const TABLET_EVENTS = [[3, 0, 16384], [3, 1, 8192], [1, 272, 1], [0, 0, 0], [1, 272, 0], [0, 0, 0]];
/**
 * The console input test (core/tests/common `CONSOLE_INPUT`): the Buildroot
 * guest with `-- /bin/sh` gets this on its serial console at step
 * `CONSOLE_INPUT_STEP` (its prompt is up by 27.3M): a command, a line for its
 * `read`, then 100 lines (5.5 KB with the rest: more than the 4 KiB RX ring)
 * whose md5sum it prints before it exits.
 */
export const CONSOLE_INPUT = 'stty -echo; read l; echo "webpc: got [$l]"; head -n 100 | md5sum; exit\nhello from the host\n' +
  Array.from({ length: 100 }, (_, i) => `line ${String(i).padStart(3, '0')}: the quick brown fox jumps over the lazy dog\n`).join('');
export const CONSOLE_INPUT_STEP = 30_000_000;
export const CONSOLE_INPUT_WANT = 'webpc: got [hello from the host]\ncccad7da1df76c0ac16983284a789f3e  -\n';
/** Their kernel command line. */
/** `jit_helper_report` of the vCPU at `cpu` (a `jit_new` vCPU, or `vm_cpu`), parsed. */
export function helperReport(ex: { jit_helper_report(v: number): number }, memory: WebAssembly.Memory, cpu: number): { op: string; calls: number }[] {
  const p = ex.jit_helper_report(cpu);
  if (!p) return [];
  const bytes = new Uint8Array(memory.buffer, p);
  const text = new TextDecoder().decode(bytes.slice(0, bytes.indexOf(0)));
  return text.split('\n').filter(Boolean).map((l) => {
    const [op, n] = l.split(' ');
    return { op, calls: Number(n) };
  });
}

export const GUEST_CMDLINE = 'console=ttyAMA0 earlycon panic=-1 root=/dev/vda ro init=/init';
/**
 * Distro images from images/build.sh (paths under target/images) with a command
 * line that runs a test and powers off (core/tests/common `ALPINE`, `DEBIAN`).
 * Alpine: OpenRC's local service runs images/alpine/webpc.start. Debian: the
 * stock image; systemd runs `systemd.run=` as a unit, then powers off.
 */
export const DISTROS = {
  alpine: { kernel: 'alpine/Image', initrd: 'alpine/initramfs-virt', disk: 'alpine/rootfs.ext4', cmdline: 'console=ttyAMA0 root=/dev/vda rootfstype=ext4 modules=ext4 ro' },
  debian: {
    kernel: 'debian/Image', initrd: 'debian/initrd.img', disk: 'debian/disk.qcow2',
    cmdline: `console=ttyAMA0 root=/dev/vda1 ro systemd.run="/bin/sh -c 'exec >/dev/console 2>&1; echo webpc: debian; cat /etc/debian_version; uname -r; findmnt -no OPTIONS /; echo webpc: test ok'" systemd.run_success_action=poweroff systemd.run_failure_action=poweroff systemd.firstboot=off`,
  },
} as const;

// The scratch page before RAM: VmConfig, device entries, the doorbell, the command line.
const S_CFG = 0;
const S_DEVICES = 128;
const S_BELL = 2048;
/** Parallel mode: the coordinator's word (vCPU workers bump it on TX_FULL). */
const S_CTL = 2056;
const S_CMDLINE = 4096;

export type Vm = Awaited<ReturnType<typeof bootVm>>;

export async function bootVm(wasm: BufferSource | WebAssembly.Module, o: BootOptions) {
  const memory = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
  const module = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);
  const imports = coreImports(memory);
  const instance = await WebAssembly.instantiate(module, imports);
  imports.jit.bind(instance);
  const ex = unsigned(instance.exports) as unknown as Exports;
  if (ex.abi_version() !== ABI) throw new Error(`core ABI ${ex.abi_version()}, expected ${ABI}`);

  // Scratch page for VmConfig and the command line, then RAM.
  const scratch = memory.grow(1) * 65536;
  const ram = memory.grow(o.ramSize / 65536) * 65536;
  const bytes = () => new Uint8Array(memory.buffer);
  const specs = await Promise.all((o.devices ?? []).map(async (d) => {
    if (d.type !== 'blk' || d.size !== undefined) return d;
    // The capacity: a qcow2 header's virtual size, or the file size.
    if (d.url.startsWith('file:')) {
      const f = await fileSource(d.url);
      const head = f.read(0, 32)!;
      f.close?.();
      return { ...d, size: isQcow2(head) ? qcow2Size(head) : f.size };
    }
    const r = await fetch(d.url, { headers: { Range: 'bytes=0-31' } });
    if (r.status !== 206) throw new Error(`${d.url}: ${r.status}`);
    const head = new Uint8Array(await r.arrayBuffer());
    return { ...d, size: isQcow2(head) ? qcow2Size(head) : Number(r.headers.get('content-range')?.split('/')[1]) };
  }));
  const parallel = o.parallel ?? false;
  const deterministic = !o.realtime && !parallel;
  const ncpus = o.ncpus ?? 1;
  // VmConfig: RAM size, deterministic, CNTFRQ and ticks per step (defaults), device entries, framebuffer, JIT.
  const fb = o.framebuffer ?? { width: 0, height: 0 };
  // …, features, CPUs, GIC (ABI 21), parallel (ABI 25).
  new BigUint64Array(memory.buffer, scratch + S_CFG, 13).set([BigInt(o.ramSize), deterministic ? 1n : 0n, 0n, 0n, BigInt(scratch + S_DEVICES), BigInt(specs.length), BigInt(fb.width), BigInt(fb.height), BigInt(o.jit ?? 0), o.crypto === false ? 0n : 1n, BigInt(ncpus), 0n, parallel ? 1n : 0n]);
  new BigUint64Array(memory.buffer, scratch + S_DEVICES, 5 * specs.length).set(specs.flatMap((d) => deviceEntry(d).entry));
  const cmd = new TextEncoder().encode(o.cmdline);
  bytes().set(cmd, scratch + S_CMDLINE);
  // The same placement as core/tests/boot.rs: Image at +2 MiB, initrd at +128 MiB.
  const kernelOff = o.kernelOffset ?? 2 << 20;
  const initrdOff = 128 << 20;
  bytes().set(o.kernel, ram + kernelOff);
  if (o.initrd) bytes().set(o.initrd, ram + initrdOff);

  const vm = ex.vm_new(ram, BigInt(o.ramSize), scratch + S_CFG);
  if (!vm) throw new Error('vm_new failed');
  const initrdLen = BigInt(o.initrd?.length ?? 0);
  if (ex.vm_boot(vm, BigInt(RAM_BASE + kernelOff), BigInt(RAM_BASE + initrdOff), initrdLen, scratch + S_CMDLINE, cmd.length)) {
    throw new Error('vm_boot rejected the Image or layout');
  }
  const shared = specs.map((_, i) => ex.vm_device(vm, i));
  Devices.writeConfig(memory, shared, specs);
  const signal = ex.vm_signal(vm);
  const wakes = Array.from({ length: ncpus }, (_, i) => ex.vm_cpu_signal(vm, i));
  const devices = await deviceHost({ memory, shared, ram, signal, specs, deterministic, wakes }, scratch + S_BELL, parallel);
  /** Sets signal-word bits, then bumps and notifies every vCPU's wake word (docs/abi.md). */
  const raise = (bits: number) => {
    const i32 = new Int32Array(memory.buffer);
    Atomics.or(i32, signal / 4, bits);
    Atomics.notify(i32, signal / 4);
    for (const w of wakes) {
      Atomics.add(i32, w / 4, 1);
      Atomics.notify(i32, w / 4);
    }
  };
  // Realtime idling blocks on the signal word, which a page's main thread can't.
  const canBlock = typeof window === 'undefined';

  const tx = ex.vm_console(vm);
  const decoder = new TextDecoder();
  /** Takes what the guest wrote since the last call. */
  const drain = () => {
    const u32 = new Uint32Array(memory.buffer);
    const head = Atomics.load(u32, tx / 4);
    let tail = Atomics.load(u32, tx / 4 + 1);
    const out: number[] = [];
    const buf = bytes();
    for (; tail !== head; tail = (tail + 1) >>> 0) out.push(buf[tx + 8 + (tail % RING)]);
    Atomics.store(u32, tx / 4 + 1, head);
    return decoder.decode(new Uint8Array(out), { stream: true });
  };
  // Console input: the host is the RX ring's one producer (it follows TX: core/src/pl011.rs `Rings`).
  const rx = tx + 8 + RING;
  const queued: Uint8Array[] = [];
  const encoder = new TextEncoder();
  /** Moves queued input into the RX ring as far as it has room, and wakes the vCPUs if it moved any. */
  const pump = () => {
    if (!queued.length) return;
    const u32 = new Uint32Array(memory.buffer);
    const buf = bytes();
    const tail = Atomics.load(u32, rx / 4 + 1);
    const start = Atomics.load(u32, rx / 4);
    let head = start;
    while (queued.length && ((head - tail) >>> 0) < RING) {
      const chunk = queued[0];
      const n = Math.min(chunk.length, RING - ((head - tail) >>> 0));
      for (let k = 0; k < n; k++) buf[rx + 8 + (((head + k) >>> 0) % RING)] = chunk[k];
      head = (head + n) >>> 0;
      if (n === chunk.length) queued.shift();
      else queued[0] = chunk.subarray(n);
    }
    if (head !== start) {
      Atomics.store(u32, rx / 4, head); // after the bytes (sequentially consistent)
      raise(SIGNAL_RX);
    }
  };
  /** Queues bytes (a string as UTF-8) for the guest's PL011; what the RX ring can't take yet waits for the next run. */
  const send = (data: string | Uint8Array | ArrayBuffer) => {
    const b = typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data).slice(); // a copy: the caller may reuse its buffer
    if (b.length) queued.push(b);
    pump();
  };
  if (o.serialIn) o.serialIn.onmessage = (e: MessageEvent) => send(e.data);
  const blocks = Array.from({ length: ncpus }, (_, i) => ex.vm_counters(vm, i));
  const counters = blocks[0];
  /** Counter `i` summed over the vCPUs' blocks (round-robin counts everything in block 0). */
  const counter = (i: number) => blocks.reduce((sum, b) => sum + Number(Atomics.load(new BigUint64Array(memory.buffer, b, Counter.LEN), i)), 0);
  const fbPa = Number(ex.vm_framebuffer(vm));
  const par = parallel ? coordinator({ module, memory, instance, vm, ncpus, bell: scratch + S_BELL, ctl: scratch + S_CTL, raise }) : undefined;
  const RING_HALF = RING / 2;
  const txUsed = () => {
    const u32 = new Uint32Array(memory.buffer);
    return (Atomics.load(u32, tx / 4) - Atomics.load(u32, tx / 4 + 1)) >>> 0;
  };
  const txHead = () => Atomics.load(new Uint32Array(memory.buffer), tx / 4);
  /** The TX ring's head when `runAsync` last returned: it also wakes on output after that. */
  let seenHead = 0;
  return {
    memory,
    /** The framebuffer (web/display.ts): byte address in `memory`, width, height; x8r8g8b8, packed rows. */
    framebuffer: fbPa ? { addr: ram + fbPa - RAM_BASE, ...fb } : undefined,
    /** Byte addresses of guest RAM (PA 0x4000_0000) and of the vCPU registers (`cpu::Cpu`) in `memory`. */
    ram,
    cpu: ex.vm_cpu(vm, 0),
    /** Byte address of vCPU 0's `vm::Counters` in `memory` (u64s, read with Atomics.load; its PC word is vCPU 0's). */
    counters,
    /** Sets bits in the signal word and wakes every vCPU (docs/abi.md). */
    signal: raise,
    /** A snapshot of the counters, summed over the vCPUs; exceptions by EC only where non-zero. */
    stats: () => stats(counter),
    /** The same for each vCPU's own block (parallel mode; round-robin counts everything in vCPU 0's). */
    cpuStats: () => blocks.map((b) => stats((i) => Number(Atomics.load(new BigUint64Array(memory.buffer, b, Counter.LEN), i)))),
    /** The JIT's helper calls by instruction class, most frequent first (ABI 18; empty without a JIT). */
    helperReport: () => helperReport(ex, memory, ex.vm_cpu(vm, 0)),
    /**
     * Runs up to `budget` steps; returns the exit kind and steps taken. DEVICE
     * exits are handled here (the backends take the requests, and in
     * deterministic mode this waits for them), as core/tests/common does,
     * except where the backends run inline (Node, a page's main thread) and
     * have work in flight: then it returns `DEVICE`, and the caller awaits
     * `settle()` before running on. In realtime mode an idle WFI sleeps here
     * until its deadline or a signal.
     */
    run(budget: number) {
      if (par) throw new Error('a parallel VM runs through runAsync');
      let steps = 0;
      for (;;) {
        pump();
        let kind: number;
        try {
          kind = ex.vm_run(vm, BigInt(budget - steps));
        } catch (err) {
          throw withPanic(err, ex, memory);
        }
        const info = new BigUint64Array(memory.buffer, ex.vm_exit(vm), 7); // kind, steps, value, x0-x3
        steps += Number(info[1]);
        if (kind === Exit.DEVICE) {
          // A config-space write waits even in realtime mode: the driver reads
          // the answer next (virtio-input's select/subsel).
          devices.kick(deterministic || (Number(info[2] >> 8n) & EV_CONFIG) !== 0);
          if (devices.inFlight()) return { kind, steps, value: info[2], x: [...info.subarray(3)] };
          if (steps < budget) continue;
        }
        // Idle with input queued (deterministic time: nothing else would wake it): the next pump fills the ring.
        if (kind === Exit.IDLE && deterministic && queued.length) continue;
        if (kind === Exit.IDLE && !deterministic && canBlock) {
          const sig = new Int32Array(memory.buffer, signal, 1);
          const ns = info[2];
          const none = ns === 0xffff_ffff_ffff_ffffn;
          const ms = none ? (o.idleLimitMs ?? Infinity) : Number(ns) / 1e6;
          if (Atomics.load(sig, 0) === 0 && Atomics.wait(sig, 0, 0, ms) === 'timed-out' && none) {
            throw new Error(`idle ${ms} ms with no timer deadline and no signal at pc 0x${new BigUint64Array(memory.buffer, ex.vm_cpu(vm, 0) + 256, 1)[0].toString(16)}; device requests in flight: ${devices.inFlight()}`);
          }
          continue;
        }
        return { kind: kind === Exit.DEVICE ? Exit.BUDGET : kind, steps, value: info[2], x: [...info.subarray(3)] };
      }
    },
    /**
     * `run` for either mode. In parallel mode the vCPU workers run on their
     * own (started by the first call); this returns once they retired
     * `budget` steps together, the console's TX ring is half full (`TX_FULL`:
     * drain it), the console has any output (`BUDGET`, so a terminal's echo
     * isn't held back: at once when the caller drained the ring, since the
     * core notifies its head on a byte into an empty ring; within the 10 ms
     * this waits at a time otherwise), 50 ms passed (`BUDGET`), or an exit
     * ended the run on some vCPU (then every worker has stopped). With
     * `idleLimitMs`, it throws if no vCPU retired a step for that long.
     */
    async runAsync(budget: number): Promise<{ kind: number; steps: number; value: bigint; x: bigint[] }> {
      if (!par) return this.run(budget);
      const s0 = counter(Counter.STEPS);
      const t0 = performance.now();
      const done = (kind: number, steps: number, value = 0n, x: bigint[] = []) => {
        seenHead = txHead();
        return { kind, steps, value, x };
      };
      for (;;) {
        pump();
        const end = await par.wait(10, { at: tx, value: seenHead });
        const steps = counter(Counter.STEPS) - s0;
        if (end) return done(end.kind, steps, end.value, end.x);
        if (steps >= budget || performance.now() - t0 > 50) return done(Exit.BUDGET, steps);
        if (txUsed() >= RING_HALF) return done(Exit.TX_FULL, steps);
        if (txUsed() > 0) return done(Exit.BUDGET, steps);
        if (o.idleLimitMs !== undefined && performance.now() - par.progress(counter(Counter.STEPS)) > o.idleLimitMs) {
          raise(STOP);
          throw new Error(`no vCPU retired a step in ${o.idleLimitMs} ms (pcs ${par.pcs().join(' ')})`);
        }
      }
    },
    drain,
    /** Byte address in `memory` of the console's rings (core/src/pl011.rs `Rings`: TX head, tail and bytes, then RX). */
    console: tx,
    send,
    /** Bytes `send` queued that the RX ring hasn't taken yet. */
    queued: () => queued.reduce((n, b) => n + b.length, 0),
    /** Resolves once inline backends finished what a `DEVICE` exit from `run` handed them. */
    settle: () => devices.settle(),
    /** What the guest wrote to its virtio consoles so far (all of it once `flush` resolves). */
    hvc: () => devices.output(),
    flush: () => devices.flush(),
    /** Stops the vCPUs and releases the backends; resolves once their files are closed. */
    close: () => {
      par?.close();
      return devices.close();
    },
    /** vCPU `i`'s PC (published once per chunk while it runs). */
    pc: (i = 0) => new BigUint64Array(memory.buffer, ex.vm_cpu(vm, i) + 256, 1)[0],
  };
}

/** A snapshot of counters read through `n` (word index → value); exceptions by EC only where non-zero. */
function stats(n: (i: number) => number) {
  const exceptions: Record<string, number> = {};
  for (let ec = 0; ec < 64; ec++) if (n(Counter.EXCEPTIONS + ec)) exceptions[`0x${ec.toString(16)}`] = n(Counter.EXCEPTIONS + ec);
  return {
    steps: n(Counter.STEPS), irqs: n(Counter.IRQS), exceptions, tlbMisses: n(Counter.TLB_MISSES), tlbWalks: n(Counter.TLB_WALKS), tlbFlushes: n(Counter.TLB_FLUSHES),
    jit: {
      blocks: n(Counter.JIT_BLOCKS), modules: n(Counter.JIT_MODULES), bytes: n(Counter.JIT_BYTES), compileNs: n(Counter.JIT_COMPILE_NS),
      steps: n(Counter.JIT_STEPS), dispatches: n(Counter.JIT_DISPATCHES), invalidations: n(Counter.JIT_INVALIDATIONS), flushes: n(Counter.JIT_FLUSHES),
      inline: n(Counter.JIT_INLINE), helpers: n(Counter.JIT_HELPERS), inlineSteps: n(Counter.JIT_INLINE_STEPS),
      flagsStored: n(Counter.JIT_FLAGS_STORED), flagsElided: n(Counter.JIT_FLAGS_ELIDED),
      condDirect: n(Counter.JIT_COND_DIRECT), condComputed: n(Counter.JIT_COND_COMPUTED), condMemory: n(Counter.JIT_COND_MEMORY),
      regionBlocks: n(Counter.JIT_REGION_BLOCKS), backEdges: n(Counter.JIT_BACK_EDGES), tierUps: n(Counter.JIT_TIER_UPS), stale: n(Counter.JIT_STALE),
    },
    par: {
      dsbWaits: n(Counter.PAR_DSB_WAITS), dsbWaitNs: n(Counter.PAR_DSB_WAIT_NS), tlbiIs: n(Counter.PAR_TLBI_IS), ic: n(Counter.PAR_IC),
      drains: n(Counter.PAR_DRAINS), idles: n(Counter.PAR_IDLES), lockContended: n(Counter.PAR_LOCK_CONTENDED), lockWaitNs: n(Counter.PAR_LOCK_WAIT_NS), wfes: n(Counter.PAR_WFES), outNs: n(Counter.PAR_OUT_NS),
    },
  };
}

const STOP = 1;
const SIGNAL_RX = 2;

/**
 * Parallel mode's vCPU workers (web/vcpu-worker.ts), started at the first
 * `wait`: a core instance each on `memory`, with a stack and TLS block from
 * `instance`. The first exit a worker reports that isn't STOP (or its error)
 * ends the run: the others are stopped (STOP stays set; it isn't cleared,
 * docs/abi.md).
 */
function coordinator(c: { module: WebAssembly.Module; memory: WebAssembly.Memory; instance: WebAssembly.Instance; vm: number; ncpus: number; bell: number; ctl: number; raise: (bits: number) => void }) {
  type Handle = { post(m: VcpuJob | VcpuClock): void; terminate(): void };
  let workers: Promise<Handle>[] | undefined;
  let end: { kind: number; value: bigint; x: bigint[] } | undefined;
  let error: Error | undefined;
  let stopped = 0;
  let last = { steps: -1, at: performance.now() };
  const ctl = new Int32Array(c.memory.buffer, c.ctl, 1);
  const bump = () => {
    Atomics.add(ctl, 0, 1);
    Atomics.notify(ctl, 0);
  };
  /** A worker's clock query (`clockOffset`), or its end. */
  const heard = (h: Handle, m: VcpuEnd | VcpuClock) => {
    if (m.type === 'clock') h.post({ type: 'clock', t: performance.timeOrigin + performance.now() });
    else ended(m);
  };
  const ended = (m: VcpuEnd) => {
    stopped++;
    if (m.type === 'error') error ??= new Error(`vCPU ${m.cpu}: ${m.message}`);
    else if (m.kind !== Exit.STOP) end ??= { kind: m.kind, value: m.value, x: m.x };
    if (stopped === 1) c.raise(STOP);
    bump();
  };
  const spawn = async (): Promise<Handle> => {
    const url = new URL('./vcpu-worker.ts', import.meta.url);
    if (typeof Worker !== 'undefined') {
      const w = new Worker(url, { type: 'module' });
      const h: Handle = { post: (m) => w.postMessage(m), terminate: () => w.terminate() };
      w.onmessage = (e: MessageEvent<VcpuEnd | VcpuClock>) => heard(h, e.data);
      w.onerror = (e) => ended({ type: 'error', cpu: -1, message: e.message });
      return h;
    }
    const { Worker: NodeWorker } = await import('node:worker_threads');
    const w = new NodeWorker(url);
    const h: Handle = { post: (m) => w.postMessage(m), terminate: () => void w.terminate() };
    w.on('message', (m: VcpuEnd | VcpuClock) => heard(h, m));
    w.on('error', (e: Error) => ended({ type: 'error', cpu: -1, message: String(e.stack ?? e) }));
    return h;
  };
  const start = () => Array.from({ length: c.ncpus }, async (_, cpu) => {
    const h = await spawn();
    h.post({ module: c.module, memory: c.memory, block: threadAlloc(c.instance.exports), vm: c.vm, cpu, bell: c.bell, ctl: c.ctl });
    return h;
  });
  return {
    /**
     * Waits up to `ms` for news, or for the u32 at byte `also.at` to differ
     * from `also.value` (a notify on it); the run's end once every worker has
     * stopped.
     */
    async wait(ms: number, also?: { at: number; value: number }) {
      workers ??= start();
      await Promise.all(workers);
      if (!error && !(end && stopped === c.ncpus)) {
        const head = also && { word: new Int32Array(c.memory.buffer, also.at, 1), value: also.value | 0 };
        // Already different: wait 1 ms at most instead, but wait. Returning at once would let a caller
        // looping on runAsync (a flood of console output) run on microtasks alone and starve its
        // event loop (messages, animation frames).
        const moved = head !== undefined && Atomics.load(head.word, 0) !== head.value;
        const r = [Atomics.waitAsync(ctl, 0, Atomics.load(ctl, 0), moved ? 1 : ms)];
        if (head && !moved) r.push(Atomics.waitAsync(head.word, 0, head.value, ms));
        if (r.every((w) => w.async)) await Promise.race(r.map((w) => w.value));
        else await new Promise((resolve) => setTimeout(resolve, 0)); // a word changed just now: yield anyway
      }
      if (error) throw error;
      return end && stopped === c.ncpus ? end : undefined;
    },
    /** When `steps` (all vCPUs) last changed. */
    progress(steps: number) {
      if (steps !== last.steps) last = { steps, at: performance.now() };
      return last.at;
    },
    pcs: () => Array.from({ length: c.ncpus }, (_, i) => `0x${new BigUint64Array(c.memory.buffer, (unsigned(c.instance.exports).vm_cpu as (vm: number, i: number) => number)(c.vm, i) + 256, 1)[0].toString(16)}`),
    close() {
      c.raise(STOP);
      for (const w of workers ?? []) void w.then((h) => h.terminate());
    },
  };
}

/**
 * What to type on a guest's serial console, and when: once `step` steps have
 * run (exactly then in deterministic mode), once the console shows `after`, or
 * when a deterministic guest goes idle waiting for it, whichever comes first.
 */
export type ConsoleInput = { step?: number; after?: string; data: string };

/**
 * Boots and runs until the guest powers off (or `maxSteps`), collecting the
 * console. `booted` sees the VM before it runs; `input` goes to its serial
 * console when {@link ConsoleInput} says.
 */
export async function runToPowerOff(wasm: BufferSource | WebAssembly.Module, o: BootOptions, maxSteps = 20e9, booted?: (vm: Vm) => void, input?: ConsoleInput) {
  const vm = await bootVm(wasm, o);
  booted?.(vm);
  let console = '';
  let steps = 0;
  const t0 = performance.now();
  for (;;) {
    const r = await vm.runAsync(input?.step !== undefined && steps < input.step ? Math.min(100_000_000, input.step - steps) : 100_000_000);
    steps += r.steps;
    console += vm.drain();
    const idle = r.kind === Exit.IDLE; // deterministic, with no deadline: waiting for input or for nothing
    if (input && (idle || steps >= (input.step ?? Infinity) || (input.after !== undefined && console.includes(input.after)))) {
      vm.send(input.data);
      input = undefined;
      if (idle) continue;
    }
    if (r.kind === Exit.DEVICE) await vm.settle();
    // `maxSteps` bounds DEVICE exits too (an idle guest may make one every few million steps).
    if ((r.kind === Exit.BUDGET || r.kind === Exit.TX_FULL || r.kind === Exit.DEVICE) && steps < maxSteps) continue;
    const ms = performance.now() - t0;
    await vm.flush();
    vm.close();
    return { ...r, kind: r.kind === Exit.DEVICE ? Exit.BUDGET : r.kind, steps, console, hvc: vm.hvc(), ms, pc: vm.pc() };
  }
}

/**
 * The backends: in a device worker when this thread can block on it (a
 * worker), inline otherwise. `kick` hands them what a DEVICE exit posted and
 * returns once they've taken all of it (deterministic mode).
 */
async function deviceHost(init: DevicesInit, bellAddr: number, parallel: boolean) {
  let text = '';
  const out = (_device: number, t: string) => { text += t; };
  const inWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
  if (parallel && !inWorker) {
    // The vCPU workers ring the doorbell; this thread serves it between its awaits.
    const d = await Devices.open(init, out);
    let failed: unknown;
    void d.serve(new Int32Array(init.memory.buffer, bellAddr, 2)).catch((e) => { failed = e; });
    return {
      kick: (_wait: boolean) => { throw new Error('parallel: the vCPU workers ring the doorbell'); },
      inFlight: () => false,
      settle: async () => { if (failed) throw failed; },
      output: () => text, flush: async () => { if (failed) throw failed; }, close: async () => d.close(),
    };
  }
  if (!inWorker || init.specs.length === 0) {
    // blk over HTTP needs a worker (Node has no XHR; a page can't make binary sync XHRs); Node reads `file:` images.
    const d = await Devices.open(init, out);
    // Requests complete asynchronously (disk reads return promises), so `run`
    // hands a DEVICE exit to its caller while they're in flight, and the
    // caller awaits `settle` before resuming: the same step as in a worker.
    let pending: Promise<void> | undefined;
    return {
      kick: (_wait: boolean) => { pending = d.poll(); },
      inFlight: () => pending !== undefined,
      settle: async () => { await pending; pending = undefined; },
      output: () => text, flush: async () => {}, close: async () => d.close(),
    };
  }
  const worker = new Worker(new URL('./device-worker.ts', import.meta.url), { type: 'module' });
  let flushed = () => {};
  let closed = () => {};
  let closing: Promise<void> | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    worker.onerror = (e) => reject(new Error(`device worker: ${e.message}`));
    worker.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'ready') resolve();
      else if (e.data.type === 'error') reject(new Error(`device worker: ${e.data.message}`));
      else if (e.data.type === 'console') out(e.data.device, e.data.text);
      else if (e.data.type === 'flushed') flushed();
      else if (e.data.type === 'closed') closed();
    };
  });
  worker.postMessage({ type: 'init', ...init, bell: bellAddr }, specPorts(init.specs));
  await ready; // before anything blocks on it
  const bell = new Int32Array(init.memory.buffer, bellAddr, 2);
  return {
    inFlight: () => false,
    settle: async () => {},
    kick: (wait: boolean) => ring(bell, wait), // completions come back through SIGNAL_DEVICE
    output: () => text,
    flush: () => new Promise<void>((resolve) => {
      flushed = resolve;
      worker.postMessage({ type: 'flush' });
    }),
    /**
     * Resolves once it released its files (so another VM can open the overlay), or after a second
     * if it doesn't answer (e.g. a sync XHR still waiting); the same promise on a second call.
     */
    close: () => (closing ??= new Promise<void>((resolve) => {
      closed = resolve;
      setTimeout(resolve, 1000);
      worker.postMessage({ type: 'close' });
    })),
  };
}
