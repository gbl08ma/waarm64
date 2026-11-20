// The virtio-gpu device's queues around a `Gpu` (web/gpu.ts; docs/devices.md "virtio-gpu"): commands taken from the
// controlq and the cursorq, and their replies sent in order: a fenced command's once the host has run it, a paced
// flush's at the frame's end, Venus's ring fences' out of line as their fences retire.
import { gather, scatter, type Ctx, type Request } from './devices.ts';
import {
  busy,
  EVENT_DISPLAY,
  FLAG_FENCE,
  Gpu,
  RESOURCE_FLUSH,
  SUBMIT_3D,
  type GpuHooks,
  type GpuOptions,
} from './gpu.ts';
import { FLAG_INFO_RING_IDX } from './venus.ts';

/** The virtio-gpu backend (queue 0: controlq, 1: cursorq) around a `Gpu`. */
export function gpuBackend(ctx: Ctx, o: GpuOptions, hooks: GpuHooks = {}) {
  const gpu = new Gpu(() => ctx.ram(), ctx.layout, o);
  gpu.hooks = hooks;
  gpu.raise = () =>
    ctx.changeConfig((c) => {
      const v = new DataView(c.buffer, c.byteOffset, 16);
      v.setUint32(0, v.getUint32(0, true) | EVENT_DISPLAY, true);
    });
  // Replies not sent yet, in order: a fenced command's waits for the host (`ready` once it has run), and with
  // `paceFlushes` a flush that follows the last within a frame waits for the frame's end, with all behind it.
  type Held = {
    w0: number;
    len: number;
    flush: boolean;
    ready: boolean;
    behind: boolean;
    at: number;
    type: number;
    write: Request['write'];
    reply: Uint8Array;
  };
  let held: Held[] = [];
  // Replies to ring fences (Venus's), sent when their fence retires. They are out of line: such a fence stands for a
  // queue's work, which may wait for the guest's own signal, and the replies held behind it would fill the queue before
  // the guest got to send that (docs/devices.md "Venus"). The kernel takes fences of different rings in any order.
  // They hold queue entries meanwhile, and a program that queues work waiting for its own signal, from the thread that
  // sends it, can fill the queue and stop that thread in the kernel. So while the queue is full (`QUEUE_FULL` entries) and
  // for `RING_STALL_MS` neither has a ring fence retired nor has the guest sent anything, the second newest of the ring
  // with most gives its entry back: answered with no fence flag, its fence stays unsignalled in the kernel until the next
  // fence of that ring to be answered signals it (a fence signals the earlier ones of its dma-fence context). One entry
  // at a time, and only then (dEQP's timeline_semaphore.device_host hung when entries came back at any 8 held).
  // A guest may wait for such a fence alone while the ring's newest waits for what it does next, so once its own work is
  // done (`loose`, `due`) the next reply that has no fence of its own says it (`carry`): the guest's next command's, or,
  // when the guest sends nothing for `CARRY_MS`, the display event's GET_DISPLAY_INFO, which the kernel sends from its
  // own work (the review of R1 to R4's C2, VK4 T36).
  type Ringed = Held & { lane: string; id: bigint; seq: number; due: boolean };
  const QUEUE_FULL = 16,
    RING_STALL_MS = 250,
    CARRY_MS = 20;
  const rings = new Set<Ringed>();
  let loose: Ringed[] = [];
  let ringSeq = 0;
  let carryWatch: ReturnType<typeof setTimeout> | undefined;
  // A reply that has no fence of its own takes the newest due fence of a ring (which signals the earlier ones of its
  // dma-fence context, ring and all) before it is completed.
  const carry = (write: Request['write'], reply: Uint8Array) => {
    if (reply.length < 24) return;
    const v = new DataView(reply.buffer, reply.byteOffset, reply.length);
    if (v.getUint32(4, true) & FLAG_FENCE) return;
    const due = loose.filter((l) => l.due);
    if (!due.length) return;
    const h = due.filter((l) => l.lane === due[0].lane).reduce((a, b) => (b.seq > a.seq ? b : a));
    loose = loose.filter((l) => l.lane !== h.lane || l.seq > h.seq);
    v.setUint32(4, v.getUint32(4, true) | FLAG_FENCE, true);
    v.setBigUint64(8, h.id, true);
    scatter(ctx.ram(), write, reply);
  };
  const askCarrier = () => {
    carryWatch = undefined;
    if (!loose.some((l) => l.due)) return;
    gpu.raise?.();
    carryWatch = setTimeout(askCarrier, CARRY_MS);
  };
  let ringActive = 0;
  let ringWatch: ReturnType<typeof setTimeout> | undefined;
  const giveBack = () => {
    const lanes = new Map<string, Ringed[]>();
    for (const h of rings) lanes.set(h.lane, [...(lanes.get(h.lane) ?? []), h]);
    const most = [...lanes.values()].reduce((a, b) => (b.length > a.length ? b : a));
    if (most.length < 2) return;
    const h = most[most.length - 2];
    rings.delete(h);
    loose.push(h);
    new DataView(h.reply.buffer, h.reply.byteOffset, h.reply.length).setUint32(4, 0, true);
    scatter(ctx.ram(), h.write, h.reply);
    ctx.complete(h.w0, h.len);
  };
  const full = () => rings.size + held.length >= QUEUE_FULL;
  const watchRings = () => {
    ringWatch = undefined;
    if (!full()) return;
    if (performance.now() - ringActive >= RING_STALL_MS) {
      for (let before = 0; full() && rings.size > 1 && rings.size !== before;) {
        before = rings.size;
        giveBack();
      }
      ringActive = performance.now();
    }
    armRings();
  };
  // Armed for what is left of the stall, not a whole `RING_STALL_MS` again: a timer may fire a little before
  // `performance.now()` says it is due (a cloud host's mostly do), and the guest's queue would then wait for twice the stall;
  // the same for activity since the timer was armed.
  const armRings = () => {
    if (full())
      ringWatch ??= setTimeout(watchRings, Math.max(1, Math.ceil(ringActive + RING_STALL_MS - performance.now())));
  };
  // The stats' queue occupancy (`?displaystats`): the most replies held at once, and the time QUEUE_FULL of them were
  // (the page's queue size: the guest's ring had no free entry, so its next command waited).
  let fullSince = -1;
  const occupancy = () => {
    busy.heldMax = Math.max(busy.heldMax, held.length);
    const now = performance.now();
    if (held.length >= QUEUE_FULL && fullSince < 0) fullSince = now;
    else if (held.length < QUEUE_FULL && fullSince >= 0) {
      busy.fullMs += now - fullSince;
      fullSince = -1;
    }
  };
  let lastFlush = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const FRAME_MS = 1000 / 60;
  const pump = (fromTimer = false) => {
    while (held.length) {
      const h = held[0];
      if (!h.ready) return;
      if (h.flush && o.paceFlushes) {
        const now = performance.now();
        if (!fromTimer && now - lastFlush < FRAME_MS) {
          timer ??= setTimeout(
            () => {
              timer = undefined;
              pump(true);
            },
            Math.max(0, lastFlush + FRAME_MS - now),
          );
          return;
        }
        // A frame's end is a frame after the last, not when the timer got to run (timers are late: the rate would sag below 60).
        lastFlush = fromTimer && now - lastFlush < 2 * FRAME_MS ? lastFlush + FRAME_MS : now;
        fromTimer = false;
      }
      held.shift();
      carry(h.write, h.reply);
      busy.heldMs += performance.now() - h.at;
      if (h.behind) busy.behindMs += performance.now() - h.at;
      occupancy();
      busy.events?.push(performance.timeOrigin + performance.now(), 0x10000 + h.type);
      ctx.complete(h.w0, h.len);
    }
  };
  return {
    gpu,
    request(r: Request) {
      const ram = ctx.ram();
      const len = r.read.reduce((n, s) => n + s.len, 0);
      const cmd = gather(ram, r.read, len);
      if (r.queue === 1) {
        gpu.cursor(cmd);
        return 0;
      }
      const room = r.write.reduce((n, s) => n + s.len, 0);
      const t0 = (ringActive = performance.now());
      const type = cmd.length >= 4 ? new DataView(cmd.buffer, cmd.byteOffset, 4).getUint32(0, true) : 0;
      busy.events?.push(performance.timeOrigin + t0, type);
      const reply = gpu.control(cmd, room);
      scatter(ram, r.write, reply);
      busy.request += performance.now() - t0;
      busy.requests++;
      const wait = gpu.takeWait();
      const flush = !!o.paceFlushes && type === RESOURCE_FLUSH;
      const now = performance.now();
      if (
        wait &&
        type === SUBMIT_3D &&
        new DataView(cmd.buffer, cmd.byteOffset, cmd.length).getUint32(4, true) & FLAG_INFO_RING_IDX
      ) {
        const c = new DataView(cmd.buffer, cmd.byteOffset, cmd.length);
        const h: Ringed = {
          w0: r.w0,
          len: reply.length,
          flush,
          ready: false,
          behind: false,
          at: now,
          type,
          lane: `${c.getUint32(16, true)}:${c.getUint8(20)}`,
          write: r.write,
          reply,
          id: c.getBigUint64(8, true),
          seq: ringSeq++,
          due: false,
        };
        rings.add(h);
        void wait.then(() => {
          ringActive = performance.now();
          if (rings.delete(h)) {
            // It signals the earlier fences of its ring, those without an entry too.
            loose = loose.filter((l) => l.lane !== h.lane || l.seq > h.seq);
            ctx.complete(h.w0, h.len);
          } else if (loose.includes(h)) {
            h.due = true;
            carryWatch ??= setTimeout(askCarrier, CARRY_MS);
          }
        });
        armRings();
        return undefined;
      }
      if (held.length || wait || (flush && now - lastFlush < FRAME_MS)) {
        // `behind`: neither fenced nor a paced flush, held only for the replies before it.
        const h: Held = {
          w0: r.w0,
          len: reply.length,
          flush,
          ready: !wait,
          behind: !wait && !flush,
          at: now,
          type,
          write: r.write,
          reply,
        };
        held.push(h);
        occupancy();
        armRings();
        if (wait) {
          busy.fences++;
          void wait.then(() => {
            const dt = performance.now() - now;
            busy.fenceMs += dt;
            busy.fenceMaxMs = Math.max(busy.fenceMaxMs, dt);
            h.ready = true;
            pump();
          });
        } else pump();
        return undefined;
      }
      if (flush) lastFlush = now;
      carry(r.write, reply);
      return reply.length;
    },
    // events_clear: write-one-to-clear of events_read; the guest's write is taken and zeroed.
    config() {
      const c = ctx.config();
      const v = new DataView(c.buffer, c.byteOffset, 16);
      const clear = v.getUint32(4, true);
      if (clear) {
        v.setUint32(0, v.getUint32(0, true) & ~clear, true);
        v.setUint32(4, 0, true);
        if (clear & EVENT_DISPLAY) gpu.eventsCleared();
      }
    },
    reset: () => {
      clearTimeout(timer);
      timer = undefined;
      held = [];
      rings.clear();
      loose = [];
      clearTimeout(carryWatch);
      carryWatch = undefined;
      clearTimeout(ringWatch);
      ringWatch = undefined;
      fullSince = -1;
      gpu.reset();
    },
    save: () => gpu.save(),
    refusal: () => gpu.refusal(),
    restore: (state: unknown) => gpu.restore(state),
  };
}
