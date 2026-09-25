// Host side of the whole-VM ABI (PLAN.md §2, ABI 7): instantiates the core on
// shared memory, places guest RAM after the core's heap (layout A), boots an
// arm64 Image and runs it, draining the console. virtio backends run in a
// device worker (web/device-worker.ts) when this runs in a worker, and inline
// otherwise (Node, a page's main thread). Runs in a worker or in Node.
// Time is deterministic unless `realtime` is set (the host clock, and idle
// WFIs sleep on the signal word).
import { Devices, deviceEntry, type DeviceSpec, type DevicesInit } from './devices.ts';
import { isQcow2, qcow2Size } from './qcow2.ts';

export const ABI = 7;
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

/** The core's imports: the shared memory, and the host clock for realtime mode. */
export function coreImports(memory: WebAssembly.Memory) {
  return { env: { memory, now_ms: () => performance.now() } };
}

/** u64 word indexes in `vm::Counters` (core/src/vm.rs). */
export const Counter = { STEPS: 0, EXCEPTIONS: 1, IRQS: 65, TLB_HITS: 66, TLB_MISSES: 67, TLB_WALKS: 68, TLB_FLUSHES: 69, PC: 70, LEN: 71 } as const;

export type BootOptions = { ramSize: number; kernel: Uint8Array; initrd?: Uint8Array; cmdline: string; devices?: DeviceSpec[]; realtime?: boolean };

/** The devices the test and benchmark guests expect: target/images/linux's root filesystem at `disk` (a URL) is /dev/vda. */
export const guestDevices = (disk: string): DeviceSpec[] => [{ type: 'console' }, { type: 'rng' }, { type: 'blk', url: disk }];
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
    cmdline: `console=ttyAMA0 root=/dev/vda1 ro systemd.run="/bin/sh -c 'exec >/dev/console 2>&1; echo webpc: debian; cat /etc/debian_version; uname -r; echo webpc: test ok'" systemd.run_success_action=poweroff systemd.run_failure_action=poweroff`,
  },
} as const;

// The scratch page before RAM: VmConfig, device entries, the doorbell, the command line.
const S_CFG = 0;
const S_DEVICES = 64;
const S_BELL = 2048;
const S_CMDLINE = 4096;

export async function bootVm(wasm: BufferSource | WebAssembly.Module, o: BootOptions) {
  const memory = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
  const module = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);
  const ex = (await WebAssembly.instantiate(module, coreImports(memory))).exports as unknown as Exports;
  if (ex.abi_version() !== ABI) throw new Error(`core ABI ${ex.abi_version()}, expected ${ABI}`);

  // Scratch page for VmConfig and the command line, then RAM.
  const scratch = memory.grow(1) * 65536;
  const ram = memory.grow(o.ramSize / 65536) * 65536;
  const bytes = () => new Uint8Array(memory.buffer);
  const specs = await Promise.all((o.devices ?? []).map(async (d) => {
    if (d.type !== 'blk' || d.size !== undefined) return d;
    // The capacity: a qcow2 header's virtual size, or the file size.
    const r = await fetch(d.url, { headers: { Range: 'bytes=0-31' } });
    if (r.status !== 206) throw new Error(`${d.url}: ${r.status}`);
    const head = new Uint8Array(await r.arrayBuffer());
    return { ...d, size: isQcow2(head) ? qcow2Size(head) : Number(r.headers.get('content-range')?.split('/')[1]) };
  }));
  const deterministic = !o.realtime;
  // VmConfig: RAM size, deterministic, CNTFRQ and ticks per step (defaults), device entries.
  new BigUint64Array(memory.buffer, scratch + S_CFG, 6).set([BigInt(o.ramSize), deterministic ? 1n : 0n, 0n, 0n, BigInt(scratch + S_DEVICES), BigInt(specs.length)]);
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
     * deterministic mode this waits for them), as core/tests/common does. In
     * realtime mode an idle WFI sleeps here until its deadline or a signal.
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
    // The blk backend needs a worker (Node has no XHR; a page can't make binary sync XHRs).
    const d = new Devices(init, out);
    return { kick: () => void d.poll(), output: () => text, flush: async () => {}, close: () => {} };
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
      if (!init.deterministic) return; // completions come back through SIGNAL_DEVICE
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
