// The core instance's plumbing (docs/abi.md): its imports, its compiled module and the copy with exact memory
// limits, the exports that return addresses, the panic message, the VmConfig's words, more instances on one
// memory (a vCPU worker's) and their clock. What every thread that runs the core needs, without the VM around it.
import { spillImports } from './spill.ts';
import { MAX_SPILL } from './ram.ts';
import { jitHost } from './jit-host.ts';

/**
 * The core's `VmConfig` (core/src/vm.rs, `vm_new`'s): each field's first word, in the struct's order; `rngSeed` is 4
 * words, `spill` MAX_SPILL. A field the core adds (an ABI change) is added here at its word (tests/config-words.test.ts
 * checks these against the struct).
 */
export const VM_CONFIG = {
  ramSize: 0,
  deterministic: 1,
  cntfrq: 2,
  ticksPerInsn: 3,
  devices: 4,
  ndevices: 5,
  fbWidth: 6,
  fbHeight: 7,
  jit: 8,
  features: 9,
  ncpus: 10,
  gic: 11,
  smp: 12,
  rtc: 13,
  firmware: 14,
  flashSize: 15,
  fwCfg: 16,
  fwCfgLen: 17,
  memPages: 18,
  rngSeed: 19,
  xhci: 23,
  spill: 24,
  jitBytes: 24 + MAX_SPILL,
  window: 25 + MAX_SPILL,
  windowAt: 26 + MAX_SPILL,
  fma: 27 + MAX_SPILL,
} as const;
export const VM_CONFIG_WORDS = 28 + MAX_SPILL;

/** A `VmConfig`'s words from its fields by name (a field not given is 0; an array field's words from its first). */
export function vmConfig(fields: { [K in keyof typeof VM_CONFIG]?: bigint | readonly bigint[] }): BigUint64Array {
  const out = new BigUint64Array(VM_CONFIG_WORDS);
  for (const [k, v] of Object.entries(fields) as [keyof typeof VM_CONFIG, bigint | readonly bigint[]][])
    if (typeof v === 'bigint') out[VM_CONFIG[k]] = v;
    else out.set(v, VM_CONFIG[k]);
  return out;
}

/** Exit kinds (core/src/vm.rs `exit`). */
export const Exit = { BUDGET: 0, PSCI: 1, IDLE: 2, TX_FULL: 3, UNIMPLEMENTED: 4, STOP: 5, DEVICE: 6 } as const;
export const PSCI_SYSTEM_OFF = 0x8400_0008n;

/**
 * The core's imports: the shared memory, the host clock for realtime mode,
 * `jit_install` and `jit_compile` (core/src/jit). The JIT works once `jit.bind` has the core's
 * instance; until then `jit_install` fails and the core only interprets. `compile`: this vCPU's
 * port to the compile worker (web/jit-compile-worker.ts; parallel SMP). `ram`: the spill memories'
 * accessor over `spill`, memory 1 first (web/spill.ts).
 */
export function coreImports(
  memory: WebAssembly.Memory,
  clock = performance.timeOrigin,
  stall: Stall[] = [],
  compile?: MessagePort,
  spill: WebAssembly.Memory[] = [],
) {
  const hooks = stall.map((s) => stallHook(memory, s));
  const wrap = <F extends (...a: never[]) => unknown>(where: Stall['on'], f: F) =>
    hooks.reduce((g, h) => h(where, g), f);
  const now_ms = wrap('clock', () => clock + performance.now());
  const jit = jitHost(memory, now_ms, compile, spill);
  return {
    env: { memory, now_ms, jit_install: wrap('install', jit.install), jit_compile: jit.compile },
    ram: spillImports(spill),
    jit,
  };
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
export type Stall = {
  cpu: number;
  on: 'clock' | 'install' | 'idle';
  addr: number;
  ms: number;
  arm?: number;
  after?: number;
};

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
    if (where === 'idle')
      return (() => {
        block(3);
      }) as unknown as F;
    return ((...a: never[]) => {
      block(1);
      return f(...a);
    }) as F;
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
export const POINTERS = [
  'thread_alloc',
  'vcpu_new',
  'mem_new',
  'jit_new',
  'jit_stats',
  'vm_new',
  'vm_flash',
  'vm_cpu',
  'vm_exit',
  'vm_exit_cpu',
  'vm_console',
  'vm_signal',
  'vm_cpu_signal',
  'vm_cpu_stop',
  'vm_device',
  'vm_xhci',
  'vm_counters',
  'vm_jit_gauge',
  'vm_window_watch',
  'jit_helper_report',
  'panic_message',
];

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
const coreBytes = new WeakMap<
  WebAssembly.Module,
  { bytes: Uint8Array; exact: Map<number, Promise<WebAssembly.Module>> }
>();

/**
 * Compiles the core and keeps its bytes, so that `bootVm` can make the copy that runs a fixed-size memory
 * ({@link exactCore}). A module compiled otherwise still boots, without that copy.
 */
export async function compileCore(wasm: BufferSource): Promise<WebAssembly.Module> {
  const bytes = new Uint8Array(
    ArrayBuffer.isView(wasm) ? wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) : wasm.slice(0),
  );
  const module = await WebAssembly.compile(bytes);
  coreBytes.set(module, { bytes, exact: new Map() });
  return module;
}

/**
 * The core declaring its memory import with exact limits, `pages` both (docs/abi.md "A fixed-size memory"), compiled
 * once a size; undefined for a module not from {@link compileCore}.
 */
export function exactCore(module: WebAssembly.Module, pages: number): Promise<WebAssembly.Module> | undefined {
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
      if (kind === 0)
        leb(); // a function's type
      else if (kind === 1) {
        at++; // the element type, then the limits
        const flags = wasm[at++];
        leb();
        if (flags & 1) leb();
      } else if (kind === 3)
        at += 2; // a global's type and mutability
      else if (kind === 4) {
        at++;
        leb();
      } else throw new Error(`import kind ${kind}`);
      out.push(...wasm.subarray(desc, at));
    }
    if (at !== start + size || found !== 1)
      throw new Error(`the import section: ${found} memories, ${at - start} of ${size} bytes`);
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
export function panicNote(text: string, ex: WebAssembly.Exports, memory: WebAssembly.Memory): string {
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
    if (e.stack !== undefined && !e.stack.includes(e.message))
      e.stack = e.stack.includes(was) ? e.stack.replace(was, e.message) : `core panic: ${m}\n${e.stack}`;
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
export function instantiateThread(
  module: WebAssembly.Module,
  memory: WebAssembly.Memory,
  block: ThreadBlock,
  clock?: number,
  stall?: Stall[],
  compile?: MessagePort,
  spill: WebAssembly.Memory[] = [],
) {
  const imports = coreImports(memory, clock, stall, compile, spill);
  const instance = new WebAssembly.Instance(module, imports);
  (instance.exports.__stack_pointer as WebAssembly.Global).value = block.stack + THREAD_STACK;
  (instance.exports.__wasm_init_tls as (tls: number) => void)(block.tls);
  imports.jit.bind(instance);
  return instance;
}

export const STOP = 1;
export const SIGNAL_RX = 2;
