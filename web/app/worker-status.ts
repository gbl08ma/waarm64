// The machine worker's status (web/app/worker.ts; web/app/protocol.ts `Status`): the running machine's counters, posted
// every second for the status bar, the memory signal and the tests.
import type { Vm } from '../vm.ts';
import type { Signal } from './memory.ts';
import type { Status } from './protocol.ts';
import type { DeviceKind } from './shape.ts';
import { post } from './worker-post.ts';

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
    counted: vm.counting(),
    jitBlocks: s.jit.blocks,
    jitFlushes: s.jit.flushes,
    jitCompileMs: s.jit.compileNs / 1e6,
    jitSteps: s.jit.steps,
    jitBytes: s.jit.bytes,
    irqs: s.irqs,
    tlbMisses: s.tlbMisses,
    tlbFlushes: s.tlbFlushes,
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

/** The keyboard's driver: the page sends keys typed on the screen to the serial console until it is up (the firmware's menus, GRUB). */
export function watchKeyboard(vm: Vm, here: { kind: DeviceKind }[]) {
  const kbd = here.findIndex((s) => s.kind === 'keyboard');
  let kbdLive: boolean | undefined;
  return kbd >= 0
    ? setInterval(() => {
        const live = (vm.deviceStatus(kbd) & 4) !== 0;
        if (live !== kbdLive) post({ type: 'keyboard', live: (kbdLive = live) });
      }, 200)
    : undefined;
}

/** The memory signal (web/app/memory.ts): past what the device reports, the JIT's cache holds no more than it does now
 * (the gauge's limit: it flushes there, docs/jit.md "The page's memory signal"). */
export function limitJit(vm: Vm, st: Status) {
  const device = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (device && st.estimateBytes > device * 2 ** 30 && !st.memory.jitLimit)
    vm.setJitLimit(Math.max(st.memory.jitLiveBytes, 1));
}
