// Runs bench/io/suite.ts in a dedicated worker with the file chosen in #bench-file (bench/run.ts --input),
// and exposes the result as `window.benchResult`.
const params = new URLSearchParams(location.search);
const log = document.getElementById('log')!;
const input = document.getElementById('bench-file') as HTMLInputElement;
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
worker.onmessage = (e: MessageEvent) => {
  if (e.data.log) log.textContent += e.data.log + '\n';
  else Object.assign(window, { benchResult: e.data });
};
worker.onerror = (e) => Object.assign(window, { benchResult: { error: e.message } });
input.addEventListener('change', () => {
  worker.postMessage({ quick: params.has('quick'), only: params.get('only'), file: input.files![0] });
});
