// The device backends' owner on the VM's thread (`deviceHost`): the device worker (web/device-worker.ts), or the
// backends inline; and the xHCI's port as `attach`/`detach`.
import type { UsbFromWorker, UsbIdentity, UsbState, UsbToWorker, UsbVirtual } from './usb-device.ts';
import { CLOSE_MS, Devices, specPorts, stateBuffers, type DevicesInit } from './devices.ts';
import { ring } from './virtio.ts';
import { fromWire, type Msg } from './msg.ts';
import type { DeviceAnswer, FromDeviceWorker, ToDeviceWorker } from './device-worker.ts';
import type { InspectAnswer, InspectQuery } from './surface.ts';
import { newWorker, type WarmWorkers } from './warm-workers.ts';
import { endWithOwner, type CloseOptions } from './worker-end.ts';

/** `attach` and `detach` over the xHCI's port, each resolving with its `usb-state` (one per request, in order; a keyboard's `usb-leds` isn't an answer). */
export function usbHost(port: MessagePort) {
  const waiting: { connector: number; resolve: (m: UsbState) => void }[] = [];
  port.onmessage = (e: MessageEvent<UsbFromWorker>) => {
    if (e.data.type !== 'usb-state') return;
    const i = waiting.findIndex((w) => w.connector === e.data.connector);
    if (i >= 0) waiting.splice(i, 1)[0].resolve(e.data);
  };
  const ask = (m: UsbToWorker) =>
    new Promise<UsbState>((resolve) => {
      waiting.push({ connector: m.connector, resolve });
      port.postMessage(m);
    });
  return {
    attach: (connector: number, device: UsbIdentity | UsbVirtual) => ask({ type: 'usb-attach', connector, device }),
    detach: (connector: number) => ask({ type: 'usb-detach', connector }),
  };
}

/**
 * `ring` with a wait that yields instead of blocking: resolves once the backends took everything up to this ring, or
 * once `stopped` (the host's close: a closed `Devices.serve` answers no ring, and a pause's quiesce would wait for good).
 */
async function ringAsync(bell: Int32Array, stopped: () => boolean) {
  const n = Atomics.add(bell, 0, 1) + 1;
  Atomics.notify(bell, 0);
  for (let a; (((a = Atomics.load(bell, 1)) - n) | 0) < 0;) {
    if (a === -1) throw new Error('device backends failed (see their error)');
    if (stopped()) return;
    const w = Atomics.waitAsync(bell, 1, a, 100);
    if (w.async) await w.value;
  }
}

/** `e` as an Error (what a promise rejects with and a function throws here). */
const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));

/**
 * `e`, or the backends' own error where the doorbell says they failed (word 1 is -1: `ring`'s "device backends
 * failed"): `failure` brings it a moment later (the device worker's message, `serve`'s rejection); `e` if it doesn't
 * come within a second.
 */
