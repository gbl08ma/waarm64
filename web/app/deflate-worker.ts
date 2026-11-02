// One of the disk-out worker's compressors (web/app/deflate-pool.ts): deflates the
// clusters it is sent, each on its own (web/qcow2-write.ts `deflate`), and sends back the ones that
// shrank end to end with their lengths (0: stored as it is).
import { toWire, type WireError } from '../msg.ts';
import { CLUSTER, deflate } from '../qcow2-write.ts';

export type DeflateRequest = { id: number; clusters: Uint8Array };
export type DeflateResult = { id: number; lengths: Uint16Array; packed: Uint8Array } | { id: number; error: WireError };

self.onmessage = async (e: MessageEvent<DeflateRequest>) => {
  const { id, clusters } = e.data;
  try {
    const lengths = new Uint16Array(clusters.length / CLUSTER);
    const packed = new Uint8Array(clusters.length);
    let at = 0;
    for (let k = 0; k < lengths.length; k++) {
      const p = await deflate(clusters.subarray(k * CLUSTER, (k + 1) * CLUSTER));
      if (!p) continue;
      packed.set(p, at);
      lengths[k] = p.length;
      at += p.length;
    }
    const out = packed.slice(0, at);
    self.postMessage({ id, lengths, packed: out } satisfies DeflateResult, { transfer: [lengths.buffer, out.buffer] });
  } catch (err) {
    self.postMessage({ id, error: toWire(err) } satisfies DeflateResult);
  }
};
