// Loads the wasm core in a worker on shared memory, as a vCPU worker will.
try {
  const mem = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
  const { instance } = await WebAssembly.instantiateStreaming(fetch('/target/wasm32-unknown-unknown/release/webpc_core.wasm'), { env: { memory: mem } });
  const ex = instance.exports as Record<string, (...a: number[]) => number>;
  const counter = 1 << 20;
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
