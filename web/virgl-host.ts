// Between the virtio-gpu device (web/gpu.ts, in the device worker) and where WebGL2 runs (docs/devices.md "virgl", docs/graphics.md "The GPU worker"):
// the device checks the guest's commands and keeps its own tables, and hands the 3D work and, on a 3D machine, the
// screen to a host. The host is the GPU worker (web/gpu-worker.ts) over a MessagePort — the page's top-level worker
// that owns the screen's canvas — or, in tests, a renderer in the same thread. Calls are ordered and answer nothing;
// `fence` resolves once everything before it has run (the device holds a fenced command's reply until then, so the
// guest sees its uploads read and its read-backs written).
import type { Backing, Box, RendererSnapshot, ResourceDesc } from './virgl-renderer.ts';
import type { VirglRenderer } from './virgl-renderer.ts';
import type { Screen } from './virgl-screen.ts';
import { walk } from './virgl.ts';
import { toWire, type WireError } from './msg.ts';

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
  | { t: 'load'; state: RendererSnapshot }
  | VenusCall;

/**
 * Venus's (docs/devices.md "The host-visible window"): its contexts, its blob resources (host memory the renderer
 * keeps, mapped into the window at an offset the guest picked, and out of it again), their attachments, and its
 * submits as the guest wrote them. The virgl renderer passes them over (`runCall`); Venus's renderer takes them.
 */
export type VenusCall =
  | { t: 'vctx'; id: number; create: boolean; name?: string }
  | { t: 'blob'; ctx: number; res: number; mem: number; flags: number; blobId: bigint; size: number }
  | { t: 'blob-map'; res: number; offset: number; size: number }
  | { t: 'blob-unmap'; res: number }
  | { t: 'blob-unref'; res: number }
  /** A blob attached to a context, or with `size` a virgl resource attached to a Venus context (its bytes as the guest sees them): imported (web/venus-import.ts). */
  | { t: 'blob-ctx'; ctx: number; res: number; attach: boolean; size?: number }
  /** A SUBMIT_3D's bytes, and with the fence flag its fence (the renderer retires it before the device answers). */
  | { t: 'vsubmit'; ctx: number; bytes: Uint8Array; fence?: { flags: number; ring: number; id: bigint } }
  /** The renderer's memory (memory 1: the GPU worker instantiates it there), the window in it, and memory 0 (`core`), where the write-watch's words are. */
  | { t: 'venus-init'; memory: WebAssembly.Memory; core: WebAssembly.Memory; window: { at: number; bytes: number; watch: number } };

/** What a host's `save` answers: the renderer's state, or why it can't be saved now. */
export type HostSave = { state: RendererSnapshot } | { refused: WireError };

/**
 * A Venus fence: its context, ring and id. It stands for that ring's work, and only that: another client's fence doesn't
 * depend on it (and may not wait for it: a queue's work can wait for what the guest does later, vk/README.md "Waits
 * before their signal"). `ringed`: the guest said the ring (`FLAG_INFO_RING_IDX`), so the fence is of a dma-fence
 * context of its own in the guest and may be answered out of the device's order; one without shares the virgl fences'
 * context, whose answers must stay in order (a later one signals the earlier ones).
 */
export type FenceScope = { ctx: number; ring: number; id: bigint; ringed: boolean };

export interface VirglHost {
  call(c: HostCall): void;
  /** Resolves when every call before it has run; undefined if they all have already (an in-thread host). With `scope`, a Venus fence: `FenceScope`. */
  fence(scope?: FenceScope): Promise<void> | undefined;
  /** A resource's bytes as the guest would store them (`VirglRenderer.readResource`), once every call before it has run. */
  read?(res: number): Promise<Uint8Array | null>;
  /** The renderer's state for a snapshot, once every call before it has run and its queries have their results. */
  save?(): Promise<HostSave>;
}

/** The renderer's answer to a snapshot (the queries settled first: `pollQueries`). */
export function saveRenderer(r: VirglRenderer): HostSave {
  const refused = r.snapshotRefusal();
  return refused ? { refused: toWire(refused) } : { state: r.save() };
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
    default: return; // Venus's calls: its own renderer's
  }
}

