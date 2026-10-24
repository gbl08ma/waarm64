// Runs the spike in a dedicated worker (where vCPUs will live) and exposes
// the result as `window.benchResult` for bench/run.ts.
const params = new URLSearchParams(location.search);
const log = document.getElementById('log')!;
// The page's query goes along as the worker's name: a suite reads its own switches from it (bench/boot: `nocw`). Not in
// the worker's URL: the dev server would resolve the worker's imports and pick its language from the query too.
const url = new URL('./worker.ts', import.meta.url);
const worker = new Worker(url, { type: 'module', name: location.search });
worker.onmessage = (e: MessageEvent) => {
  if (e.data.log) log.textContent += e.data.log + '\n';
  else Object.assign(window, { benchResult: e.data });
};
worker.onerror = (e) => Object.assign(window, { benchResult: { error: e.message } });
// <body data-suite> picks the suite module (relative to worker.ts); default: the M0 spike.
worker.postMessage({ quick: params.has('quick'), only: params.get('only'), suite: document.body.dataset.suite ?? './benchmarks.ts' });
