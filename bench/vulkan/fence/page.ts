// VK3 L2's round trips (bench/vulkan/fence.ts): runs worker.ts in a dedicated worker, as the GPU worker is one, and
// returns what it measured.
export function run(n: number) {
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  return new Promise<unknown>((resolve) => {
    w.onmessage = (m) => { resolve(m.data); w.terminate(); };
    w.onerror = (e) => { resolve({ error: e.message }); w.terminate(); };
    w.postMessage({ n });
  });
}
