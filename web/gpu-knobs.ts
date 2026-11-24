// The GPU worker's knobs (web/gpu-worker.ts `init`): the page's address as the GPU worker takes it, parsed once on the
// page (`parseGpuKnobs`) so the worker reads no query. `?gpu=` is a comma list of knobs; the page's own (`2d`, `virgl`,
// `vulkan`) and the machine worker's (web/app/run/dev-knobs.ts) are in the same list and ignored here.
import type { ShareMode } from './venus-share.ts';
import type { VenusPoll } from './venus-host.ts';
import type { QueryPoll } from './virgl-host.ts';

/** What the GPU worker's `init` takes besides the canvas and the port. */
export type GpuWorkerKnobs = {
  /** `?displaystats`: `render-stats` once a second (bench/gpu). */
  stats?: boolean;
  /** `?gpu=debug`: the renderer's trace on the console, each line once. */
  debug?: boolean;
  /** `?gpu=checkprograms`: the renderer reads every part of a draw's program key again and refuses the draw whose kept one is stale (web/virgl-renderer.ts `checkPrograms`; tests, dEQP runs). */
  checkPrograms?: boolean;
  /** `?avprobe`: `flash` when a present turns the screen's centre bright (bench/audio/avsync.ts). */
  probe?: boolean;
  /** Advertise the browser's video decoders and decode with them (docs/graphics.md "Video"; the page's default, `?gpu=novideo` turns it off). */
  video?: boolean;
  /** `?gpu=swvideo`: every codec decoded in software, H.264 offered (experiments on a host with hardware decoders). */
  softwareVideo?: boolean;
  /** `?gpu=waitattached`: a submit waits while its context has any pending picture's plane attached, not only one it can touch (web/virgl-renderer.ts `submitTouches`; A/B). */
  waitAttached?: boolean;
  /** `?gpu=vkbitmap`, `vkcanvas` or `vkreadback`: how Vulkan's frames reach virgl (web/venus-share.ts), that way only, instead of the probe's choice and the check's fallbacks. */
  vkShare?: ShareMode;
  /** `?gpu=vkbreak=<way>` (tests): that way's copies come out black, and the GPU ways are tried even where the page renders in software. */
  vkBreak?: ShareMode[];
  /** `?gpu=vkvendor=<maker>` (e.g. `nvidia`): the adapter's maker as the Vulkan device takes it (web/venus-caps.ts `VENDORS`; tests). */
  vkVendor?: string;
  /** `?gpu=vkpoll=timeout` or `vkpoll=pump`: Venus polls its rings an older way, the default being the pump on a ticker worker (web/venus-host.ts `VenusPoll`; A/B). */
  vkPoll?: VenusPoll;
  /** `?gpu=vkpipelines=sync`: Venus's pipelines made at once, not asynchronously (web/venus-gpu.ts; A/B). */
  vkSyncPipelines?: boolean;
  /** `?gpu=vkpipedelay=<ms>`: each Venus pipeline made asynchronously is ready that much later (web/venus-gpu.ts; VK3 L4e: a cold host compile anywhere). */
  vkPipeDelayMs?: number;
  /** `?gpu=vkcache=off`: no shaders kept across runs (web/venus-cache.ts; A/B, cold runs). */
  vkNoCache?: boolean;
  /** The budget of Vulkan's shader store (bytes; the Preferences' `shaderMiB`, web/venus-cache.ts `CACHE_BUDGET` when unset). */
  vkShaderBudget?: number;
  /** `?gpu=vkpremake=on`: render pipelines made at vkCreateGraphicsPipelines too, not only at their first draw (web/venus-host.ts `VenusOptions.premake`; A/B, off by default). */
  vkPremake?: boolean;
  /** `?gpu=vkqueues=<n>`: the Vulkan device's first n queue families (web/venus-host.ts `VenusOptions.queueFamilies`; A/B). */
  vkQueues?: number;
  /** `?gpu=vkimport=rewrite`: each import of a virgl resource gets a texture of its own, written at its bind, as before VK4 T16 (web/venus-import.ts; A/B). */
  vkImportRewrite?: boolean;
  /** `?gpu=vknudge=<ms>`: the pump's nudges at most this often, 0 none (web/venus-host.ts; VK3 L2b's A/B). */
  vkNudgeMs?: number;
  /** `?gpu=vkgputime`: each Venus submit's passes timed on the GPU (timestamp queries; VK3 L2b). */
  vkGpuTime?: boolean;
  /** `?gpu=vkidle=<ms>`: a Venus ring stays active that long after its last command (web/venus-host.ts `VenusOptions.ringIdleMs`; A/B). */
  vkIdleMs?: number;
  /** `?gpu=vktick=<ms>`: the Venus pump's ticker sleeps that long between turns (web/venus-host.ts `VenusOptions.tickMs`; A/B). */
  vkTickMs?: number;
  /** `?gpu=vkhold=<feature>` (repeatable): an adapter feature the Vulkan device doesn't take (web/venus-caps.ts `gpuFeatures`; A/B). */
  vkHold?: string[];
  /** `?gpu=vkformats=held`: the device doesn't take `HELD_FEATURES` (libplacebo's advanced path off, the default until VK3 L4e; A/B). */
  vkHeldFormats?: boolean;
  /** `?gpu=vkycbcr=off` (false): the Vulkan device without YCbCr conversions and the multi-planar formats (on by default since VK3 L7.3; web/venus-host.ts `VenusOptions.ycbcr`). */
  vkYcbcr?: boolean;
  /** `?gpu=vkl9=<suspect>` (repeatable, `all`): VK3 L9a's suspects back at 4fdc69fb's behaviour (web/venus-caps.ts `L9_SUSPECTS`; the NVIDIA run's A/B). */
  vkL9?: string[];
  /** `?gpu=vkskip=<path>` (repeatable): an emulated path's work left out, wrong pixels and no refused command (web/venus-host.ts `SKIPS`; VK4 T23's A/B). */
  vkSkip?: string[];
  /** `?gpu=capsno=<FORMAT>[+<FORMAT>…]` (repeatable): virgl formats taken out of the caps' masks (web/virgl-caps.ts `withoutFormats`; what the guest chooses, A/B). */
  capsNo?: string[];
  /** `?gpu=capsyes=<BIT>[+<BIT>…]` (repeatable): capability bits offered that the renderer doesn't back (web/virgl-caps.ts `withBits`; an A/B, wrong pixels possible). */
  capsYes?: string[];
  /** `?gpu=querypoll=<way>`: how pending occlusion queries are polled (web/virgl-host.ts `QueryPoll`, `spin` by default; PERF loop 16's A/B). */
  queryPoll?: QueryPoll;
};

