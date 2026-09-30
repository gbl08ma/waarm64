// Per-vCPU liveness (BUG1's stress test, bench/stress): each vCPU worker
// (web/vcpu-worker.ts) times its `vm_run_cpu` calls into a small shared block,
// and the coordinator (or anything holding the block) reads it to tell a vCPU
// that is slow or stalled from one that is idle or busy. Host-side only: no
// core ABI. Times are epoch milliseconds (`performance.timeOrigin + now()`),
// comparable across threads.

/** Doubles per vCPU: chunks, enteredAt, lastReturn, maxRunMs, maxRunAt, maxHostMs, maxHostAt, spare. */
const SLOTS = 8;
const CHUNKS = 0, ENTERED = 1, RETURNED = 2, MAX_RUN = 3, MAX_RUN_AT = 4, MAX_HOST = 5, MAX_HOST_AT = 6;

export const epochMs = () => performance.timeOrigin + performance.now();

/** A block for `ncpus` vCPUs, on a SharedArrayBuffer (posted to the workers). */
export const newLiveness = (ncpus: number) => new Float64Array(new SharedArrayBuffer(ncpus * SLOTS * 8));

/** One vCPU's view of the block, for its worker. `enter`/`leave` bracket `vm_run_cpu`; `handled` ends the host work after it. */
export function livenessWriter(block: Float64Array, cpu: number, now = epochMs) {
  const at = cpu * SLOTS;
  let left = 0;
  return {
    enter() {
      block[at + ENTERED] = now();
    },
    /** `vm_run_cpu` returned. */
    leave() {
      const t = now();
      const run = t - block[at + ENTERED];
      block[at + CHUNKS]++;
      block[at + ENTERED] = 0;
      block[at + RETURNED] = t;
      left = t;
      if (run > block[at + MAX_RUN]) {
        block[at + MAX_RUN] = run;
        block[at + MAX_RUN_AT] = t;
      }
    },
    /**
     * The worker finished what the exit asked (a doorbell, a console drain), not counting an idle wait:
     * the time since `leave` is the host's own, and a long one is a stall outside the core.
     */
    handled() {
      const host = now() - left;
      if (host > block[at + MAX_HOST]) {
        block[at + MAX_HOST] = host;
        block[at + MAX_HOST_AT] = left;
      }
    },
  };
}

export type VcpuLiveness = {
  cpu: number;
  /** `vm_run_cpu` calls returned so far. */
  chunks: number;
  /** ms the vCPU has been inside its current `vm_run_cpu` call (0 while outside it: idle, or handling an exit). */
  runningMs: number;
  /** ms since its last return (0 before the first chunk). */
  sinceReturnMs: number;
  /** The longest call so far, and when it ended (epoch ms). */
  maxRunMs: number;
  maxRunAt: number;
  /** The longest host-side handling of a non-idle exit, and when it started. */
  maxHostMs: number;
  maxHostAt: number;
};

/** Reads the block (any thread). */
export function readLiveness(block: Float64Array, now = epochMs): VcpuLiveness[] {
  const t = now();
  return Array.from({ length: block.length / SLOTS }, (_, cpu) => {
    const at = cpu * SLOTS;
    const entered = block[at + ENTERED];
    const returned = block[at + RETURNED];
    return {
      cpu, chunks: block[at + CHUNKS], runningMs: entered ? t - entered : 0, sinceReturnMs: returned ? t - returned : 0,
      maxRunMs: block[at + MAX_RUN], maxRunAt: block[at + MAX_RUN_AT], maxHostMs: block[at + MAX_HOST], maxHostAt: block[at + MAX_HOST_AT],
    };
  });
}
