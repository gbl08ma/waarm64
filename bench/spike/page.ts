// Runs the spike in a dedicated worker (where vCPUs will live) and exposes
// the result as `window.benchResult` for bench/run.ts.
const params = new URLSearchParams(location.search);
const log = document.getElementById('log')!;
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
worker.onmessage = (e: MessageEvent) => {
  if (e.data.log) log.textContent += e.data.log + '\n';
  else Object.assign(window, { benchResult: e.data });
};
worker.onerror = (e) => Object.assign(window, { benchResult: { error: e.message } });
// <body data-suite> picks the suite module (relative to worker.ts); default: the M0 spike.
worker.postMessage({ quick: params.has('quick'), only: params.get('only'), suite: document.body.dataset.suite ?? './benchmarks.ts' });
