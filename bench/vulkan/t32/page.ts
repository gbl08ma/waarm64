// The page of VK4 T32's suite (suite.ts): the suite in a worker (bench/spike/worker.ts, as bench/run.ts's pages run
// theirs), the result as `window.benchResult` for bench/run.ts.
const params = new URLSearchParams(location.search);
const log = document.getElementById('log')!;
const worker = new Worker(new URL('../../spike/worker.ts', import.meta.url), { type: 'module', name: location.search });
worker.onmessage = (e: MessageEvent) => {
  if (e.data.log) { log.textContent += e.data.log + '\n'; return; }
  Object.assign(window, { benchResult: e.data });
};
worker.onerror = (e) => Object.assign(window, { benchResult: { error: e.message } });
worker.postMessage({ quick: params.has('quick'), only: params.get('only'), suite: '../vulkan/t32/suite.ts' });
