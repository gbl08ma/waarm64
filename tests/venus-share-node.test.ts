// web/venus-share.ts's bookkeeping in Node, against fakes of WebGPU and the virgl renderer (the copies themselves are
// tests/venus-share.test.ts's, in Chromium): a resource id the guest reuses starts afresh, and the GPU ways' canvases
// (one per size) are let go of one at a time, unconfigured; a 16-bit normalized image goes by readback in a GPU mode.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VenusShare, type SharedTexture } from '../web/venus-share.ts';
import type { ExternalResource } from '../web/virgl-objects.ts';
import type { VirglRenderer } from '../web/virgl-renderer.ts';

const B8G8R8A8 = 1;

/** A renderer with the external resources attached to context 1, and the ids whose submits wait (`externalWait`). */
function fakeRenderer() {
  const waits = new Set<number>();
  const r = {
    externals: [] as ExternalResource[],
    waits,
    writes: 0,
    externalWait(id: number, waiting: boolean) {
      if (waiting) waits.add(id);
      else waits.delete(id);
    },
    externalsOf: () => r.externals,
    writeExternal() {
      r.writes++;
    },
  };
  return r;
}

/** A WebGPU device whose every object is a stub that takes any call. */
function fakeDevice() {
  const stub = (): unknown =>
    new Proxy(() => undefined, {
      get: (_t, k) => (k === 'then' ? undefined : stub()),
      apply: () => stub(),
    });
  return stub() as GPUDevice;
}

const texture = (width: number, height: number, format: GPUTextureFormat = 'bgra8unorm') =>
  ({ width, height, format, createView: () => ({}) }) as unknown as GPUTexture;

test("venus-share: a reused resource id's submits are held again while the old one's hold is still out", async () => {
  const renderer = fakeRenderer();
  let settle!: () => void;
  let pending: Promise<void> | undefined = new Promise((r) => (settle = r));
  // Not an image the readback way copies (an rgba32float texture isn't shared): only the holds are under test.
  const src: SharedTexture = { texture: texture(64, 64, 'rgba32float'), written: 1 };
  const share = new VenusShare(fakeDevice(), 'readback', renderer as unknown as VirglRenderer, () => src, {
    idle: () => pending,
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const old: { id: number; width: number; height: number; format: number; dead?: boolean } = {
      id: 5,
      width: 64,
      height: 64,
      format: B8G8R8A8,
    };
    renderer.externals = [old];
    // Submits held for their pipelines: this one waits for them, and so does what samples resource 5.
    share.prepare(1);
    assert.ok(renderer.waits.has(5));
    // The guest unrefs it (the renderer drops its wait), and makes another resource with the same id.
    old.dead = true;
    renderer.waits.delete(5);
    share.forget(5);
    renderer.externals = [{ id: 5, width: 64, height: 64, format: B8G8R8A8 }];
    share.prepare(1);
    assert.ok(renderer.waits.has(5), "the new resource's submits wait too");
    // The held submits go: the old resource's hold ends without taking the new one's with it.
    pending = undefined;
    settle();
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(!renderer.waits.has(5), 'both holds ended');
  } finally {
    console.warn = warn;
  }
});

test('venus-share: the GPU ways keep at most 8 canvases, the least recently used unconfigured as a new size comes', () => {
  const unconfigured: string[] = [];
  const g = globalThis as { OffscreenCanvas?: unknown };
  const had = g.OffscreenCanvas;
  g.OffscreenCanvas = class {
    width: number;
    height: number;
    constructor(width: number, height: number) {
      [this.width, this.height] = [width, height];
    }
    getContext() {
      const key = `${this.width}x${this.height}`;
      return {
        configure() {},
        unconfigure: () => unconfigured.push(key),
        getCurrentTexture: () => ({ createView: () => ({}) }),
      };
    }
  };
  try {
    const renderer = fakeRenderer();
    const share = new VenusShare(fakeDevice(), 'canvas', renderer as unknown as VirglRenderer, () => undefined);
    const copy = (share as unknown as { copyGpu(r: ExternalResource, s: SharedTexture): boolean }).copyGpu.bind(share);
    // A window dragged wider: a new size each frame.
    for (let w = 100; w < 112; w++) {
      const r: ExternalResource = { id: 1, width: w, height: 50, format: B8G8R8A8 };
      assert.ok(copy(r, { texture: texture(w, 50), written: w }));
    }
    assert.equal(renderer.writes, 12);
    assert.deepEqual(unconfigured, ['100x50', '101x50', '102x50', '103x50']);
    // The main surface's size, used every frame, stays while the others come and go: the least recently used goes.
    unconfigured.length = 0;
    const frame = (w: number) =>
      assert.ok(copy({ id: 1, width: w, height: 50, format: B8G8R8A8 }, { texture: texture(w, 50), written: w }));
    frame(104); // the oldest of the 8 kept, used again
    frame(200);
    frame(104);
    frame(201);
    assert.deepEqual(unconfigured, ['105x50', '106x50'], 'the one in use is kept');
  } finally {
    g.OffscreenCanvas = had;
  }
});

test('venus-share: a 16-bit normalized image goes the readback way whatever the mode', () => {
  const renderer = fakeRenderer();
  // The readback's buffer: mapped never (the copy's start is under test).
  const device = new Proxy(fakeDevice(), {
    get: (t, k) =>
      k === 'createBuffer'
        ? () => ({ mapAsync: () => new Promise(() => {}), mapState: 'pending', destroy: () => undefined })
        : (t as unknown as Record<string | symbol, unknown>)[k],
  });
  const src: SharedTexture = { texture: texture(64, 64, 'rgba16unorm' as GPUTextureFormat), written: 1 };
  const share = new VenusShare(device, 'bitmap', renderer as unknown as VirglRenderer, () => src);
  const r = { id: 9, width: 64, height: 64, format: 51 } as ExternalResource; // R16G16B16A16_UNORM
  renderer.externals = [r];
  // When the compositor's submit arrives: its bytes are on their way, and the submit waits for them.
  share.prepare(1);
  assert.equal(share.stats.readbacks, 1);
  assert.ok(renderer.waits.has(9));
  // Before the submit runs, a GPU way copies nothing of it, and stays the way.
  share.refresh(r);
  assert.deepEqual([share.stats.bitmaps, share.stats.canvases, renderer.writes], [0, 0, 0]);
  assert.equal(share.mode, 'bitmap');
  assert.equal(share.stats.checks, 0);
});
