// VK1 step 1 in Chromium (run.ts --chromium drives it): spike.wasm and the stages fetched from /target/vk1/, run by
// spike.ts's protocol in a worker-free page (the same V8 the GPU worker would be), the results handed back.
import { loadSpike, nirHashes, runAll } from './spike.ts';

Object.assign(window, {
  vk1: async (wasm: string, files: string[], reps: number) => {
    const t0 = performance.now();
    const bytes = await (await fetch(wasm)).arrayBuffer();
    const t1 = performance.now();
    const module = await WebAssembly.compile(bytes);
    const t2 = performance.now();
    const spike = await loadSpike(module);
    const t3 = performance.now();
    const stages = await Promise.all(files.map(async (name) => ({ name, words: new Uint8Array(await (await fetch(name)).arrayBuffer()) })));
    const passes = runAll(spike, stages, reps);
    const nir = nirHashes(spike, stages);
    return { nir, fetchMs: t1 - t0, compileMs: t2 - t1, instantiateMs: t3 - t2, memoryBytes: spike.memoryBytes(), passes, userAgent: navigator.userAgent };
  },
});
