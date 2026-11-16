// One of web/inflate-pool.ts's workers: inflates the compressed qcow2 clusters it is sent, one after another, through
// its own codec (web/deflate.ts, on the core its pool sends first), each to `size` bytes, and sends them back end to
// end, with which ones unpacked.
import { coreModule, threadDeflate } from './deflate.ts';

export type InflateInit = { type: 'init'; module: WebAssembly.Module };
export type InflateRequest = { id: number; size: number; lengths: Uint32Array; packed: Uint8Array };
/** The clusters, or why none could be (the codec didn't start: web/inflate-pool.ts does them on its own thread). */
export type InflateResult = { id: number; ok: Uint8Array; out: Uint8Array } | { id: number; error: string };

self.onmessage = async (e: MessageEvent<InflateInit | InflateRequest>) => {
  if ('type' in e.data) {
    void coreModule(e.data.module);
    return;
  }
  const { id, size, lengths, packed } = e.data;
  // Every request is answered: one this worker can't do is said to be, and the pool does it (an error it didn't catch
  // would reach no one: an async handler's rejection isn't the Worker's `error`).
  try {
    const z = await threadDeflate();
    const ok = new Uint8Array(lengths.length);
    const out = new Uint8Array(lengths.length * size);
    let at = 0;
    lengths.forEach((len, k) => {
      const data = z.inflate(packed.subarray(at, (at += len)), size);
      if (data) { out.set(data, k * size); ok[k] = 1; }
    });
    self.postMessage({ id, ok, out } satisfies InflateResult, { transfer: [ok.buffer, out.buffer] });
  } catch (err) {
    self.postMessage({ id, error: String((err as Error)?.message ?? err) } satisfies InflateResult);
  }
};
