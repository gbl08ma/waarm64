// The machine worker's status (web/app/worker.ts; web/app/protocol.ts `Status`): the running machine's counters, posted
// every second for the status bar, the memory signal and the tests.
import type { Vm } from '../vm.ts';
import type { Signal } from './memory.ts';
import type { Status } from './protocol.ts';

/** `io`: the device index of each of the page's disks and adapters, in its order (none: a machine without `network`), and the xHCI's (none: no USB controller); `signal`: the run's memory signal, updated. */
export function status(
  vm: Vm,
  ncpus: number,
  ramMiB: number,
  uptime: number,
  loopMaxMs: number,
  loopAgeMs: number,
  io: { disks: number[]; nets?: number[]; usb?: number },
  signal: Signal,
): Status {
  const s = vm.stats();
  const c = vm.deviceIo(); // two per device: blk read, written; net received, sent
  const memory = vm.hostUse();
  const estimateBytes = signal.update(memory, ncpus);
  return {
    ncpus,
    ramMiB,
    uptime,
    steps: s.steps,
    jitBlocks: s.jit.blocks,
    jitFlushes: s.jit.flushes,
    jitCompileMs: s.jit.compileNs / 1e6,
    jitSteps: s.jit.steps,
    jitBytes: s.jit.bytes,
    irqs: s.irqs,
    loopMaxMs,
    loopAgeMs,
    vcpus: vm.liveness(),
    stats: s,
    memory,
    estimateBytes,
    peakBytes: signal.peak,
    disks: io.disks.map((i) => ({ read: c[2 * i], written: c[2 * i + 1] })),
    nets: io.nets?.map((i) => ({ rx: c[2 * i], tx: c[2 * i + 1] })),
    usb: io.usb === undefined ? undefined : { in: c[2 * io.usb], out: c[2 * io.usb + 1] },
    cpus: vm.parallel ? vm.cpuStats().map((b) => ({ steps: b.steps, jitSteps: b.jit.steps })) : undefined,
    asleep: vm.suspended(),
  };
}