/**
 * Fences in order within a lane, each answered once what it waits for has happened. Virgl's (the unnamed lane): GL's
 * occlusion queries are ready at a fence (a `glFinish` makes them available), WebGL's only after the task that ended
 * them, so the GPU worker holds a fence while they're pending and releases it from its query poll (dEQP-GLES3
 * occlusion_query). A ring of Venus's is a lane of its own: its fences wait for the ring's work, and that can be as long
 * as the guest likes, so nothing else may wait with them (VK4 R1).
 */
export class FenceGate<F> {
  private held: { f: F; settled: () => boolean; lane?: string }[] = [];
  private readonly answer: (f: F) => void;
  constructor(answer: (f: F) => void) { this.answer = answer; }
  /** A fence after the calls so far; `settled` says whether what it waits for has happened. */
  fence(f: F, settled: () => boolean, lane?: string) {
    if (!this.held.some((h) => h.lane === lane) && settled()) return this.answer(f);
    this.held.push({ f, settled, lane });
  }
  /** Answers the held fences that have settled, in order in each lane. */
  release() {
    const stopped = new Set<string | undefined>();
    this.held = this.held.filter((h) => {
      if (stopped.has(h.lane) || !h.settled()) {
        stopped.add(h.lane);
        return true;
      }
      this.answer(h.f);
      return false;
    });
  }
  get waiting() { return this.held.length; }
  /** The oldest fence held in the unnamed lane (a ring's may wait for the guest as long as it likes). */
  get oldest(): F | undefined { return this.held.find((h) => h.lane === undefined)?.f; }
}

/** The lane of `FenceGate` a fence goes in. */
export const fenceLane = (scope?: FenceScope) => (scope?.ringed ? `${scope.ctx}:${scope.ring}` : undefined);

/**
 * How the GPU worker looks again at pending occlusion queries (WebGL has a query's result only in a task after the one
 * that ended it, and no event when it comes): `timeout`, a 4 ms timer; `message`, the next task (a message to itself:
 * the thread busy while any are pending); `wait`, `Atomics.waitAsync`'s 0.25 ms timeout; `ticker`, woken by a ticker
 * worker's notify every 0.05 ms (web/venus-ticker.ts, as Venus's pump) while any are pending; `spin`, `message` for
 * `SPIN_MS` since the pending set last changed (a query added or settled: `next`'s `changes`, not the count, which a
 * client keeping one in flight holds at 1), then `timeout`: the default (PERF loop 16, bench/gpu/REPORT.md: a
 * result came ~0.75 ms after its end on the M4, a 4 ms timer saw it ~13 ms after, the thread busy only while it waits).
 */
export type QueryPoll = 'timeout' | 'message' | 'wait' | 'ticker' | 'spin';

/** How long `spin` polls at every task since the pending set last changed (ms). */
export const SPIN_MS = 2;

/**
 * A scheduler of the next poll, the way asked (`QueryPoll`); `timeout` where the way isn't there. `next` is told how many
 * are pending and a count of the changes to the set so far (the renderer's `queryChanges`); `idle()` says none are pending
 * any more (the ticker parks: blocked on its word 1, no CPU). The ticker's worker is the GPU worker's child, ended with it
 * (the page terminates the GPU worker, and a worker's dedicated workers end with their owner); one GPU worker has one
 * scheduler, made once. `clock` is `spin`'s (ms; tests give their own).
 */
