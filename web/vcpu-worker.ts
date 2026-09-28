// A vCPU worker (M7, parallel SMP; docs/abi.md "M7 (SMP)"): one per vCPU,
// each with its own core instance on the VM's memory, so its own function
// table and JIT code. It runs `vm_run_cpu` for its vCPU until the VM stops:
// it sleeps on the vCPU's wake word while the vCPU is idle or off, rings the
// device doorbell on DEVICE exits (and waits for config writes), lets the
// coordinator drain the console on TX_FULL, and reports the exit that ends
// its run (PSCI, UNIMPLEMENTED, STOP) or its error to the coordinator
// (web/vm.ts `bootVm`). Runs in a browser worker or a Node worker thread.
import { EV_CONFIG, ring } from './devices.ts';
import { Exit, instantiateThread, type ThreadBlock } from './vm.ts';

export type VcpuJob = {
  module: WebAssembly.Module;
  memory: WebAssembly.Memory;
  block: ThreadBlock;
  vm: number;
  cpu: number;
  /** Byte addresses in `memory`: the device doorbell (two i32 words) and the coordinator's word (bumped on TX_FULL). */
  bell: number;
  ctl: number;
};
export type VcpuEnd = { type: 'exit'; cpu: number; kind: number; value: bigint; x: bigint[] } | { type: 'error'; cpu: number; message: string };

type Ex = {
  vm_run_cpu(vm: number, cpu: number, budget: bigint): number;
  vm_exit_cpu(vm: number, cpu: number): number;
  vm_cpu_signal(vm: number, i: number): number;
};

/** Steps per `vm_run_cpu` call: it returns early on anything the worker handles. */
const BUDGET = 100_000_000n;
const NONE = 0xffff_ffff_ffff_ffffn;

function run(j: VcpuJob): VcpuEnd {
  const ex = instantiateThread(j.module, j.memory, j.block).exports as unknown as Ex;
  const mem = j.memory;
  const wake = new Int32Array(mem.buffer, ex.vm_cpu_signal(j.vm, j.cpu), 1);
  const bell = new Int32Array(mem.buffer, j.bell, 2);
  const ctl = new Int32Array(mem.buffer, j.ctl, 1);
  const info = ex.vm_exit_cpu(j.vm, j.cpu);
  for (;;) {
    const kind = ex.vm_run_cpu(j.vm, j.cpu, BUDGET);
    // kind, steps, value, x0-x3, cpu, wake (a fresh view: the memory may have grown).
    const e = new BigUint64Array(mem.buffer, info, 9);
    switch (kind) {
      case Exit.BUDGET:
        continue;
      case Exit.IDLE: {
        // Until its deadline or a wake-up; an off vCPU (no deadline) rechecks every second.
        const ms = e[2] === NONE ? 1000 : Number(e[2]) / 1e6;
        Atomics.wait(wake, 0, Number(e[8]) | 0, ms);
        continue;
      }
      case Exit.TX_FULL:
        Atomics.add(ctl, 0, 1);
        Atomics.notify(ctl, 0);
        Atomics.wait(wake, 0, Atomics.load(wake, 0), 1);
        continue;
      case Exit.DEVICE:
        // A config-space write waits: the driver reads the answer next (virtio-input's select/subsel).
        ring(bell, (Number(e[2] >> 8n) & EV_CONFIG) !== 0);
        continue;
      default:
        return { type: 'exit', cpu: j.cpu, kind, value: e[2], x: [...e.subarray(3, 7)] };
    }
  }
}

function start(j: VcpuJob): VcpuEnd {
  try {
    return run(j);
  } catch (err) {
    return { type: 'error', cpu: j.cpu, message: String((err as Error).stack ?? err) };
  }
}

if ('WorkerGlobalScope' in globalThis) {
  const self = globalThis as unknown as { onmessage: (e: MessageEvent<VcpuJob>) => void; postMessage(m: unknown): void };
  self.onmessage = (e) => self.postMessage(start(e.data));
} else {
  const { parentPort } = await import('node:worker_threads');
  parentPort!.once('message', (j: VcpuJob) => parentPort!.postMessage(start(j)));
}
