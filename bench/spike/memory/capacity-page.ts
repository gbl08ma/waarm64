// M0.5 capacity experiments, page side. capacity.ts drives these through
// page.evaluate(() => cap.<fn>(...)); each returns plain JSON. Needs
// --js-flags=--expose-gc so freed memories can be reclaimed between steps.
import { I32, I64, ModuleBuilder, op } from '../wasm.ts';

export type Desc = { i64?: boolean; initial: number; maximum?: number; shared?: boolean };
export type Err = { name: string; message: string };

const err = (e: unknown): Err => ({ name: (e as Error).name, message: (e as Error).message });
const gc = () => { for (let i = 0; i < 3; i++) (globalThis as unknown as { gc: () => void }).gc(); };

export function mk(d: Desc): WebAssembly.Memory {
  const n = (v: number) => (d.i64 ? BigInt(v) : v);
  return new WebAssembly.Memory({
    initial: n(d.initial), ...(d.maximum !== undefined ? { maximum: n(d.maximum) } : {}), shared: d.shared, ...(d.i64 ? { address: 'i64' } : {}),
  } as unknown as WebAssembly.MemoryDescriptor);
}

/** Writes one byte per 4 KiB page, so the pages become resident. */
export function touch(m: WebAssembly.Memory, offset: number, bytes: number) {
  const u = new Uint8Array(m.buffer);
  for (let o = offset; o < offset + bytes; o += 4096) u[o] = 1;
}

const held = new Map<number, WebAssembly.Memory>();
let nextId = 0;
const workers: Worker[] = [];
let nextCall = 0;

/** Largest `initial` (pages) that allocates, searching down from `hi`. Frees each attempt. */
function maxAlloc(d: Omit<Desc, 'initial'>, hi: number) {
  const tryAlloc = (p: number) => { try { mk({ ...d, initial: p, maximum: d.maximum ?? (d.shared ? p : undefined) }); return null; } catch (e) { return err(e); } finally { gc(); } };
  const first = tryAlloc(hi);
  if (!first) return { pages: hi, bytes: hi * 65536 };
  let lo = 0;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tryAlloc(mid)) hi = mid; else lo = mid; }
  return { pages: lo, bytes: lo * 65536, errorAtLimit: first };
}

function memModule(limits: { min: number; max?: number; shared?: boolean; memory64?: boolean }) {
  const m = new ModuleBuilder();
  m.memory(limits);
  m.exportMemory('mem', 0);
  return m.bytes();
}
function tryModule(limits: Parameters<typeof memModule>[0]) {
  const bytes = memModule(limits);
  const r: Record<string, unknown> = { limits, validates: WebAssembly.validate(bytes) };
  try {
    const mem = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.mem as WebAssembly.Memory;
    r.instantiates = true;
    r.bytes = mem.buffer.byteLength;
  } catch (e) { r.instantiates = false; r.error = err(e); }
  gc();
  return r;
}

