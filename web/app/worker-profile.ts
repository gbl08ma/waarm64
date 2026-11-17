// The machine worker's answers to the page's asks about the running machine `vm` (web/app/worker.ts `asked`): the
// profilers, for benchmarks (docs/benchmarking.md: the guest PC sampler and the vCPU timeline), its heap's use, the
// disks' overlays compacted (after the guest's trim: web/app/areas/trim-actions.ts), and the questions about its
// surfaces (web/surface.ts: `inspect`).
import type { Vm } from '../vm.ts';
import { startSampler, startTimeline, type Timeline } from '../profiler.ts';
import type { ToWorker } from './protocol.ts';
import { answerBuffers, type InspectAnswer, type InspectQuery } from '../surface.ts';
import { post } from './worker-post.ts';
import { inspectRam } from './worker-ram.ts';

/** Answers `m` if it is one of these asks (a profiler on or off, the heap, the compaction, a surface). */
export function asked(vm: Vm | undefined, m: ToWorker) {
  if (m.type === 'profile') void profile(vm, m.on, m.id);
  else if (m.type === 'timeline') void timeline(vm, m.on, m.id);
  else if (m.type === 'heap') {
    if (vm) post({ type: 'heap', id: m.id, heap: vm.heapUse() });
  } else if (m.type === 'compact') {
    const id = m.id;
    void (vm ? vm.compact(m.measure) : Promise.resolve(undefined)).then(
      (c) => post({ type: 'compacted', id, ...c }),
      () => post({ type: 'compacted', id }),
    );
  } else if (m.type === 'inspect') {
    const id = m.id;
    void inspect(vm, m.query)
      .catch((): InspectAnswer => ({ kind: 'none' }))
      .then((answer) => post({ type: 'inspected', id, answer }, answerBuffers(answer)));
  }
}

/**
 * Who answers a surface's query, by its kind: a disk's (`disk-*`) the machine's devices (web/vm.ts `Vm.inspect`, the
 * device worker); RAM's (`ram-*`) the RAM map's scanner (web/app/worker-ram.ts).
 */
function inspect(vm: Vm | undefined, query: InspectQuery): Promise<InspectAnswer> {
  if (query.kind.startsWith('ram-')) return inspectRam(vm, query);
  if (vm && query.kind.startsWith('disk-')) return vm.inspect(query);
  return Promise.resolve({ kind: 'none' });
}

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
