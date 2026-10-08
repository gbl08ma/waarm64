// Host side of the whole-VM ABI (docs/abi.md): instantiates the core on
// shared memory, places guest RAM after the core's heap (layout A), boots an
// arm64 Image and runs it, draining the console. virtio backends run in a
// device worker (web/device-worker.ts) when this runs in a worker, and inline
// otherwise (Node, a page's main thread). Runs in a worker or in Node.
// Time is deterministic unless `realtime` is set (the host clock, and idle
// WFIs sleep on the signal word). With `parallel` (M7), every vCPU runs in
// its own worker (web/vcpu-worker.ts) and this thread coordinates them.
import type { GpuState } from './gpu.ts';
import { Devices, EV_CONFIG, deviceEntry, diskIdentity, fileSource, ring, specPorts, type DeviceSpec, type DevicesInit } from './devices.ts';
import { isQcow2, qcow2Size } from './qcow2.ts';
import { newLiveness, readLiveness, type VcpuLiveness } from './liveness.ts';
import { SnapshotError } from './snapshot-file.ts';
import type { VcpuClock, VcpuEnd, VcpuJob } from './vcpu-worker.ts';

export const ABI = 33;
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
  vm_flash(vm: number): number;
  panic_message(): number;
  thread_alloc(size: number, align: number): number;
  heap_reserve(pages: number): number;
  vm_snapshot_size(vm: number): bigint;
  vm_snapshot_save(vm: number, ptr: number, len: number): bigint;
  vm_snapshot_restore(vm: number, ptr: number, len: number): number;
  snapshot_version(): number;
};

/**
 * What a VM is besides its RAM, for a snapshot (docs/plans/snapshots.md): the core's state
 * (`vm_snapshot_save`, format `version`) and the host's, as JSON: each backend's state (null: none)
 * and the serial input the guest hasn't been given yet.
 */
export type VmState = { version: number; core: Uint8Array; host: { devices: unknown[]; input: number[] } };

/**
 * A snapshot to start a VM from instead of booting it (`BootOptions.restore`): its {@link VmState}
 * and `fill`, which writes the snapshot's RAM into the new VM's (zeroed) RAM before the core
 * restores its state.
 */
export type Restore = { core: Uint8Array; host: VmState['host']; fill(ram: Uint8Array): void | Promise<void> };

/**
 * The core's imports: the shared memory, the host clock for realtime mode, and
 * `jit_install` (core/src/jit). The JIT works once `jit.bind` has the core's
 * instance; until then `jit_install` fails and the core only interprets.
 */
export function coreImports(memory: WebAssembly.Memory, clock = performance.timeOrigin, stall: Stall[] = []) {
  const jit = jitHost(memory);
  const hooks = stall.map((s) => stallHook(memory, s));
  const wrap = <F extends (...a: never[]) => unknown>(where: Stall['on'], f: F) => hooks.reduce((g, h) => h(where, g), f);
  return { env: { memory, now_ms: wrap('clock', () => clock + performance.now()), jit_install: wrap('install', jit.install) }, jit };
}

/**
 * A test-only host stall (tests/hoststall.test.ts, BUG1): blocks vCPU `cpu`'s
 * worker for `ms` at the first `on` call after the guest armed it. `addr` is a
 * u64 in guest RAM (a byte address in the memory): the guest writes `arm` there
 * (default `1`, `3` for `idle`), the hook writes `2` (so the guest knows the
 * worker is about to block; not if `arm` is 2) and blocks, `after` ms after the
 * first call that found it armed (default at once). `clock` and `install` are the core's imports, called
 * inside `vm_run_cpu` (the vCPU is RUN: other vCPUs' DSBs wait for it);
 * `idle` is web/vcpu-worker.ts after `vm_run_cpu` returned IDLE (the vCPU is OUT).
 */
export type Stall = { cpu: number; on: 'clock' | 'install' | 'idle'; addr: number; ms: number; arm?: number; after?: number };

