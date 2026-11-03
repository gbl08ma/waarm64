// The Venus pump's clock (web/venus-host.ts `VenusPoll`, VK4 T13): a worker of its own that, while the pump runs (word 1
// set), sleeps `period` ms in a blocking `Atomics.wait` and then bumps and notifies word 0, which the GPU worker's pump
// waits on with `Atomics.waitAsync` (its own timeout, the pump's old period, only a fallback). Chromium stretches
// `waitAsync`'s timeout to ~1.5 ms on the Mac (0.17–0.47 ms on Linux), and each synchronous Venus call of the guest waits
// a turn, while a blocking wait in a worker turns in ~0.08 ms there at 0.05, and the waiter it notifies keeps that pace
// (bench/vulkan/wake.ts, bench/vulkan/REPORT.md "VK4 T13–T14"). Stopped (word 1 clear), it waits on word 1, waking only
// for the alive bits. The pump never clears word 1 while a turn waits on a tick (venus-host.ts `turn`).
//
// It is also vkr's ring monitor (GD G3): every third of the report period the guest asked (Mesa's 3 s), it sets the
// alive bit of each monitored ring's status word (`alive`: the module's table, vk/glue.c `venus_ring_alive`), whatever
// the GPU worker's thread is doing. A call that holds that thread for seconds (Dawn's createShaderModule of Godot's
// Forward+ shader took 5 s on the GPU process) then reads as a busy renderer to Venus's watchdog in the guest, which
// aborted the program after ~3.5 s without the bit; a renderer gone for good still trips Mesa's own 895 s abort.
type Start = { sab: SharedArrayBuffer; period: number; alive?: { memory: WebAssembly.Memory; table: number } };

/** The alive bit (Venus's `VK_RING_STATUS_ALIVE_BIT_MESA`) and how often it's set at most (ms) whatever the period asked. */
const ALIVE_BIT = 4, ALIVE_MIN_MS = 10;

/**
 * Sets the alive bit of the table's rings, under its lock (vkr holds it while it changes the table, so no word is written
 * after its ring is gone). Returns the next pause (ms), or undefined if vkr held the lock (tried again at the next wake).
 */
export function setAlive(memory: WebAssembly.Memory, table: number): number | undefined {
  const u = new Uint32Array(memory.buffer), at = table >>> 2;
  if (Atomics.compareExchange(u, at, 0, 1) !== 0) return undefined;
  const periodUs = u[at + 1], n = u[at + 2];
  for (let i = 0; i < n; i++) Atomics.or(u, u[at + 3 + i] >>> 2, ALIVE_BIT);
  Atomics.store(u, at, 0);
  // No ring asks yet: looked at again at the default's pace (Mesa's 3 s).
  return Math.max(ALIVE_MIN_MS, (periodUs || 3_000_000) / 3000);
}

// (On globalThis: imported in Node, tests/venus-ticker.test.ts, the module defines `setAlive` and nothing runs.)
(globalThis as { onmessage?: unknown }).onmessage = (e: MessageEvent<Start>) => {
  const { sab, period, alive } = e.data;
  const w = new Int32Array(sab), sleep = new Int32Array(new SharedArrayBuffer(4));
  let every = 1000, last = -Infinity;
  for (;;) {
    if (alive) {
      const now = performance.now();
      if (now - last >= every) {
        const next = setAlive(alive.memory, alive.table);
        if (next !== undefined) [every, last] = [next, now];
      }
    }
    if (!Atomics.load(w, 1)) {
      Atomics.wait(w, 1, 0, alive ? every : Infinity);
      continue;
    }
    Atomics.wait(sleep, 0, 0, period);
    Atomics.add(w, 0, 1);
    Atomics.notify(w, 0);
  }
};
