// The device side: waits for word 0 to change, answers in word 1.
self.onmessage = async (e) => {
  const { sab, mode } = e.data;
  const b = new Int32Array(sab);
  if (mode === 'asyncbusy') setInterval(() => { const t = performance.now(); while (performance.now() - t < 1); }, 4); // other work on the thread
  for (let seen = 0; ;) {
    const v = Atomics.load(b, 0);
    if (v === seen) {
      if (mode === 'spin') continue;
      if (mode.startsWith('async')) { const w = Atomics.waitAsync(b, 0, seen); if (w.async) await w.value; }
      else Atomics.wait(b, 0, seen);
      continue;
    }
    seen = v;
    Atomics.store(b, 1, v);
    Atomics.notify(b, 1);
  }
};
