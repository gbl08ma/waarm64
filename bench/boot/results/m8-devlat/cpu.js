// The vCPU side: rings word 0, waits for word 1 (spin: polls 50 µs first, as web/vcpu-worker.ts idles).
self.onmessage = (e) => {
  const { sab, mode, n } = e.data;
  const b = new Int32Array(sab);
  const t = new Float64Array(n);
  for (let i = 1; i <= n + 200; i++) {
    const t0 = performance.now();
    Atomics.store(b, 0, i); Atomics.notify(b, 0);
    const s = performance.now();
    while (Atomics.load(b, 1) !== i) {
      if (mode === 'spin' && performance.now() - s < 0.05) continue;
      Atomics.wait(b, 1, Atomics.load(b, 1) === i ? i : Atomics.load(b, 1), 10);
    }
    if (i > 200) t[i - 201] = (performance.now() - t0) * 1000;
  }
  t.sort();
  postMessage({ p50: t[n >> 1], p90: t[Math.floor(n * 0.9)] });
};
