// The Venus pump's clock (web/venus-host.ts `VenusPoll`, VK4 T13): a worker of its own that, while the pump runs (word 1
// set), sleeps `period` ms in a blocking `Atomics.wait` and then bumps and notifies word 0, which the GPU worker's pump
// waits on with `Atomics.waitAsync` (its own timeout, the pump's old period, only a fallback). Chromium stretches
// `waitAsync`'s timeout to ~1.5 ms on the Mac (0.17–0.47 ms on Linux), and each synchronous Venus call of the guest waits
// a turn, while a blocking wait in a worker turns in ~0.08 ms there at 0.05, and the waiter it notifies keeps that pace
// (bench/vulkan/wake.ts, bench/vulkan/REPORT.md "VK4 T13–T14"). Stopped (word 1 clear), it waits on word 1 and costs
// nothing. The pump never clears word 1 while a turn waits on a tick (venus-host.ts `turn`).
type Start = { sab: SharedArrayBuffer; period: number };

onmessage = (e: MessageEvent<Start>) => {
  const w = new Int32Array(e.data.sab), sleep = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    Atomics.wait(w, 1, 0);
    Atomics.wait(sleep, 0, 0, e.data.period);
    Atomics.add(w, 0, 1);
    Atomics.notify(w, 0);
  }
};
