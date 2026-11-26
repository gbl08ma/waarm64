// The machine worker's development knobs (docs/frontend.md "Query parameters"): measurements', tests' and A/Bs' switches
// in the page's address, parsed once on the page into the start message's `dev` (web/app/protocol.ts), so the worker
// reads no query. Their spellings are the address's: bench/, the dEQP runs and the tests use them.

/** The machine worker's knobs from the address. */
export type DevKnobs = {
  /**
   * The display's tuning (docs/devices.md "virtio-gpu"), from `?gpu=`: flush replies paced to the frame (`nopace`
   * turns it off) and a queue of 16 (`q<N>`); `virgl-null` virgl on the null renderer (G2: the guest's 3D commands
   * counted, nothing drawn); `capture` a trace of them on the display port (web/virgl-trace.ts, kept in
   * `window.__virglCapture`); `nowatch` (with Vulkan) no write-watch of the window at each submit; `canvas2d` and
   * `gl2d` a 2D machine's screen (web/gpu-present.ts; by default WebGL2 on a GPU, a 2D context elsewhere).
   */
  gpu: {
    paceFlushes: boolean;
    queueSize: number;
    virglNull: boolean;
    noWatch: boolean;
    capture: boolean;
    screen2d: 'canvas2d' | 'webgl2' | 'auto';
  };
  /**
   * The sound's measurements (docs/audio.md "Measurements"), from `?snd=`: `timer` completes played messages on a timer
   * instead of the worklet's notify, `stats` posts their timing once a second (kept in `window.__sndStats`).
   */
  snd: { wake: 'timer' | 'worklet'; stats: boolean };
  /** The JIT compiles in its compile worker (`?jit=nocw` turns it off: an A/B). */
  compileWorker: boolean;
  /** The JIT's FMA forms on the host's fused `madd` (`?fma=emul` forces their emulation; web/vm.ts `BootOptions.fma`). */
  fma: boolean;
  /** The core's memory imported at its size (`?growcore`: growable, web/core.ts `exactCore`; an A/B). */
  exactCore: boolean;
  /** `?vyield=<ms>`: the vCPU workers' yield (web/vm.ts `vcpuYieldMs`); none: the default. */
  vcpuYieldMs?: number;
  /** `?vspin=<µs>`: an idle vCPU worker's poll before it sleeps (web/vm.ts `vcpuSpinUs`); none: the default. */
  vcpuSpinUs?: number;
  /** `?sharesasync=<name>,…` (tests, measurements): folders in the browser served as a folder on the computer is. */
  sharesAsync: string[];
  /** The display reports its draw latencies (`draw-stats`, kept in `window.__drawStats`; `?displaystats`, bench/gpu). */
  displayStats: boolean;
  /** The disks keep stage timers and a trace of their base reads (the `waarm64-iostats` channel; `?iostats`, bench/remote-disk). */
  ioStats: boolean;
  /** A remote disk's blocks aren't kept in OPFS (`?diskcache=0`: bench/remote-disk's A/B). */
  noDiskCache: boolean;
  /** The display posts `flash` when a draw turns the screen's centre bright (`?avprobe`: bench/audio/avsync.ts). */
  avProbe: boolean;
  /**
   * Only the guest's own signs say the machine is up (systemd's READY=1, the clipboard agent's HELLO), not its serial
   * ready marker (`?ready=guest`: the tests' check of those signs, docs/devices.md "vsock").
   */
  guestReadyOnly: boolean;
  /**
   * The guest agent's end played by the page's tests (`?agentstub`, tests/page-clipboard-ui.test.ts): the link's channel
   * on any machine, its device end kept on the page (`window.__agentStub`) instead of the worker's vsock.
   */
  agentStub: boolean;
  /**
   * The room a file save's staging file assumes, bytes, instead of the storage's estimate (`?stageroom=<MiB>`: the
   * tests' "no room", docs/frontend.md "Snapshots").
   */
  stageRoom?: number;
};

/** The machine worker's knobs from the page's query. */
export function parseDevKnobs(q: URLSearchParams): DevKnobs {
  const gpu = (q.get('gpu') ?? '').split(',');
  const queue = gpu.find((k) => /^q\d+$/.test(k));
  const snd = (q.get('snd') ?? '').split(',');
  return {
    gpu: {
      paceFlushes: !gpu.includes('nopace'),
      queueSize: queue ? Number(queue.slice(1)) : 16,
      virglNull: gpu.includes('virgl-null'),
      noWatch: gpu.includes('nowatch'),
      capture: gpu.includes('capture'),
      screen2d: gpu.includes('canvas2d') ? 'canvas2d' : gpu.includes('gl2d') ? 'webgl2' : 'auto',
    },
    snd: { wake: snd.includes('timer') ? 'timer' : 'worklet', stats: snd.includes('stats') },
    compileWorker: q.get('jit') !== 'nocw',
    fma: q.get('fma') !== 'emul',
    exactCore: !q.has('growcore'),
    vcpuYieldMs: q.has('vyield') ? Number(q.get('vyield')) : undefined,
    vcpuSpinUs: q.has('vspin') ? Number(q.get('vspin')) : undefined,
    sharesAsync: (q.get('sharesasync') ?? '').split(','),
    displayStats: q.has('displaystats'),
    ioStats: q.has('iostats'),
    noDiskCache: q.get('diskcache') === '0',
    avProbe: q.has('avprobe'),
    guestReadyOnly: q.get('ready') === 'guest',
    agentStub: q.has('agentstub'),
    stageRoom: q.has('stageroom') ? Number(q.get('stageroom')) * 2 ** 20 : undefined,
  };
}
