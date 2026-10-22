// Between the virtio-gpu device (web/gpu.ts, in the device worker) and where WebGL2 runs (docs/devices.md "virgl"):
// the device checks the guest's commands and keeps its own tables, and hands the 3D work and, on a 3D machine, the
// screen to a host. The host is the GPU worker (web/gpu-worker.ts) over a MessagePort — the page's top-level worker
// that owns the screen's canvas — or, in tests, a renderer in the same thread. Calls are ordered and answer nothing;
// `fence` resolves once everything before it has run (the device holds a fenced command's reply until then, so the
// guest sees its uploads read and its read-backs written).
import type { Backing, Box, RendererSnapshot, ResourceDesc } from './virgl-renderer.ts';
import type { VirglRenderer } from './virgl-renderer.ts';
import type { Screen } from './virgl-screen.ts';
import { walk } from './virgl.ts';

export type Rect = { x: number; y: number; w: number; h: number };

export type HostCall =
  /** Guest RAM by memory (memory 0, then the spill memories: web/ram.ts). */
  | { t: 'ram'; ram: { buffer: ArrayBufferLike; offset: number; length: number }[] }
  | { t: 'ctx'; id: number; create: boolean }
  | { t: 'res'; desc: ResourceDesc }
  | { t: 'unref'; id: number }
  | { t: 'backing'; id: number; backing: Backing | null }
  | { t: 'ctxres'; ctx: number; res: number; attach: boolean }
  | { t: 'transfer'; ctx: number; res: number; level: number; box: Box; offset: number; stride: number; layerStride: number; toHost: boolean }
  | { t: 'submit'; ctx: number; words: Uint32Array }
  /**
   * The screen shows a 2D resource's pixels (rows `width` pixels apart, in shared memory: the guest's bytes, with the
   * byte positions of R, G and B in `swizzle`; RGBA without it) or a 3D resource; `rect` is the part shown. Neither: the screen is off.
   */
  | { t: 'scanout'; pixels?: Uint8Array; swizzle?: number[]; res?: number; width: number; height: number; rect: Rect }
  /** The scanout's rectangle changed (scanout coordinates): show it. */
  | { t: 'damage'; rect: Rect }
  | { t: 'reset' }
  /** A snapshot's 3D state (`VirglRenderer.save`) in place of what the renderer has (a restore). */
  | { t: 'load'; state: RendererSnapshot };

/** What a host's `save` answers: the renderer's state, or why it can't be saved now. */
export type HostSave = { state: RendererSnapshot } | { refused: string };

export interface VirglHost {
  call(c: HostCall): void;
  /** Resolves when every call before it has run; undefined if they all have already (an in-thread host). */
  fence(): Promise<void> | undefined;
  /** A resource's bytes as the guest would store them (`VirglRenderer.readResource`), once every call before it has run. */
  read?(res: number): Promise<Uint8Array | null>;
  /** The renderer's state for a snapshot, once every call before it has run and its queries have their results. */
  save?(): Promise<HostSave>;
}

/** The renderer's answer to a snapshot (the queries settled first: `pollQueries`). */
export function saveRenderer(r: VirglRenderer): HostSave {
  const refused = r.snapshotRefusal();
  return refused ? { refused } : { state: r.save() };
}

/** The contents' buffers in a renderer's state (to transfer it across a port). */
export function snapshotBuffers(s: RendererSnapshot): ArrayBuffer[] {
  return s.resources.flatMap((r) => r.levels.map((l) => l.data.buffer as ArrayBuffer));
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
    case 'load': return r.load(c.state);
    case 'ram': return;
  }
}

/**
 * Fences in order, each answered once the occlusion queries ended before it have their results: GL's are ready at a
 * fence (a `glFinish` makes them available), WebGL's only after the task that ended them, so the GPU worker holds a
 * fence while they're pending and releases it from its query poll (dEQP-GLES3 occlusion_query).
 */
export class FenceGate<F> {
  private held: { f: F; settled: () => boolean }[] = [];
  private readonly answer: (f: F) => void;
  constructor(answer: (f: F) => void) { this.answer = answer; }
  /** A fence after the calls so far; `settled` says whether the queries they ended have their results. */
  fence(f: F, settled: () => boolean) {
    if (!this.held.length && settled()) return this.answer(f);
    this.held.push({ f, settled });
  }
  /** Answers the held fences whose queries have settled, in order. */
  release() {
    while (this.held.length && this.held[0].settled()) this.answer(this.held.shift()!.f);
  }
  get waiting() { return this.held.length; }
}

/** What the GPU worker takes from the device worker's port: the calls, fences and reads (`portHost`). */
export type WorkerCall = HostCall | { t: 'fence'; id: number; at: number } | { t: 'read'; id: number; res: number } | { t: 'save'; id: number };

