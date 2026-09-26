// Host side of the whole-VM ABI (PLAN.md §2, ABI 10): instantiates the core on
// shared memory, places guest RAM after the core's heap (layout A), boots an
// arm64 Image and runs it, draining the console. virtio backends run in a
// device worker (web/device-worker.ts) when this runs in a worker, and inline
// otherwise (Node, a page's main thread). Runs in a worker or in Node.
// Time is deterministic unless `realtime` is set (the host clock, and idle
// WFIs sleep on the signal word).
import { Devices, EV_CONFIG, deviceEntry, fileSource, specPorts, type DeviceSpec, type DevicesInit } from './devices.ts';
import { isQcow2, qcow2Size } from './qcow2.ts';

export const ABI = 10;
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
  vm_cpu(vm: number): number;
  vm_counters(vm: number): number;
  vm_signal(vm: number): number;
  vm_device(vm: number, i: number): number;
  vm_framebuffer(vm: number): bigint;
};

/**
 * The core's imports: the shared memory, the host clock for realtime mode, and
 * `jit_install` (core/src/jit). The JIT works once `jit.bind` has the core's
 * instance; until then `jit_install` fails and the core only interprets.
 */
export function coreImports(memory: WebAssembly.Memory) {
  const jit = jitHost(memory);
  return { env: { memory, now_ms: () => performance.now(), jit_install: jit.install }, jit };
}

/**
 * The host half of the JIT: compiles a module the core generated,
 * synchronously, and puts its exports f0, f1, … into the core's function table
 * at JIT slot `slot` on (after the core's own entries). The modules import the
 * memory, the table and the core's exports (its helpers) from `env`.
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
      const bytes = new Uint8Array(memory.buffer, ptr, len).slice(); // a non-shared copy
      const f = new WebAssembly.Instance(new WebAssembly.Module(bytes), imports).exports;
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
  LEN: 79,
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
  /** `VmConfig.jit`: 0 interpreter only (the default), 1 JIT, 2 JIT-stress. */
  jit?: 0 | 1 | 2;
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
/** Their kernel command line. */
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
const S_CMDLINE = 4096;

export type Vm = Awaited<ReturnType<typeof bootVm>>;

export async function bootVm(wasm: BufferSource | WebAssembly.Module, o: BootOptions) {
  const memory = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
  const module = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);
  const imports = coreImports(memory);
  const instance = await WebAssembly.instantiate(module, imports);
  imports.jit.bind(instance);
  const ex = instance.exports as unknown as Exports;
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
  const deterministic = !o.realtime;
  // VmConfig: RAM size, deterministic, CNTFRQ and ticks per step (defaults), device entries, framebuffer, JIT.
  const fb = o.framebuffer ?? { width: 0, height: 0 };
  new BigUint64Array(memory.buffer, scratch + S_CFG, 9).set([BigInt(o.ramSize), deterministic ? 1n : 0n, 0n, 0n, BigInt(scratch + S_DEVICES), BigInt(specs.length), BigInt(fb.width), BigInt(fb.height), BigInt(o.jit ?? 0)]);
  new BigUint64Array(memory.buffer, scratch + S_DEVICES, 5 * specs.length).set(specs.flatMap((d) => deviceEntry(d).entry));
  const cmd = new TextEncoder().encode(o.cmdline);
  bytes().set(cmd, scratch + S_CMDLINE);
  // The same placement as core/tests/boot.rs: Image at +2 MiB, initrd at +128 MiB.
  const kernelOff = 2 << 20;
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
  const devices = await deviceHost({ memory, shared, ram, signal, specs, deterministic }, scratch + S_BELL);
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
  const counters = ex.vm_counters(vm);
  const fbPa = Number(ex.vm_framebuffer(vm));
  return {
    memory,
    /** The framebuffer (web/display.ts): byte address in `memory`, width, height; x8r8g8b8, packed rows. */
    framebuffer: fbPa ? { addr: ram + fbPa - RAM_BASE, ...fb } : undefined,
    /** Byte addresses of guest RAM (PA 0x4000_0000) and of the vCPU registers (`cpu::Cpu`) in `memory`. */
    ram,
    cpu: ex.vm_cpu(vm),
    /** Byte address of `vm::Counters` in `memory` (u64s, read with Atomics.load). */
    counters,
    /** A snapshot of the counters; exceptions by EC only where non-zero. */
    stats() {
      const c = new BigUint64Array(memory.buffer, counters, Counter.LEN);
      const n = (i: number) => Number(Atomics.load(c, i));
      const exceptions: Record<string, number> = {};
      for (let ec = 0; ec < 64; ec++) if (n(Counter.EXCEPTIONS + ec)) exceptions[`0x${ec.toString(16)}`] = n(Counter.EXCEPTIONS + ec);
      return {
        steps: n(Counter.STEPS), irqs: n(Counter.IRQS), exceptions, tlbMisses: n(Counter.TLB_MISSES), tlbWalks: n(Counter.TLB_WALKS), tlbFlushes: n(Counter.TLB_FLUSHES),
        jit: {
          blocks: n(Counter.JIT_BLOCKS), modules: n(Counter.JIT_MODULES), bytes: n(Counter.JIT_BYTES), compileNs: n(Counter.JIT_COMPILE_NS),
          steps: n(Counter.JIT_STEPS), dispatches: n(Counter.JIT_DISPATCHES), invalidations: n(Counter.JIT_INVALIDATIONS), flushes: n(Counter.JIT_FLUSHES),
        },
      };
    },
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
      let steps = 0;
      for (;;) {
        const kind = ex.vm_run(vm, BigInt(budget - steps));
        const info = new BigUint64Array(memory.buffer, ex.vm_exit(vm), 7); // kind, steps, value, x0-x3
        steps += Number(info[1]);
        if (kind === Exit.DEVICE) {
          // A config-space write waits even in realtime mode: the driver reads
          // the answer next (virtio-input's select/subsel).
          devices.kick(deterministic || (Number(info[2] >> 8n) & EV_CONFIG) !== 0);
          if (devices.inFlight()) return { kind, steps, value: info[2], x: [...info.subarray(3)] };
          if (steps < budget) continue;
        }
        if (kind === Exit.IDLE && !deterministic && canBlock) {
          const sig = new Int32Array(memory.buffer, signal, 1);
          const ns = info[2];
          if (Atomics.load(sig, 0) === 0) Atomics.wait(sig, 0, 0, ns === 0xffff_ffff_ffff_ffffn ? Infinity : Number(ns) / 1e6);
          continue;
        }
        return { kind: kind === Exit.DEVICE ? Exit.BUDGET : kind, steps, value: info[2], x: [...info.subarray(3)] };
      }
    },
    drain,
    /** Resolves once inline backends finished what a `DEVICE` exit from `run` handed them. */
    settle: () => devices.settle(),
    /** What the guest wrote to its virtio consoles so far (all of it once `flush` resolves). */
    hvc: () => devices.output(),
    flush: () => devices.flush(),
    close: () => devices.close(),
    pc: () => new BigUint64Array(memory.buffer, ex.vm_cpu(vm) + 256, 1)[0],
  };
}