/** The stall's hook for one worker: wraps an import (`clock`, `install`), or, for `idle`, returns a function that blocks if armed. */
export function stallHook(memory: WebAssembly.Memory, s: Stall) {
  const word = () => new Int32Array(memory.buffer, s.addr, 1);
  let done = false;
  let seen: number | undefined;
  const block = (armed: number) => {
    armed = s.arm ?? armed;
    if (done || Atomics.load(word(), 0) !== armed) return;
    seen ??= performance.now();
    if (performance.now() - seen < (s.after ?? 0)) return;
    done = true;
    if (armed !== 2) Atomics.store(word(), 0, 2);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s.ms);
  };
  return <F extends (...a: never[]) => unknown>(where: Stall['on'], f: F): F => {
    if (where !== s.on) return f;
    if (where === 'idle') return (() => { block(3); }) as unknown as F;
    return ((...a: never[]) => { block(1); return f(...a); }) as F;
  };
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
const POINTERS = ['thread_alloc', 'vm_new', 'vm_flash', 'vm_cpu', 'vm_exit', 'vm_exit_cpu', 'vm_console', 'vm_signal', 'vm_cpu_signal', 'vm_device', 'vm_counters', 'jit_helper_report', 'panic_message'];

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

/**
 * The core's panic message as the coordinator reads it (the memory is shared),
 * for a worker's error that lacks it; or what the buffer held instead (BUG1).
 */
function panicNote(text: string, ex: WebAssembly.Exports, memory: WebAssembly.Memory): string {
  if (text.includes('core panic:')) return '';
  try {
    const m = panicMessage(ex, memory);
    if (m) return `\ncore panic (read by the coordinator): ${m}`;
    const at = (unsigned(ex).panic_message as () => number)();
    return `\n(no core panic message recorded: length word ${Atomics.load(new Int32Array(memory.buffer, at, 1), 0)} at ${at})`;
  } catch (e) {
    return `\n(reading the core panic message failed: ${String(e)})`;
  }
}

/** `err`, with the core's panic message (if there is one) put in front of its stack. */
export function withPanic(err: unknown, ex: WebAssembly.Exports, memory: WebAssembly.Memory): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  let m: string | undefined;
  try {
    m = panicMessage(ex, memory);
  } catch {}
  if (m) {
    const was = e.message;
    e.message = `${was}: core panic: ${m}`;
    // Hosts report the stack, which V8 fixes (message included) once anything reads it.
    if (e.stack !== undefined && !e.stack.includes(e.message)) e.stack = e.stack.includes(was) ? e.stack.replace(was, e.message) : `core panic: ${m}\n${e.stack}`;
  }
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
export function instantiateThread(module: WebAssembly.Module, memory: WebAssembly.Memory, block: ThreadBlock, clock?: number, stall?: Stall[]) {
  const imports = coreImports(memory, clock, stall);
  const instance = new WebAssembly.Instance(module, imports);
  (instance.exports.__stack_pointer as WebAssembly.Global).value = block.stack + THREAD_STACK;
  (instance.exports.__wasm_init_tls as (tls: number) => void)(block.tls);
  imports.jit.bind(instance);
  return instance;
}

/** A flush of at least this many slots is worth a {@link collect}. */
const NUDGE_SLOTS = 4096;

/**
 * Asks V8 to collect now. The flushed blocks' instances are garbage, and V8 frees their code only when a
 * major GC collects them; a worker's JS heap stays small, so that GC can come minutes late and the dead
 * code piles up (a Go build on 4 vCPUs: the tab peaked at 9.6 GB with the code cache capped). Allocating a large
 * ArrayBuffer (untouched, so no memory) reports external-memory pressure, which makes V8 collect.
 */
