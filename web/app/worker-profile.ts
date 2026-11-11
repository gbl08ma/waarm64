// The machine worker's profilers, for benchmarks (web/app/worker.ts; docs/benchmarking.md): the guest PC sampler and
// the vCPU timeline over the running machine `vm`.
import type { Vm } from '../vm.ts';
import { startSampler, startTimeline, type Timeline } from '../profiler.ts';
import { post } from './worker-post.ts';

let stopSampler: (() => Promise<[string, number][]>) | undefined;
/**
 * The guest PC sampler (web/profiler.ts) over every vCPU's counters block, for benchmarks. While it runs, a vCPU
 * publishes its PC every PROFILE_CHUNK steps (`vm_set_chunk`; 32768 otherwise, or at an exit): a sample is then where
 * the vCPU is, not where its last long chunk ended.
 */
const PROFILE_CHUNK = 256;
export async function profile(vm: Vm | undefined, on: boolean, id = 0) {
  if (on && vm && !stopSampler) {
    vm.setChunk(PROFILE_CHUNK);
    stopSampler = await startSampler(vm.memory, vm.counterBlocks, 50);
  } else if (!on && stopSampler) {
    const stop = stopSampler;
    stopSampler = undefined;
    vm?.setChunk(0);
    post({ type: 'profile', id, samples: await stop() });
  }
}

let stopTimeline: (() => Promise<Timeline>) | undefined;
/** The vCPU timeline (web/profiler.ts `startTimeline`), for benchmarks. */
export async function timeline(vm: Vm | undefined, on: boolean, id = 0) {
  if (on && vm && !stopTimeline) {
    stopTimeline = await startTimeline(vm.memory, vm.counterBlocks, vm.liveBlock);
  } else if (!on && stopTimeline) {
    const stop = stopTimeline;
    stopTimeline = undefined;
    post({ type: 'timeline', id, timeline: await stop() });
  }
}