async function backendsFailure(bell: Int32Array, failure: Promise<Error>, e: unknown): Promise<Error> {
  if (Atomics.load(bell, 1) !== -1) return asError(e);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Error>((resolve) => (timer = setTimeout(resolve, 1000, asError(e))));
  try {
    return await Promise.race([failure, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The backends: in a device worker when this thread can block on it (a
 * worker), inline otherwise. `kick` hands them what a DEVICE exit posted and
 * returns once they've taken all of it (deterministic mode). Exported for its tests (tests/device-host.test.ts).
 */
export async function deviceHost(
  init: DevicesInit,
  bellAddr: number,
  parallel: boolean,
  notice?: (m: Msg) => void,
  warm?: WarmWorkers,
) {
  let text = '';
  const out = (_device: number, t: string) => {
    text += t;
  };
  const inWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
  if (parallel && !inWorker) {
    // The vCPU workers ring the doorbell; this thread serves it between its awaits.
    const d = await Devices.open(init, out, notice);
    let failed: Error | undefined;
    let failedNow: (e: Error) => void = () => {};
    const failure = new Promise<Error>((resolve) => (failedNow = resolve));
    let closed = false;
    const bell = new Int32Array(init.memory.buffer, bellAddr, 2);
    void d.serve(bell).catch((e: unknown) => {
      failed = asError(e);
      failedNow(failed);
    });
    return {
      kick: (_wait: boolean) => {
        throw new Error('parallel: the vCPU workers ring the doorbell');
      },
      inFlight: () => false,
      settle: async () => {
        if (failed) throw failed;
      },
      failure: (e: unknown) => backendsFailure(bell, failure, e),
      quiesce: () =>
        ringAsync(bell, () => closed).catch(async (e: unknown) => {
          throw await backendsFailure(bell, failure, e);
        }),
      save: async () => d.save(),
      refusal: () => d.refusal(),
      written: async (i: number) => d.written(i),
      blocks: async (i: number, blocks: Uint32Array) => d.blocks(i, blocks),
      compact: (measure?: boolean) => d.compact(measure),
      inspect: (i: number, query: InspectQuery) => d.inspect(i, query),
      hint: (ms: number) => d.hint(ms),
      release: () => d.release(),
      output: () => text,
      flush: async () => {
        if (failed) throw failed;
      },
      close: async (_c?: CloseOptions) => {
        closed = true;
        Atomics.notify(bell, 1); // a quiesce waiting for its answer
        d.close();
        return d.stats();
      },
    };
  }
  if (!inWorker || (init.specs.length === 0 && !init.xhci)) {
    // blk over HTTP needs a worker (Node has no XHR; a page can't make binary sync XHRs); Node reads `file:` images.
    const d = await Devices.open(init, out, notice);
    // Requests complete asynchronously (disk reads return promises), so `run`
    // hands a DEVICE exit to its caller while they're in flight, and the
    // caller awaits `settle` before resuming: the same step as in a worker.
    let pending: Promise<void> | undefined;
    return {
      kick: (_wait: boolean) => {
        pending = d.poll();
      },
      inFlight: () => pending !== undefined,
      settle: async () => {
        await pending;
        pending = undefined;
      },
      failure: async (e: unknown) => asError(e), // a poll's own error, which `settle` throws
      quiesce: async () => {
        await pending;
        pending = d.poll();
        await pending;
        pending = undefined;
      },
      save: async () => d.save(),
      refusal: () => d.refusal(),
      written: async (i: number) => d.written(i),
      blocks: async (i: number, blocks: Uint32Array) => d.blocks(i, blocks),
      compact: (measure?: boolean) => d.compact(measure),
      inspect: (i: number, query: InspectQuery) => d.inspect(i, query),
      hint: (ms: number) => d.hint(ms),
      release: () => d.release(),
      output: () => text,
      flush: async () => {},
      close: async (_c?: CloseOptions) => (d.close(), d.stats()),
    };
  }
  const worker = warm?.take('device') ?? newWorker('device');
  // Requests and their answers pair by id (docs/host-code.md §2.4); `closed` answers what a closed worker never will.
  type Asked<T> = T extends { id: number } ? Omit<T, 'id'> : never;
  type Ask = Asked<ToDeviceWorker>;
  type Waiter = { answer: (a: DeviceAnswer) => void; fail: (e: Error) => void; closed: () => void };
  const waiting = new Map<number, Waiter>();
  let askId = 0;
  let ended = false; // `closed` came (or the close's wait ran out): nothing more is answered
  /** The device worker's error after `ready` (a backend threw in `Devices.serve`): what every later ask fails with. */
  let failed: Error | undefined;
  let failedNow: (e: Error) => void = () => {};
  const failure = new Promise<Error>((resolve) => (failedNow = resolve));
  /** Asks `m`; `answer` reads the answer (it may throw); `closed` is the value when the worker closes unanswered. */
  const ask = <T>(m: Ask, answer: (a: DeviceAnswer) => T, closed: () => T) =>
    new Promise<T>((resolve, reject) => {
      const settle = (f: () => T) => {
        try {
          resolve(f());
        } catch (e) {
          reject(asError(e));
        }
      };
      if (failed !== undefined) return reject(failed);
      if (ended) return settle(closed);
      const id = askId++;
      waiting.set(id, { answer: (a) => settle(() => answer(a)), fail: reject, closed: () => settle(closed) });
      worker.postMessage({ ...m, id });
    });
  const settleAll = (how: (w: Waiter) => void) => {
    const all = [...waiting.values()];
    waiting.clear();
    for (const w of all) how(w);
  };
  const gone = () => {
    throw new Error('the device worker closed');
  };
  const disk = (a: DeviceAnswer) => {
    if (a.type !== 'disk') throw new Error(`device worker: ${a.type} for a disk's request`);
    if (a.error) throw new Error(a.error);
    return a;
  };
  let closing: Promise<unknown> | undefined;
  /** The close's `ending` (web/worker-end.ts `endWithOwner`). */
  let endingClose = false;
  let closedWith = (_stats?: unknown) => {};
  const ready = new Promise<void>((resolve, reject) => {
    let started = false;
    worker.onerror = (e) => reject(new Error(`device worker: ${e.message}`));
    worker.onmessage = (e: MessageEvent<FromDeviceWorker>) => {
      const m = e.data;
      if (m.type === 'ready') {
        started = true;
        resolve();
      } else if (m.type === 'error') {
        // The error as the device worker had it (its fields, an overlay's `problem`, kept: web/app/worker-errors.ts `explain`).
        const err = m.error ? fromWire(m.error) : new Error(`device worker: ${m.message}`);
        if (!started) return reject(err);
        failed ??= err;
        const why = failed;
        failedNow(why);
        settleAll((w) => w.fail(why));
      } else if (m.type === 'console') out(m.device, m.text);
      else if (m.type === 'notice') notice?.(m.message);
      else if (m.type === 'closed') {
        ended = true;
        endWithOwner(worker, endingClose); // its files released (it never ends itself: web/device-worker.ts)
        settleAll((w) => w.closed());
        closedWith(m.stats);
      } else {
        const w = waiting.get(m.id);
        waiting.delete(m.id);
        w?.answer(m);
      }
    };
  });
  // A restore's state is the device worker's from here: its bytes (a 3D renderer's contents, ~100 MB on a desktop)
  // moved, not copied (a copy took ~80 ms of the start; bench/boot/REPORT.md "SNAPZ loop 7").
  worker.postMessage({ type: 'init', ...init, bell: bellAddr } satisfies ToDeviceWorker, [
    ...specPorts(init.specs),
    ...(init.xhci?.port ? [init.xhci.port] : []),
    ...stateBuffers(init.state ?? []),
  ]);
  // before anything blocks on it; a worker that failed to start is ended (its overlays' locks and the memory with it)
  await ready.catch((e: unknown) => {
    worker.terminate();
    throw e;
  });
  const bell = new Int32Array(init.memory.buffer, bellAddr, 2);
  const failureOf = (e: unknown) => backendsFailure(bell, failure, e);
  return {
    inFlight: () => false,
    settle: async () => {
      if (failed !== undefined) throw failed;
    },
    failure: failureOf,
    // A remote disk's requests run on after a poll (realtime, R4): they complete before the doorbell is answered.
    quiesce: async () => {
      // what the last poll hadn't taken: the drain waits for it too
      await ringAsync(bell, () => closing !== undefined).catch(async (e: unknown) => {
        throw await failureOf(e);
      });
      if (closing) return;
      await ask(
        { type: 'drain' },
        () => undefined,
        () => undefined,
      );
    },
    /** The backends' state for a snapshot (web/devices.ts `Devices.save`). */
    save: () =>
      ask(
        { type: 'save' },
        (a) => {
          if (a.type === 'saved' && a.state) return a.state;
          const m = a as Extract<DeviceAnswer, { type: 'saved' }>;
          throw m.wire ? fromWire(m.wire) : new Error(m.error ?? 'the device worker has no state');
        },
        gone,
      ),
    /** Why a snapshot would be refused now (web/devices.ts `Devices.refusal`), or undefined. */
    refusal: () =>
      closing
        ? Promise.resolve(undefined)
        : ask(
            { type: 'refusal' },
            (a) => (a.type === 'refusal' ? a.refused : undefined),
            () => undefined,
          ),
    written: (i: number) => ask({ type: 'written', device: i }, (a) => disk(a).written, gone),
    blocks: (i: number, blocks: Uint32Array) => ask({ type: 'blocks', device: i, blocks }, (a) => disk(a).bytes!, gone),
    compact: (measure?: boolean) =>
      ask({ type: 'compact', measure }, (a) => disk(a).compacted ?? { before: 0, after: 0 }, gone),
    inspect: async (i: number, query: InspectQuery): Promise<InspectAnswer> =>
      closing
        ? { kind: 'none' }
        : ask<InspectAnswer>(
            { type: 'inspect', device: i, query },
            (a) => disk(a).inspected ?? { kind: 'none' },
            () => ({ kind: 'none' }),
          ),
    // Bounded here too: a worker that hangs meanwhile answers nothing.
    hint: async (ms: number) =>
      closing
        ? undefined
        : Promise.race([
            ask(
              { type: 'hint', ms },
              (a) => disk(a).hinted,
              () => undefined,
            ),
            new Promise<undefined>((r) => setTimeout(() => r(undefined), ms + 2000)),
          ]),
    release: () => {
      if (!closing) worker.postMessage({ type: 'release' } satisfies ToDeviceWorker);
    },
    kick: (wait: boolean) => ring(bell, wait), // completions come back through SIGNAL_DEVICE
    output: () => text,
    flush: () =>
      ask(
        { type: 'flush' },
        () => undefined,
        () => undefined,
      ),
    /**
     * Resolves once it released its files (so another VM can open the overlay), or after `CLOSE_MS` and a little
     * if it doesn't answer (e.g. a sync XHR still waiting); the same promise on a second call. Then the worker is
     * ended: terminated, or with `ending` left to this thread's end (web/worker-end.ts `endWithOwner`). The value is
     * the blk timers of devices with `stats` (web/iostats.ts), if any.
     */
    close: (c: CloseOptions = {}) =>
      (closing ??= new Promise<unknown>((resolve) => {
        endingClose = !!c.ending;
        closedWith = resolve;
        setTimeout(() => {
          if (!ended) endWithOwner(worker, endingClose);
          ended = true;
          settleAll((w) => w.closed());
          resolve(undefined);
        }, CLOSE_MS + 500);
        worker.postMessage({ type: 'close' });
        Atomics.notify(bell, 1); // a quiesce waiting for its answer
      })),
  };
}