function collect() {
  try {
    new ArrayBuffer(256 << 20);
  } catch {
    // no address space to spare: the GC comes when it comes
  }
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
  // Slots the last install used up to (its end), and the highest slot end since the cache last flushed.
  let lastEnd = 0;
  let hi = 0;
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
      // The slots start over from 0 when the cache flushes: its old blocks are dead, so the table lets go of
      // the ones this module doesn't overwrite, and V8 can free their instances and code.
      if (slot < lastEnd) {
        for (let k = slot + n; k < hi; k++) table.set(base + k, null);
        // Only for a big cache (JIT-stress flushes every few blocks).
        if (hi > NUDGE_SLOTS) collect();
        hi = 0;
      }
      lastEnd = slot + n;
      hi = Math.max(hi, lastEnd);
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
  // ABI 33: instructions the block interpreter ran, blocks it decoded, times its cache started over.
  DEC_STEPS: 101, DEC_BLOCKS: 102, DEC_CLEARS: 103,
  LEN: 104,
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
  /** `VmConfig.jit`: 0 interpreter only (the default), 1 JIT, 2 JIT-stress, 3 JIT-check (ABI 24), 4 the block interpreter (the dispatcher without compiling, ABI 33). */
  jit?: 0 | 1 | 2 | 3 | 4;
  /** `VmConfig.features` bit 0 (ABI 19): the crypto extensions (AES, PMULL, SHA1, SHA256), advertised and implemented; on unless false (M6.5 loop 7). */
  crypto?: boolean;
  /** Test only: stalls one vCPU's host worker (parallel mode), see {@link Stall}; `addr` here is a guest PA. */
  stall?: Stall | Stall[];
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
  /**
   * The firmware configuration (`VmConfig.firmware`, ABI 29, docs/abi.md "M8
   * phase B"): `kernel` is EDK2's `QEMU_EFI.fd` (loaded at RAM + 512 KiB, its
   * `text_offset`), with no initrd or command line. `flash` is the saved
   * variable store (erased if absent; `flashSize` bytes, 1 MiB by default),
   * `fwCfg` fw_cfg's named files. Deterministic runs get a PL031 counting
   * from {@link FIRMWARE_EPOCH_MS}.
   */
  firmware?: Firmware;
  /**
   * A fixed-size memory (`VmConfig.mem_pages`, ABI 32; docs/abi.md "A fixed-size memory"), on
   * unless false: the memory is made at its final size, {@link HEAP_RESERVE} of it for the core's
   * heap, and JIT code imports it with exact limits, which spares Linux arm64 hosts a reload of its
   * size after every call (docs/v8.md "Bounds checks"). Off, or when RAM leaves no room for the
   * reserve, the memory grows as the core needs it.
   */
  fixedMemory?: boolean;
  /**
   * Start from a snapshot (ABI 30): `kernel`, `initrd`, `cmdline` and the firmware's flash and
   * files aren't used (RAM and the core's state have what the machine made of them); the rest
   * must describe the machine the snapshot was taken on, or `bootVm` throws a `SnapshotError`.
   */
  restore?: Restore;
};

export type Firmware = { flash?: Uint8Array; flashSize?: number; fwCfg?: { name: string; data: string | Uint8Array }[] };

/** The PL031's start in deterministic firmware runs: 2026-09-01 00:00 UTC (as core/tests/common's). */
export const FIRMWARE_EPOCH_MS = 1_788_220_800_000;
/** Where the firmware goes in RAM: its `Image` header's text_offset, as QEMU puts it. */
const FIRMWARE_OFFSET = 512 << 10;
export const FLASH_SIZE = 1 << 20;
/** A fw_cfg file's name field, NUL included (core/src/fw_cfg.rs). */
const FW_CFG_NAME = 56;

/** fw_cfg's files in the core's buffer format: a NUL-padded name, a u32 LE size, the bytes. */
export function fwCfgBuffer(files: { name: string; data: string | Uint8Array }[]) {
  const parts = files.flatMap(({ name, data }) => {
    const n = new TextEncoder().encode(name);
    if (!n.length || n.length >= FW_CFG_NAME) throw new Error(`fw_cfg name ${name}: 1 to ${FW_CFG_NAME - 1} bytes`);
    const d = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const head = new Uint8Array(FW_CFG_NAME + 4);
    head.set(n);
    new DataView(head.buffer).setUint32(FW_CFG_NAME, d.length, true);
    return [head, d];
  });
  const out = new Uint8Array(parts.reduce((k, p) => k + p.length, 0));
  parts.reduce((k, p) => (out.set(p, k), k + p.length), 0);
  return out;
}

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
 * line that runs a test and powers off (core/tests/common `ALPINE`).
 * Alpine: OpenRC's local service runs images/alpine/webpc.start.
 */
export const DISTROS = {
  alpine: { kernel: 'alpine/Image', initrd: 'alpine/initramfs-virt', disk: 'alpine/rootfs.ext4', cmdline: 'console=ttyAMA0 root=/dev/vda rootfstype=ext4 modules=ext4 ro' },
} as const;

// The scratch page before RAM: VmConfig, device entries, the doorbell, the command line.
const S_CFG = 0;
const S_DEVICES = 256;
const S_BELL = 2048;
/** Parallel mode: the coordinator's word (vCPU workers bump it on TX_FULL). */
const S_CTL = 2056;
/** Parallel mode's pause word (a generation: odd while a pause is requested or held) and, from `S_PARKED`, each vCPU worker's word (the generation it is parked in). */
const S_PAUSE = 2060;
const S_PARKED = 3072;
const S_CMDLINE = 4096;

export type Vm = Awaited<ReturnType<typeof bootVm>>;

