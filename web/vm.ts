// Host side of the whole-VM ABI (docs/abi.md): instantiates the core on
// shared memory, places guest RAM after the core's heap (layout A), boots an
// arm64 Image and runs it, draining the console. virtio backends run in a
// device worker (web/device-worker.ts) when this runs in a worker, and inline
// otherwise (Node, a page's main thread). Runs in a worker or in Node.
// Time is deterministic unless `realtime` is set (the host clock, and idle
// WFIs sleep on the signal word). With `parallel` (M7), every vCPU runs in
// its own worker (web/vcpu-worker.ts) and this thread coordinates them.
import { chunkedHead, isManifestUrl } from './chunked.ts';
import { fusedFma } from './fma.ts';
import type { GpuState } from './gpu.ts';
import type { SndState } from './snd.ts';
import type { UsbFromWorker, UsbIdentity, UsbState, UsbToWorker, UsbVirtual } from './usb-device.ts';
import type { UsbAttach } from './usb.ts';
import { WindowWatch } from './window.ts';
import { CLOSE_MS, Devices, ENTRY_WORDS, EV_CONFIG, VENUS_ARENA, VENUS_WINDOW, deviceEntry, deviceShm, diskIdentity, fileSource, ring, specPorts, type DeviceSpec, type DevicesInit } from './devices.ts';
import { isQcow2, qcow2Size } from './qcow2.ts';
import { newLiveness, readLiveness, type VcpuLiveness } from './liveness.ts';
import { corrupt, SnapshotError } from './snapshot-file.ts';
import { fromWire, msg, MsgError, type Msg, type WireError } from './msg.ts';
import type { VcpuClock, VcpuEnd, VcpuJob } from './vcpu-worker.ts';
import type { CompileInit, CompileJob, CompiledJob } from './jit-compile-worker.ts';
import { spillImports } from './spill.ts';
import { HEAP_FLOOR, MAX_SPILL, MAX_SPILL_BYTES, ramLayout } from './ram.ts';
export { HEAP_FLOOR, MAX_MEMORY0_RAM, MAX_SPILL, MAX_SPILL_BYTES, splitError, splitRam } from './ram.ts';

export const ABI = 65;
const RAM_BASE = 0x4000_0000;
/** The vCPU and compile workers' files for Node's worker_threads (a lookup, so the page's bundler doesn't copy them as assets). */
const NODE_WORKERS = { vcpu: './vcpu-worker.ts', compile: './jit-compile-worker.ts' };
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
  vm_set_chunk(vm: number, steps: bigint): void;
  vm_window_watch(vm: number): number;
  vm_device(vm: number, i: number): number;
  vm_xhci(vm: number): number;
  vm_framebuffer(vm: number): bigint;
  vm_flash(vm: number): number;
  panic_message(): number;
  thread_alloc(size: number, align: number): number;
  heap_reserve(pages: number): number;
  heap_stats(out: number): void;
  heap_probe(size: number): void;
  vm_jit_gauge(vm: number): number;
  vm_snapshot_size(vm: number): bigint;
  vm_snapshot_save(vm: number, ptr: number, len: number): bigint;
  vm_snapshot_restore(vm: number, ptr: number, len: number): number;
  snapshot_version(): number;
  vm_suspended(vm: number): number;
  vm_wake(vm: number): number;
  vm_clock_skip(vm: number, ns: bigint): number;
};

/**
 * What a VM is besides its RAM, for a snapshot (docs/platform.md "Snapshots"): the core's state
 * (`vm_snapshot_save`, format `version`) and the host's, as JSON: each backend's state (null: none)
 * and the serial input the guest hasn't been given yet.
 */
export type VmState = { version: number; core: Uint8Array; host: { devices: unknown[]; input: number[] } };

/**
 * A snapshot to start a VM from instead of booting it (`BootOptions.restore`): its {@link VmState}
 * and `fill`, which writes the snapshot's RAM into the new VM's (zeroed) RAM, memory 0's and each spill memory's, before the core
 * restores its state.
 */
export type Restore = { core: Uint8Array; host: VmState['host']; fill(ram: Uint8Array, spill?: Uint8Array[]): void | Promise<void> };

/**
 * The core's imports: the shared memory, the host clock for realtime mode,
 * `jit_install` and `jit_compile` (core/src/jit). The JIT works once `jit.bind` has the core's
 * instance; until then `jit_install` fails and the core only interprets. `compile`: this vCPU's
 * port to the compile worker (web/jit-compile-worker.ts; parallel SMP). `ram`: the spill memories'
 * accessor over `spill`, memory 1 first (web/spill.ts).
 */
export function coreImports(memory: WebAssembly.Memory, clock = performance.timeOrigin, stall: Stall[] = [], compile?: MessagePort, spill: WebAssembly.Memory[] = []) {
  const hooks = stall.map((s) => stallHook(memory, s));
  const wrap = <F extends (...a: never[]) => unknown>(where: Stall['on'], f: F) => hooks.reduce((g, h) => h(where, g), f);
  const now_ms = wrap('clock', () => clock + performance.now());
  const jit = jitHost(memory, now_ms, compile, spill);
  return { env: { memory, now_ms, jit_install: wrap('install', jit.install), jit_compile: jit.compile }, ram: spillImports(spill), jit };
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
/** The core's exports that return an address (every `-> *` export: tests/core-wasm.test.ts checks), past 2 GiB in a big memory. */
export const POINTERS = ['thread_alloc', 'vcpu_new', 'mem_new', 'jit_new', 'jit_stats', 'vm_new', 'vm_flash', 'vm_cpu', 'vm_exit', 'vm_exit_cpu', 'vm_console', 'vm_signal', 'vm_cpu_signal', 'vm_device', 'vm_xhci', 'vm_counters', 'vm_jit_gauge', 'vm_window_watch', 'jit_helper_report', 'panic_message'];

/** `exports` with the address-returning functions ({@link POINTERS}) made unsigned. */
export function unsigned(exports: WebAssembly.Exports): WebAssembly.Exports {
  const ex = { ...exports };
  for (const name of POINTERS) {
    const f = ex[name];
    if (typeof f === 'function') ex[name] = (...args: unknown[]) => (f as (...a: unknown[]) => number)(...args) >>> 0;
  }
  return ex;
}

/** The bytes behind each core module {@link compileCore} compiled, and its copies with exact memory limits by size. */
const coreBytes = new WeakMap<WebAssembly.Module, { bytes: Uint8Array; exact: Map<number, Promise<WebAssembly.Module>> }>();

/**
 * Compiles the core and keeps its bytes, so that `bootVm` can make the copy that runs a fixed-size memory
 * ({@link exactCore}). A module compiled otherwise still boots, without that copy.
 */
export async function compileCore(wasm: BufferSource): Promise<WebAssembly.Module> {
  const bytes = new Uint8Array(ArrayBuffer.isView(wasm) ? wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) : wasm.slice(0));
  const module = await WebAssembly.compile(bytes);
  coreBytes.set(module, { bytes, exact: new Map() });
  return module;
}

/**
 * The core declaring its memory import with exact limits, `pages` both (docs/abi.md "A fixed-size memory"), compiled
 * once a size; undefined for a module not from {@link compileCore}.
 */
function exactCore(module: WebAssembly.Module, pages: number): Promise<WebAssembly.Module> | undefined {
  const c = coreBytes.get(module);
  if (!c) return undefined;
  let m = c.exact.get(pages);
  if (!m) c.exact.set(pages, (m = WebAssembly.compile(memoryLimits(c.bytes, pages))));
  return m;
}

/**
 * A copy of the module `wasm` whose one imported memory declares `min` = `max` = `pages` (shared kept): its import
 * section rewritten, the rest copied. Throws on a module without exactly one imported memory.
 */
