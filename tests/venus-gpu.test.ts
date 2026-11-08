// Pipelines made asynchronously (web/venus-gpu.ts, VK3 L3), on a stand-in WebGPU device that logs what reaches its
// queue: a submit drawing with a pipeline still being made is held until it is ready, and everything after it in the
// queue's order (another submit, a buffer write, an import's write) waits behind it; completions stay in submit order.
// The real device's side is tests/venus-driver.test.ts's (Chromium).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bitsBetween, deviceRequest, fanMost, L9_LIMITS, l9Suspects, packedSwizzle, VenusGpu, xfbOpen } from '../web/venus-gpu.ts';

// The classes venus-gpu.ts tells objects apart by.
class FakeBuffer { destroyed = false; destroy() { this.destroyed = true; } mapAsync() { return Promise.resolve(); } getMappedRange() { return new ArrayBuffer(16); } unmap() {} }
class FakeTexture { destroy() {} }
const g = globalThis as Record<string, unknown>;
g.GPUBuffer ??= FakeBuffer;
g.GPUTexture ??= FakeTexture;
g.GPUQuerySet ??= class { destroy() {} };

type Pending = { resolve: (p: object) => void; reject: (e: Error) => void };

function fakeDevice() {
  const log: string[] = [];
  const pending: Pending[] = [];
  let pipelines = 0;
  const pass = { setPipeline: (p: { name: string }) => log.push(`setPipeline ${p.name}`), draw: (n: number) => log.push(`draw ${n}`), end: () => log.push('end'), setBindGroup() {}, setViewport() {}, setScissorRect() {} };
  const device = {
    addEventListener() {},
    pushErrorScope() {},
    popErrorScope: () => Promise.resolve(null),
    createBuffer: () => new FakeBuffer(),
    createShaderModule: () => ({ getCompilationInfo: () => Promise.resolve({ messages: [] }) }),
    createPipelineLayout: () => ({}),
    createRenderPipeline: () => { log.push('made at once'); return { name: `sync${++pipelines}` }; },
    createRenderPipelineAsync: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    createCommandEncoder: () => {
      log.push('encoder');
      return { beginRenderPass: () => pass, finish: () => ({}) };
    },
    queue: {
      submit: (b: unknown[]) => log.push(b.length ? 'submit' : 'nudge'),
      writeBuffer: (_b: unknown, _o: number, data: Uint8Array) => log.push(`write ${[...data].join(',')}`),
      onSubmittedWorkDone: () => Promise.resolve(),
    },
  };
  return { device: device as unknown as GPUDevice, log, pending };
}

function setup() {
  const { device, log, pending } = fakeDevice();
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const completed: number[] = [];
  const gpu = new VenusGpu(device, memory, (serial) => completed.push(serial), () => []);
  const wg = gpu.imports() as Record<string, (...a: number[]) => number | void>;
  const u8 = new Uint8Array(memory.buffer);
  // JSON and bytes for the imports, written into memory at `at`.
  const put = (at: number, s: string | number[]) => {
    const b = typeof s === 'string' ? new TextEncoder().encode(s) : Uint8Array.from(s);
    u8.set(b, at);
    return [at, b.length] as const;
  };
  const drawWith = (pipeline: number, serial: number) => {
    wg.gpu_encoder();
    wg.gpu_render_pass(...put(1024, '{"colorAttachments":[],"width":4,"height":4}'));
    wg.gpu_set_pipeline(pipeline);
    wg.gpu_draw(serial * 3, 1, 0, 0);
    wg.gpu_submit(serial);
  };
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  return { gpu, wg, log, pending, completed, put, drawWith, settle, u8 };
}