export function queryScheduler(way: QueryPoll, poll: () => void, ticker?: () => Worker, clock: () => number = () => performance.now()): { next(pending: number, changes: number): true; idle(): void } {
  const idle = () => {};
  if (way === 'spin' && typeof MessageChannel !== 'undefined') {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => poll();
    (ch.port1 as { unref?: () => void }).unref?.(); // Node's (tests): the port alone doesn't keep the process
    let since = 0, last = -1;
    return {
      next: (_pending, changes) => {
        const now = clock();
        if (changes !== last) [since, last] = [now, changes];
        if (now - since < SPIN_MS) ch.port2.postMessage(0);
        else setTimeout(poll, 4);
        return true;
      },
      idle: () => { last = -1; },
    };
  }
  if (way === 'ticker' && ticker && typeof Atomics.waitAsync === 'function' && typeof SharedArrayBuffer !== 'undefined') {
    const sab = new SharedArrayBuffer(8), w = new Int32Array(sab);
    let worker: Worker | undefined;
    return {
      next: () => {
        if (!worker) (worker = ticker()).postMessage({ sab, period: 0.05 });
        Atomics.store(w, 1, 1);
        Atomics.notify(w, 1);
        const r = Atomics.waitAsync(w, 0, Atomics.load(w, 0), 4);
        if (r.async) void r.value.then(poll);
        else setTimeout(poll, 0);
        return true;
      },
      idle: () => Atomics.store(w, 1, 0),
    };
  }
  if (way === 'message' && typeof MessageChannel !== 'undefined') {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => poll();
    return { next: () => (ch.port2.postMessage(0), true), idle };
  }
  if (way === 'wait' && typeof Atomics.waitAsync === 'function' && typeof SharedArrayBuffer !== 'undefined') {
    const w = new Int32Array(new SharedArrayBuffer(4));
    return {
      next: () => {
        const r = Atomics.waitAsync(w, 0, 0, 0.25);
        if (r.async) void r.value.then(poll);
        else setTimeout(poll, 0);
        return true;
      },
      idle,
    };
  }
  return { next: () => (setTimeout(poll, 4), true), idle };
}

/**
 * What a fence waits for: every earlier call to have run (`backlog`: Venus's wait for its module) and, by its scope,
 * its own retirement (a ring's are in order, and its lane keeps them so; nothing sent after it: a later fence of the
 * ring may wait for what the guest does once this one is answered) or virgl's queries. A hold of the device's (a blob's,
 * a context's end) has no scope: those calls run at once, and they mustn't wait for a queue's work.
 */
export function fenceSettled(scope: FenceScope | undefined, host: { queries(): () => boolean; backlog(): boolean; venus(): { retired(ctx: number, ring: number, id: bigint): boolean } | undefined }) {
  const queries = scope ? undefined : host.queries();
  return () => {
    if (host.backlog()) return false;
    if (!scope) return queries!();
    return host.venus()?.retired(scope.ctx, scope.ring, scope.id) ?? true;
  };
}

/** What the GPU worker takes from the device worker's port: the calls, fences and reads (`portHost`). */
export type WorkerCall = HostCall | { t: 'fence'; id: number; at: number; scope?: FenceScope } | { t: 'read'; id: number; res: number } | { t: 'save'; id: number };

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

/** Whether a submit destroys a sub-context (DESTROY_SUB_CTX): it doesn't pass its context's waiting calls, which may use it. */
function destroysSub(words: Uint32Array) {
  let yes = false;
  walk(words, (cmd) => { if (cmd === 30) yes = true; });
  return yes;
}

/**
 * The GPU worker's calls in order, with video (docs/graphics.md "Video's findings"). The guest expects a picture decoded once
 * its END_FRAME has run (Mesa's virgl makes no fence for it; virglrenderer decodes synchronously), while WebCodecs
 * decodes asynchronously, and a software decoder may hold a picture until later ones come. So a call waits here while
 * it could see a pending picture: one of a context that has a pending picture's plane attached (the renderer gives a
 * context only the resources attached to it), unless the submit only decodes (`decodeOnly`: the decoder gets the
 * later pictures it may be waiting for), and one that names a pending plane. The rest runs, in order: a call that an
 * earlier waiting one must precede waits too (the same context, the same resource; a fence, a read, the screen and
 * what ends a resource's life wait for every earlier waiting call). That includes another context's call that could
 * see what a waiting one draws, a submit of a context sharing an attached resource with it or a transfer of one of
 * its resources: the guest has no sync between contexts beyond the host running their commands in order (a
 * compositor samples a client's buffer right after the client's draws into it were sent; docs/graphics.md "The call queue"). If nothing comes out for `nudgeMs` while calls
 * wait, frames held for the next one are sent (`nudge`: AV1's, web/video-av1.ts); after `drainMs`, the decoders that
 * hold pictures are drained (`drain`); after `giveUpMs`, the pending pictures are given up (`giveUp`; the guest sees
 * the buffers' old planes rather than hanging); and a picture pending for `oldMs` is given up whatever comes out
 * (`giveUpOld`).
 */
