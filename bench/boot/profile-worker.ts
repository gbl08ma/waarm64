// Boots twice to warm up, then once with the PC sampler running.
import { startSampler } from '../../web/profiler.ts';
import { boot, images } from './suite.ts';

try {
  const img = await images();
  const module = await WebAssembly.compile(img.wasm);
  for (let i = 0; i < 2; i++) await boot(module, img);
  let stop: (() => Promise<[string, number][]>) | undefined;
  const r = await boot(module, img, async (vm) => {
    stop = await startSampler(vm.memory, vm.counters);
  });
  self.postMessage({ totalMs: r.total, stats: r.stats, samples: await stop!(), userAgent: navigator.userAgent });
} catch (e) {
  self.postMessage({ error: String((e as Error).stack ?? e) });
}