/**
 * The GPU worker's knobs from the page's query (`?gpu=`, `?displaystats`, `?avprobe`) and the Preferences' shader
 * budget (MiB; 0 or none: the store's default).
 */
export function parseGpuKnobs(query: URLSearchParams, shaderMiB?: number): GpuWorkerKnobs {
  const list = (query.get('gpu') ?? '').split(',');
  /** The value of knob `prefix…` (the first), and of each. */
  const knob = (prefix: string) => list.find((k) => k.startsWith(prefix))?.slice(prefix.length);
  const knobs = (prefix: string) => list.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  const knobNumber = (prefix: string) => {
    const v = knob(prefix);
    return v === undefined ? undefined : Number(v);
  };
  /** A list knob's items (`+` or space between them), every one given. */
  const knobList = (prefix: string) =>
    knobs(prefix)
      .flatMap((k) => k.split(/[+ ]/))
      .filter(Boolean);
  return {
    stats: query.has('displaystats'),
    debug: list.includes('debug'),
    checkPrograms: list.includes('checkprograms'),
    probe: query.has('avprobe'),
    video: !list.includes('novideo'),
    softwareVideo: list.includes('swvideo'),
    waitAttached: list.includes('waitattached'),
    vkShare: (['readback', 'canvas', 'bitmap'] as const).find((w) => list.includes(`vk${w}`)),
    vkBreak: knobs('vkbreak=') as ShareMode[],
    vkVendor: knob('vkvendor='),
    vkPoll: list.includes('vkpoll=timeout') ? 'timeout' : list.includes('vkpoll=pump') ? 'pump' : undefined,
    vkSyncPipelines: list.includes('vkpipelines=sync'),
    vkPipeDelayMs: knobNumber('vkpipedelay='),
    vkNoCache: list.includes('vkcache=off'),
    vkImportRewrite: list.includes('vkimport=rewrite'),
    vkPremake: list.includes('vkpremake=on'),
    vkQueues: knobNumber('vkqueues='),
    vkShaderBudget: shaderMiB ? shaderMiB * 2 ** 20 : undefined,
    vkNudgeMs: knobNumber('vknudge='),
    vkGpuTime: list.includes('vkgputime'),
    vkTickMs: knobNumber('vktick='),
    vkIdleMs: knobNumber('vkidle='),
    vkHold: knobs('vkhold='),
    vkHeldFormats: list.includes('vkformats=held'),
    vkYcbcr: !list.includes('vkycbcr=off'),
    vkL9: knobs('vkl9='),
    vkSkip: knobs('vkskip='),
    capsNo: knobList('capsno='),
    capsYes: knobList('capsyes='),
    queryPoll: knob('querypoll=') as QueryPoll | undefined,
  };
}