/**
 * Whether a submit only decodes: video commands (CCMD 53–61: codecs, buffers, a picture's BEGIN/DECODE/END_FRAME)
 * and what Mesa's VA driver sends with them (its sub-context, its objects, TRANSFER3D into its staging buffers).
 */
export function decodeOnly(words: Uint32Array) {
  let only = true;
  const n = walk(words, (cmd) => { if (!DECODE_SUBMIT.has(cmd)) only = false; });
  return n > 0 && only;
}
// CREATE_OBJECT, SET_SUB_CTX, CREATE_SUB_CTX, DESTROY_SUB_CTX, TRANSFER3D, END_TRANSFERS, SET_TWEAKS, 53–61.
const DECODE_SUBMIT = new Set([1, 28, 29, 30, 43, 44, 46, 53, 54, 55, 56, 57, 58, 59, 60, 61]);

/**
 * The GPU worker's calls in order, with video (docs/plans/video.md §5, §7). The guest expects a picture decoded once
 * its END_FRAME has run (Mesa's virgl makes no fence for it; virglrenderer decodes synchronously), while WebCodecs
 * decodes asynchronously, and a software decoder may hold a picture until later ones come. So a call waits here while
 * it could see a pending picture: one of a context that has a pending picture's plane attached (the renderer gives a
 * context only the resources attached to it), unless the submit only decodes (`decodeOnly`: the decoder gets the
 * later pictures it may be waiting for), and one that names a pending plane. The rest runs, in order: a call that an
 * earlier waiting one must precede waits too (the same context, the same resource; a fence, a read, the screen and
 * what ends a resource's life wait for every earlier waiting call). That includes another context's call that could
 * see what a waiting one draws, a submit of a context sharing an attached resource with it or a transfer of one of
 * its resources: the guest has no sync between contexts beyond the host running their commands in order (a
 * compositor samples a client's buffer right after the client's draws into it were sent; graphics.md §24). If nothing comes out for `nudgeMs` while calls
 * wait, frames held for the next one are sent (`nudge`: AV1's, web/video-av1.ts); after `drainMs`, the decoders that
 * hold pictures are drained (`drain`); after `giveUpMs`, the pending pictures are given up (`giveUp`; the guest sees
 * the buffers' old planes rather than hanging).
 */
export class CallQueue<M extends WorkerCall> {
  private q: M[] = [];
  private readonly o: {
    run(m: M): void;
    /**
     * Whether a pending picture's plane is attached to a context, whether a resource is one, whether two contexts have
     * a resource attached in common and whether a context has a resource attached.
     */
    pending: { ctx(id: number): boolean; res(id: number): boolean; shared(a: number, b: number): boolean; holds(ctx: number, res: number): boolean };
    nudge?(): void; drain(): void; giveUp(): void; nudgeMs?: number; drainMs?: number; giveUpMs?: number;
  };
  /** Since when nothing has come out while calls wait (undefined: none wait). */
  private since?: number;
  private drained = false;
  private nudged = false;
  /** Calls that ran ahead of waiting ones, and the longest wait (ms), for the stats. */
  ahead = 0;
  maxWaitMs = 0;

  constructor(o: CallQueue<M>['o']) { this.o = o; }

  get length() { return this.q.length; }

  push(m: M, now = performance.now()) {
    this.q.push(m);
    this.pump(now);
  }

  /** Runs what may run; call it when a picture comes out (`progress`) and from a timer while `stalled` (`tick`). */
  pump(now = performance.now()) {
    while (this.q.length && this.pass());
    if (this.q.length) this.since ??= now;
    else {
      if (this.since !== undefined) this.maxWaitMs = Math.max(this.maxWaitMs, now - this.since);
      this.since = undefined;
      this.drained = this.nudged = false;
    }
  }

  /** Whether calls wait for pictures. */
  get stalled() { return this.since !== undefined; }

  /** A picture came out (or was given up). */
  progress(now = performance.now()) {
    if (this.since !== undefined) {
      this.maxWaitMs = Math.max(this.maxWaitMs, now - this.since);
      this.since = now;
    }
    this.drained = this.nudged = false;
    this.pump(now);
  }

  /** While stalled: nudges, drains, then gives up, when nothing has come out for long enough. */
  tick(now = performance.now()) {
    if (this.since === undefined) return;
    const idle = now - this.since;
    if (idle >= (this.o.nudgeMs ?? 30) && !this.nudged) {
      this.nudged = true;
      this.o.nudge?.();
    }
    if (idle >= (this.o.drainMs ?? 200) && !this.drained) {
      this.drained = true;
      this.o.drain();
    }
    if (idle >= (this.o.giveUpMs ?? 1000)) this.o.giveUp();
    this.pump(now);
  }