test('a submit drawing with a pipeline being made waits for it, and the queue work after it waits too', async () => {
  const { gpu, wg, log, pending, completed, put, drawWith, settle, u8 } = setup();
  wg.gpu_create(0, 1, ...put(0, '{"size":256,"usage":8}'));
  wg.gpu_create(6, 2, ...put(0, '{"layout":0,"vertex":{"module":0}}'));
  assert.equal(pending.length, 1, 'made asynchronously');
  drawWith(2, 1);
  // A write after it, from memory changed right after the call: the held write keeps the bytes of its call.
  wg.gpu_write(1, 0, ...put(2048, [1, 2, 3, 4]));
  u8.set([9, 9, 9, 9], 2048);
  drawWith(2, 2);
  const imported: string[] = [];
  gpu.later(() => imported.push('import'));
  const idle = gpu.idle();
  assert.ok(idle, 'idle() while held');
  await settle();
  assert.deepEqual(log, [], 'nothing reached the queue while the pipeline was being made');
  assert.deepEqual(completed, []);
  assert.deepEqual(imported, []);
  assert.equal(gpu.stats.deferred, 2, 'both held');

  pending[0].resolve({ name: 'async1' });
  await idle;
  await settle();
  assert.deepEqual(log, ['encoder', 'setPipeline async1', 'draw 3', 'end', 'submit', 'write 1,2,3,4', 'encoder', 'setPipeline async1', 'draw 6', 'end', 'submit']);
  assert.deepEqual(imported, ['import']);
  assert.deepEqual(completed, [1, 2], 'completed in submit order');
  assert.equal(gpu.stats.syncPipelines, 0);
  assert.equal(gpu.idle(), undefined, 'nothing held now');
});

test('with its pipeline ready, a submit goes at once; a pipeline WebGPU refuses is made at once for its error', async () => {
  const { gpu, wg, log, pending, completed, put, drawWith, settle } = setup();
  wg.gpu_create(6, 2, ...put(0, '{"layout":0,"vertex":{"module":0}}'));
  pending[0].resolve({ name: 'async1' });
  await settle();
  drawWith(2, 1);
  assert.deepEqual(log, ['encoder', 'setPipeline async1', 'draw 3', 'end', 'submit'], 'not held');
  assert.equal(gpu.stats.deferred, 0);

  log.length = 0;
  wg.gpu_create(6, 3, ...put(0, '{"layout":0,"vertex":{"module":0}}'));
  drawWith(3, 2);
  pending[1].reject(new Error('a GPUPipelineError'));
  await settle();
  assert.deepEqual(log, ['made at once', 'encoder', 'setPipeline sync1', 'draw 6', 'end', 'submit']);
  assert.deepEqual(completed, [1, 2]);
});

test('a pipeline made after its submit began (never by the driver) is made at once, not left out', async () => {
  const { gpu, wg, log, put, settle } = setup();
  wg.gpu_encoder();
  wg.gpu_render_pass(...put(1024, '{"colorAttachments":[],"width":4,"height":4}'));
  wg.gpu_create(6, 2, ...put(0, '{"layout":0,"vertex":{"module":0}}'));
  wg.gpu_set_pipeline(2);
  wg.gpu_draw(3, 1, 0, 0);
  wg.gpu_submit(1);
  await settle();
  assert.equal(gpu.stats.syncPipelines, 1);
  assert.deepEqual(log, ['encoder', 'made at once', 'setPipeline sync1', 'draw 3', 'end', 'submit']);
});

test('?gpu=vkpipelines=sync makes them at once, as before', async () => {
  const { device, log, pending } = fakeDevice();
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const gpu = new VenusGpu(device, memory, () => {}, () => [], { syncPipelines: true });
  const wg = gpu.imports() as Record<string, (...a: number[]) => number | void>;
  const b = new TextEncoder().encode('{"layout":0,"vertex":{"module":0}}');
  new Uint8Array(memory.buffer).set(b);
  wg.gpu_create(6, 2, 0, b.length);
  assert.equal(pending.length, 0);
  assert.deepEqual(log, ['made at once']);
});

test('a submit\'s parts are counted (VK3 L2b): its encoding, queue.submit, passes, draws, and the done of those with a pass', async () => {
  const { gpu, wg, put, settle } = setup();
  wg.gpu_encoder();
  wg.gpu_render_pass(...put(1024, '{"colorAttachments":[],"width":4,"height":4}'));
  wg.gpu_draw(3, 1, 0, 0);
  wg.gpu_draw(6, 1, 0, 0);
  wg.gpu_submit(1);
  // One without a pass (a fence's or an upload's alone).
  wg.gpu_encoder();
  wg.gpu_submit(2);
  await settle();
  const s = gpu.stats;
  assert.equal(s.passes, 1);
  assert.equal(s.draws, 2);
  assert.equal(s.done, 2);
  assert.equal(s.workDone, 1, 'only the submit with a pass');
  assert.ok(s.encodeMs >= 0 && s.submitCallMs >= 0 && s.workDoneMs >= 0);
  assert.equal(s.gpuTimed, 0, 'not timed without ?gpu=vkgputime');
});

