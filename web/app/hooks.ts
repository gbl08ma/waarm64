// The page's hooks for tests, benchmarks and tools (docs/testing.md): what they read and call on `window`,
// typed in one place (docs/frontend-code.md §5.4). Most are set only with `?displaystats` or `?snd=` (`benchHooks`).
import type { PageAudio } from '../audio.ts';
import type { AgentLink } from './agent-link.ts';
import type { ClipboardShare } from './clipboard.ts';
import type { PageFolders } from './folders-live.ts';
import type { FromWorker, Status } from './protocol.ts';
import type { DisplayToPage } from '../gpu-present.ts';
import type { FromGpuWorker } from '../gpu-worker.ts';

/** The 3D screen read back (RGBA, top row first). */
export type Grab = { width: number; height: number; pixels: Uint8Array };

declare global {
  interface Window {
    /** The last status (bench/stress, the benchmarks). */
    __status?: Status;
    /** The guest PC sampler's histogram, the vCPU timeline, the core's heap: the answers to the calls below. */
    __profile?: Extract<FromWorker, { type: 'profile' }>['samples'];
    __timeline?: Extract<FromWorker, { type: 'timeline' }>['timeline'];
    __heap?: Extract<FromWorker, { type: 'heap' }>['heap'];
    __webpcProfile?: (on: boolean) => void;
    __webpcTimeline?: (on: boolean) => void;
    __webpcHeap?: () => void;
    /** The serial console's output so far. */
    __serialLog?: () => string;
    /** The GPU worker's thread blocked `ms` (tests/page-venus.test.ts). */
    __webpcStallGpu?: (ms: number) => void;
    /** The Venus renderer's emulated work left out (bench/vulkan/t23.ts). */
    __webpcVkSkip?: (paths: string[]) => void;
    /** The 3D screen as the page draws it (bench/vulkan/present.ts). */
    __webpcGrab?: () => Promise<Grab>;
    /** `?iostats`: the disks' timers and base-read traces (web/iostats.ts). */
    __ioStats?: () => Promise<unknown>;
    /** `?avprobe`: when the screen's centre turned bright (ms on this page's clock; bench/audio/avsync.ts). */
    __flashes?: number[];
    /** `?displaystats`: the display's and the GPU worker's reports, and the device's events and presents in them. */
    __drawStats?: Extract<DisplayToPage, { type: 'draw-stats' }>[];
    __devEvents?: number[];
    __renderStats?: Extract<FromGpuWorker, { type: 'render-stats' }>[];
    __presents?: number[];
    /** A virgl trace's records (web/virgl-trace.ts). */
    __virglCapture?: Uint8Array[];
    /** The running machine's clipboard agent link and sharing (the clipboard tests). */
    __agent?: AgentLink;
    __clipboard?: ClipboardShare;
    /** `?snd=`: the page's sound (tests and measurements). */
    __audio?: PageAudio;
    /** The page's live folders (tools/screens.ts). */
    __folders?: PageFolders;
  }
}
