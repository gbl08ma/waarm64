// Virgl's resources into Venus's textures (web/venus-import.ts; vk/README.md "Imports"), in Node with stand-ins for the
// WebGPU device and the virgl renderer: what each imported texture is written with, and when, while the GPU worker's
// queue work is held behind submits (web/venus-gpu.ts `later`), pictures are pending, resources end and the renderer
// is reset (VK3 L4c-C: the static review's finding 3 and "the import maps outlive resets").
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VenusImport } from '../web/venus-import.ts';

const R8 = 64;

/** A virgl renderer as the import sees it: resources (R8, 2×1) with bytes, and planes with a picture pending. */
function renderer() {
  const resources = new Map<number, Uint8Array>();
  const pending = new Set<number>();
  return {
    resources, pending, readbacks: 0,
    resourceInfo(id: number) { return resources.has(id) ? { format: R8, width: 2, height: 1 } : undefined; },
    readResource(id: number) { this.readbacks++; return resources.get(id)?.slice() ?? null; },
    videoPending: { res: (id: number) => pending.has(id) },
  };
}

/** A device whose queue records each texture write as `<texture>=<bytes>`, and textures named for it. */
function device() {
  const writes: string[] = [];
  const names = new Map<object, string>();
  return {
    writes,
    texture(name: string) {
      const t = { format: 'r8unorm', width: 2, height: 1 };
      names.set(t, name);
      return t as unknown as GPUTexture;
    },
    queue: { writeTexture(dst: { texture: object }, data: Uint8Array) { writes.push(`${names.get(dst.texture)}=${[...data].join(',')}`); } },
  };
}

/** `VenusGpu.later`'s order: work goes at once, or after held submits (`hold`/`drain`). */
function queue() {
  let held: (() => void)[] | undefined;
  return {
    later: (f: () => void) => (held ? held.push(f) : f()),
    hold() { held = []; },
    drain() { const h = held ?? []; held = undefined; for (const f of h) f(); },
  };
}

function setup() {
  const r = renderer(), d = device(), q = queue();
  const im = new VenusImport(d as unknown as GPUDevice, r as never, q.later);
  /** A picture written into resource `res` (virgl's texture has it, then the import is told: `onPlane`). */
  const picture = (res: number, ...bytes: number[]) => {
    r.resources.set(res, new Uint8Array(bytes));
    im.plane(res, new Uint8Array(bytes), 2, 1, 1);
  };
  return { r, d, q, im, picture };
}

test('VenusImport: a bind while its picture is pending reads nothing back; the picture, when it lands, is written', () => {
  const { r, d, im, picture } = setup();
  r.resources.set(5, new Uint8Array([0, 0])); // a fresh surface: its virgl texture still empty
  r.pending.add(5);
  const t = d.texture('T');
  im.bind(t, 5);
  assert.equal(r.readbacks, 0, 'a pending resource is read back');
  assert.deepEqual(d.writes, []);
  r.pending.delete(5);
  picture(5, 7, 8);
  assert.deepEqual(d.writes, ['T=7,8']);
  // Imported again (each frame it shows): the picture, not a readback.
  im.bind(d.texture('U'), 5);
  assert.equal(r.readbacks, 0);
  assert.deepEqual(d.writes, ['T=7,8', 'U=7,8']);
});

test('VenusImport: a bind held behind submits, whose resource ends and whose id is reused, takes nothing of the new one', () => {
  const { r, d, q, im } = setup();
  r.resources.set(5, new Uint8Array([1, 1]));
  q.hold();
  im.bind(d.texture('T'), 5); // the driver's bind of resource 5's import, held
  // The resource ends (virgl's unref runs at once) and its id comes back for another surface.
  im.unref(5);
  r.resources.set(5, new Uint8Array([9, 9]));
  q.drain();
  assert.deepEqual(d.writes, [], 'the held bind wrote the reused id\'s bytes');
  // The new resource's first import reads its own bytes back, not a stale copy.
  im.bind(d.texture('U'), 5);
  assert.deepEqual(d.writes, ['U=9,9']);
});

test('VenusImport: a picture held behind submits for a resource that then ends leaves nothing for the id\'s next owner', () => {
  const { r, d, q, im, picture } = setup();
  r.resources.set(5, new Uint8Array([1, 1]));
  const t = d.texture('T');
  im.bind(t, 5);
  q.hold();
  picture(5, 3, 3); // the picture's write, held
  im.unref(5);
  r.resources.set(5, new Uint8Array([9, 9]));
  q.drain();
  // The texture of the ended resource stays out of the new one's pictures, and the new one's import reads its bytes.
  picture(5, 4, 4);
  im.bind(d.texture('U'), 5);
  assert.deepEqual(d.writes, ['T=1,1', 'T=3,3', 'U=4,4']);
  im.bind(t, 0);
});

test('VenusImport: a reset (or a snapshot\'s load) forgets every resource\'s bytes and textures', () => {
  const { r, d, im, picture } = setup();
  r.resources.set(5, new Uint8Array([1, 1]));
  im.bind(d.texture('T'), 5);
  picture(5, 3, 3);
  im.reset();
  // After the reset id 5 is another resource: its import reads its bytes; its pictures go only to its own textures.
  r.resources.set(5, new Uint8Array([9, 9]));
  im.bind(d.texture('U'), 5);
  picture(5, 4, 4);
  assert.deepEqual(d.writes, ['T=1,1', 'T=3,3', 'U=9,9', 'U=4,4']);
});