test('?gpu=vkgputime times a submit\'s passes on the GPU with timestamp queries, read once it is done', async () => {
  const log: string[] = [];
  const descs: GPURenderPassDescriptor[] = [];
  // Begin 1,000 ns, end 251,000: 0.25 ms.
  const times = new BigUint64Array([1000n, 251000n]);
  const device = {
    features: new Set(['timestamp-query']),
    addEventListener() {},
    createBuffer: () => Object.assign(new FakeBuffer(), { getMappedRange: () => times.buffer }),
    createQuerySet: () => { log.push('query set'); return {}; },
    createCommandEncoder: () => ({
      beginRenderPass: (d: GPURenderPassDescriptor) => { descs.push(d); return { end() {}, draw() {} }; },
      resolveQuerySet: (_q: unknown, first: number, n: number) => log.push(`resolve ${first} ${n}`),
      copyBufferToBuffer: () => log.push('copy'),
      finish: () => ({}),
    }),
    queue: { submit: () => log.push('submit'), writeBuffer() {}, onSubmittedWorkDone: () => Promise.resolve() },
  } as unknown as GPUDevice;
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const gpu = new VenusGpu(device, memory, () => {}, () => [], { gpuTime: true });
  const wg = gpu.imports() as Record<string, (...a: number[]) => number | void>;
  const b = new TextEncoder().encode('{"colorAttachments":[],"width":4,"height":4}');
  new Uint8Array(memory.buffer).set(b, 1024);
  for (const serial of [1, 2]) {
    wg.gpu_encoder();
    wg.gpu_render_pass(1024, b.length);
    wg.gpu_draw(3, 1, 0, 0);
    wg.gpu_submit(serial);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  }
  assert.deepEqual(descs.map((d) => d.timestampWrites && [d.timestampWrites.beginningOfPassWriteIndex, d.timestampWrites.endOfPassWriteIndex]), [[0, 1], [0, 1]]);
  assert.deepEqual(log, ['query set', 'resolve 0 2', 'copy', 'submit', 'resolve 0 2', 'copy', 'submit'], 'one query set, reused');
  assert.equal(gpu.stats.gpuTimed, 2);
  assert.ok(Math.abs(gpu.stats.gpuMs - 0.5) < 1e-9, String(gpu.stats.gpuMs));

  // Without the adapter's feature: nothing timed, passes as before.
  descs.length = 0;
  const plain = new VenusGpu({ ...device, features: new Set() } as unknown as GPUDevice, memory, () => {}, () => [], { gpuTime: true });
  const wp = plain.imports() as Record<string, (...a: number[]) => number | void>;
  wp.gpu_encoder();
  wp.gpu_render_pass(1024, b.length);
  wp.gpu_submit(1);
  assert.equal(descs[0].timestampWrites, undefined);
});

test('a storage texture a pass may write counts as written (VK3 L4c-F: presentation copies only written images)', async () => {
  // The review's "storage writes don't count as writes": a WSI image written by a compute shader wasn't marked.
  class Tex extends (globalThis as unknown as { GPUTexture: typeof FakeTexture }).GPUTexture { createView() { return {}; } }
  const pass = { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} };
  const device = {
    addEventListener() {},
    pushErrorScope() {},
    popErrorScope: () => Promise.resolve(null),
    createTexture: () => new Tex(),
    createBindGroupLayout: (d: object) => ({ d }),
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({ beginComputePass: () => pass, finish: () => ({}) }),
    queue: { submit() {}, writeBuffer() {}, onSubmittedWorkDone: () => Promise.resolve() },
  } as unknown as GPUDevice;
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const gpu = new VenusGpu(device, memory, () => {}, () => []);
  const wg = gpu.imports() as Record<string, (...a: number[]) => number | void>;
  const u8 = new Uint8Array(memory.buffer);
  const put = (s: string) => { const b = new TextEncoder().encode(s); u8.set(b, 0); return [0, b.length] as const; };
  wg.gpu_create(1, 1, ...put('{"size":[4,4],"format":"rgba8unorm","usage":12}'));
  wg.gpu_create(1, 2, ...put('{"size":[4,4],"format":"rgba8unorm","usage":12}'));
  wg.gpu_create(2, 3, ...put('{"texture":1}'));
  wg.gpu_create(2, 4, ...put('{"texture":2}'));
  wg.gpu_create(4, 5, ...put('{"entries":[{"binding":0,"visibility":4,"storageTexture":{"access":"write-only","format":"rgba8unorm"}},{"binding":2,"visibility":4,"storageTexture":{"access":"read-only","format":"rgba8unorm"}}]}'));
  wg.gpu_create(8, 6, ...put('{"layout":5,"entries":[{"binding":0,"view":3},{"binding":2,"view":4}]}'));
  wg.gpu_encoder();
  wg.gpu_compute_pass();
  wg.gpu_set_bind_group(0, 6, 0, 0);
  wg.gpu_dispatch(1, 1, 1);
  wg.gpu_pass_end();
  wg.gpu_submit(1);
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  assert.equal(gpu.texture(1)?.written, 1, 'the texture bound for writing');
  assert.equal(gpu.texture(2)?.written, 0, 'the texture bound read-only');
});

