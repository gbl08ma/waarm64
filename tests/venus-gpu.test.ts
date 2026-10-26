// Pipelines made asynchronously (web/venus-gpu.ts, VK3 L3), on a stand-in WebGPU device that logs what reaches its
// queue: a submit drawing with a pipeline still being made is held until it is ready, and everything after it in the
// queue's order (another submit, a buffer write, an import's write) waits behind it; completions stay in submit order.
// The real device's side is tests/venus-driver.test.ts's (Chromium).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VenusGpu } from '../web/venus-gpu.ts';

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
