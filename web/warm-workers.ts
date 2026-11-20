// The browser workers a machine runs on (the device worker, the vCPU workers, the JIT's compile worker), and those
// started ahead of its `bootVm`.

/**
 * A machine's workers started ahead of its `bootVm` (`BootOptions.warm`): a worker's module loads in ~60-120 ms on
 * the dev server, which a start from a snapshot then spends beside its check pass rather than after it (the device
 * worker before the devices' state goes back, the vCPU workers before the guest runs again; bench/boot/REPORT.md
 * "SNAPZ loop 7"). `take` hands out one of a kind or a new one; one that failed to load is replaced (the new one fails
 * where its error is heard). `end` ends those not taken: once the vCPU workers are started, or `bootVm` failed.
 */
export type WarmWorkers = { take(which: WorkerKind): Worker; end(): void };
export type WorkerKind = 'device' | 'vcpu' | 'compile';

/**
 * A browser worker of `which` kind: `new Worker(new URL('…', import.meta.url))` written out whole, as the page's
 * bundler finds workers (docs/frontend.md "The build").
 */
export function newWorker(which: WorkerKind) {
  if (which === 'device') return new Worker(new URL('./device-worker.ts', import.meta.url), { type: 'module' });
  if (which === 'vcpu') return new Worker(new URL('./vcpu-worker.ts', import.meta.url), { type: 'module' });
  return new Worker(new URL('./jit-compile-worker.ts', import.meta.url), { type: 'module' });
}

/**
 * The machine's workers made now, for its `bootVm` (`BootOptions.warm`): the device worker, `ncpus` vCPU workers (a
 * snapshot's machine may have another count: what's missing is made then, what's left ended), and with `compile` the
 * JIT's compile worker. Nothing without browser workers (Node: undefined).
 */
export function warmWorkers(ncpus: number, compile: boolean): WarmWorkers | undefined {
  if (typeof Worker === 'undefined' || typeof WorkerGlobalScope === 'undefined') return undefined;
  const failed = new WeakSet<Worker>();
  const spawn = (which: WorkerKind) => {
    const w = newWorker(which);
    w.onerror = (e) => {
      e.preventDefault();
      failed.add(w);
    };
    return w;
  };
  const ready: Record<WorkerKind, Worker[]> = {
    device: [spawn('device')],
    vcpu: Array.from({ length: ncpus }, () => spawn('vcpu')),
    compile: compile ? [spawn('compile')] : [],
  };
  return {
    take(which) {
      const w = ready[which].shift();
      if (!w) return newWorker(which);
      w.onerror = null;
      if (!failed.has(w)) return w;
      w.terminate();
      return newWorker(which);
    },
    end() {
      for (const list of Object.values(ready)) for (const w of list.splice(0)) w.terminate();
    },
  };
}