// VK3 L8a (the track-end review's finding 2): a draw's index range is what it reads, not the rest of a big buffer.
function bindingDevice() {
  class Buf extends (globalThis as unknown as { GPUBuffer: typeof FakeBuffer }).GPUBuffer { size: number; constructor(size: number) { super(); this.size = size; } }
  const groups: GPUBindGroupEntry[][] = [], copies: number[][] = [], warnings: string[] = [];
  const pass = { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {}, setImmediates() {} };
  const device = {
    limits: { maxStorageBufferBindingSize: 128 << 20, minStorageBufferOffsetAlignment: 256 },
    addEventListener() {},
    pushErrorScope() {},
    popErrorScope: () => Promise.resolve(null),
    createBuffer: (d: { size: number }) => new Buf(d.size),
    createShaderModule: () => ({ getCompilationInfo: () => Promise.resolve({ messages: [] }) }),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: (d: { entries: GPUBindGroupEntry[] }) => { groups.push(d.entries); return {}; },
    createCommandEncoder: () => ({
      beginComputePass: () => pass,
      copyBufferToBuffer: (_a: unknown, from: number, _b: unknown, at: number, size: number) => copies.push([from, at, size]),
      clearBuffer() {},
      finish: () => ({}),
    }),
    queue: { submit() {}, writeBuffer() {}, onSubmittedWorkDone: () => Promise.resolve() },
  } as unknown as GPUDevice;
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const gpu = new VenusGpu(device, memory, () => {}, () => []);
  (gpu as unknown as { warn(s: string): void }).warn = (s: string) => warnings.push(s);
  const wg = gpu.imports() as Record<string, (...a: number[]) => number | void>;
  const u8 = new Uint8Array(memory.buffer);
  const put = (s: string) => { const b = new TextEncoder().encode(s); u8.set(b, 0); return [0, b.length] as const; };
  return { gpu, wg, put, groups, copies, warnings, Buf };
}

test('the provoking-vertex pass binds the indices its draw reads, not the bound range to a big buffer\'s end', () => {
  const { wg, put, groups } = bindingDevice();
  // A 1 GiB index buffer bound whole; a triangle list of 6 16-bit indices from index 1000.
  wg.gpu_create(0, 1, ...put(`{"size":${1 << 30},"usage":${16 | 128}}`));
  wg.gpu_encoder();
  wg.gpu_provoke(0, 1, 0, 1 << 30, 0, 0, 0, 1000, 6, 2);
  const src = groups[0][0].resource as GPUBufferBinding;
  // From the 256-aligned start of index 1000 (byte 2000: 1792) to its last index's end (2012), in words.
  assert.equal(src.offset, 1792);
  assert.equal(src.size, 2012 - 1792);
});

test('a captured indexed draw copies the indices it reads, so a big index buffer doesn\'t skip the capture', () => {
  const { gpu, warnings, copies, Buf } = bindingDevice();
  const ib = new Buf(1 << 30);
  const x = { stride: [16, 0, 0, 0], base: [], words: [], bgls: [], immediateSize: 0, code: 'fn wg_vs', buffers: [],
    pipelines: { main: {}, advance: {}, layout: {}, slots: [], captured: [0] } };
  const session = { bufs: [{ guest: new Buf(4096), at: 0, size: 4096, word: 4 }], out: new Buf(8192) };
  const g = gpu as unknown as { enc: unknown; device: GPUDevice; xfbDraw(s: object, j: object): void };
  g.enc = g.device.createCommandEncoder();
  // 3 16-bit indices from index 10 of a buffer bound whole.
  g.xfbDraw(session, { xfb: x, topology: 3, count: 3, instances: 1, wide: 0, ib, offset: 0, size: 1 << 30, first: 10, base: 0, firstInstance: 0, vb: [], groups: [] });
  assert.deepEqual(warnings, []);
  // The indices' copy into the draw's inputs, after its 112 bytes of parameters (VK4 T40): bytes [20, 26) as two words.
  assert.deepEqual(copies[0], [20, 112, 8]);
});