export class CallQueue<M extends WorkerCall> {
  /** The waiting calls, each with its place in the guest's order. */
  private q: { m: M; n: number }[] = [];
  private next = 0;
  private readonly o: {
    /** Runs a call; `n` is its place in the guest's order (the pictures it decodes take it: `VideoContext`). */
    run(m: M, n: number): void;
    /**
     * Whether a pending picture's plane is attached to a context, whether a resource is one (of the pictures decoded
     * by calls before `before`: a call never waits for a later one's), whether two contexts have a resource attached
     * in common and whether a context has a resource attached.
     */
    pending: {
      ctx(id: number, before: number): boolean; res(id: number, before: number): boolean; shared(a: number, b: number): boolean; holds(ctx: number, res: number): boolean;
      /** Whether a submit (its context's first waiting one) could see a pending plane: finer than `ctx` (a context that decodes and draws has every picture's planes attached). Without it, `ctx`. */
      submit?(ctx: number, words: Uint32Array, before: number): boolean;
    };
    /** After the calls that could run ran: pictures held back from their planes (`sees`) may be written now. */
    ran?(): void;
    nudge?(): void; drain(): void; giveUp(): void; nudgeMs?: number; drainMs?: number; giveUpMs?: number;
    /**
     * Gives up the pictures pending since before a time, called while calls wait with `now - oldMs`: one a decoder
     * never outputs while later ones come out (so `giveUp` never comes) would hold them as long as decoding goes on.
     */
    giveUpOld?(before: number): void; oldMs?: number;
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
    this.q.push({ m, n: this.next++ });
    this.pump(now);
  }

  /**
   * Whether a call before `before` that still waits could see these planes: a picture that call `before` decoded
   * isn't written into them until it can't (a decode runs ahead of its own context's waiting draws, and the guest may
   * decode into a surface a draw before it samples).
   */
  sees(planes: readonly number[], before: number) {
    const p = this.o.pending;
    for (const { m, n } of this.q) {
      if (n >= before) break;
      const ctx = m.t === 'submit' || m.t === 'ctxres' || m.t === 'transfer' ? m.ctx : undefined;
      const res = m.t === 'transfer' || m.t === 'read' || m.t === 'ctxres' ? m.res : m.t === 'unref' || m.t === 'backing' ? m.id : undefined;
      for (const r of planes) if (r === res || (ctx !== undefined && p.holds(ctx, r))) return true;
    }
    return false;
  }

  /** Runs what may run; call it when a picture comes out (`progress`) and from a timer while `stalled` (`tick`). */
  pump(now = performance.now()) {
    while (this.q.length && this.pass());
    this.o.ran?.();
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
    this.o.giveUpOld?.(now - (this.o.oldMs ?? 3000));
    this.pump(now);
  }

