// VK3 L3 (bench/vulkan/pipelines.ts): N new render pipelines made in a worker either way WebGPU offers, then one
// submit drawing with each, timed until done: createRenderPipeline one after the other (what web/venus-gpu.ts did) or
// createRenderPipelineAsync all at once. Meanwhile this page's main thread times WebGL round trips (a 1-pixel
// readPixels) to see whether the GPU process stops serving other work while it compiles.
type Row = { median: number; p90: number; max: number; n: number };
const stat = (v: number[]): Row => {
  const s = [...v].sort((a, b) => a - b);
  const q = (p: number) => s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
  return { median: +q(0.5).toFixed(2), p90: +q(0.9).toFixed(2), max: +(s.at(-1) ?? 0).toFixed(2), n: s.length };
};

const gl = (document.getElementById('gl') as HTMLCanvasElement).getContext('webgl2')!;
const px = new Uint8Array(4);
function ping() {
  const t = performance.now();
  gl.clearColor(Math.random(), 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return performance.now() - t;
}

/** One arm: `mode` sync or async, `n` pipelines of shaders unique to `seed`. */
export async function run(mode: 'sync' | 'async', n: number, seed: number, size: number) {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const pings: number[] = [];
  let busy = true;
  const pinger = (async () => {
    while (busy) {
      pings.push(ping());
      await new Promise((r) => setTimeout(r, 4));
    }
  })();
  const res = await new Promise<Record<string, unknown>>((resolve) => {
    worker.onmessage = (e) => resolve(e.data);
    worker.postMessage({ mode, n, seed, size });
  });
  busy = false;
  await pinger;
  worker.terminate();
  return { ...res, webgl: stat(pings) };
}
