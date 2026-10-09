// Between the virtio-gpu device (web/gpu.ts, in the device worker) and where WebGL2 runs (docs/devices.md "virgl"):
// the device checks the guest's commands and keeps its own tables, and hands the 3D work and, on a 3D machine, the
// screen to a host. The host is the GPU worker (web/gpu-worker.ts) over a MessagePort — the page's top-level worker
// that owns the screen's canvas — or, in tests, a renderer in the same thread. Calls are ordered and answer nothing;
// `fence` resolves once everything before it has run (the device holds a fenced command's reply until then, so the
// guest sees its uploads read and its read-backs written).
import type { Backing, Box, ResourceDesc } from './virgl-renderer.ts';
import type { VirglRenderer } from './virgl-renderer.ts';
import type { Screen } from './virgl-screen.ts';

export type Rect = { x: number; y: number; w: number; h: number };

export type HostCall =
  | { t: 'ram'; buffer: ArrayBufferLike; offset: number; length: number }
  | { t: 'ctx'; id: number; create: boolean }
  | { t: 'res'; desc: ResourceDesc }
  | { t: 'unref'; id: number }
  | { t: 'backing'; id: number; backing: Backing | null }
  | { t: 'ctxres'; ctx: number; res: number; attach: boolean }
  | { t: 'transfer'; ctx: number; res: number; level: number; box: Box; offset: number; stride: number; layerStride: number; toHost: boolean }
  | { t: 'submit'; ctx: number; words: Uint32Array }
  /** The screen shows a 2D resource's RGBA (rows `width` pixels apart, in shared memory) or a 3D resource; `rect` is the part shown. Neither: the screen is off. */
  | { t: 'scanout'; pixels?: Uint8Array; res?: number; width: number; height: number; rect: Rect }
  /** The scanout's rectangle changed (scanout coordinates): show it. */
  | { t: 'damage'; rect: Rect }
  | { t: 'reset' };

export interface VirglHost {
  call(c: HostCall): void;
  /** Resolves when every call before it has run; undefined if they all have already (an in-thread host). */
  fence(): Promise<void> | undefined;
  /** A resource's bytes as the guest would store them (`VirglRenderer.readResource`), once every call before it has run. */
  read?(res: number): Promise<Uint8Array | null>;
}

/** Runs a host call on a renderer and a screen (the GPU worker's loop, or a test's in-thread host). */
export function runCall(c: HostCall, r: VirglRenderer, screen?: Screen) {
  switch (c.t) {
    case 'ctx': return c.create ? r.createContext(c.id) : r.destroyContext(c.id);
    case 'res': return r.createResource(c.desc);
    case 'unref': return r.unrefResource(c.id);
    case 'backing': return c.backing ? r.attachBacking(c.id, c.backing) : r.detachBacking(c.id);
    case 'ctxres': return c.attach ? r.attach(c.ctx, c.res) : r.detach(c.ctx, c.res);
    case 'transfer': return r.transfer(c.ctx, c.res, c.level, c.box, c.offset, c.stride, c.layerStride, c.toHost);
    case 'submit': return r.submit(c.ctx, c.words);
    case 'scanout': return screen?.scanout(c);
    case 'damage': return screen?.damage(c.rect);
    case 'reset': {
      screen?.scanout({ width: 0, height: 0, rect: { x: 0, y: 0, w: 0, h: 0 } });
      return r.reset();
    }
    case 'ram': return;
  }
}

/** A host in this thread: calls run at once. */
export function localHost(r: VirglRenderer, screen?: Screen): VirglHost {
  return { call: (c) => void runCall(c, r, screen), fence: () => undefined, read: (res) => Promise.resolve(r.readResource(res)) };
}

/** A host across a port (the device worker's end of the GPU worker). */
export function portHost(port: MessagePort): VirglHost {
  let next = 1;
  const waiting = new Map<number, () => void>();
  const reads = new Map<number, (bytes: Uint8Array | null) => void>();
  port.onmessage = (e: MessageEvent<{ t: 'fenced'; id: number } | { t: 'read'; id: number; bytes: Uint8Array | null }>) => {
    if (e.data?.t === 'read') {
      reads.get(e.data.id)?.(e.data.bytes);
      reads.delete(e.data.id);
      return;
    }
    if (e.data?.t !== 'fenced') return;
    // Fences complete in order: this one and every earlier one.
    for (const [id, done] of waiting) {
      if (id > e.data.id) break;
      waiting.delete(id);
      done();
    }
  };
  return {
    call(c) {
      if (c.t === 'submit') port.postMessage(c, [c.words.buffer]);
      else port.postMessage(c);
    },
    fence() {
      const id = next++;
      port.postMessage({ t: 'fence', id });
      return new Promise<void>((resolve) => waiting.set(id, resolve));
    },
    read(res) {
      const id = next++;
      port.postMessage({ t: 'read', id, res });
      return new Promise((resolve) => reads.set(id, resolve));
    },
  };
}