test('?gpu=vkl9=… asks for the device as at 4fdc69fb, suspect by suspect (VK3 L9a\'s NVIDIA arms); none by default', () => {
  const adapter = {
    features: new Set(['texture-compression-bc', 'subgroups', 'shader-f16', 'timestamp-query']),
    limits: { maxTextureDimension2D: 16384, maxStorageBuffersInVertexStage: 8, maxStorageTexturesInVertexStage: 4, maxBindingsPerBindGroup: 1000, maxColorAttachmentBytesPerSample: 64 },
  } as unknown as GPUAdapter;
  const asked = (l9: string[]) => { const d = deviceRequest(adapter, { l9: l9Suspects(l9) }); return { features: [...(d.requiredFeatures ?? [])].sort(), limits: Object.keys(d.requiredLimits ?? {}).sort() }; };
  const now = asked([]);
  assert.deepEqual(now.features, ['shader-f16', 'subgroups', 'texture-compression-bc']);
  for (const k of L9_LIMITS) assert.ok(now.limits.includes(k), k);
  assert.deepEqual(asked(['features']).features, ['texture-compression-bc']);
  assert.deepEqual(asked(['features']).limits, now.limits);
  assert.deepEqual(asked(['limits']).features, now.features);
  assert.deepEqual(asked(['limits']).limits, now.limits.filter((k) => !L9_LIMITS.includes(k)));
  assert.deepEqual(asked(['all']), asked(['features', 'limits']));
  assert.deepEqual(l9Suspects(['all']), ['features', 'limits', 'bindgroups', 'pad']);
  assert.deepEqual(l9Suspects(['pad', 'nonsense']), ['pad']);
});

// VK3 L9b: NVIDIA's dEQP-VK run had a completion throw ("table index is out of bounds", a trap in the module's
// complete), and the next submit was then completed at once, its readbacks not mapped yet and their staging destroyed
// under the map ("Buffer was destroyed before mapping was resolved"): a failure stays its own submit's.
test('a completion that throws neither completes the next submit before its readbacks are mapped nor destroys them under the map', async () => {
  let resolveMap!: () => void;
  const mapped = new Promise<void>((r) => { resolveMap = r; });
  class Staging extends FakeBuffer { mapAsync() { return mapped; } }
  const stagings: Staging[] = [], warnings: string[] = [], completed: number[] = [];
  const device = {
    addEventListener() {},
    pushErrorScope() {},
    popErrorScope: () => Promise.resolve(null),
    createBuffer: (d: { usage: number }) => { const b = d.usage & 1 ? new Staging() : new FakeBuffer(); if (b instanceof Staging) stagings.push(b); return b; },
    createCommandEncoder: () => ({ copyBufferToBuffer() {}, finish: () => ({}) }),
    queue: { submit() {}, writeBuffer() {}, onSubmittedWorkDone: () => Promise.resolve() },
  } as unknown as GPUDevice;
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const gpu = new VenusGpu(device, memory, (serial) => {
    if (serial === 1) throw new Error('a trap');
    completed.push(serial);
  }, () => []);
  (gpu as unknown as { warn(s: string): void }).warn = (s: string) => warnings.push(s);
  const wg = gpu.imports() as Record<string, (...a: number[]) => number | void>;
  const u8 = new Uint8Array(memory.buffer);
  const json = new TextEncoder().encode('{"size":256,"usage":12}');
  u8.set(json, 0);
  wg.gpu_create(0, 1, 0, json.length);
  wg.gpu_encoder();
  wg.gpu_submit(1);
  wg.gpu_encoder();
  wg.gpu_readback(1, 0, 16);
  wg.gpu_submit(2);
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  await settle();
  assert.equal(stagings.length, 1);
  assert.deepEqual(completed, [], 'submit 2 waits for its readback');
  assert.equal(stagings[0].destroyed, false, 'its staging kept while it maps');
  assert.equal(warnings.length, 1, warnings.join('; '));
  assert.match(warnings[0], /a trap/);
  resolveMap();
  await settle();
  assert.deepEqual(completed, [2]);
  assert.equal(stagings[0].destroyed, true);
});

