// VK4 T31's cost of the copies (bench/vulkan/REPORT.md "VK4 T31"): a 1024×1024 image's upload (buffer → texture) and
// readback (texture → buffer) through the GPU worker's own imports (web/venus-gpu.ts), for a format WebGPU has
// (R8G8B8A8_UNORM, rgba8unorm: one copy) against formats it lacks (R8G8B8_UNORM, its 3-byte texels in rgba8unorm;
// B8G8R8A8_UINT, its channels reordered in rgba8uint), whose copies are the worker's compute pass and a copy through a
// temporary buffer (`packPass`). Samples are ms a copy (wall, back to back, two in flight).
//   node bench/run.ts --page bench/vulkan/t31/index.html --chromium-args='<the VM's WebGPU switches>' --out bench/results/local/t31/cost.json
import type { Options, Sample } from '../../spike/benchmarks.ts';
import { VenusGpu } from '../../../web/venus-gpu.ts';

const W = 1024, H = 1024;
// The driver's JSON (wg_device.c `packed_key`): R, G, B, A's [shift, bits], a texel's bytes, each channel's kind.
const FORMATS: { name: string; texture: string; bytes: number; packed?: number[] }[] = [
  { name: 'r8g8b8a8_unorm', texture: 'rgba8unorm', bytes: 4 },
  { name: 'r8g8b8_unorm', texture: 'rgba8unorm', bytes: 3, packed: [0, 8, 8, 8, 16, 8, 0, 0, 3, 0, 0, 0, 0] },
  { name: 'b8g8r8a8_uint', texture: 'rgba8uint', bytes: 4, packed: [16, 8, 8, 8, 0, 8, 24, 8, 4, 2, 2, 2, 2] },
];

async function copies(o: Options): Promise<Sample[]> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('no WebGPU adapter');
  const device = await adapter.requestDevice();
  device.addEventListener('uncapturederror', (e) => console.error('webgpu:', (e as GPUUncapturedErrorEvent).error.message));
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 16, shared: true });
  const gpu = new VenusGpu(device, memory, () => {}, () => [], { syncPipelines: true });
  const wg = gpu.imports() as Record<string, (...a: number[]) => number | void>;
  const u8 = new Uint8Array(memory.buffer);
  const create = (kind: number, id: number, j: object) => {
    const b = new TextEncoder().encode(JSON.stringify(j));
    u8.set(b, 0);
    wg.gpu_create(kind, id, 0, b.length);
  };
  let serial = 1;
  const out: Sample[] = [];
  const samples = o.quick ? 3 : 10, frames = 20;
  for (const [i, f] of FORMATS.entries()) {
    const buffer = 10 + 2 * i, texture = buffer + 1, bpr = Math.ceil((W * f.bytes) / 256) * 256;
    create(0, buffer, { size: bpr * H, usage: 0x80 | 0x4 | 0x8 /* STORAGE | COPY_SRC | COPY_DST */ });
    create(1, texture, { ...(f.packed ? { packed: f.packed } : {}), size: [W, H, 1], mipLevelCount: 1, sampleCount: 1, dimension: '2d', format: f.texture, usage: 1 | 2 | 4 });
    for (const way of ['upload', 'readback'] as const) {
      const copy = () => {
        wg.gpu_encoder();
        if (way === 'upload') wg.gpu_copy_bt(buffer, 0, bpr, H, texture, 0, 0, 0, 0, W, H, 1, 0);
        else wg.gpu_copy_tb(buffer, 0, bpr, H, texture, 0, 0, 0, 0, W, H, 1, 0);
        wg.gpu_submit(serial++);
      };
      const pending: Promise<void>[] = [];
      const settle = async (n: number) => { while (pending.length > n) await pending.shift(); };
      const ms: number[] = [];
      for (let s = -1; s < samples; s++) {
        const t = performance.now();
        for (let k = 0; k < frames; k++) { copy(); pending.push(device.queue.onSubmittedWorkDone()); await settle(1); }
        await settle(0);
        if (s >= 0) ms.push((performance.now() - t) / frames);
      }
      out.push({ name: 'copies', unit: 'ms', params: { format: f.name, texture: f.texture, way, size: `${W}x${H}` }, samples: ms });
      o.log?.(`${f.name} ${way}: ${ms.map((x) => x.toFixed(3)).join(' ')}`);
    }
  }
  device.destroy();
  return out;
}

export const suite = { copies };
export async function runAll(o: Options): Promise<Sample[]> {
  return copies(o);
}
