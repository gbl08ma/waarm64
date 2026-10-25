// The page of VK0's WebGPU arms (bench/vulkan/webgpu.ts drives it): the scene runs in a worker; the page passes the
// runner's calls on as `window.vk0`.
import type { Result, Settings } from './aquarium.ts';

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let next = 0;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string; log?: string }>) => {
  if (e.data.log !== undefined) { console.log(e.data.log); return; }
  const w = waiting.get(e.data.id)!;
  waiting.delete(e.data.id);
  if (e.data.error) w.reject(new Error(e.data.error));
  else w.resolve(e.data.result);
};
const call = (op: string, args: unknown) => new Promise((resolve, reject) => {
  const id = next++;
  waiting.set(id, { resolve, reject });
  worker.postMessage({ id, op, args });
});
Object.assign(window, {
  vk0: {
    init: (packUrl: string, wasmUrl: string) => call('init', { packUrl, wasmUrl }),
    run: (s: Settings) => call('run', s) as Promise<Result>,
    // The frame's pixels as base64 (RGBA rows, top first).
    dump: (s: Settings, frame: number) => call('dump', { s, frame }) as Promise<string>,
  },
  crossOriginIsolatedPage: self.crossOriginIsolated,
});

// `?sweep`: the page runs every setting itself and downloads the results (the NVIDIA desktop's script, when its
// headless Chromium doesn't get the GPU and the user opens the page in their own browser). The settings are the
// runner's defaults; `?sweep=quick` takes fewer frames.
const params = new URLSearchParams(location.search);
if (params.has('sweep')) {
  const log = (m: string) => { document.getElementById('log')!.textContent += m + '\n'; };
  const quick = params.get('sweep') === 'quick';
  const base = { width: 1920, height: 1080, warmup: quick ? 10 : 60, samples: quick ? 3 : 10, frames: quick ? 10 : 60, inFlight: 2, gpuFrames: 20 };
  const settings: (Settings & { name: string })[] = [];
  for (const msaa of [1, 4] as const) {
    for (const fishMode of ['storage', 'dynamic', 'immediates'] as const) {
      for (const fish of [1, 100, 1000, 10000, 30000]) settings.push({ ...base, name: `fish-${fish}-msaa${msaa}-${fishMode}`, fish, toolkit: 0, msaa, fishMode });
    }
    for (const toolkit of [2000, 8000]) settings.push({ ...base, name: `toolkit-${toolkit}-msaa${msaa}`, fish: 0, toolkit, msaa, fishMode: 'storage' });
  }
  (async () => {
    log('loading the scene...');
    const adapter = await call('init', { packUrl: '/target/vulkan/aquarium.pack', wasmUrl: '/target/vulkan/scene.wasm' });
    log(`adapter: ${JSON.stringify(adapter)}`);
    const results: unknown[] = [];
    for (const s of settings) {
      try {
        const r = (await call('run', s)) as Result;
        const med = (v: number[]) => { const x = [...v].sort((a, b) => a - b); return x.length ? x[x.length >> 1] : 0; };
        results.push({ name: s.name, settings: s, ...r });
        log(`${s.name}: ${med(r.frameMs).toFixed(3)} ms a frame, worker ${med(r.jsMs).toFixed(3)} ms, GPU ${med(r.gpuMs).toFixed(3)} ms`);
      } catch (e) {
        log(`${s.name}: ${(e as Error).message.split('\n')[0]}`);
      }
    }
    const blob = new Blob([JSON.stringify({ arm: 'webgpu', userAgent: navigator.userAgent, adapter, date: new Date().toISOString(), results }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'vk0-webgpu-results.json';
    document.body.append(a);
    a.click();
    log('done: vk0-webgpu-results.json downloaded (send it back with the rest)');
  })();
}
