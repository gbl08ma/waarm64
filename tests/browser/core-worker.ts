// Loads the wasm core in a worker on shared memory, as a vCPU worker will.
import { coreImports } from '../../web/core.ts';

try {
  const mem = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
  const { instance } = await WebAssembly.instantiateStreaming(fetch('/target/wasm32-unknown-unknown/release/waarm64_core.wasm'), coreImports(mem));
  const ex = instance.exports as Record<string, (...a: number[]) => number>;
  const counter = mem.grow(1) * 65536; // past the core's own data and stack
  ex.atomic_inc(counter);
  ex.atomic_inc(counter);
  self.postMessage({
    crossOriginIsolated: self.crossOriginIsolated,
    abi: ex.abi_version(),
    counter: Atomics.load(new Uint32Array(mem.buffer), counter / 4),
  });
} catch (e) {
  self.postMessage({ error: String(e) });
}