/**
 * Boots and runs until the guest powers off (or `maxSteps`), collecting the
 * console. `booted` sees the VM before it runs.
 */
export async function runToPowerOff(wasm: BufferSource | WebAssembly.Module, o: BootOptions, maxSteps = 20e9, booted?: (vm: Vm) => void) {
  const vm = await bootVm(wasm, o);
  booted?.(vm);
  let console = '';
  let steps = 0;
  const t0 = performance.now();
  for (;;) {
    const r = vm.run(100_000_000);
    steps += r.steps;
    console += vm.drain();
    if (r.kind === Exit.DEVICE) {
      await vm.settle();
      continue;
    }
    if ((r.kind === Exit.BUDGET || r.kind === Exit.TX_FULL) && steps < maxSteps) continue;
    const ms = performance.now() - t0;
    await vm.flush();
    vm.close();
    return { ...r, steps, console, hvc: vm.hvc(), ms, pc: vm.pc() };
  }
}

/**
 * The backends: in a device worker when this thread can block on it (a
 * worker), inline otherwise. `kick` hands them what a DEVICE exit posted and
 * returns once they've taken all of it (deterministic mode).
 */
async function deviceHost(init: DevicesInit, bellAddr: number) {
  let text = '';
  const out = (_device: number, t: string) => { text += t; };
  const inWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
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
      output: () => text, flush: async () => {}, close: () => d.close(),
    };
  }
  const worker = new Worker(new URL('./device-worker.ts', import.meta.url), { type: 'module' });
  let flushed = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    worker.onerror = (e) => reject(new Error(`device worker: ${e.message}`));
    worker.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'ready') resolve();
      else if (e.data.type === 'error') reject(new Error(`device worker: ${e.data.message}`));
      else if (e.data.type === 'console') out(e.data.device, e.data.text);
      else if (e.data.type === 'flushed') flushed();
    };
  });
  worker.postMessage({ type: 'init', ...init, bell: bellAddr }, specPorts(init.specs));
  await ready; // before anything blocks on it
  const bell = new Int32Array(init.memory.buffer, bellAddr, 2);
  return {
    inFlight: () => false,
    settle: async () => {},
    kick(wait: boolean) {
      const n = Atomics.add(bell, 0, 1) + 1;
      Atomics.notify(bell, 0);
      if (!wait) return; // completions come back through SIGNAL_DEVICE
      for (let a; (a = Atomics.load(bell, 1)) !== n;) {
        if (a === -1) throw new Error('device worker failed (see its error)');
        Atomics.wait(bell, 1, a);
      }
    },
    output: () => text,
    flush: () => new Promise<void>((resolve) => {
      flushed = resolve;
      worker.postMessage({ type: 'flush' });
    }),
    close: () => worker.postMessage({ type: 'close' }), // it releases its files, then ends
  };
}
