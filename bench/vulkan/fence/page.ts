// VK3 L2's round trips (bench/vulkan/fence.ts): runs worker.ts in a dedicated worker, as the GPU worker is one, and
// returns what it measured. L2b: the worker can ask the page to draw with WebGL meanwhile (`{ webgl: true }`): a
// 1080p canvas cleared and drawn every animation frame, the GPU process's GL work beside Dawn's, as the page's screen.
let gl: { stop(): void } | undefined;
function webgl() {
  const c = document.createElement('canvas');
  c.width = 1920;
  c.height = 1080;
  c.style.width = '480px';
  document.body.append(c);
  const g = c.getContext('webgl2')!;
  let on = true;
  const draw = () => {
    if (!on) return;
    g.clearColor(Math.random(), 0.5, 0.5, 1);
    g.clear(g.COLOR_BUFFER_BIT);
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
  return { stop() { on = false; c.remove(); } };
}

export function run(n: number) {
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  return new Promise<unknown>((resolve) => {
    w.onmessage = (m) => {
      if (m.data && typeof m.data.webgl === 'boolean') {
        gl?.stop();
        gl = m.data.webgl ? webgl() : undefined;
        (m.ports[0] as MessagePort).postMessage(0);
        return;
      }
      resolve(m.data);
      w.terminate();
    };
    w.onerror = (e) => { resolve({ error: e.message }); w.terminate(); };
    w.postMessage({ n });
  });
}
