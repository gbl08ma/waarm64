// One arm of a paired A/B (bench/ab.ts): its worker (bench/boot/pair.ts) stays alive between samples, and
// `window.pairSample(workload)` runs one. The page's query goes along as the worker's name (bench/spike/page.ts).
const log = document.getElementById('log')!;
const worker = new Worker(new URL('./pair.ts', import.meta.url), { type: 'module', name: location.search });
const waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
let next = 0;
const failAll = (e: Error) => { for (const w of waiting.values()) w.fail(e); waiting.clear(); };
worker.onmessage = (e: MessageEvent<{ log?: string; id?: number; result?: unknown; error?: string }>) => {
  if (e.data.log !== undefined) { log.textContent += e.data.log + '\n'; return; }
  const w = waiting.get(e.data.id!);
  waiting.delete(e.data.id!);
  if (e.data.error) w?.fail(new Error(e.data.error));
  else w?.ok(e.data.result);
};
worker.onerror = (e) => failAll(new Error(`the arm's worker failed: ${e.message}`));
Object.assign(window, {
  pairSample: (workload: string) => new Promise((ok, fail) => { waiting.set(next, { ok, fail }); worker.postMessage({ id: next++, workload }); }),
  pairIsolated: crossOriginIsolated,
});