  /** One pass over the queue in order, running what may run (each call sees what the ones before it did); whether it ran any. */
  private pass() {
    const p = this.o.pending;
    // What the waiting calls so far hold back: their contexts and the resources they name.
    const busy = new Set<number>(), named = new Set<number>();
    // Whether a call of `ctx` could see what a waiting context draws (through a resource they share).
    const sees = (ctx: number) => { for (const b of busy) if (p.shared(ctx, b)) return true; return false; };
    const held = (res: number) => { for (const b of busy) if (p.holds(b, res)) return true; return false; };
    let waits = false, ran = false;
    for (let k = 0; k < this.q.length;) {
      const m = this.q[k];
      let go: boolean;
      switch (m.t) {
        case 'submit':
          go = !busy.has(m.ctx) && (decodeOnly(m.words) || (!p.ctx(m.ctx) && !sees(m.ctx)));
          if (!go) busy.add(m.ctx);
          break;
        case 'res':
          go = !named.has(m.desc.id);
          if (!go) named.add(m.desc.id);
          break;
        case 'ctxres':
          go = !busy.has(m.ctx) && !named.has(m.res);
          if (!go) {
            busy.add(m.ctx);
            named.add(m.res);
          }
          break;
        case 'ctx':
          go = !busy.has(m.id);
          if (!go) busy.add(m.id);
          break;
        case 'transfer':
          go = !busy.has(m.ctx) && !named.has(m.res) && !p.res(m.res) && !held(m.res);
          if (!go) {
            busy.add(m.ctx);
            named.add(m.res);
          }
          break;
        case 'backing':
          if (m.backing) {
            go = !named.has(m.id) && !p.res(m.id);
            if (!go) named.add(m.id);
            break;
          }
        // falls through: a backing's detach ends what it held
        case 'unref':
          // What ends a resource waits for every earlier waiting call (a submit may use it), and nothing passes it.
          if (waits || p.res(m.id)) return ran;
          go = true;
          break;
        case 'read':
          if (waits || p.res(m.res)) return ran;
          go = true;
          break;
        case 'save':
          if (waits) return ran;
          go = true;
          break;
        case 'fence': case 'scanout': case 'damage':
          // After every earlier call (a fence says they've all run; the screen shows what they drew), in order.
          go = !waits;
          break;
        default: // reset, load, ram
          if (waits) return ran;
          go = true;
      }
      if (!go) {
        waits = true;
        k++;
        continue;
      }
      this.q.splice(k, 1);
      if (waits) this.ahead++;
      this.o.run(m);
      ran = true;
    }
    return ran;
  }
}

/** A host in this thread: calls run at once. */
export function localHost(r: VirglRenderer, screen?: Screen): VirglHost {
  return { call: (c) => void runCall(c, r, screen), fence: () => undefined, read: (res) => Promise.resolve(r.readResource(res)), save: () => Promise.resolve(saveRenderer(r)) };
}

/** How long the device worker took to see the GPU worker's `fenced` answers (bench/gpu's stats): their count, total and longest ms. */
export const fenceLag = { n: 0, ms: 0, maxMs: 0 };
/** Now on a clock both workers share (their `performance.now()`s start at different times). */
export const clock = () => performance.timeOrigin + performance.now();

/** A host across a port (the device worker's end of the GPU worker). */
export function portHost(port: MessagePort): VirglHost {
  let next = 1;
  const waiting = new Map<number, () => void>();
  const reads = new Map<number, (bytes: Uint8Array | null) => void>();
  const saves = new Map<number, (s: HostSave) => void>();
  port.onmessage = (e: MessageEvent<{ t: 'fenced'; id: number; at: number } | { t: 'read'; id: number; bytes: Uint8Array | null } | ({ t: 'saved'; id: number } & HostSave)>) => {
    if (e.data?.t === 'read') {
      reads.get(e.data.id)?.(e.data.bytes);
      reads.delete(e.data.id);
      return;
    }
    if (e.data?.t === 'saved') {
      const { id, t, ...answer } = e.data;
      void t;
      saves.get(id)?.(answer);
      saves.delete(id);
      return;
    }
    if (e.data?.t !== 'fenced') return;
    const lag = clock() - e.data.at;
    fenceLag.n++;
    fenceLag.ms += lag;
    fenceLag.maxMs = Math.max(fenceLag.maxMs, lag);
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
      else if (c.t === 'load') port.postMessage(c, snapshotBuffers(c.state));
      else port.postMessage(c);
    },
    fence() {
      const id = next++;
      port.postMessage({ t: 'fence', id, at: clock() });
      return new Promise<void>((resolve) => waiting.set(id, resolve));
    },
    read(res) {
      const id = next++;
      port.postMessage({ t: 'read', id, res });
      return new Promise((resolve) => reads.set(id, resolve));
    },
    save() {
      const id = next++;
      port.postMessage({ t: 'save', id });
      return new Promise((resolve) => saves.set(id, resolve));
    },
  };
}
