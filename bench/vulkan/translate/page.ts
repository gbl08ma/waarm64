// The page of VK0's arm 3 (bench/vulkan/webgpu.ts --arm3 drives it): the replay runs in a worker; the page passes the
// runner's calls on as `window.vk0`.
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
    init: (url: string, noImmediates = false) => call('init', { url, noImmediates }),
    run: (s: unknown) => call('run', s),
    dump: (s: unknown, frame: number, image: number) => call('dump', { s, frame, image }),
  },
  crossOriginIsolatedPage: self.crossOriginIsolated,
});

// `?sweep=fish1,fish1000,...`: the page replays each trace (/target/vulkan/captures/<name>-trace) itself and downloads
// the results (the NVIDIA desktop's script, when its headless Chromium doesn't get the GPU). A worker a trace.
const params = new URLSearchParams(location.search);
if (params.has('sweep')) {
  const log = (m: string) => { document.getElementById('log')!.textContent += m + '\n'; };
  (async () => {
    const results: unknown[] = [];
    for (const name of (params.get('sweep') ?? '').split(',').filter(Boolean)) {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      const ask = (op: string, args: unknown) => new Promise<unknown>((resolve, reject) => {
        w.onmessage = (e: MessageEvent<{ result?: unknown; error?: string; log?: string }>) => {
          if (e.data.log !== undefined) return;
          if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data.result);
        };
        w.postMessage({ id: 0, op, args });
      });
      try {
        const adapter = await ask('init', { url: `/target/vulkan/captures/${name}-trace` });
        const r = (await ask('run', { warmup: 60, samples: 10, frames: 60, inFlight: 2, gpuFrames: 0 })) as { frameMs: number[] };
        const med = [...r.frameMs].sort((a, b) => a - b)[r.frameMs.length >> 1];
        results.push({ name, adapter, ...r });
        log(`${name}: ${med.toFixed(3)} ms a frame`);
      } catch (e) {
        log(`${name}: ${(e as Error).message.split('\n')[0]}`);
      }
      w.terminate();
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ arm: 'translated', userAgent: navigator.userAgent, date: new Date().toISOString(), results }, null, 1)], { type: 'application/json' }));
    a.download = 'vk0-translated-results.json';
    document.body.append(a);
    a.click();
    log('done: vk0-translated-results.json downloaded');
  })();
}
