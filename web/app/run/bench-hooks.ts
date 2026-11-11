// The benchmarks' and tests' calls on `window` (web/app/hooks.ts; `?displaystats`, `?snd=`, `?iostats`): the guest
// PC sampler, the vCPU timeline, the core's heap, the serial log, the GPU worker's stall and Venus's skips, the 3D
// screen's read-back, the disks' timers.
import type { PageAudio } from '../../audio.ts';
import type { ToGpuWorker } from '../../gpu-worker.ts';
import type { SerialTerminal } from '../areas/serial-terminal.ts';
import type { Grab } from '../hooks.ts';
import type { FromWorker, ToWorker } from '../protocol.ts';
import { benchHooks, params } from './knobs.ts';
import type { PageMachine } from './page-machine.svelte.ts';
import type { Replies } from './replies.ts';

export function installBenchHooks(
  m: PageMachine,
  terminal: SerialTerminal,
  replies: { grabs: Replies<Grab>; worker: Replies<FromWorker> },
  audio: PageAudio,
) {
  if (params.has('snd')) window.__audio = audio; // tests and measurements (?snd=stats)
  if (params.has('iostats'))
    window.__ioStats = () =>
      new Promise((resolve) => {
        const ch = new BroadcastChannel('webpc-iostats');
        ch.onmessage = (e) => {
          ch.close();
          resolve(e.data);
        };
        ch.postMessage('ask');
      });
  if (!benchHooks) return;
  const gpu = (msg: ToGpuWorker) => m.run?.gpu?.postMessage(msg);
  /** Asks the machine worker `msg` (a stop, the heap): its answer, by id. */
  const ask = async <K extends 'profile' | 'timeline' | 'heap'>(msg: (id: number) => ToWorker & { type: K }) => {
    const w = m.run?.worker;
    if (!w) return undefined;
    return (await replies.worker.ask((id) => w.postMessage(msg(id)))) as Extract<FromWorker, { type: K }>;
  };
  // A stop's and the heap's answers land in the globals the benchmarks wait on (`__profile`, `__timeline`, `__heap`).
  window.__webpcProfile = (on) => {
    if (on) m.run?.worker.postMessage({ type: 'profile', on } satisfies ToWorker);
    else void ask((id) => ({ type: 'profile', on, id })).then((a) => a && (window.__profile = a.samples));
  };
  window.__webpcTimeline = (on) => {
    if (on) m.run?.worker.postMessage({ type: 'timeline', on } satisfies ToWorker);
    else void ask((id) => ({ type: 'timeline', on, id })).then((a) => a && (window.__timeline = a.timeline));
  };
  window.__serialLog = () => terminal.log;
  window.__webpcHeap = () => void ask((id) => ({ type: 'heap', id })).then((a) => a && (window.__heap = a.heap));
  window.__webpcStallGpu = (ms) => gpu({ type: 'stall', ms });
  window.__webpcVkSkip = (paths) => gpu({ type: 'vkskip', skip: paths });
  window.__webpcGrab = () => {
    const w = m.run?.gpu;
    if (!w) return Promise.resolve({ width: 0, height: 0, pixels: new Uint8Array(0) });
    return replies.grabs.ask((id) => w.postMessage({ type: 'grab', id } satisfies ToGpuWorker));
  };
}