  /** One pass over the queue in order, running what may run (each call sees what the ones before it did); whether it ran any. */
  private pass() {
    const p = this.o.pending;
    // What the waiting calls so far hold back: their contexts and the resources they name.
    const busy = new Set<number>(), named = new Set<number>();
    // The contexts with a waiting call other than a draw (a transfer, an attach or detach, the context's end): a
    // decode, which may read what it brings, doesn't pass it.
    const strict = new Set<number>();
    // Whether a call of `ctx` could see what a waiting context draws (through a resource they share).
    const sees = (ctx: number) => { for (const b of busy) if (p.shared(ctx, b)) return true; return false; };
    const held = (res: number) => { for (const b of busy) if (p.holds(b, res)) return true; return false; };
    let waits = false, ran = false;
    for (let k = 0; k < this.q.length;) {
      const { m, n } = this.q[k];
      let go: boolean;
      switch (m.t) {
        case 'submit':
          // A decode passes its own context's waiting calls too: in one process (Chromium's GPU process decodes and
          // draws on one context), a draw waiting for a picture a software decoder holds would otherwise hold back the
          // later pictures the decoder waits for. What it writes waits for them instead (`sees`). Every submit of Mesa's
          // virgl selects its sub-context first (past its queued transfers), so one run ahead leaves none behind.
          if (decodeOnly(m.words) && !(busy.has(m.ctx) && destroysSub(m.words))) go = !strict.has(m.ctx);
          else {
            go = !busy.has(m.ctx) && !(p.submit ? p.submit(m.ctx, m.words, n) : p.ctx(m.ctx, n)) && !sees(m.ctx);
            if (!go) busy.add(m.ctx);
          }
          break;
        case 'res':
          go = !named.has(m.desc.id);
          if (!go) named.add(m.desc.id);
          break;
        case 'ctxres':
          // An attach only makes a resource reachable (no earlier call names one not yet attached), so it passes its
          // context's waiting draws as a decode does (Chromium attaches each new picture's planes); a detach doesn't.
          go = (m.attach || !busy.has(m.ctx)) && !named.has(m.res);
          if (!go) {
            busy.add(m.ctx);
            strict.add(m.ctx);
            named.add(m.res);
          }
          break;
        case 'ctx':
          go = !busy.has(m.id);
          if (!go) {
            busy.add(m.id);
            strict.add(m.id);
          }
          break;
        case 'transfer':
          go = !busy.has(m.ctx) && !named.has(m.res) && !p.res(m.res, n) && !held(m.res);
          if (!go) {
            busy.add(m.ctx);
            strict.add(m.ctx);
            named.add(m.res);
          }
          break;
        case 'backing':
          if (m.backing) {
            go = !named.has(m.id) && !p.res(m.id, n);
            if (!go) named.add(m.id);
            break;
          }
        // falls through: a backing's detach ends what it held
        case 'unref':
          // What ends a resource waits for every earlier waiting call (a submit may use it), and nothing passes it.
          if (waits || p.res(m.id, n)) return ran;
          go = true;
          break;
        case 'read':
          if (waits || p.res(m.res, n)) return ran;
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
        case 'vctx': case 'blob-ctx':
          // Venus's calls that end things are as an unref: after every earlier call, and nothing passes them.
          if (!(m.t === 'vctx' ? m.create : m.attach)) {
            if (waits) return ran;
            go = true;
            break;
          }
        // falls through: one that makes a context or attaches a resource runs at once, as do the others below
        case 'blob': case 'blob-map': case 'vsubmit':
          // Venus's own: no virgl call waits on them, and its rings, which are polled and pass every queued call,
          // may name what they make (a resource the guest imports: web/venus-import.ts) before the queue would run it.
          go = true;
          break;
        default: // reset, load, ram, venus-init; Venus's blob-unmap and blob-unref
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
      this.o.run(m, n);
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

/** How long a fence may go unanswered before the console says so (`portHost`, the GPU worker's `FenceGate`). */
export const STUCK_MS = 5000;

/** A host across a port (the device worker's end of the GPU worker). */
export function portHost(port: MessagePort): VirglHost {
  let next = 1;
  const waiting = new Map<number, () => void>();
  // A fence unanswered for `STUCK_MS` is said on the console once (the guest's GPU tasks wait behind it; the GPU
  // worker says why when it holds one for queries), and when it's answered.
  const sent = new Map<number, number>();
  const stuck = new Set<number>();
  let watch: ReturnType<typeof setInterval> | undefined;
  const check = () => {
    if (!sent.size) {
      clearInterval(watch);
      watch = undefined;
      return;
    }
    for (const [id, at] of sent) {
      if (clock() - at <= STUCK_MS) break;
      if (stuck.has(id)) continue;
      stuck.add(id);
      console.warn(`virgl: fence ${id} unanswered for ${((clock() - at) / 1000).toFixed(0)} s (the guest's 3D waits behind it)`);
    }
  };
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
    // This one alone: a ring's fences are answered out of the others' order (`FenceGate`).
    const id = e.data.id, done = waiting.get(id);
    if (!done) return;
    waiting.delete(id);
    if (stuck.delete(id)) console.warn(`virgl: fence ${id} answered after ${((clock() - sent.get(id)!) / 1000).toFixed(0)} s`);
    sent.delete(id);
    done();
  };
  return {
    call(c) {
      if (c.t === 'submit') port.postMessage(c, [c.words.buffer]);
      else if (c.t === 'load') port.postMessage(c, snapshotBuffers(c.state));
      else port.postMessage(c);
    },
    fence(scope) {
      const id = next++;
      const at = clock();
      port.postMessage({ t: 'fence', id, at, ...(scope ? { scope } : {}) });
      sent.set(id, at);
      watch ??= setInterval(check, 1000);
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
