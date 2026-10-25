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
