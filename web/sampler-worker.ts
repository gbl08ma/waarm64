// Guest PC sampler (docs/benchmarking.md): runs beside the vCPU worker on the same shared
// memory and reads `vm::Counters.pc` (updated every run-loop chunk) every
// `periodUs` until ctl[0] is set; replies with a histogram of PCs.
type Start = { memory: WebAssembly.Memory; pcAddrs: number[]; ctl: SharedArrayBuffer; periodUs: number };

self.onmessage = (e: MessageEvent<Start>) => {
  const { memory, pcAddrs, ctl, periodUs } = e.data;
  const flag = new Int32Array(ctl);
  const hist = new Map<bigint, number>();
  const views = () => pcAddrs.map((a) => new BigUint64Array(memory.buffer, a, 1));
  let vs = views();
  Atomics.store(flag, 1, 1); // started
  Atomics.notify(flag, 1);
  while (Atomics.load(flag, 0) === 0) {
    if (vs[0].buffer.byteLength !== memory.buffer.byteLength) vs = views();
    for (const v of vs) {
      const pc = Atomics.load(v, 0);
      hist.set(pc, (hist.get(pc) ?? 0) + 1);
    }
    const until = performance.now() + periodUs / 1000;
    while (performance.now() < until);
  }
  self.postMessage([...hist].map(([pc, n]) => [pc.toString(16), n]));
};