/**
 * The core's heap in a fixed-size memory, its static data and stack included: the JIT's maps and
 * buffers, the devices', a vCPU worker's stack and TLS (~150 MB under a heavy 4-vCPU load, docs/jit.md
 * "Memory"). Running out traps the machine, so it is generous: untouched pages cost nothing.
 */
export const HEAP_RESERVE = 1 << 30;

export async function bootVm(wasm: BufferSource | WebAssembly.Module, o: BootOptions) {
  const fwCfg = o.firmware?.fwCfg?.length ? fwCfgBuffer(o.firmware.fwCfg) : undefined;
  // The memory's final size when it is fixed: the heap reserve, the scratch page, RAM, fw_cfg's files.
  const pages = (HEAP_RESERVE + 65536 + o.ramSize + (fwCfg ? Math.ceil(fwCfg.length / 65536) * 65536 : 0)) / 65536;
  const fixed = o.fixedMemory !== false && pages <= 65536;
  const memory = new WebAssembly.Memory({ initial: 32, maximum: fixed ? pages : 65536, shared: true });
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
    if (d.file) {
      const head = new Uint8Array(await d.file.slice(0, 32).arrayBuffer());
      return { ...d, size: isQcow2(head) ? qcow2Size(head) : d.file.size };
    }
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
  // A PL031 RTC from the host's wall clock (ABI 28), realtime only, or in the firmware configuration from a fixed epoch.
  // The firmware configuration (ABI 29): the flash bank's size, fw_cfg's files (copied by vm_new).
  // A fixed memory's pages (ABI 32), else 0.
  const fw = o.firmware;
  const rtc = !deterministic ? BigInt(Date.now()) : fw ? BigInt(FIRMWARE_EPOCH_MS) : 0n;
  const fwCfgAt = fwCfg ? memory.grow(Math.ceil(fwCfg.length / 65536)) * 65536 : 0;
  if (fwCfg) bytes().set(fwCfg, fwCfgAt);
  // The rest of a fixed memory goes to the core's heap; the last page or two, which the
  // allocator's rounding leaves, the host grows itself.
  if (fixed) {
    // A RangeError, as a failed grow is (the page's "couldn't reserve" message).
    if (!ex.heap_reserve(pages)) throw new RangeError(`the core's heap reserve: no memory to grow ${pages} pages into`);
    memory.grow(pages - memory.buffer.byteLength / 65536);
  }
  new BigUint64Array(memory.buffer, scratch + S_CFG, 19).set([BigInt(o.ramSize), deterministic ? 1n : 0n, 0n, 0n, BigInt(scratch + S_DEVICES), BigInt(specs.length), BigInt(fb.width), BigInt(fb.height), BigInt(o.jit ?? 0), o.crypto === false ? 0n : 1n, BigInt(ncpus), 0n, parallel ? 1n : 0n, rtc,
    fw ? 1n : 0n, fw ? BigInt(fw.flashSize ?? FLASH_SIZE) : 0n, BigInt(fwCfgAt), BigInt(fwCfg?.length ?? 0), fixed ? BigInt(pages) : 0n]);
  new BigUint64Array(memory.buffer, scratch + S_DEVICES, 5 * specs.length).set(specs.flatMap((d) => deviceEntry(d).entry));
  const cmd = new TextEncoder().encode(o.cmdline);
  bytes().set(cmd, scratch + S_CMDLINE);
  // The same placement as core/tests/boot.rs: Image at +2 MiB, initrd at +128 MiB.
  const kernelOff = o.kernelOffset ?? (fw ? FIRMWARE_OFFSET : 2 << 20);
  const initrdOff = 128 << 20;
  if (!o.restore) {
    bytes().set(o.kernel, ram + kernelOff);
    if (o.initrd) bytes().set(o.initrd, ram + initrdOff);
  }

  const vm = ex.vm_new(ram, BigInt(o.ramSize), scratch + S_CFG);
  if (!vm) throw new Error('vm_new failed');
  const flashAt = fw ? ex.vm_flash(vm) : 0;
  const flashSize = fw?.flashSize ?? FLASH_SIZE;
  const shared = specs.map((_, i) => ex.vm_device(vm, i));
  if (o.restore) {
    // RAM first (the transports read the chains their backends held from it), then the core's
    // state: the registers, the devices, their config spaces, the flash bank.
    await o.restore.fill(new Uint8Array(memory.buffer, ram, o.ramSize));
    const { core } = o.restore;
    const at = ex.thread_alloc(core.length, 16);
    if (!at) throw new Error('no memory for the snapshot\'s state');
    bytes().set(core, at);
    let r: number;
    try {
      r = ex.vm_snapshot_restore(vm, at, core.length);
    } catch (err) {
      throw withPanic(err, ex, memory);
    }
    if (r === 1) throw new SnapshotError('other-version', `This snapshot was made by another version of this page (its machine state isn't format ${ex.snapshot_version()}, the one this version reads). Open it in the version that made it.`);
    if (r === 2) throw new SnapshotError('other-machine', 'This snapshot is of a machine with other hardware (memory, processors or devices) than this one, so it can\'t continue here.');
    if (r) throw new SnapshotError('corrupt', 'This snapshot is damaged (its machine state is inconsistent). Download or copy it again; if it keeps failing, save a new one.');
  } else {
    if (fw?.flash) {
      if (fw.flash.length !== flashSize) throw new Error(`firmware.flash: ${fw.flash.length} bytes, the bank has ${flashSize}`);
      bytes().set(fw.flash, flashAt);
    }
    const initrdLen = BigInt(o.initrd?.length ?? 0);
    if (ex.vm_boot(vm, BigInt(RAM_BASE + kernelOff), BigInt(RAM_BASE + initrdOff), initrdLen, scratch + S_CMDLINE, cmd.length)) {
      throw new Error('vm_boot rejected the Image or layout');
    }
    Devices.writeConfig(memory, shared, specs);
  }
  const signal = ex.vm_signal(vm);
  const wakes = Array.from({ length: ncpus }, (_, i) => ex.vm_cpu_signal(vm, i));
  const devices = await deviceHost({ memory, shared, ram, ramSize: o.ramSize, signal, specs, deterministic, wakes, state: o.restore?.host.devices }, scratch + S_BELL, parallel);
  // The restore posted the chains the old backends held to the request rings: the new ones take them.
  if (o.restore) await devices.quiesce();
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
  // Input the saved machine's host hadn't given the guest yet: at the first run's pump, as there.
  if (o.restore?.host.input.length) queued.push(Uint8Array.from(o.restore.host.input));
  /** The buffer `snapshot` has the core write its state to (never freed: kept for the next one). */
  let stateBuf = { at: 0, len: 0 };
  const blocks = Array.from({ length: ncpus }, (_, i) => ex.vm_counters(vm, i));
  const counters = blocks[0];
  /** Counter `i` summed over the vCPUs' blocks (round-robin counts everything in block 0). */
  const counter = (i: number) => blocks.reduce((sum, b) => sum + Number(Atomics.load(new BigUint64Array(memory.buffer, b, Counter.LEN), i)), 0);
  const fbPa = Number(ex.vm_framebuffer(vm));
  const par = parallel ? coordinator({ module, memory, instance, vm, ncpus, bell: scratch + S_BELL, ctl: scratch + S_CTL, pause: scratch + S_PAUSE, parked: scratch + S_PARKED, raise, clearStop: () => void Atomics.and(new Int32Array(memory.buffer), signal / 4, ~STOP), quiesce: () => devices.quiesce(), stall: [o.stall ?? []].flat().map((x) => ({ ...x, addr: ram + x.addr - RAM_BASE })) }) : undefined;
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
    /** Bytes of guest RAM (at `ram`). */
    ramSize: o.ramSize,
    /**
     * The VM's state for a snapshot, with every vCPU out of the core: between `run` calls after
     * `settle()`, or once `pause()` resolved true. Guest RAM (`memory` at `ram`, `ramSize` bytes) is
     * the snapshot's other half: copy it before the VM runs on. The VM is unchanged.
     */
    async snapshot(): Promise<VmState> {
      for (let tries = 0; tries < 1000; tries++) {
        // Takes the completions the backends left, as the run loop would at its next boundary.
        const n = ex.vm_snapshot_size(vm);
        if (n === 0xffff_ffff_ffff_ffffn) throw new Error("the machine can't be saved now: the guest changed buffers it had given to a device");
        if (n === 0n) {
          // A device has something for its backend (chains that hadn't fit, an event): serve it.
          await devices.quiesce();
          continue;
        }
        if (stateBuf.len < Number(n)) {
          const len = Number(n) + 65536;
          const at = ex.thread_alloc(len, 16);
          if (!at) throw new Error("no memory for the machine's state");
          stateBuf = { at, len };
        }
        const got = Number(ex.vm_snapshot_save(vm, stateBuf.at, stateBuf.len));
        if (!got) continue; // a backend completed something in between
        return {
          version: ex.snapshot_version(),
          core: bytes().slice(stateBuf.at, stateBuf.at + got),
          host: { devices: await devices.save(), input: queued.flatMap((b) => [...b]) },
        };
      }
      throw new Error("the machine can't be saved: its devices never went quiet");
    },
    /**
     * The writable disks' changes, for a snapshot (the VM as for `snapshot()`): for each disk with
     * an overlay its slot, what its overlay belongs to (`diskIdentity`), its size and the blocks
     * (4 KiB, ascending) the overlay holds; `diskBlocks` reads some of them.
     */
    async disks(): Promise<{ slot: number; identity: string; size: number; blocks: number[] }[]> {
      const out = [];
      for (const [slot, d] of specs.entries()) {
        if (d.type !== 'blk' || !d.overlay) continue;
        const blocks = await devices.written(slot);
        if (blocks) out.push({ slot, identity: diskIdentity(d, d.size ?? 0), size: d.size ?? 0, blocks });
      }
      return out;
    },
    diskBlocks: (slot: number, blocks: number[]) => devices.blocks(slot, blocks),
    /** The backends' state (`Devices.save`: for a snapshot; a test reads the display's hashes from it), with the devices quiet. */
    /** Device `i`'s virtio status register (bit 2 is DRIVER_OK: a guest driver is using it). */
    deviceStatus: (i: number) => Atomics.load(new Uint32Array(memory.buffer), (shared[i] + 4) / 4),
    deviceState: async () => { await devices.quiesce(); return devices.save(); },
    /** The framebuffer (web/display.ts): byte address in `memory`, width, height; x8r8g8b8, packed rows. */
    framebuffer: fbPa ? { addr: ram + fbPa - RAM_BASE, ...fb } : undefined,
    /** A copy of the firmware configuration's flash bank (the variable store), to save once the vCPUs stopped; undefined without one. */
    flash: () => (flashAt ? bytes().slice(flashAt, flashAt + flashSize) : undefined),
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
    /**
     * Stops every vCPU at its next chunk boundary and waits until the backends are done with every
     * request they don't hold (the ones they hold, a receive buffer, wait for the guest to run).
     * Resolves true once nothing runs guest code and nothing writes guest RAM (until `resume`);
     * false if the machine ended meanwhile (an exit that ends the run, a closed VM). The workers keep
     * their core instances and code caches. Twice is the same pause. Round-robin: between `run` calls
     * the vCPUs are out already, so this only settles the devices.
     */
    pause: async (): Promise<boolean> => {
      if (par) return par.pause();
      await devices.quiesce();
      return true;
    },
    /** Lets a paused VM run on (nothing without a pause). */
    resume: () => par?.resume(),
    /** What a pause leaves: the doorbell's rung and served words, the signal word and whether the vCPUs are held. */
    paused: () => {
      const i32 = new Int32Array(memory.buffer);
      return { bell: [i32[(scratch + S_BELL) / 4], i32[(scratch + S_BELL) / 4 + 1]], signal: i32[signal / 4], held: par?.held() ?? false };
    },
    /** Stops the vCPUs and releases the backends; resolves once their files are closed. */
    close: () => {
      par?.close();
      return devices.close();
    },
    /** Per-vCPU liveness (parallel mode; empty otherwise): time inside the current chunk, the longest chunk and host-side handling so far. */
    liveness: (): VcpuLiveness[] => par?.liveness() ?? [],
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
      decSteps: n(Counter.DEC_STEPS), decoded: n(Counter.DEC_BLOCKS), decClears: n(Counter.DEC_CLEARS),
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
function coordinator(c: { module: WebAssembly.Module; memory: WebAssembly.Memory; instance: WebAssembly.Instance; vm: number; ncpus: number; bell: number; ctl: number; pause: number; parked: number; raise: (bits: number) => void; clearStop: () => void; quiesce: () => Promise<void>; stall: Stall[] }) {
  type Handle = { post(m: VcpuJob | VcpuClock): void; terminate(): void };
  let workers: Promise<Handle>[] | undefined;
  let end: { kind: number; value: bigint; x: bigint[] } | undefined;
  let error: Error | undefined;
  let stopped = 0;
  let last = { steps: -1, at: performance.now() };
  const live = newLiveness(c.ncpus);
  const ctl = new Int32Array(c.memory.buffer, c.ctl, 1);
  if (c.ncpus > 128) throw new Error('too many vCPUs for the parked words');
  // Pause (docs/platform.md "Pausing"): `pword` is odd while a pause is requested or held; each worker
  // writes the odd value it parked in to its own `parked` word.
  const pword = new Int32Array(c.memory.buffer, c.pause, 1);
  const parkedWords = new Int32Array(c.memory.buffer, c.parked, c.ncpus);
  let state: 'running' | 'pausing' | 'paused' = 'running';
  let wantResume = false;
  let closed = false;
  let pausing: Promise<boolean> | undefined;
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
    if (m.type === 'error') error ??= new Error(`vCPU ${m.cpu}: ${m.message}${panicNote(m.message, c.instance.exports, c.memory)}`);
    else if (m.kind !== Exit.STOP) end ??= { kind: m.kind, value: m.value, x: m.x };
    if (stopped === 1) c.raise(STOP);
    release();
    bump();
  };
  /** Makes the pause word even (the workers leave a pause) and wakes them. */
  const release = () => {
    if (Atomics.load(pword, 0) & 1) Atomics.add(pword, 0, 1);
    Atomics.notify(pword, 0);
  };
  const doPause = async (): Promise<boolean> => {
    workers ??= start();
    await Promise.all(workers);
    const gen = Atomics.add(pword, 0, 1) + 1;
    Atomics.notify(pword, 0);
    c.raise(STOP);
    // Each worker parks and bumps `ctl`; nothing here blocks (the backends may be on this thread).
    for (;;) {
      if (error) throw error;
      if (stopped > 0 || closed) return false;
      const seen = Atomics.load(ctl, 0);
      if (parkedWords.every((_, i) => Atomics.load(parkedWords, i) === gen)) break;
      const w = Atomics.waitAsync(ctl, 0, seen, 100);
      if (w.async) await w.value;
    }
    // Every worker waits on the pause word, so none can miss STOP going away.
    c.clearStop();
    await c.quiesce();
    if (error) throw error;
    if (stopped > 0 || closed) return false;
    state = 'paused';
    if (wantResume) resume();
    return true;
  };
  const resume = () => {
    if (state === 'pausing') {
      wantResume = true;
      return;
    }
    if (state !== 'paused') return;
    state = 'running';
    last = { steps: last.steps, at: performance.now() };
    Atomics.add(pword, 0, 1);
    Atomics.notify(pword, 0);
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
    h.post({ module: c.module, memory: c.memory, block: threadAlloc(c.instance.exports), vm: c.vm, cpu, bell: c.bell, ctl: c.ctl, pause: c.pause, parked: c.parked, stall: c.stall.filter((x) => x.cpu === cpu), live });
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
    /** Each vCPU worker's timing of its `vm_run_cpu` calls (web/liveness.ts). */
    liveness: (): VcpuLiveness[] => readLiveness(live),
    /** When `steps` (all vCPUs) last changed. */
    progress(steps: number) {
      // Time paused isn't time without progress.
      if (steps !== last.steps || state !== 'running') last = { steps, at: performance.now() };
      return last.at;
    },
    /** See `Vm.pause`. */
    pause(): Promise<boolean> {
      if (error) return Promise.reject(error);
      if (closed || stopped > 0) return Promise.resolve(false);
      wantResume = false;
      if (state === 'paused') return Promise.resolve(true);
      if (state === 'pausing') return pausing!;
      state = 'pausing';
      pausing = doPause().finally(() => {
        if (state === 'pausing') state = 'running'; // it failed or the machine ended
        pausing = undefined;
      });
      return pausing;
    },
    resume,
    held: () => state === 'paused',
    pcs: () => Array.from({ length: c.ncpus }, (_, i) => `0x${new BigUint64Array(c.memory.buffer, (unsigned(c.instance.exports).vm_cpu as (vm: number, i: number) => number)(c.vm, i) + 256, 1)[0].toString(16)}`),
    close() {
      closed = true;
      c.raise(STOP);
      release();
      bump();
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
    // The display's state (hashes of the scanout and the cursor), for a machine with a virtio-gpu.
    const slot = (o.devices ?? []).findIndex((d) => d.type === 'gpu');
    const gpu = slot >= 0 ? (await vm.deviceState())[slot] as GpuState : undefined;
    vm.close();
    return { ...r, kind: r.kind === Exit.DEVICE ? Exit.BUDGET : r.kind, steps, console, hvc: vm.hvc(), ms, pc: vm.pc(), flash: vm.flash(), gpu };
  }
}

/** `ring` with a wait that yields instead of blocking: resolves once the backends took everything up to this ring. */
async function ringAsync(bell: Int32Array) {
  const n = Atomics.add(bell, 0, 1) + 1;
  Atomics.notify(bell, 0);
  for (let a; ((a = Atomics.load(bell, 1)) - n | 0) < 0;) {
    if (a === -1) throw new Error('device backends failed (see their error)');
    const w = Atomics.waitAsync(bell, 1, a, 100);
    if (w.async) await w.value;
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
      quiesce: () => ringAsync(new Int32Array(init.memory.buffer, bellAddr, 2)),
      save: async () => d.save(),
      written: async (i: number) => d.written(i),
      blocks: async (i: number, blocks: number[]) => d.blocks(i, blocks),
      output: () => text, flush: async () => { if (failed) throw failed; }, close: async () => (d.close(), d.stats()),
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
      quiesce: async () => { await pending; pending = d.poll(); await pending; pending = undefined; },
      save: async () => d.save(),
      written: async (i: number) => d.written(i),
      blocks: async (i: number, blocks: number[]) => d.blocks(i, blocks),
      output: () => text, flush: async () => {}, close: async () => (d.close(), d.stats()),
    };
  }
  const worker = new Worker(new URL('./device-worker.ts', import.meta.url), { type: 'module' });
  let flushed = () => {};
  let closed = (_stats?: unknown) => {};
  let saved = (_m: { state?: unknown[]; error?: string }) => {};
  // Requests for a disk's changes (`written`, `blocks`), answered by id.
  type DiskAnswer = { written?: number[]; bytes?: Uint8Array; error?: string };
  const asked = new Map<number, (m: DiskAnswer) => void>();
  let askId = 0;
  const ask = (m: { type: 'written' | 'blocks'; device: number; blocks?: number[] }) => new Promise<DiskAnswer>((resolve, reject) => {
    const id = askId++;
    asked.set(id, (a) => {
      asked.delete(id);
      if (a.error) reject(new Error(a.error));
      else resolve(a);
    });
    worker.postMessage({ ...m, id });
  });
  let closing: Promise<unknown> | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    worker.onerror = (e) => reject(new Error(`device worker: ${e.message}`));
    worker.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'ready') resolve();
      else if (e.data.type === 'error') reject(new Error(`device worker: ${e.data.message}`));
      else if (e.data.type === 'console') out(e.data.device, e.data.text);
      else if (e.data.type === 'flushed') flushed();
      else if (e.data.type === 'saved') saved(e.data);
      else if (e.data.type === 'disk') asked.get(e.data.id)?.(e.data);
      else if (e.data.type === 'closed') closed(e.data.stats);
    };
  });
  worker.postMessage({ type: 'init', ...init, bell: bellAddr }, specPorts(init.specs));
  await ready; // before anything blocks on it
  const bell = new Int32Array(init.memory.buffer, bellAddr, 2);
  return {
    inFlight: () => false,
    settle: async () => {},
    quiesce: () => ringAsync(bell),
    /** The backends' state for a snapshot (web/devices.ts `Devices.save`). */
    save: () => new Promise<unknown[]>((resolve, reject) => {
      saved = (m) => (m.state ? resolve(m.state) : reject(new Error(m.error ?? 'the device worker has no state')));
      worker.postMessage({ type: 'save' });
    }),
    written: async (i: number) => (await ask({ type: 'written', device: i })).written,
    blocks: async (i: number, blocks: number[]) => (await ask({ type: 'blocks', device: i, blocks })).bytes!,
    kick: (wait: boolean) => ring(bell, wait), // completions come back through SIGNAL_DEVICE
    output: () => text,
    flush: () => new Promise<void>((resolve) => {
      flushed = resolve;
      worker.postMessage({ type: 'flush' });
    }),
    /**
     * Resolves once it released its files (so another VM can open the overlay), or after a second
     * if it doesn't answer (e.g. a sync XHR still waiting); the same promise on a second call. The value is
     * the blk timers of devices with `stats` (web/iostats.ts), if any.
     */
    close: () => (closing ??= new Promise<unknown>((resolve) => {
      closed = resolve;
      setTimeout(resolve, 1000);
      worker.postMessage({ type: 'close' });
    })),
  };
}
