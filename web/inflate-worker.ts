// One of web/inflate-pool.ts's workers: inflates the compressed qcow2 clusters it is sent, one after
// another (web/qcow2.ts `inflateEach`, each to `size` bytes), and sends them back end to end, with
// which ones unpacked.
import { inflateEach } from './qcow2.ts';

export type InflateRequest = { id: number; size: number; lengths: Uint32Array; packed: Uint8Array };
export type InflateResult = { id: number; ok: Uint8Array; out: Uint8Array };

self.onmessage = async (e: MessageEvent<InflateRequest>) => {
  const { id, size, lengths, packed } = e.data;
  let at = 0;
  const clusters = await inflateEach(Array.from(lengths, (len) => packed.subarray(at, at += len)), size);
  const ok = new Uint8Array(lengths.length);
  const out = new Uint8Array(lengths.length * size);
  clusters.forEach((data, k) => { if (data) { out.set(data, k * size); ok[k] = 1; } });
  self.postMessage({ id, ok, out } satisfies InflateResult, { transfer: [ok.buffer, out.buffer] });
};