const api = {
  /** Per-memory limits: max allocatable size, over-limit errors, declarable maxima, grow. */
  limits() {
    const out: Record<string, unknown> = {};
    for (const i64 of [false, true]) {
      for (const shared of [false, true]) {
        const key = `${i64 ? 'memory64' : 'wasm32'}_${shared ? 'shared' : 'unshared'}`;
        const cap = i64 ? 262144 : 65536; // pages; the engine limits found by probing (see REPORT.md)
        const r: Record<string, unknown> = { maxInitial: maxAlloc({ i64, shared }, cap) };
        try { mk({ i64, shared, initial: 1, maximum: cap + 1 }); r.maxDeclarableJs = 'accepted above engine limit'; } catch (e) { r.overMaximumJs = err(e); }
        try { mk({ i64, shared, initial: cap + 1, maximum: cap + 1 }); } catch (e) { r.overInitialJs = err(e); }
        gc();
        // grow in 1 GiB steps up to the declared maximum
        try {
          const m = mk({ i64, shared, initial: 1, maximum: cap });
          let pages = 1;
          try { for (;;) { const step = Math.min(16384, cap - pages); if (!step) break; m.grow((i64 ? BigInt(step) : step) as number); pages += step; } } catch (e) { r.growError = err(e); }
          r.grewToBytes = pages * 65536;
          try { m.grow((i64 ? 1n : 1) as number); } catch (e) { r.growPastMaximum = err(e); }
        } catch (e) { r.growSetupError = err(e); }
        gc();
        r.moduleDeclared = i64
          ? [tryModule({ min: 1, max: cap, shared, memory64: true }), tryModule({ min: 1, max: cap + 1, shared, memory64: true }),
            tryModule({ min: 1, max: 2 ** 48, shared, memory64: true }), tryModule({ min: cap, max: cap, shared, memory64: true })]
          : [tryModule({ min: 1, max: 65536, shared }), tryModule({ min: 1, max: 65537, shared }), tryModule({ min: 65536, max: 65536, shared })];
        out[key] = r;
      }
    }
    return out;
  },

  alloc(d: Desc, touchBytes = 0, touchOffset = 0): { id: number } | { error: Err } {
    try {
      const m = mk(d);
      if (touchBytes) touch(m, touchOffset, touchBytes);
      held.set(nextId, m);
      return { id: nextId++ };
    } catch (e) { return { error: err(e) }; }
  },
  /** Allocates up to `k` memories; stops at the first failure. */
  allocMany(d: Desc, k: number) {
    for (let i = 0; i < k; i++) {
      const r = api.alloc(d);
      if ('error' in r) return { allocated: i, error: r.error };
    }
    return { allocated: k };
  },
  touch(id: number, offset: number, bytes: number) { touch(held.get(id)!, offset, bytes); return true; },
  freeAll() { held.clear(); gc(); return true; },

  async startWorkers(n: number) {
    for (let i = 0; i < n; i++) workers.push(new Worker(new URL('./capacity-worker.ts', import.meta.url), { type: 'module' }));
    return Promise.all(workers.map((_, i) => api.worker(i, { cmd: 'ping' })));
  },
  worker(i: number, msg: Record<string, unknown>): Promise<unknown> {
    const id = nextCall++;
    return new Promise((resolve) => {
      const w = workers[i];
      const onMsg = (e: MessageEvent) => { if (e.data.id === id) { w.removeEventListener('message', onMsg); resolve(e.data.result); } };
      w.addEventListener('message', onMsg);
      w.postMessage({ ...msg, id });
    });
  },

  /** Shared memory64, atomics on non-zero memories, JS views over >4 GiB, mixed-index memory.copy. */
  async features() {
    const out: Record<string, unknown> = {};
    const HIGH = 2 ** 32 + 4096; // an address above 4 GiB in the memory64 memory
    let mems: WebAssembly.Memory[];
    try {
      mems = [
        mk({ initial: 1, maximum: 1, shared: true }),
        mk({ initial: 1, maximum: 1, shared: true }),
        mk({ i64: true, initial: 2 ** 32 / 65536 + 16, maximum: 2 ** 32 / 65536 + 16, shared: true }),
      ];
      out.sharedMemory64 = { ok: true, bufferType: mems[2].buffer.constructor.name, bytes: mems[2].buffer.byteLength };
    } catch (e) { out.sharedMemory64 = { ok: false, error: err(e) }; return out; }

    // JS-side access above 4 GiB.
    try {
      const u8 = new Uint8Array(mems[2].buffer);
      const b64 = new BigInt64Array(mems[2].buffer);
      Atomics.add(b64, HIGH / 8, 5n);
      out.jsViewsAbove4GiB = { ok: true, uint8Length: u8.length, atomicsAddAbove4GiB: Atomics.load(b64, HIGH / 8) === 5n };
      b64[HIGH / 8] = 0n;
    } catch (e) { out.jsViewsAbove4GiB = { ok: false, error: err(e) }; }

    // Module: m0, m1 shared wasm32; m2 shared memory64. Atomics on memories 1 and 2.
    const m = new ModuleBuilder();
    m.importMemory('env', 'm0', { min: 1, max: 1, shared: true });
    m.importMemory('env', 'm1', { min: 1, max: 1, shared: true });
    m.importMemory('env', 'm2', { min: 65552, max: 65552, shared: true, memory64: true });
    const loop = (body: number[]) => [
      ...op.block(), ...op.loop(), ...op.localGet(1), ...op.localGet(0), ...op.i32GeU, ...op.brIf(1),
      ...body, ...op.localGet(1), ...op.i32Const(1), ...op.i32Add, ...op.localSet(1), ...op.br(0), ...op.end, ...op.end,
    ];
    m.exportFunc('add32_m1', m.func(m.type([I32], []), [I32], loop([...op.i32Const(0), ...op.i32Const(1), ...op.i32AtomicRmwAdd(0, 1), ...op.drop])));
    m.exportFunc('add64_m2', m.func(m.type([I32], []), [I32], loop([...op.i64Const(HIGH), ...op.i64Const(1), ...op.i64AtomicRmwAdd(0, 2), ...op.drop])));
    m.exportFunc('wait_m1', m.func(m.type([], [I32]), [], [...op.i32Const(64), ...op.i32Const(0), ...op.i64Const(5e9), ...op.atomicWait32(0, 1)]));
    m.exportFunc('notify_m1', m.func(m.type([], [I32]), [], [...op.i32Const(64), ...op.i32Const(1), ...op.atomicNotify(0, 1)]));
    m.exportFunc('wait_m2', m.func(m.type([], [I32]), [], [...op.i64Const(HIGH + 64), ...op.i32Const(0), ...op.i64Const(5e9), ...op.atomicWait32(0, 2)]));
    m.exportFunc('notify_m2', m.func(m.type([], [I32]), [], [...op.i64Const(HIGH + 64), ...op.i32Const(1), ...op.atomicNotify(0, 2)]));
    // copy(dst in m0 (i32), src in m2 (i64), len) — memory.copy across index types
    m.exportFunc('copy_m2_to_m0', m.func(m.type([I32, I64, I32], []), [], [...op.localGet(0), ...op.localGet(1), ...op.localGet(2), ...op.memoryCopy(0, 2)]));
    const bytes = m.bytes();
    out.atomicsModuleValidates = WebAssembly.validate(bytes);
    if (!out.atomicsModuleValidates) return out;
    const mod = new WebAssembly.Module(bytes);
    const ex = new WebAssembly.Instance(mod, { env: { m0: mems[0], m1: mems[1], m2: mems[2] } }).exports as Record<string, (...a: unknown[]) => number>;
    await api.startWorkers(1);
    const w = workers[workers.length - 1];
    const call = (fn: string, args: unknown[] = []) => api.worker(workers.indexOf(w), { cmd: 'run', mod, mems, fn, args });

    const N = 5_000_000;
    const pending = Promise.all([call('add32_m1', [N]), call('add64_m2', [N])]);
    ex.add32_m1(N); ex.add64_m2(N);
    await pending;
    const v32 = new Int32Array(mems[1].buffer)[0], v64 = new BigInt64Array(mems[2].buffer)[HIGH / 8];
    out.atomicRmwNonZeroMemory = { expected: 2 * N, wasm32Memory1: v32, memory64Memory2Above4GiB: Number(v64), ok: v32 === 2 * N && v64 === BigInt(2 * N) };

    for (const [waitFn, notifyFn] of [['wait_m1', 'notify_m1'], ['wait_m2', 'notify_m2']]) {
      const waiting = call(waitFn);
      let woken = 0;
      for (let t = 0; t < 50 && !woken; t++) { await new Promise((r) => setTimeout(r, 20)); woken = ex[notifyFn](); }
      out[waitFn] = { woken, waitResult: await waiting, ok: woken === 1 }; // wait result 0 = "ok" (woken)
    }

    new Uint8Array(mems[2].buffer).set([1, 2, 3, 4], HIGH);
    ex.copy_m2_to_m0(0, BigInt(HIGH), 4);
    out.memoryCopyMixedIndexTypes = { ok: new Uint8Array(mems[0].buffer, 0, 4).join() === '1,2,3,4' };
    return out;
  },
};

Object.assign(globalThis, { cap: api });
