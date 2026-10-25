// The page of VK0's C, E and F suite: the suite in a worker (bench/spike/worker.ts, as bench/run.ts's pages run theirs),
// the result as `window.benchResult` for the runners (bench/run.ts, bench/vulkan/micro.ts) and, with `?download`,
// downloaded as vk0-micro-results.json (the NVIDIA desktop's script, in the user's own Chromium).
const params = new URLSearchParams(location.search);
const log = document.getElementById('log')!;
const worker = new Worker(new URL('../../spike/worker.ts', import.meta.url), { type: 'module', name: location.search });
worker.onmessage = (e: MessageEvent) => {
  if (e.data.log) { log.textContent += e.data.log + '\n'; return; }
  Object.assign(window, { benchResult: e.data });
  if (params.has('download')) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ ...e.data, date: new Date().toISOString() }, null, 1)], { type: 'application/json' }));
    a.download = 'vk0-micro-results.json';
    document.body.append(a);
    a.click();
    log.textContent += 'done: vk0-micro-results.json downloaded\n';
  }
};
worker.onerror = (e) => Object.assign(window, { benchResult: { error: e.message } });
worker.postMessage({ quick: params.has('quick'), only: params.get('only'), suite: '../vulkan/micro/suite.ts' });
