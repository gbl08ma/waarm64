// The benchmarks' and tests' calls on `window` (web/app/hooks.ts; `?displaystats`, `?snd=`, `?iostats`): the guest
// PC sampler, the vCPU timeline, the core's heap, the serial log, the GPU worker's stall and Venus's skips, the 3D
// screen's read-back, the disks' timers.
import type { PageAudio } from '../../audio.ts';
import type { ToGpuWorker } from '../../gpu-worker.ts';
import type { SerialTerminal } from '../areas/serial-terminal.ts';
import type { Grab } from '../hooks.ts';
import type { ToWorker } from '../protocol.ts';
import { benchHooks, params } from './knobs.ts';
import type { PageMachine } from './page-machine.svelte.ts';
import type { Replies } from './replies.ts';

export function installBenchHooks(m: PageMachine, terminal: SerialTerminal, grabs: Replies<Grab>, audio: PageAudio) {
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
  const post = (msg: ToWorker) => m.run?.worker.postMessage(msg);
  const gpu = (msg: ToGpuWorker) => m.run?.gpu?.postMessage(msg);
  window.__webpcProfile = (on) => post({ type: 'profile', on });
  window.__webpcTimeline = (on) => post({ type: 'timeline', on });
  window.__serialLog = () => terminal.log;
  window.__webpcHeap = () => post({ type: 'heap' });
  window.__webpcStallGpu = (ms) => gpu({ type: 'stall', ms });
  window.__webpcVkSkip = (paths) => gpu({ type: 'vkskip', skip: paths });
  window.__webpcGrab = () => {
    const w = m.run?.gpu;
    if (!w) return Promise.resolve({ width: 0, height: 0, pixels: new Uint8Array(0) });
    return grabs.ask((id) => w.postMessage({ type: 'grab', id } satisfies ToGpuWorker));
  };
}