export function memoryLimits(wasm: Uint8Array, pages: number): Uint8Array<ArrayBuffer> {
  let at = 8;
  const leb = () => {
    let v = 0;
    for (let shift = 0; ; shift += 7) {
      const b = wasm[at++];
      v += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return v;
    }
  };
  const enc = (v: number) => {
    const out: number[] = [];
    do {
      const b = v % 128;
      v = Math.floor(v / 128);
      out.push(v ? b | 0x80 : b);
    } while (v);
    return out;
  };
  while (at < wasm.length) {
    const sectionAt = at;
    const id = wasm[at++];
    const size = leb();
    const start = at;
    if (id !== 2) {
      at = start + size;
      continue;
    }
    const out: number[] = [];
    const n = leb();
    out.push(...enc(n));
    let found = 0;
    for (let k = 0; k < n; k++) {
      const from = at;
      for (let s = 0; s < 2; s++) {
        const len = leb(); // the module and field names
        at += len;
      }
      const kind = wasm[at++];
      out.push(...wasm.subarray(from, at));
      if (kind === 2) {
        const flags = wasm[at++];
        if (flags & ~3) throw new Error(`memory import limits 0x${flags.toString(16)}: not a 32-bit memory`);
        leb();
        if (flags & 1) leb();
        out.push(flags | 1, ...enc(pages), ...enc(pages));
        found++;
        continue;
      }
      const desc = at;
      if (kind === 0) leb(); // a function's type
      else if (kind === 1) {
        at++; // the element type, then the limits
        const flags = wasm[at++];
        leb();
        if (flags & 1) leb();
      } else if (kind === 3) at += 2; // a global's type and mutability
      else if (kind === 4) {
        at++;
        leb();
      } else throw new Error(`import kind ${kind}`);
      out.push(...wasm.subarray(desc, at));
    }
    if (at !== start + size || found !== 1) throw new Error(`the import section: ${found} memories, ${at - start} of ${size} bytes`);
    const section = [2, ...enc(out.length), ...out];
    const r = new Uint8Array(sectionAt + section.length + wasm.length - at);
    r.set(wasm.subarray(0, sectionAt));
    r.set(section, sectionAt);
    r.set(wasm.subarray(at), sectionAt + section.length);
    return r;
  }
  throw new Error('no import section');
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
export function instantiateThread(module: WebAssembly.Module, memory: WebAssembly.Memory, block: ThreadBlock, clock?: number, stall?: Stall[], compile?: MessagePort, spill: WebAssembly.Memory[] = []) {
  const imports = coreImports(memory, clock, stall, compile, spill);
  const instance = new WebAssembly.Instance(module, imports);
  (instance.exports.__stack_pointer as WebAssembly.Global).value = block.stack + THREAD_STACK;
  (instance.exports.__wasm_init_tls as (tls: number) => void)(block.tls);
  imports.jit.bind(instance);
  return instance;
}

/**
 * How often a vCPU worker returns to its event loop (web/vcpu-worker.ts `yieldMs`): Firefox's pages session went from
 * 3-6 stalls of 100-808 ms a session to none over 54 ms (bench/boot/REPORT.md "M8: V8's GC on the vCPU threads").
 */
export const VCPU_YIELD_MS = 100;

/** How long a vCPU's host keeps a compiled module it hasn't installed, and how many at most (web/vm.ts `jitHost`). */
const RECEIVED_KEEP_MS = 30_000;
const RECEIVED_MAX = 4096;

/** A flush of at least this many slots is worth a {@link collect}. */
const NUDGE_SLOTS = 4096;
/** An install this long is logged (`webpc-slow install`). */
const SLOW_INSTALL_MS = 20;

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
 * memory, the spill memories (`ram1`, …), the table, the core's exports (its helpers) and the host clock (`now_ms`) from `env`, and
 * already-installed blocks they chain to from `t`, by table index. With a
 * port to the compile worker (`compile`), the core hands it each module it
 * emits first, and installs it once compiled there: a hit in V8's module cache.
 */
function jitHost(memory: WebAssembly.Memory, now_ms: () => number, port?: MessagePort, spill: WebAssembly.Memory[] = []) {
  let table: WebAssembly.Table | undefined;
  let base = 0;
  let imports: WebAssembly.Imports = {};
  // The bytes are copied out of the shared memory (V8 compiles only unshared ones) into one buffer, reused.
  let scratch = new ArrayBuffer(0);
  // Slots the last install used up to (its end), and the highest slot end since the cache last flushed.
  let lastEnd = 0;
  let hi = 0;
  // The compile worker's compiled modules by number, as they arrive through the event loop (ABI 37): installing one
  // skips V8's decoding and validating the bytes again, which `new WebAssembly.Module` does before it finds them in
  // its cache (four fifths of an install: bench/boot/REPORT.md "M8: the compile worker's modules, posted").
  const received = new Map<number, { module?: WebAssembly.Module; at: number }>();
  if (port) {
    port.onmessage = (e: MessageEvent<CompiledJob>) => {
      const now = performance.now();
      received.set(e.data.seq, { module: e.data.module, at: now });
      // A table that doesn't install (a vCPU asleep) keeps nothing alive for long.
      for (const [k, v] of received) if (now - v.at > RECEIVED_KEEP_MS || received.size > RECEIVED_MAX) received.delete(k); else break;
    };
    (port as { unref?(): void }).unref?.(); // Node: listening doesn't keep the worker alive
  }
  return {
    bind(core: WebAssembly.Instance) {
      table = core.exports.__indirect_function_table as WebAssembly.Table;
      base = table.length;
      // The spill memories as `env.ram1`…, which modules import for their loads' and stores' spill arms (docs/spill-memories.md).
      imports = { env: { ...core.exports, memory, table, now_ms, ...Object.fromEntries(spill.map((m, k) => [`ram${k + 1}`, m])) } };
    },
    install(ptr: number, len: number, slot: number, seq: number): number {
      if (!table) return -1;
      const t0 = performance.now();
      let module: WebAssembly.Module;
      // The worker's compiled module (seq 0: none, compile the bytes); -2 if it isn't here yet.
      const got = seq !== 0 ? received.get(seq >>> 0) : undefined;
      if (seq !== 0 && !got) return -2;
      if (got?.module) {
        module = got.module;
        for (const k of received.keys()) if (((k - (seq >>> 0)) | 0) <= 0) received.delete(k);
      } else {
        // (A module the worker failed to compile: compiled here, to report the error.)
        if (scratch.byteLength < len) scratch = new ArrayBuffer(Math.max(len, 2 * scratch.byteLength, 1 << 16));
        const bytes = new Uint8Array(scratch, 0, len);
        bytes.set(new Uint8Array(memory.buffer, ptr >>> 0, len)); // `ptr` is a u32 the i32 import signs
        module = new WebAssembly.Module(bytes);
      }
      const t1 = performance.now();
      // Blocks it chains to that are already compiled (M5 step 7): `t.<table index>`.
      const t: Record<string, WebAssembly.ExportValue> = {};
      for (const i of WebAssembly.Module.imports(module)) if (i.module === 't') t[i.name] = table.get(Number(i.name));
      const f = new WebAssembly.Instance(module, { ...imports, t }).exports;
      const n = Object.keys(f).length;
      const at = base + slot;
      const t2 = performance.now();
      let gc = 0;
      const restart = slot < lastEnd;
      // The slots start over from 0 when the cache flushes: its old blocks are dead, so the table lets go of
      // the ones this module doesn't overwrite, and V8 can free their instances and code.
      if (restart) {
        for (let k = slot + n; k < hi; k++) table.set(base + k, null);
        // Only for a big cache (JIT-stress flushes every few blocks).
        if (hi > NUDGE_SLOTS) {
          gc = performance.now();
          collect();
          gc = performance.now() - gc;
        }
        hi = 0;
      }
      lastEnd = slot + n;
      hi = Math.max(hi, lastEnd);
      if (table.length < at + n) table.grow(at + n - table.length);
      for (let k = 0; k < n; k++) table.set(at + k, f[`f${k}`] as WebAssembly.ExportValue as never);
      // An install the vCPU felt (it runs on the vCPU's thread, the guest's clock running on): for the benchmarks'
      // timelines (bench/gpu/guest-session.ts collects `webpc-slow` lines).
      const ms = performance.now() - t0;
      if (ms >= SLOW_INSTALL_MS) console.debug(`webpc-slow install ${ms.toFixed(1)} ms at ${(performance.timeOrigin + t0).toFixed(0)}: compile ${(t1 - t0).toFixed(1)} instantiate ${(t2 - t1).toFixed(1)} gc ${gc.toFixed(1)} bytes ${len} functions ${n}${restart ? ' (slots start over)' : ''}`);
      return at;
    },
    /** `env.jit_compile`: posts a copy of the module to the compile worker; 0 without one. */
    compile(ptr: number, len: number, seq: number, epoch: number, ready: number): number {
      if (!port || !table) return 0;
      const bytes = new Uint8Array(len);
      bytes.set(new Uint8Array(memory.buffer, ptr >>> 0, len));
      port.postMessage({ seq: seq >>> 0, epoch: epoch >>> 0, ready: ready >>> 0, bytes: bytes.buffer } satisfies CompileJob, [bytes.buffer]);
      return 1;
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
  // ABI 36: modules installed from the compile worker, and compiled on the vCPU after waiting for it too long.
  JIT_WORKER_INSTALLS: 104, JIT_OVERDUE: 105,
  // ABI 37: times the worker's compiled module hadn't reached the vCPU yet, and runs ended early for it to arrive.
  JIT_PARKS: 106, JIT_PARK_EXITS: 107,
  // ABI 46: the JIT cache's lock (acquisitions, contended ones, ns waited), ns emitting, of those under the lock, ns
  // forming batches into regions.
  JIT_LOCKS: 108, JIT_LOCK_CONTENDED: 109, JIT_LOCK_WAIT_NS: 110, JIT_EMIT_NS: 111, JIT_EMIT_LOCKED_NS: 112, JIT_PLAN_NS: 113,
  // ABI 47: the core's heap: the JIT block map's prunes, flushes for a heap with no room for a map to grow, flushes for a
  // table that lacked modules whose bytes were dropped; the heap bytes a table's decoded blocks and its known blocks take.
  JIT_PRUNES: 114, JIT_RESCUES: 115, JIT_LAG_FLUSHES: 116, JIT_DEC_BYTES: 117, JIT_KNOWN_BYTES: 118,
  // ABI 48: jump-cache misses that found the lock held and ran their block interpreted instead of waiting.
  JIT_LOCK_SKIPPED: 119,
  // ABI 50: ns the block map's prunes took (under the cache's lock).
  JIT_PRUNE_NS: 120,
  LEN: 121,
} as const;

/**
 * `framebuffer`: a simple-framebuffer of that many pixels (x8r8g8b8) at the top
 * of RAM, which `bootVm`'s `framebuffer` locates for web/display.ts.
 */
export type BootOptions = {
  /** Guest RAM in memory 0 (at most `MAX_MEMORY0_RAM` (web/ram.ts) for a fixed memory). */
  ramSize: number;
  /**
   * `VmConfig.window` (ABI 53): the host-visible window's bytes, at the guest PA after RAM (a multiple of 2 MiB; 0, the
   * default, none); a transport whose entry has `shm` reports it as its shared memory region 1 (docs/devices.md
   * "virtio-gpu"). Its bytes are in memory 1 at `windowAt` (`VmConfig.window_at`, ABI 55: a Venus machine's
   * `VENUS_ARENA`, past the renderer's arena; else 0), node 1's RAM after them.
   */
  window?: number;
  windowAt?: number;
  /**
   * The spill memories' sizes (`VmConfig.spill`, ABI 39; docs/spill-memories.md): RAM past memory 0, each a
   * shared memory of its own and a CPU-less NUMA node for the guest; `splitRam` (web/ram.ts) makes the usual split.
   */
  spill?: number[];
  kernel: Uint8Array;
  initrd?: Uint8Array;
  cmdline: string;
  devices?: DeviceSpec[];
  /** What the devices tell the user while the machine runs on (a ramdisk out of memory): the page's message bar. */
  onNotice?: (m: Msg) => void;
  realtime?: boolean;
  framebuffer?: { width: number; height: number };
  /** Where in RAM the kernel goes (default 2 MiB); 0 for the bare-metal tests, linked at the start of RAM. */
  kernelOffset?: number;
  /** `VmConfig.jit`: 0 interpreter only (the default), 1 JIT, 2 JIT-stress, 3 JIT-check (ABI 24), 4 the block interpreter (the dispatcher without compiling, ABI 33). */
  jit?: 0 | 1 | 2 | 3 | 4;
  /**
   * `VmConfig.jit_bytes` (ABI 44): the JIT's code cache budget in wasm bytes, the most its live modules hold before a
   * flush (V8 spends several times that on their code and metadata: docs/jit.md "Memory"). Default (0): the core's,
   * `jit::MAX_BYTES`.
   */
  jitBytes?: number;
  /**
   * `VmConfig.fma` (ABI 58): the JIT's FMA forms use relaxed-SIMD's `madd` where the host fuses it ({@link fusedFma});
   * on unless false, which forces their emulation (`?fma=emul`; the guest sees no difference).
   */
  fma?: boolean;
  /** `VmConfig.features` bit 0 (ABI 19): the crypto extensions (AES, PMULL, SHA1, SHA256), advertised and implemented; on unless false (M6.5 loop 7). */
  crypto?: boolean;
  /**
   * `VmConfig.features` bit 1 (ABI 35): FEAT_RNG (`RNDR`, `RNDRRS`), advertised and implemented; on unless false.
   * Realtime mode keys its streams from `crypto.getRandomValues` (`VmConfig.rng_seed`), deterministic mode with zeros.
   */
  rng?: boolean;
  /** `VmConfig.features` bit 2 (ABI 35): FEAT_E0PD, which spares a KASLR kernel KPTI; on unless false. */
  e0pd?: boolean;
  /** `VmConfig.features` bit 3 (ABI 51): FEAT_SHA512 and FEAT_SHA3, advertised and implemented (with `crypto`); on unless false. */
  sha3?: boolean;
  /** `VmConfig.features` bit 4 (ABI 59): FEAT_JSCVT (`FJCVTZS`), advertised and implemented; on unless false. */
  jscvt?: boolean;
  /** `VmConfig.features` bits 5 to 9 (ABI 59): FEAT_LRCPC, FEAT_SB, FEAT_FlagM with FlagM2, FEAT_DIT, FEAT_FRINTTS; each on unless false. */
  rcpc?: boolean;
  sb?: boolean;
  flagm?: boolean;
  dit?: boolean;
  frintts?: boolean;
  /** `VmConfig.features` bit 10 (ABI 60): FEAT_DotProd; on unless false. */
  dotprod?: boolean;
  /** `VmConfig.features` bit 11 (ABI 61): FEAT_I8MM; off unless true (measured slower: docs/cpu.md). */
  i8mm?: boolean;
  /** `VmConfig.features` bit 12 (ABI 62): FEAT_RDM; on unless false. */
  rdm?: boolean;
  /** `VmConfig.features` bit 13 (ABI 62): FEAT_LRCPC2 (with `rcpc` only); on unless false. */
  rcpc2?: boolean;
  /** `VmConfig.features` bit 14 (ABI 63): FEAT_FCMA; off unless true (measured slower: docs/cpu.md). */
  fcma?: boolean;
  /** `VmConfig.features` bit 15 (ABI 65): FEAT_FP16; off unless true (docs/cpu.md). */
  fp16?: boolean;
  /** `VmConfig.features` bit 16 (ABI 65): FEAT_FHM (with `fp16` only); off unless true (docs/cpu.md). */
  fhm?: boolean;
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
   * Parallel mode: compile the JIT's modules in a worker of their own (web/jit-compile-worker.ts), the vCPUs
   * interpreting their blocks until then, instead of on the vCPU that emitted them (docs/jit.md "Sharing").
   * On unless false.
   */
  compileWorker?: boolean;
  /**
   * Parallel mode: each vCPU worker returns to its event loop this often, in ms (web/vcpu-worker.ts `yieldMs`;
   * default {@link VCPU_YIELD_MS}, 0: never).
   */
  vcpuYieldMs?: number;
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
   * Tests only: the core's heap reserve in bytes instead of {@link HEAP_RESERVE} (and never under `HEAP_FLOOR`), so a
   * test runs the heap out in a minute (tests/heap.test.ts).
   */
  heapReserve?: number;
  /**
   * With a fixed memory, the core itself runs a copy that imports the memory with exact limits (docs/abi.md "A
   * fixed-size memory"), unless false, or `wasm` is a module not from {@link compileCore}.
   */
  exactCore?: boolean;
  /**
   * Start from a snapshot (ABI 30): `kernel`, `initrd`, `cmdline` and the firmware's flash and
   * files aren't used (RAM and the core's state have what the machine made of them); the rest
   * must describe the machine the snapshot was taken on, or `bootVm` throws a `SnapshotError`.
   */
  restore?: Restore;
  /**
   * An xHCI with 4 root connectors (`VmConfig.xhci`, ABI 38; docs/usb.md): `port` carries the
   * contract's messages (web/usb-device.ts `UsbToWorker`/`UsbFromWorker`: `usb-attach`, `usb-detach`,
   * one `usb-state` back for each) to the device worker, which takes them whenever they come, before
   * the guest's driver runs too (the port just shows a device). Without `port`, the VM's `usb` has
   * `attach`/`detach` that do the same. `attach`: devices plugged in before the guest runs. `events`:
   * plugs and unplugs at step counts, for `runToPowerOff` (exactly there in deterministic mode): `device`
   * to attach, none to detach. A machine without `usb` has no controller (its guests' steps are as they were).
   */
  usb?: { port?: MessagePort; attach?: UsbAttach[]; events?: UsbEvent[] };
};

/** A plug (with `device`) or an unplug of `connector` at `step` (`BootOptions.usb.events`). */
export type UsbEvent = { step: number; connector: number; device?: UsbIdentity | UsbVirtual };

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
const S_DEVICES = 512;
/** `heap_stats`'s two words (ABI 45). */
const S_HEAP = 384;
const S_BELL = 2048;
/** Parallel mode: the coordinator's word (vCPU workers bump it on TX_FULL). */
const S_CTL = 2056;
/** Parallel mode's pause word (a generation: odd while a pause is requested or held) and, from `S_PARKED`, each vCPU worker's word (the generation it is parked in). */
const S_PAUSE = 2060;
/** Parallel mode's start word: the vCPU workers wait there until all are instantiated (web/vcpu-worker.ts). */
const S_START = 2064;
const S_PARKED = 3072;
const S_CMDLINE = 4096;

export type Vm = Awaited<ReturnType<typeof bootVm>>;

/** The JIT cache's gauge words (`jit::GAUGE_WORDS`, `vm_jit_gauge`). */
const GAUGE_WORDS = 8;

/**
 * The core's heap in a fixed-size memory, its static data and stack included: the JIT's maps and
 * buffers, the devices', a vCPU worker's stack and TLS (~540–600 MiB under a heavy 4-vCPU load, docs/spill-memories.md
 * "The heap floor"). Running out traps the machine, so it is generous: untouched pages cost nothing.
 */
export const HEAP_RESERVE = 1 << 30;

export async function bootVm(wasm: BufferSource | WebAssembly.Module, o: BootOptions) {
  const fwCfg = o.firmware?.fwCfg?.length ? fwCfgBuffer(o.firmware.fwCfg) : undefined;
  // The memory's final size when it is fixed: the heap reserve, the scratch page, RAM, fw_cfg's files.
  // The reserve takes what 4 GiB leaves, capped at HEAP_RESERVE, never under HEAP_FLOOR.
  // The host-visible window: a Venus GPU's (web/devices.ts VENUS_WINDOW) unless the caller says. It is in memory 1,
  // after a Venus machine's renderer arena there (web/venus-host.ts, vk/README.md), before node 1's RAM.
  const venus = (o.devices ?? []).some((d) => d.type === 'gpu' && d.virgl && d.venus);
  const windowBytes = o.window ?? (venus ? VENUS_WINDOW : 0);
  const windowAt = windowBytes ? o.windowAt ?? (venus ? VENUS_ARENA : 0) : 0;
  const spillAt = windowBytes ? windowAt + windowBytes : 0;
  const rest = 65536 + o.ramSize + (fwCfg ? Math.ceil(fwCfg.length / 65536) * 65536 : 0);
  const pages = ((o.heapReserve ?? Math.max(HEAP_FLOOR, Math.min(HEAP_RESERVE, 2 ** 32 - rest))) + rest) / 65536;
  const fixed = o.fixedMemory !== false && pages <= 65536;
  const memory = new WebAssembly.Memory({ initial: 32, maximum: fixed ? pages : 65536, shared: true });
  // Memories 1 and up (docs/spill-memories.md), each at its final size: the spill memories' RAM, memory 1's after
  // what it holds before it (`VmConfig::memory_sizes`).
  const spillSizes = o.spill ?? [];
  if (spillSizes.length > MAX_SPILL || spillSizes.some((s) => !s || s % 65536 || s > MAX_SPILL_BYTES)) throw new RangeError(`spill memories ${spillSizes.join(', ')}: at most ${MAX_SPILL}, each 64 KiB to 4 GiB in 64 KiB steps`);
  const memSizes = spillAt ? [spillAt + (spillSizes[0] ?? 0), ...spillSizes.slice(1)] : spillSizes;
  if (memSizes[0] > MAX_SPILL_BYTES) throw new RangeError(`memory 1 holds the window at ${windowAt} and node 1's ${spillSizes[0]} bytes: past 4 GiB`);
  const spill = memSizes.map((s) => new WebAssembly.Memory({ initial: s / 65536, maximum: s / 65536, shared: true }));
  /** Each spill memory's RAM, memory 1 first (node 1's after the window there). */
  const spillRam = () => spill.slice(0, spillSizes.length).map((m, k) => new Uint8Array(m.buffer, k ? 0 : spillAt, spillSizes[k]));
  const first = wasm instanceof WebAssembly.Module ? wasm : await compileCore(wasm);
  // The core that runs a fixed memory declares its exact size: compiled while the first instance lays the memory out.
  const exact = fixed && o.exactCore !== false ? exactCore(first, pages) : undefined;
  exact?.catch(() => {});
  const imports = coreImports(memory, undefined, undefined, undefined, spill);
  let module = first;
  let instance = await WebAssembly.instantiate(first, imports);
  imports.jit.bind(instance);
  let ex = unsigned(instance.exports) as unknown as Exports;
  if (ex.abi_version() !== ABI) throw new Error(`core ABI ${ex.abi_version()}, expected ${ABI}`);

  // Scratch page for VmConfig and the command line, then RAM.
  const scratch = memory.grow(1) * 65536;
  const ram = memory.grow(o.ramSize / 65536) * 65536;
  const bytes = () => new Uint8Array(memory.buffer);
  const specs = await Promise.all((o.devices ?? []).map(async (d) => {
    if (d.type === 'gpu' && d.venus) return { ...d, window: windowBytes };
    if (d.type !== 'blk' || d.size !== undefined) return d;
    if (d.source || d.stored) throw new Error(`a ${d.source === 'ram' ? 'ramdisk' : d.stored ? 'stored disk' : 'blank disk'} needs a size`);
    if (!d.url && !d.file) throw new Error('a disk with no image (url, file or source)');
    // The capacity: a qcow2 header's virtual size, or the file size.
    if (d.file) {
      const head = new Uint8Array(await d.file.slice(0, 32).arrayBuffer());
      return { ...d, size: isQcow2(head) ? qcow2Size(head) : d.file.size };
    }
    if (d.url!.startsWith('file:')) {
      const f = await fileSource(d.url!);
      const head = f.read(0, 32)!;
      f.close?.();
      return { ...d, size: isQcow2(head) ? qcow2Size(head) : f.size };
    }
    if (isManifestUrl(d.url!)) {
      const { manifest, head } = await chunkedHead(d.url!);
      return { ...d, size: isQcow2(head) ? qcow2Size(head) : manifest.size };
    }
    const r = await fetch(d.url!, { headers: { Range: 'bytes=0-31' } });
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
  // FEAT_RNG's key (ABI 35): the host's CSPRNG in realtime mode (the core ignores it in deterministic mode).
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
    // The memory is at its size: the rest runs on the exact core, here and in every worker. The first instance only
    // laid the memory out (it can grow it; the exact one can't) and isn't called again.
    if (exact) {
      module = await exact;
      instance = instantiateThread(module, memory, threadAlloc(instance.exports), undefined, undefined, undefined, spill);
      ex = unsigned(instance.exports) as unknown as Exports;
    }
  }
  // getRandomValues doesn't take a view of shared memory: a seed of its own, copied in.
  const seed = deterministic ? new BigUint64Array(4) : crypto.getRandomValues(new BigUint64Array(4));
  const features = (o.crypto === false ? 0n : 1n) | (o.rng === false ? 0n : 2n) | (o.e0pd === false ? 0n : 4n) | (o.sha3 === false ? 0n : 8n) | (o.jscvt === false ? 0n : 16n)
    | (o.rcpc === false ? 0n : 32n) | (o.sb === false ? 0n : 64n) | (o.flagm === false ? 0n : 128n) | (o.dit === false ? 0n : 256n) | (o.frintts === false ? 0n : 512n) | (o.dotprod === false ? 0n : 1024n) | (o.i8mm === true ? 2048n : 0n)
    | (o.rdm === false ? 0n : 4096n) | (o.rcpc2 === false ? 0n : 8192n) | (o.fcma === true ? 16384n : 0n)
    | (o.fp16 === true ? 32768n : 0n) | (o.fhm === true ? 65536n : 0n);
  new BigUint64Array(memory.buffer, scratch + S_CFG, 36).set([BigInt(o.ramSize), deterministic ? 1n : 0n, 0n, 0n, BigInt(scratch + S_DEVICES), BigInt(specs.length), BigInt(fb.width), BigInt(fb.height), BigInt(o.jit ?? 0), features, BigInt(ncpus), 0n, parallel ? 1n : 0n, rtc,
    fw ? 1n : 0n, fw ? BigInt(fw.flashSize ?? FLASH_SIZE) : 0n, BigInt(fwCfgAt), BigInt(fwCfg?.length ?? 0), fixed ? BigInt(pages) : 0n, ...seed, o.usb ? 0x404n : 0n, // and the xHCI's 4 + 4 ports (ABI 38)
    ...Array.from({ length: MAX_SPILL }, (_, k) => BigInt(spillSizes[k] ?? 0)), // the spill memories' sizes (ABI 39)
    BigInt(o.jitBytes ?? 0), // the JIT's code cache budget (ABI 44)
    BigInt(windowBytes), // the host-visible window (ABI 53)
    BigInt(windowAt), // where it is in memory 1 (ABI 55)
    o.fma !== false && fusedFma() ? 1n : 0n]); // the JIT's FMA forms on the host's fused madd (ABI 58)
  new BigUint64Array(memory.buffer, scratch + S_DEVICES, ENTRY_WORDS * specs.length).set(specs.flatMap((d) => [...deviceEntry(d).entry, deviceShm(d)]));
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
    await o.restore.fill(new Uint8Array(memory.buffer, ram, o.ramSize), spillRam());
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
    if (r === 1) throw new SnapshotError('snapshots:vm.otherVersion', { format: ex.snapshot_version() }, 'other-version');
    if (r === 2) throw new SnapshotError('snapshots:vm.otherHardware', {}, 'other-machine');
    if (r) throw corrupt(msg('snapshots:vm.damage.inconsistent'));
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
  // The xHCI's messages: the caller's port, or a channel of our own behind `usb.attach`/`usb.detach`.
  const usbChannel = o.usb && !o.usb.port ? new MessageChannel() : undefined;
  const xhci = o.usb ? { shared: ex.vm_xhci(vm), port: o.usb.port ?? usbChannel!.port1, attach: o.usb.attach } : undefined;
  // Each device's two I/O byte counters (`DevicesInit.io`), shared with the device worker that adds to them, then the xHCI's.
  const ioBytes = 16 * (specs.length + 1);
  const io = new Float64Array(typeof SharedArrayBuffer === 'function' ? new SharedArrayBuffer(ioBytes) : new ArrayBuffer(ioBytes));
  // The window is memory 1's bytes at `windowAt`; its write-watch's words are memory 0's.
  const venusWindow = windowBytes ? { at: windowAt, bytes: windowBytes, watch: ex.vm_window_watch(vm) } : undefined;
  const layout = ramLayout(o.ramSize, spillSizes, windowBytes, spillAt);
  const devices = await deviceHost({ memory, shared, ram, ramSize: o.ramSize, layout, window: venusWindow, spill, signal, specs, deterministic, wakes, state: o.restore?.host.devices, xhci, io }, scratch + S_BELL, parallel, o.onNotice);
  const usb = usbChannel && usbHost(usbChannel.port2);
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
  // The JIT cache's gauge (ABI 45), asked for before any vCPU runs.
  const gauge = ex.vm_jit_gauge(vm);
  const counters = blocks[0];
  /** Counter `i` summed over the vCPUs' blocks (round-robin counts everything in block 0). */
  const counter = (i: number) => blocks.reduce((sum, b) => sum + Number(Atomics.load(new BigUint64Array(memory.buffer, b, Counter.LEN), i)), 0);
  const fbPa = Number(ex.vm_framebuffer(vm));
  const par = parallel ? coordinator({ module, memory, spill, instance, vm, ncpus, bell: scratch + S_BELL, ctl: scratch + S_CTL, pause: scratch + S_PAUSE, parked: scratch + S_PARKED, start: scratch + S_START, raise, clearStop: () => void Atomics.and(new Int32Array(memory.buffer), signal / 4, ~STOP), quiesce: () => devices.quiesce(), stall: [o.stall ?? []].flat().map((x) => ({ ...x, addr: ram + x.addr - RAM_BASE })), compileWorker: (o.jit ?? 0) !== 0 && o.compileWorker !== false, yieldMs: o.vcpuYieldMs ?? VCPU_YIELD_MS }) : undefined;
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
    /** The core runs the copy that imports the memory with exact limits (`BootOptions.exactCore`). */
    exactCore: module !== first,
    /**
     * Tests only: an infallible allocation of `size` bytes on this thread's core (ABI 50); one the heap can't hold
     * traps, with the allocation error hook's message.
     */
    heapProbe: (size: number) => {
      try {
        ex.heap_probe(size);
      } catch (err) {
        throw withPanic(err, ex, memory);
      }
    },
    /** The xHCI's connectors when `BootOptions.usb` has no port of the caller's: attach or detach, resolving with the device worker's `usb-state`. */
    usb,
    /** Bytes of guest RAM (at `ram`). */
    ramSize: o.ramSize,
    /** The host-visible window's write-watch (`BootOptions.window`; its bytes are memory 1's at `window.at`). */
    watch: windowBytes ? new WindowWatch(memory, ex.vm_window_watch(vm)) : undefined,
    /** The window's bytes (`BootOptions.window`), if there is one: `bytes` at `at` in `spill[0]`. */
    window: venusWindow,
    /** Memories 1 and up, memory 1 first: the guest RAM past memory 0 (`spillRam`), and memory 1's renderer arena and window before node 1. */
    spill,
    /** Each spill memory's RAM (`BootOptions.spill`), memory 1's node 1 first: what a snapshot keeps. */
    spillRam,
    /** Whether the guest is in PSCI SYSTEM_SUSPEND: every vCPU off until `wake` (docs/platform.md "System suspend"). */
    suspended: () => ex.vm_suspended(vm) !== 0,
    /** Wakes a guest in SYSTEM_SUSPEND: its vCPU resumes where the guest asked. False if it wasn't suspended. */
    wake() {
      if (!ex.vm_wake(vm)) return false;
      raise(0); // round-robin's host may sleep on the signal word with no deadline
      return true;
    },
    /** Moves a suspended guest's clock on by `ms` (the time it was away); false if it isn't suspended or time is deterministic. */
    clockSkip: (ms: number) => ex.vm_clock_skip(vm, BigInt(Math.max(0, Math.round(ms * 1e6)))) !== 0,
    /**
     * The VM's state for a snapshot, with every vCPU out of the core: between `run` calls after
     * `settle()`, or once `pause()` resolved true. Guest RAM (`memory` at `ram`, `ramSize` bytes) is
     * the snapshot's other half: copy it before the VM runs on. The VM is unchanged but for its realtime clock, held at the saved reading until a vCPU runs again.
     */
    async snapshot(): Promise<VmState> {
      for (let tries = 0; tries < 1000; tries++) {
        // Takes the completions the backends left, as the run loop would at its next boundary.
        const n = ex.vm_snapshot_size(vm);
        if (n === 0xffff_ffff_ffff_ffffn) throw new MsgError('snapshots:vm.cantSaveNow', {}, { cause: o.usb ? msg('snapshots:vm.cantSaveNow.usb') : msg('snapshots:vm.cantSaveNow.buffers') });
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
        const saved = await devices.save();
        // A device that can't be saved now says why (web/gpu.ts `save`), as an error posted across workers.
        const why = saved.map((d) => (d as { unsaveable?: WireError } | null)?.unsaveable).find((x) => x);
        if (why) throw new MsgError('snapshots:vm.cantSave', {}, { cause: fromWire(why) });
        return {
          version: ex.snapshot_version(),
          core: bytes().slice(stateBuf.at, stateBuf.at + got),
          host: { devices: saved, input: queued.flatMap((b) => [...b]) },
        };
      }
      throw new MsgError('snapshots:vm.cantSave', {}, { cause: msg('snapshots:vm.cantSave.notQuiet') });
    },
    /**
     * The writable disks' changes, for a snapshot (the VM as for `snapshot()`): for each disk with
     * an overlay, and each ramdisk, its slot, what its overlay belongs to (`diskIdentity`), its size, the blocks
     * (4 KiB, ascending) the overlay (or the ramdisk) holds, and the overlay's path and generation
     * (docs/machines.md §5.1: what the snapshot pins; asking moves the next change's generation on);
     * `diskBlocks` reads some of them.
     */
    async disks(): Promise<{ slot: number; identity: string; size: number; blocks: number[]; overlay?: string; generation?: number; ram?: boolean }[]> {
      const out = [];
      for (const [slot, d] of specs.entries()) {
        if (d.type !== 'blk' || !(d.overlay || d.source === 'ram')) continue;
        const w = await devices.written(slot);
        if (w) out.push({ slot, identity: diskIdentity(d, d.size ?? 0), size: d.size ?? 0, blocks: w.blocks, overlay: d.overlay, generation: w.generation, ...(d.source === 'ram' ? { ram: true } : {}) });
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
    /**
     * What the core's heap has touched, for benchmarks (docs/spill-memories.md "The heap floor"): the non-zero 4 KiB
     * pages below the scratch page (the core's data, stacks and first heap), and in the reserve past RAM and fw_cfg's
     * files, and how far into the reserve the last one is (the allocator carves it from its start, and freed memory
     * keeps its bytes, so that is the heap's high-water mark). Scans the memory: tenths of a second for a 1 GiB reserve.
     */
    /**
     * What the machine holds that its host pays for, cheaply (docs/jit.md "The page's memory signal"): the guest's RAM
     * (memory 0's and the spill memories'), the core's heap (`heap_stats`: live bytes and their high-water mark), and
     * the JIT's cache (`vm_jit_gauge`: the wasm bytes and modules since the last flush, the budget, the epochs; ABI 47:
     * the block map's keys and the heap bytes its table takes, the module bytes held for vCPUs that haven't taken them).
     */
    hostUse: () => {
      const h = new BigUint64Array(memory.buffer, scratch + S_HEAP, 2);
      ex.heap_stats(scratch + S_HEAP);
      const g = (i: number) => (gauge ? Number(Atomics.load(new BigUint64Array(memory.buffer, gauge, GAUGE_WORDS), i)) : 0);
      return { ramBytes: o.ramSize + spillSizes.reduce((a, b) => a + b, 0), heapLive: Number(h[0]), heapPeak: Number(h[1]), jitLiveBytes: g(0), jitModules: g(1), jitBudget: g(2), jitEpochs: g(3), jitLimit: g(4), jitKeys: g(5), jitKeyBytes: g(6), jitHeld: g(7) };
    },
    /** Caps the JIT's budget at `bytes` (the gauge's limit word, ABI 45; at least 16 MiB; 0: the machine's budget): the page's memory signal. */
    setJitLimit: (bytes: number) => { if (gauge) Atomics.store(new BigUint64Array(memory.buffer, gauge, GAUGE_WORDS), 4, BigInt(Math.max(0, Math.round(bytes)))); },
    heapUse: () => {
      const w = new Uint32Array(memory.buffer);
      const nonzero = (page: number) => { for (let i = page * 1024, e = i + 1024; i < e; i++) if (w[i]) return true; return false; };
      const reserve = (fwCfg ? fwCfgAt + Math.ceil(fwCfg.length / 65536) * 65536 : ram + o.ramSize) / 4096;
      let below = 0, touched = 0, high = 0;
      const buckets: number[] = []; // MiB touched in each 32 MiB of the reserve
      for (let p = 0; p < scratch / 4096; p++) if (nonzero(p)) below++;
      // A Venus machine's renderer arena, memory 1's first bytes, is counted apart (its data and stack at its base, its
      // heap upward from them: the highest touched page is its high-water mark).
      const arena = venus ? VENUS_ARENA : 0;
      const w1 = arena ? new Uint32Array(spill[0].buffer, 0, arena / 4) : undefined;
      let arenaTouched = 0, arenaHigh = 0;
      for (let p = 0; p < arena / 4096; p++) {
        let any = false;
        for (let i = p * 1024, e = i + 1024; i < e; i++) if (w1![i]) { any = true; break; }
        if (any) { arenaTouched++; arenaHigh = p + 1; }
      }
      // The allocator's segment record sits at the reserve's end: the high-water mark leaves out the last 64 KiB.
      const top = memory.buffer.byteLength / 4096;
      for (let p = reserve, end = top; p < end; p++) {
        if (!nonzero(p)) continue;
        touched++;
        if (p < end - 16) high = p - reserve + 1;
        const b = Math.floor((p - reserve) / 8192);
        buckets[b] = (buckets[b] ?? 0) + 1 / 256;
      }
      return { belowBytes: below * 4096, reserveBytes: top * 4096 - reserve * 4096, touchedBytes: touched * 4096, highBytes: high * 4096, buckets: Array.from(buckets, (x) => Math.round(x ?? 0)), arenaBytes: arena, arenaTouchedBytes: arenaTouched * 4096, arenaHighBytes: arenaHigh * 4096 };
    },
    cpu: ex.vm_cpu(vm, 0),
    /** Byte address of vCPU 0's `vm::Counters` in `memory` (u64s, read with Atomics.load; its PC word is vCPU 0's). */
    counters,
    /** Every vCPU's counters block (parallel mode: each publishes its own PC there; round-robin: only block 0 is live). */
    counterBlocks: blocks,
    /** Sets bits in the signal word and wakes every vCPU (docs/abi.md). */
    signal: raise,
    /** Parallel mode's steps between two publications of a vCPU's PC (0: the default); the PC sampler shortens it. */
    setChunk: (steps: number) => ex.vm_set_chunk(vm, BigInt(steps)),
    /** A snapshot of the counters, summed over the vCPUs; exceptions by EC only where non-zero. */
    stats: () => stats(counter),
    /** The vCPUs run each on its own worker (`VmConfig.parallel`): `cpuStats` is then per vCPU. */
    parallel,
    /**
     * Each device's I/O bytes since the VM started (`DevicesInit.io`), by device index (`VmConfig.devices`): [2i] and
     * [2i + 1] are a blk's bytes read and written, a net's bytes received (to the guest) and sent; 0 for other kinds.
     * The pair after the last device's is the xHCI's (`Usb`): the bytes its devices gave the guest (IN) and took (OUT).
     * The live view (the device worker adds to it): read it, don't keep a copy expecting it to move.
     */
    deviceIo: () => io,
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
      usbChannel?.port2.close();
      return devices.close();
    },
    /** Per-vCPU liveness (parallel mode; empty otherwise): time inside the current chunk, the longest chunk and host-side handling so far. */
    liveness: (): VcpuLiveness[] => par?.liveness() ?? [],
    /** The liveness block (parallel mode), for web/profiler.ts `startTimeline`. */
    liveBlock: par?.liveBlock,
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
      workerInstalls: n(Counter.JIT_WORKER_INSTALLS), overdue: n(Counter.JIT_OVERDUE), parks: n(Counter.JIT_PARKS), parkExits: n(Counter.JIT_PARK_EXITS),
      locks: n(Counter.JIT_LOCKS), lockContended: n(Counter.JIT_LOCK_CONTENDED), lockWaitNs: n(Counter.JIT_LOCK_WAIT_NS),
      emitNs: n(Counter.JIT_EMIT_NS), emitLockedNs: n(Counter.JIT_EMIT_LOCKED_NS), planNs: n(Counter.JIT_PLAN_NS),
      prunes: n(Counter.JIT_PRUNES), rescues: n(Counter.JIT_RESCUES), lagFlushes: n(Counter.JIT_LAG_FLUSHES),
      decBytes: n(Counter.JIT_DEC_BYTES), knownBytes: n(Counter.JIT_KNOWN_BYTES), lockSkipped: n(Counter.JIT_LOCK_SKIPPED), pruneNs: n(Counter.JIT_PRUNE_NS),
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
function coordinator(c: { module: WebAssembly.Module; memory: WebAssembly.Memory; spill: WebAssembly.Memory[]; instance: WebAssembly.Instance; vm: number; ncpus: number; bell: number; ctl: number; pause: number; parked: number; start: number; raise: (bits: number) => void; clearStop: () => void; quiesce: () => Promise<void>; stall: Stall[]; compileWorker: boolean; yieldMs: number }) {
  type Handle = { post(m: VcpuJob | VcpuClock | CompileInit, transfer?: Transferable[]): void; terminate(): void };
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
  // `new Worker(new URL('…', import.meta.url))` written out whole, as the page's bundler finds workers (docs/frontend.md
  // "The build"); Node's worker_threads get the same files by a URL it leaves alone.
  const spawn = async (which: 'vcpu' | 'compile' = 'vcpu'): Promise<Handle> => {
    if (typeof Worker !== 'undefined') {
      const w = which === 'vcpu' ? new Worker(new URL('./vcpu-worker.ts', import.meta.url), { type: 'module' }) : new Worker(new URL('./jit-compile-worker.ts', import.meta.url), { type: 'module' });
      const h: Handle = { post: (m, t) => w.postMessage(m, t ?? []), terminate: () => w.terminate() };
      w.onmessage = (e: MessageEvent<VcpuEnd | VcpuClock>) => heard(h, e.data);
      w.onerror = (e) => ended({ type: 'error', cpu: -1, message: e.message });
      return h;
    }
    const { Worker: NodeWorker } = await import('node:worker_threads');
    const w = new NodeWorker(new URL(NODE_WORKERS[which], import.meta.url));
    const h: Handle = { post: (m, t) => w.postMessage(m, t as never), terminate: () => void w.terminate() };
    w.on('message', (m: VcpuEnd | VcpuClock) => heard(h, m));
    w.on('error', (e: Error) => ended({ type: 'error', cpu: -1, message: String(e.stack ?? e) }));
    return h;
  };
  // The JIT's compile worker, and a port to it for each vCPU worker.
  let compiler: Promise<Handle> | undefined;
  const start = () => {
    const channels = c.compileWorker ? Array.from({ length: c.ncpus }, () => new MessageChannel()) : [];
    if (channels.length) {
      compiler = spawn('compile');
      const ports = channels.map((ch) => ch.port2);
      void compiler.then((h) => h.post({ memory: c.memory, ports }, ports));
    }
    return Array.from({ length: c.ncpus }, async (_, cpu) => {
      const h = await spawn();
      const compile = channels[cpu]?.port1;
      h.post({ module: c.module, memory: c.memory, spill: c.spill, block: threadAlloc(c.instance.exports), vm: c.vm, cpu, bell: c.bell, ctl: c.ctl, pause: c.pause, parked: c.parked, start: c.start, ncpus: c.ncpus, stall: c.stall.filter((x) => x.cpu === cpu), live, compile, yieldMs: c.yieldMs }, compile ? [compile] : []);
      return h;
    });
  };
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
    /** The liveness block itself (bench/gpu/guest-session.ts's timeline reads it from a worker). */
    liveBlock: live,
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
      void compiler?.then((h) => h.terminate());
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
 * console when {@link ConsoleInput} says. Past `maxMs` of wall-clock time it
 * closes the VM and throws with the console's end: a realtime guest stuck
 * waiting with its timers running retires too few steps for `maxSteps`, and
 * too many for `idleLimitMs`, to end the run.
 */
export async function runToPowerOff(wasm: BufferSource | WebAssembly.Module, o: BootOptions, maxSteps = 20e9, booted?: (vm: Vm) => void, input?: ConsoleInput, maxMs = Infinity) {
  const vm = await bootVm(wasm, o);
  booted?.(vm);
  let console = '';
  let steps = 0;
  const t0 = performance.now();
  const usbEvents = [...(o.usb?.events ?? [])].sort((a, b) => a.step - b.step);
  let late: Error | undefined;
  const run = async () => {
    for (;;) {
      if (late) throw late; // past `maxMs`: the caller has its error already
      // USB plugs at their steps: the run stops there, and the device worker has the plug before it runs on.
      while (usbEvents.length && steps >= usbEvents[0].step) {
        const e = usbEvents.shift()!;
        if (!vm.usb) throw new Error("usb.events with a port of the caller's");
        const m = await (e.device ? vm.usb.attach(e.connector, e.device) : vm.usb.detach(e.connector));
        if (m.state === 'error') throw new Error(`USB connector ${e.connector}: ${m.message}`);
      }
      const until = Math.min(input?.step !== undefined && steps < input.step ? input.step : Infinity, usbEvents[0]?.step ?? Infinity);
      const r = await vm.runAsync(Math.min(100_000_000, until - steps));
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
      // The display's state (hashes of the scanout and the cursor), for a machine with a virtio-gpu; what a
      // virtio-snd played (its sink's checksum) and the control requests it took.
      const slot = (type: string) => (o.devices ?? []).findIndex((d) => d.type === type);
      const states = slot('gpu') >= 0 || slot('snd') >= 0 ? await vm.deviceState() : [];
      const gpu = slot('gpu') >= 0 ? states[slot('gpu')] as GpuState : undefined;
      const snd = slot('snd') >= 0 ? states[slot('snd')] as SndState : undefined;
      vm.close();
      return { ...r, kind: r.kind === Exit.DEVICE ? Exit.BUDGET : r.kind, steps, console, hvc: vm.hvc(), ms, pc: vm.pc(), flash: vm.flash(), gpu, snd, stats: vm.stats() };
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    if (maxMs === Infinity) return;
    timer = setTimeout(() => {
      const pcs = Array.from({ length: o.ncpus ?? 1 }, (_, i) => `0x${vm.pc(i).toString(16)}`).join(' ');
      console += vm.drain();
      // The whole console goes with it (`console`), for a caller that keeps it.
      reject(late = Object.assign(new Error(`no power-off in ${maxMs / 1000} s (${steps} steps, pcs ${pcs}); the console's end:\n${console.slice(-3000)}`), { console }));
    }, maxMs);
  });
  const running = run();
  running.catch(() => {}); // after the deadline it ends unseen (on `late`, or a promise the closed VM never settles)
  try {
    return await Promise.race([running, deadline]);
  } catch (e) {
    void Promise.resolve(vm.close()).catch(() => {}); // the vCPU workers too: alive, they would keep the process from exiting
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** `attach` and `detach` over the xHCI's port, each resolving with its `usb-state` (one per request, in order; a keyboard's `usb-leds` isn't an answer). */
function usbHost(port: MessagePort) {
  const waiting: { connector: number; resolve: (m: UsbState) => void }[] = [];
  port.onmessage = (e: MessageEvent<UsbFromWorker>) => {
    if (e.data.type !== 'usb-state') return;
    const i = waiting.findIndex((w) => w.connector === e.data.connector);
    if (i >= 0) waiting.splice(i, 1)[0].resolve(e.data);
  };
  const ask = (m: UsbToWorker) => new Promise<UsbState>((resolve) => {
    waiting.push({ connector: m.connector, resolve });
    port.postMessage(m);
  });
  return {
    attach: (connector: number, device: UsbIdentity | UsbVirtual) => ask({ type: 'usb-attach', connector, device }),
    detach: (connector: number) => ask({ type: 'usb-detach', connector }),
  };
}

/**
 * `ring` with a wait that yields instead of blocking: resolves once the backends took everything up to this ring, or
 * once `stopped` (the host's close: a closed `Devices.serve` answers no ring, and a pause's quiesce would wait for good).
 */
async function ringAsync(bell: Int32Array, stopped: () => boolean) {
  const n = Atomics.add(bell, 0, 1) + 1;
  Atomics.notify(bell, 0);
  for (let a; ((a = Atomics.load(bell, 1)) - n | 0) < 0;) {
    if (a === -1) throw new Error('device backends failed (see their error)');
    if (stopped()) return;
    const w = Atomics.waitAsync(bell, 1, a, 100);
    if (w.async) await w.value;
  }
}

/**
 * The backends: in a device worker when this thread can block on it (a
 * worker), inline otherwise. `kick` hands them what a DEVICE exit posted and
 * returns once they've taken all of it (deterministic mode).
 */
async function deviceHost(init: DevicesInit, bellAddr: number, parallel: boolean, notice?: (m: Msg) => void) {
  let text = '';
  const out = (_device: number, t: string) => { text += t; };
  const inWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
  if (parallel && !inWorker) {
    // The vCPU workers ring the doorbell; this thread serves it between its awaits.
    const d = await Devices.open(init, out, notice);
    let failed: unknown;
    let closed = false;
    const bell = new Int32Array(init.memory.buffer, bellAddr, 2);
    void d.serve(bell).catch((e) => { failed = e; });
    return {
      kick: (_wait: boolean) => { throw new Error('parallel: the vCPU workers ring the doorbell'); },
      inFlight: () => false,
      settle: async () => { if (failed) throw failed; },
      quiesce: () => ringAsync(bell, () => closed),
      save: async () => d.save(),
      written: async (i: number) => d.written(i),
      blocks: async (i: number, blocks: number[]) => d.blocks(i, blocks),
      output: () => text, flush: async () => { if (failed) throw failed; },
      close: async () => {
        closed = true;
        Atomics.notify(bell, 1); // a quiesce waiting for its answer
        d.close();
        return d.stats();
      },
    };
  }
  if (!inWorker || (init.specs.length === 0 && !init.xhci)) {
    // blk over HTTP needs a worker (Node has no XHR; a page can't make binary sync XHRs); Node reads `file:` images.
    const d = await Devices.open(init, out, notice);
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
  const drained: (() => void)[] = []; // one a `drain` message, answered in order
  let closed = (_stats?: unknown) => {};
  let saved = (_m: { state?: unknown[]; error?: string; wire?: WireError }) => {};
  // Requests for a disk's changes (`written`, `blocks`), answered by id.
  type DiskAnswer = { written?: { blocks: number[]; generation?: number }; bytes?: Uint8Array; error?: string };
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
      // The error as the device worker had it (its fields, an overlay's `problem`, kept: web/app/worker.ts `explain`).
      else if (e.data.type === 'error') reject(e.data.error ? fromWire(e.data.error) : new Error(`device worker: ${e.data.message}`));
      else if (e.data.type === 'console') out(e.data.device, e.data.text);
      else if (e.data.type === 'notice') notice?.(e.data.message);
      else if (e.data.type === 'flushed') flushed();
      else if (e.data.type === 'drained') drained.shift()?.();
      else if (e.data.type === 'saved') saved(e.data);
      else if (e.data.type === 'disk') asked.get(e.data.id)?.(e.data);
      else if (e.data.type === 'closed') {
        for (const d of drained.splice(0)) d(); // a closed worker answers no drain
        closed(e.data.stats);
      }
    };
  });
  worker.postMessage({ type: 'init', ...init, bell: bellAddr }, [...specPorts(init.specs), ...(init.xhci?.port ? [init.xhci.port] : [])]);
  await ready; // before anything blocks on it
  const bell = new Int32Array(init.memory.buffer, bellAddr, 2);
  return {
    inFlight: () => false,
    settle: async () => {},
    // A remote disk's requests run on after a poll (realtime, R4): they complete before the doorbell is answered.
    quiesce: async () => {
      await ringAsync(bell, () => closing !== undefined); // what the last poll hadn't taken: the drain waits for it too
      if (closing) return;
      await new Promise<void>((resolve) => {
        drained.push(resolve);
        worker.postMessage({ type: 'drain' });
      });
    },
    /** The backends' state for a snapshot (web/devices.ts `Devices.save`). */
    save: () => new Promise<unknown[]>((resolve, reject) => {
      saved = (m) => (m.state ? resolve(m.state) : reject(m.wire ? fromWire(m.wire) : new Error(m.error ?? 'the device worker has no state')));
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
     * Resolves once it released its files (so another VM can open the overlay), or after `CLOSE_MS` and a little
     * if it doesn't answer (e.g. a sync XHR still waiting); the same promise on a second call. The value is
     * the blk timers of devices with `stats` (web/iostats.ts), if any.
     */
    close: () => (closing ??= new Promise<unknown>((resolve) => {
      closed = resolve;
      setTimeout(resolve, CLOSE_MS + 500);
      worker.postMessage({ type: 'close' });
      Atomics.notify(bell, 1); // a quiesce waiting for its answer
    })),
  };
}
