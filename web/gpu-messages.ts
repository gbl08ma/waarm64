// The GPU worker's messages (web/gpu-worker.ts): the page's to it, and its answers and reports.
import type { GpuWorkerKnobs } from './gpu-knobs.ts';
import type { VenusGpuStats } from './venus-gpu.ts';
import type { VenusEmul, VenusTimes } from './venus-host.ts';
import type { ShareCheck } from './venus-share.ts';
import type { VideoStats, VideoStream } from './virgl-video.ts';

/** Page → GPU worker. */
export type ToGpuWorker =
  | { type: 'snapshotBytes'; id: number }
  | /** Test hook (`window.__waarm64StallGpu`): the worker's thread blocked `ms`, as in a long GPU-process call. */ {
      type: 'stall';
      ms: number;
    }
  | /** Bench hook (`window.__waarm64Grab`): the screen drawn now and read back, top row first, RGBA. */ {
      type: 'grab';
      id: number;
    }
  | /** Bench hook (`window.__waarm64VkSkip`, VK4 T23): the Venus renderer's emulated work left out from now (web/venus-host.ts `skip`). */ {
      type: 'vkskip';
      skip: string[];
    }
  | ({ type: 'init'; canvas: OffscreenCanvas; port: MessagePort } & GpuWorkerKnobs);

/** GPU worker → page. */
export type FromGpuWorker =
  | { type: 'ready'; caps: Uint8Array; renderer: string }
  /** The bytes a snapshot would hold for the 3D resources, before compression (`VirglRenderer.snapshotBytes`): Save snapshot warns past a size. */
  | { type: 'snapshotBytes'; id: number; bytes: number }
  | { type: 'grab'; id: number; width: number; height: number; pixels: Uint8Array }
  | { type: 'failed'; reason: string }
  | { type: 'lost' }
  /** With `probe`: a present turned the screen's centre bright, at `t` (ms since the epoch). */
  | { type: 'flash'; t: number }
  /**
   * Always, once a second from `ready` on (the first with it): totals since the worker started (rates are the page's)
   * and what is in use now (the page's status bar). The worker exists only on a 3D machine, so this is WebGL2 with
   * virgl. `renderer` and `vendor` are WebGL's (unmasked where the browser gives them), `software` whether the renderer
   * is a CPU rasterizer (SwiftShader, llvmpipe). `presents` are the screen's draws (at most one a display frame: a
   * guest's flip, whatever it took); `submits` the guest's command buffers, `commands` the virgl commands in them,
   * `draws` the GL draws they made, `errors` the renderer's (video's among them). `video` is off (`enabled: false`) with
   * `?gpu=novideo` or where WebCodecs decodes none of the codecs; `offered` the codecs the guest was told of and which
   * are decoded in hardware; `streams` the guest's decoding contexts now (web/virgl-video.ts `VideoStream`); `frames`
   * the pictures the guest sent, `decoded` those written back, `dropped` those given up, `errors` the video errors and
   * `decoderErrors` the decoders' own (of `errors`).
   */
  | {
      type: 'stats';
      renderer: string;
      vendor: string;
      software: boolean;
      presents: number;
      submits: number;
      commands: number;
      draws: number;
      errors: number;
      video: GpuVideoStats;
      vulkan?: VulkanReport;
    }
  | RenderStats;

/** With `stats`, once a second: what the renderer did and the time it took (bench/gpu, `?displaystats`). */
export type RenderStats = {
  type: 'render-stats';
  submits: number;
  draws: number;
  commands: number;
  busyMs: number;
  submitMs: number;
  presents: number;
  presentAt: number[];
  drawMs: number;
  programs: number;
  errors: number;
  uploadBytes: number;
  readbacks: number;
  readbackBytes: number;
  fences: number;
  fenceMs: number;
  fenceMaxMs: number;
  compileMs: number;
  /** Vulkan's frames copied into virgl's textures (web/venus-share.ts) and the thread's ms for them, in the second. */ shareRefreshes: number;
  shareMs: number;
  /** Virgl's resources written into Vulkan's textures imported from them (web/venus-import.ts): binds, of them those that made a texture, pictures, bytes and the thread's ms, in the second. */ importBinds: number;
  importMade: number;
  importPictures: number;
  importBytes: number;
  importMs: number;
  /** Textures Venus's driver made in the second (web/venus-gpu.ts `stats.textures`: an image bound to imported memory makes none, VK4 T48). */ venusTextures: number;
  /** How Vulkan's frames reach virgl now, and where the check of a GPU way stands (web/venus-share.ts). */ share?: ShareCheck & {
    checks: number;
    checksWrong: number;
    unshared: number;
    /** Prime blits' frames copied from their buffers (GD G7), in all. */ fromBuffers: number;
  };
  /** Venus's fences' way back in the second (web/venus-host.ts `VenusTimes`). */ venus?: VenusTimes;
  /** The Venus calls that asked for a reply in the second, and every command of the virtqueue's, by name (web/venus-host.ts `calls`). */ venusCalls?: Record<
    string,
    number
  >;
  /** What the emulated paths did in the second (web/venus-host.ts `emul`, VK4 T23). */ venusEmul?: VenusEmul;
  /** Venus's pipeline totals since it started (`venusPipelines`, VK3 L3). */ venusPipelines?: ReturnType<
    typeof venusPipelines
  > & {
    /** The store's bytes stored (deflated) and held in memory, and the ms its lookups took inflating (web/venus-cache.ts). */ cacheBytes: number;
    cacheHeld: number;
    cacheEntries: number;
    cacheInflateMs: number;
  };
  /** The renderer's video totals since it started (web/virgl-video.ts `VideoStats`), how many calls ran ahead of ones waiting for pictures, and the longest wait (ms) in the second (`latencyMaxMs` too is the second's). */ video: VideoStats & {
    ahead: number;
    maxWaitMs: number;
  };
  /** The occlusion queries' polls in the second, and the ms some were pending (`QueryPoll`). */ queryPolls: number;
  queryPendingMs: number;
};

/** The video part of `stats`. */
export type GpuVideoStats = {
  enabled: boolean;
  offered: { profile: string; hardware: boolean }[];
  streams: VideoStream[];
  frames: number;
  decoded: number;
  dropped: number;
  errors: number;
  decoderErrors: number;
};

/**
 * A Vulkan machine's Venus, for the status bar: the guest's Venus contexts now (one a Vulkan instance: a program holding
 * a device, roughly), the WebGPU submits and draws since it started, the adapter it draws on (`software` for a fallback
 * or SwiftShader), `device` false where the browser gave it none (Vulkan then draws nothing).
 */
export type VulkanReport = {
  contexts: number;
  submits: number;
  draws: number;
  device: boolean;
  adapter?: string;
  software?: boolean;
};

/** Venus's pipelines so far (totals; VK3 L3): made, made asynchronously and ready (and their ms), submits held for them
 * (and their ms), made at once by a submit, vkCreate*Pipelines calls in the module and their ms, the shader store's
 * lookups found and missed and its stores. bench/vulkan/venus-run.ts takes a replay's difference. */
export function venusPipelines(g: VenusGpuStats) {
  return {
    pipelines: g.pipelines,
    ready: g.pipelinesReady,
    readyMs: g.pipelineReadyMs,
    deferred: g.deferred,
    deferredMs: g.deferredMs,
    syncPipelines: g.syncPipelines,
    premade: g.premade,
    premadeUsed: g.premadeUsed,
    translations: g.translations,
    translateMs: g.translateMs,
    cacheHits: g.cacheHits,
    cacheMisses: g.cacheMisses,
    cacheStores: g.cacheStores,
  };
}
