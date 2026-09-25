// Host side of the whole-VM ABI (PLAN.md §2, ABI 6): instantiates the core on
// shared memory, places guest RAM after the core's heap (layout A), boots an
// arm64 Image and runs it, draining the console. virtio backends run in a
// device worker (web/device-worker.ts) when this runs in a worker, and inline
// otherwise (Node, a page's main thread). Runs in a worker or in Node.
import { Devices, deviceEntry, type DeviceSpec, type DevicesInit } from './devices.ts';

export const ABI = 6;
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
};

/** u64 word indexes in `vm::Counters` (core/src/vm.rs). */
export const Counter = { STEPS: 0, EXCEPTIONS: 1, IRQS: 65, TLB_HITS: 66, TLB_MISSES: 67, TLB_WALKS: 68, TLB_FLUSHES: 69, PC: 70, LEN: 71 } as const;

export type BootOptions = { ramSize: number; kernel: Uint8Array; initrd?: Uint8Array; cmdline: string; devices?: DeviceSpec[] };

/** The devices the test and benchmark guests (target/images/linux) expect. */
export const GUEST_DEVICES: DeviceSpec[] = [{ type: 'console' }, { type: 'rng' }];

// The scratch page before RAM: VmConfig, device entries, the doorbell, the command line.
const S_CFG = 0;
const S_DEVICES = 64;
const S_BELL = 2048;
const S_CMDLINE = 4096;

export async function bootVm(wasm: BufferSource | WebAssembly.Module, o: BootOptions) {
  const memory = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
  const module = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);
  const ex = (await WebAssembly.instantiate(module, { env: { memory } })).exports as unknown as Exports;
  if (ex.abi_version() !== ABI) throw new Error(`core ABI ${ex.abi_version()}, expected ${ABI}`);

  // Scratch page for VmConfig and the command line, then RAM.
  const scratch = memory.grow(1) * 65536;
  const ram = memory.grow(o.ramSize / 65536) * 65536;
  const bytes = () => new Uint8Array(memory.buffer);
  const specs = o.devices ?? [];
  // VmConfig: RAM size, deterministic, CNTFRQ and ticks per step (defaults), device entries.
  new BigUint64Array(memory.buffer, scratch + S_CFG, 6).set([BigInt(o.ramSize), 1n, 0n, 0n, BigInt(scratch + S_DEVICES), BigInt(specs.length)]);
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
  const devices = await deviceHost({ memory, shared, ram, signal: ex.vm_signal(vm), specs }, scratch + S_BELL);

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
  return {
    memory,
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
      return { steps: n(Counter.STEPS), irqs: n(Counter.IRQS), exceptions, tlbMisses: n(Counter.TLB_MISSES), tlbWalks: n(Counter.TLB_WALKS), tlbFlushes: n(Counter.TLB_FLUSHES) };
    },
    /**
     * Runs up to `budget` steps; returns the exit kind and steps taken. DEVICE
     * exits are handled here (the backends take the requests, and in
     * deterministic mode this waits for them), as core/tests/common does.
     */
    run(budget: number) {
      let steps = 0;
      for (;;) {
        const kind = ex.vm_run(vm, BigInt(budget - steps));
        const info = new BigUint64Array(memory.buffer, ex.vm_exit(vm), 7); // kind, steps, value, x0-x3
        steps += Number(info[1]);
        if (kind === Exit.DEVICE) {
          devices.kick();
          if (steps < budget) continue;
        }
        return { kind: kind === Exit.DEVICE ? Exit.BUDGET : kind, steps, value: info[2], x: [...info.subarray(3)] };
      }
    },
    drain,
    /** What the guest wrote to its virtio consoles so far (all of it once `flush` resolves). */
    hvc: () => devices.output(),
    flush: () => devices.flush(),
    close: () => devices.close(),
    pc: () => new BigUint64Array(memory.buffer, ex.vm_cpu(vm) + 256, 1)[0],
  };
}

/** Boots and runs until the guest powers off (or `maxSteps`), collecting the console. */
export async function runToPowerOff(wasm: BufferSource | WebAssembly.Module, o: BootOptions, maxSteps = 20e9) {
  const vm = await bootVm(wasm, o);
  let console = '';
  let steps = 0;
  const t0 = performance.now();
  for (;;) {
    const r = vm.run(100_000_000);
    steps += r.steps;
    console += vm.drain();
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
    const d = new Devices(init, out);
    return { kick: () => d.poll(), output: () => text, flush: async () => {}, close: () => {} };
  }
  const worker = new Worker(new URL('./device-worker.ts', import.meta.url), { type: 'module' });
  let flushed = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    worker.onerror = (e) => reject(new Error(`device worker: ${e.message}`));
    worker.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'ready') resolve();
      else if (e.data.type === 'console') out(e.data.device, e.data.text);
      else if (e.data.type === 'flushed') flushed();
    };
  });
  worker.postMessage({ type: 'init', ...init, bell: bellAddr });
  await ready; // before anything blocks on it
  const bell = new Int32Array(init.memory.buffer, bellAddr, 2);
  return {
    kick() {
      const n = Atomics.add(bell, 0, 1) + 1;
      Atomics.notify(bell, 0);
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
    close: () => worker.terminate(),
  };
}