// VK4 R3 (the review's R5): a cut of a Vulkan pass (a feedback copy, a barrier's scope) ends a WebGPU pass with its
// capture open: its jobs wait for the next part, whose draws would otherwise have no session.
// VK4 T45: the jobs before the open capture's begin (captures ended, queries) run at the cut, so a draw by a byte count
// in the next part reads their counters; a query's job neither opens nor closes a capture.
test('a capture open at a WebGPU pass\'s end goes on in the next part', () => {
  assert.equal(xfbOpen([]), -1);
  assert.equal(xfbOpen([{ op: 'begin' }, { op: 'draw' }]), 0);
  assert.equal(xfbOpen([{ op: 'begin' }, { op: 'draw' }, { op: 'end' }]), -1);
  assert.equal(xfbOpen([{ op: 'begin' }, { op: 'end' }, { op: 'begin' }]), 2);
  assert.equal(xfbOpen([{ op: 'begin' }, { op: 'draw' }, { op: 'query' }]), 0);
  assert.equal(xfbOpen([{ op: 'begin' }, { op: 'end' }, { op: 'query' }]), -1);
});

// VK4 R4 (the review's X3): the bound index range of an indirect fan is often a whole shared buffer.
test('an indirect fan\'s list is sized by a fan, not by the bound index range', () => {
  assert.equal(fanMost(48 << 20, 4), 65536);
  assert.equal(fanMost(24, 4), 6);
  assert.ok((fanMost(1 << 30, 2) - 2) * 12 < 128 << 20, 'under WebGPU\'s default storage binding');
});

test('multisampled copies carry bits: packed layouts\' channels, other formats of a block\'s size', () => {
  const r5g6b5 = [11, 5, 5, 6, 0, 5, 0, 0, 2, 0, 0, 0, 0], b5g6r5 = [0, 5, 5, 6, 11, 5, 0, 0, 2, 0, 0, 0, 0], a1r5g5b5 = [10, 5, 5, 5, 0, 5, 15, 1, 2, 0, 0, 0, 0];
  assert.equal(packedSwizzle(r5g6b5, b5g6r5), 'bgra');
  assert.equal(packedSwizzle(r5g6b5, r5g6b5), 'rgba');
  assert.equal(packedSwizzle(r5g6b5, a1r5g5b5), undefined, 'bits of another size');
  assert.equal(bitsBetween('rgba8unorm', 'rgba8unorm'), '');
  assert.equal(bitsBetween('rgba8unorm', 'r8unorm'), undefined, 'another block size');
  assert.equal(bitsBetween('rgba8snorm', 'rgba8unorm'), undefined, 'channels this doesn\'t take apart');
  // VK4 T39: rgb10a2 and packed formats by their fields.
  const ten = bitsBetween('rgb10a2unorm', 'rgba8uint')!;
  assert.match(ten, /round\(v\[0\] \* 1023\.0\)\) << 0u;/);
  assert.match(ten, /round\(v\[3\] \* 3\.0\)\) << 30u;/);
  assert.match(ten, /return vec4<u32>\(\(\(w\[0\] >> 0u\) & 255u\).*>> 24u\) & 255u\)\);/);
  const r5 = bitsBetween('rgba8unorm', 'r16uint', r5g6b5)!;
  assert.match(r5, /round\(v\[0\] \* 31\.0\)\) << 11u;/, 'red at bit 11');
  assert.match(r5, /round\(v\[1\] \* 63\.0\)\) << 5u;/);
  assert.ok(!/v\[3\]/.test(r5), 'R5G6B5 has no alpha');
  const into = bitsBetween('r16uint', 'rgba8unorm', undefined, r5g6b5)!;
  assert.match(into, /return vec4<f32>\(f32\(\(\(w\[0\] >> 11u\) & 31u\)\) \/ 31\.0, .*, 1\.0\);/, 'alpha 1');
  assert.equal(bitsBetween('rgba8unorm', 'rgba8unorm', r5g6b5, a1r5g5b5)?.includes('<< 15u'), false, 'nothing of R5G6B5 at bit 15: A1R5G5B5\'s alpha bit stays 0');
  const c = bitsBetween('rgba8unorm', 'rg16uint')!;
  assert.match(c, /round\(v\[0\] \* 255\.0\)/);
  assert.match(c, /w\[0\] \|= .* << 24u;/);
  assert.match(c, /return vec4<u32>\(.*>> 0u\) & 65535u.*>> 16u\) & 65535u.*0u, 1u\);/);
  const swapped = bitsBetween('bgra8unorm', 'r32float')!;
  assert.match(swapped.split('\n')[1], /v\[2\]/, 'bgra\'s first byte is its blue');
});
