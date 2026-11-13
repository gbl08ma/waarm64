// The page's memory signal (docs/jit.md "The page's memory signal", docs/frontend.md "Memory"): what the machine
// costs its tab, accounted from what the emulator knows, and a mark that says a machine was running when its tab
// went away. DOM-free but for `localStorage` (read and written in try/catch: a browser that refuses storage just
// gets no mark).
//
// Why not `performance.measureUserAgentSpecificMemory()`: it charges the shared wasm memory (guest RAM and the core's
// heap) at its whole reserved length once per realm that holds it (the machine worker, every vCPU worker, the
// compile, device and GPU workers: 28.9 GB for a 2.5 GiB guest on 4 vCPUs whose tab used 3-5 GB), counts JS heaps
// only beside that, never V8's wasm code or its metadata (the JIT's cost), and takes up to a minute to answer.

import type { Vm } from '../vm.ts';

/** What the machine worker reads from the core each second (`Vm.hostUse`). */
export type HostUse = ReturnType<Vm['hostUse']>;

/**
 * The renderer's cost per byte of live JIT wasm, measured in headless Chromium 153 (bench/boot/REPORT.md "M8: a
 * machine's JIT budget and the page's memory signal"): V8's code ~4.0×, its C++ metadata ~1.7×, and ~16 KB a module.
 */
export const JIT_CODE_PER_BYTE = 4.0;
export const JIT_META_PER_BYTE = 1.7;
export const JIT_PER_MODULE = 16 << 10;
/** The rest of the tab: Chromium's renderer, the page, the workers' JS heaps (~1.1 GiB on 4 vCPUs at a snapshot's start). */
export const BASE_BYTES = 0.9 * 2 ** 30;
export const BASE_PER_VCPU = 0.05 * 2 ** 30;

/**
 * The tab's memory as the emulator accounts it, bytes, and its parts. Guest RAM counts whole (a guest's page cache
 * fills it over a session; just after a start the tab is up to ~0.9 GiB under this), the core's heap at its
 * high-water mark (its allocator keeps what it frees), the JIT at its live wasm bytes times V8's measured factors.
 */
export function estimate(m: HostUse, ncpus: number) {
  const parts = {
    ram: m.ramBytes,
    heap: m.heapPeak,
    jit: m.jitLiveBytes * (JIT_CODE_PER_BYTE + JIT_META_PER_BYTE) + m.jitModules * JIT_PER_MODULE,
    base: BASE_BYTES + BASE_PER_VCPU * ncpus,
  };
  return { bytes: parts.ram + parts.heap + parts.jit + parts.base, parts };
}

/** How long a flushed epoch's code is counted after the flush: V8 frees it only when its GC collects the instances. */
export const DEAD_MS = 30_000;

/**
 * The estimate over time: `estimate`, plus a flushed epoch's JIT code for `DEAD_MS` after the flush (the renderer
 * peaks then, the old code not yet collected: one 10 s sample of the churn page 3.5 GB over the steady state), and the peak.
 */
export class Signal {
  #epochs = -1;
  #live = { bytes: 0, modules: 0 };
  #dead = { bytes: 0, modules: 0, at: -Infinity };
  peak = 0;
  update(m: HostUse, ncpus: number, now = performance.now()) {
    if (this.#epochs >= 0 && m.jitEpochs !== this.#epochs) this.#dead = { ...this.#live, at: now };
    this.#epochs = m.jitEpochs;
    this.#live = { bytes: m.jitLiveBytes, modules: m.jitModules };
    const dead =
      now - this.#dead.at < DEAD_MS
        ? this.#dead.bytes * (JIT_CODE_PER_BYTE + JIT_META_PER_BYTE) + this.#dead.modules * JIT_PER_MODULE
        : 0;
    const bytes = estimate(m, ncpus).bytes + dead;
    this.peak = Math.max(this.peak, bytes);
    return bytes;
  }
}

/** A running machine's mark: who it was and what it cost when last seen. */
export type Alive = {
  name: string;
  ramMiB: number;
  ncpus: number;
  jitMiB: number;
  gib: number;
  peakGiB: number;
  t: number;
};

const KEY = 'waarm64.alive.';
/** How often a running machine renews its mark, and how old one is when no tab is renewing it. */
export const ALIVE_EVERY_MS = 10_000;
export const ALIVE_STALE_MS = 3 * ALIVE_EVERY_MS;

/** Marks machine `key` (a stored machine's id, or a transient machine's name) as running, as of now. */
export function markAlive(key: string, a: Alive) {
  try {
    localStorage.setItem(KEY + key, JSON.stringify(a));
  } catch {
    /* no mark */
  }
}

/** The machine stopped cleanly (powered off, restarted, shut down, its tab closed): no mark. */
export function clearAlive(key: string) {
  try {
    localStorage.removeItem(KEY + key);
  } catch {
    /* nothing to clear */
  }
}

/**
 * A mark no tab has renewed (`ALIVE_STALE_MS`): the machine was running when its tab went away without a clean
 * stop, most likely killed for memory (Chromium gives a page no out-of-memory error: PLAN.md §4). Undefined otherwise.
 */
export function lastCrash(key: string, now = Date.now()): Alive | undefined {
  try {
    const a = JSON.parse(localStorage.getItem(KEY + key) ?? 'null') as Alive | null;
    return a && now - a.t > ALIVE_STALE_MS ? a : undefined;
  } catch {
    return undefined;
  }
}
