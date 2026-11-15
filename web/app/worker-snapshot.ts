// The machine worker's snapshots and suspension (web/app/worker.ts; docs/frontend.md "Snapshots", "Suspend"): the
// running machine paused, written, and resumed or closed. The guest's clock after them is the guest agent's
// (docs/frontend.md "The guest's clock").
import type { Vm } from '../vm.ts';
import { msg, MsgError, toWire } from '../msg.ts';
import { fileWriter, suspendWriter } from '../overlay.ts';
import type { Codec, Sink } from '../snapshot-file.ts';
import { writeSnapshot } from '../snapshot.ts';
import { makeRoom } from '../diskcache.ts';
import type { lzCodec } from '../lz.ts';
import { startPool, type SavePool } from '../snapshot-pool.ts';
import type { Machine } from './machine.ts';
import { header, type Session } from './worker-header.ts';
import { post, progress, state, throttled } from './worker-post.ts';
import type { SaveTimes } from './protocol.ts';

/**
 * How long the guest may take to hand over its free memory before a save (the balloon's hint, web/balloon.ts): its
 * allocator takes every free block, zeroing it. Past it the save goes on (the guest's blocks come back after it).
 */
export const HINT_MS = 10_000;

/** The tail of the serial output a snapshot carries, so a restored terminal isn't empty. */
export const TAIL = 4096;

/** The running machine, as a snapshot or a suspension takes it from the worker (web/app/worker.ts `running`). */
export type Running = {
  vm: Vm;
  session: Session;
  machine: Machine;
  /** The OPFS directory of the machine's variable store and suspended copy. */
  home: string | undefined;
  /** The serial output's tail now. */
  serial: () => string;
  /** Whether the disk in `slot` is a stored disk written in place (its overlay is its store). */
  inPlace: (slot: number) => boolean;
  /** Whether the machine is being stopped (it can be by the time an `await` returns). */
  stopping: () => boolean;
  codec: () => ReturnType<typeof lzCodec>;
  /** Closes the suspended machine without running another step (its run loop ends without a word). */
  close: () => Promise<void>;
};

let snapshotting = false;

/**
 * Answers `snapshot-check`: what a device would refuse a snapshot or a suspend (`what`) for now (Vulkan in use, a
 * video decoding: `Vm.refusal`), as the save would say it, or nothing. The page asks before it touches the machine
 * (the USB ports emptied, the pause); the save asks the devices again, paused.
 */
export async function checkSnapshot(r: Running | undefined, id: number, what: 'snapshot' | 'suspend') {
  let refused;
  try {
    const why = r && (await r.vm.refusal());
    if (why)
      refused = toWire(
        what === 'snapshot'
          ? new MsgError('snapshots:worker-snapshot.notSaved', {}, { cause: why })
          : new MsgError('machine:worker-snapshot.suspend.failed', {}, { cause: why }),
      );
  } catch {
    // Not answered: the save decides.
  }
  post({ type: 'snapshot-check', id, ...(refused ? { refused } : {}) });
}

/** The header's fields for the machine as it is now. */
function meta(r: Running) {
  // The terminal's tail from a line start: a cut escape sequence would draw garbage in the restored terminal.
  const serial = r.serial();
  const cut = serial.length >= TAIL ? serial.indexOf('\n') + 1 : 0;
  return header(r.session, r.machine.label, serial.slice(cut));
}

type Out = { sink: Sink; close: () => Promise<void>; abort: () => Promise<void> };
/** The buffers the page gave back (`snapshot-spare`) for the save in progress (its id): its next chunks go in them. */
let spare: { id: number; buffers: ArrayBuffer[] } | undefined;
/** A chunk's buffer back from the page, for save `id`'s next chunks. */
export function spareBuffer(id: number, buffer: ArrayBuffer) {
  if (spare?.id === id) spare.buffers.push(buffer);
}
/** A frame's largest size (a RAM chunk's codec bound, and its header): a chunk buffer holds any. */
const CHUNK_BUFFER = (1 << 20) + 4096;

/**
 * Where a snapshot goes: the picked file's stream (`handle`), the store's file `keep`, or the page in chunks (each
 * copied into a buffer the page gave back, else a new one, and transferred: the page copies it into a Blob and gives
 * it back, so a file's worth of buffers never waits for a GC in this worker or the page). Opened before the machine is
 * paused, closed (flushed) after it resumed; `abort` drops whatever is still open.
 */
async function output(id: number, handle?: FileSystemFileHandle, keep?: string): Promise<Out> {
  let out = await handle?.createWritable();
  let kept: Awaited<ReturnType<typeof fileWriter>> | undefined;
  try {
    kept = keep ? await fileWriter(keep, makeRoom) : undefined;
  } catch (err) {
    await out?.abort().catch(() => undefined);
    throw err;
  }
  spare = out || kept ? undefined : { id, buffers: [] };
  const sink: Sink = async (chunk) => {
    if (kept) return kept.write(chunk);
    if (out) return out.write(chunk as Uint8Array<ArrayBuffer>);
    const have = spare?.buffers.pop();
    const buffer =
      have && have.byteLength >= chunk.length ? have : new ArrayBuffer(Math.max(chunk.length, CHUNK_BUFFER));
    const copy = new Uint8Array(buffer, 0, chunk.length);
    copy.set(chunk); // the sink's bytes are its only until it returns (web/snapshot-file.ts `Sink`)
    post({ type: 'snapshot-chunk', id, data: copy }, [buffer]);
  };
  return {
    sink,
    close: async () => {
      await out?.close();
      out = undefined;
      kept?.close();
      kept = undefined;
      spare = undefined;
    },
    // Left open only by a failure (the one reported); an abort that fails has nothing to add to it.
    abort: async () => {
      if (spare?.id === id) spare = undefined;
      await out?.abort().catch(() => undefined);
      await kept?.abort().catch(() => undefined);
    },
  };
}

/**
 * The guest's free memory handed over (zeroed, held by its balloon driver until `release`), right before the pause, so
 * that the snapshot leaves it out: how long it took and its bytes (undefined: no balloon's hint).
 */
async function hint(r: Running, id: number) {
  progress(id, msg('snapshots:worker-snapshot.phase.freeing'), 0);
  const t0 = performance.now();
  const h = await r.vm.hint(HINT_MS).catch(() => undefined);
  return h && { hintMs: performance.now() - t0, hinted: h.bytes };
}

/**
 * Pauses the machine, writes its snapshot to `sink` (a stored disk written in place left out unless `whole`) and
 * resumes it, also on an error. The guest's clock stands still meanwhile: the page has the agent set it after.
 */
async function pausedWrite(r: Running, id: number, sink: Sink, lz: Codec, o: { whole: boolean; pool?: SavePool }) {
  const v = r.vm;
  progress(id, msg('snapshots:worker-snapshot.phase.pausing'), 0);
  const t0 = performance.now();
  if (!(await v.pause())) throw new MsgError('snapshots:worker-snapshot.ended');
  const pause = performance.now() - t0;
  try {
    const w = await writeSnapshot(v, sink, meta(r), lz, {
      omit: (slot) => !o.whole && r.inPlace(slot),
      pool: o.pool,
      progress: throttled(id, msg('snapshots:worker-snapshot.phase.writing')),
    });
    return { ...w, pause };
  } finally {
    v.resume();
  }
}

/**
 * The save's pool, started before the pause (with the hint: its start isn't paused time), and how long the save waited
 * for it after the hint (`poolWait`) and its start took (`poolReady`); `close` ends it, whatever came of it.
 */
function poolFor(r: Running) {
  // None when it can't start (web/snapshot-pool.ts): the save runs on this thread.
  const started = r
    .codec()
    .then((lz) => startPool(lz.module))
    .catch(() => undefined);
  return {
    async ready() {
      const t = performance.now();
      const pool = await started;
      return { pool, times: { poolWait: performance.now() - t, poolReady: pool?.readyMs ?? 0 } };
    },
    close: () => void started.then((p) => p?.close()),
  };
}

/**
 * Saves a snapshot of the running machine `r` (docs/frontend.md "Snapshots"): the VM is paused, written
 * to the picked file's stream or sent back in chunks, and resumed, also on an error. Only the
 * writing is between pause and resume: the file's stream is opened before, and closed (flushed)
 * after.
 */
export async function saveSnapshot(
  r: Running | undefined,
  id: number,
  handle?: FileSystemFileHandle,
  keep?: string,
  whole = false,
) {
  const fail = (error: unknown) => post({ type: 'snapshot-error', id, error: toWire(error) });
  if (!r)
    return fail(
      new MsgError('snapshots:worker-snapshot.notRunning', undefined, {
        cause: new MsgError('snapshots:worker-snapshot.notRunning.cause'),
      }),
    );
  if (snapshotting)
    return fail(
      new MsgError('snapshots:worker-snapshot.saving', undefined, {
        cause: new MsgError('snapshots:worker-snapshot.saving.cause'),
      }),
    );
  snapshotting = true;
  let out: Out | undefined;
  let pool: ReturnType<typeof poolFor> | undefined;
  try {
    const lz = await r.codec();
    pool = poolFor(r);
    out = await output(id, handle, keep);
    let hinted;
    let w;
    let pausedMs;
    let started;
    try {
      hinted = await hint(r, id);
      started = await pool.ready();
      const t0 = performance.now();
      w = await pausedWrite(r, id, out.sink, lz, { whole, pool: started.pool });
      pausedMs = performance.now() - t0;
    } finally {
      r.vm.release(); // the guest's free memory back to it, the save done or not
      pool.close();
    }
    progress(id, msg('snapshots:worker-snapshot.phase.finishing'), 1);
    const t1 = performance.now();
    await out.close();
    const { bytes, stateMs, blobBytes, pins, pause } = w;
    const phases: SaveTimes = { ...w.phases, ...started.times, pause, close: performance.now() - t1 };
    post({ type: 'snapshot-done', id, bytes, pausedMs, stateMs, blobBytes, pins, ...hinted, phases });
  } catch (err) {
    fail(new MsgError('snapshots:worker-snapshot.notSaved', {}, { cause: err }));
  } finally {
    pool?.close();
    await out?.abort();
    snapshotting = false;
  }
}

/** Writes the suspended copy beside the overlay in `home`; its size and where the time went (but the pause's). */
async function writeSuspended(r: Running, home: string, id: number, lz: Codec, pool?: SavePool) {
  const out = await suspendWriter(home, makeRoom);
  try {
    const w = await writeSnapshot(r.vm, (chunk) => out.write(chunk), meta(r), lz, {
      suspend: true,
      pool,
      progress: throttled(id, msg('machine:worker-snapshot.phase.suspending')),
    });
    const t = performance.now();
    out.close();
    return { bytes: w.bytes, phases: { ...w.phases, close: performance.now() - t } };
  } catch (err) {
    await out.abort();
    throw err;
  }
}

/** Why the machine can't be suspended now, or none. */
function cantSuspend(r: Running | undefined) {
  if (!r)
    return new MsgError('machine:worker-snapshot.suspend.notRunning', undefined, {
      cause: new MsgError('machine:worker-snapshot.suspend.notRunning.cause'),
    });
  if (!r.home)
    return new MsgError('machine:worker-snapshot.suspend.noHome', undefined, {
      cause: new MsgError('machine:worker-snapshot.suspend.noHome.cause'),
    });
  if (snapshotting)
    return new MsgError('machine:worker-snapshot.suspend.busy', undefined, {
      cause: new MsgError('machine:worker-snapshot.suspend.busy.cause'),
    });
  return undefined;
}

/**
 * Suspends the machine (docs/frontend.md "Suspend"): paused, its snapshot without the disk's blocks
 * is written beside the overlay, and the machine is closed without running another step, so the
 * overlay is exactly what the file's RAM expects. A failure before that leaves it running.
 */
export async function suspend(r: Running | undefined, id: number) {
  const fail = (error: unknown) => post({ type: 'snapshot-error', id, error: toWire(error) });
  const refused = cantSuspend(r);
  if (refused || !r?.home) return fail(refused);
  const home = r.home;
  snapshotting = true;
  let paused = false;
  let closing = false;
  let pool: ReturnType<typeof poolFor> | undefined;
  try {
    const lz = await r.codec();
    pool = poolFor(r);
    // A restored machine's balloon gives the hinted memory back (web/balloon.ts `restore`); a failed suspend here.
    await hint(r, id);
    const started = await pool.ready();
    progress(id, msg('snapshots:worker-snapshot.phase.pausing'), 0);
    const t0 = performance.now();
    if (!(await r.vm.pause())) throw new MsgError('snapshots:worker-snapshot.ended');
    paused = true;
    const pause = performance.now() - t0;
    const { bytes, phases } = await writeSuspended(r, home, id, lz, started.pool);
    const pausedMs = performance.now() - t0;
    pool.close();
    // From here the machine must not run: the file is only good for the disk as it is now.
    closing = true;
    await r.close();
    post({ type: 'suspend-done', id, bytes, pausedMs, phases: { ...phases, ...started.times, pause } });
    state('suspended', { note: msg('machine:worker-snapshot.suspended', { size: bytes }) });
  } catch (err) {
    if (paused && !closing) r.vm.resume();
    if (!closing) r.vm.release();
    fail(new MsgError('machine:worker-snapshot.suspend.failed', {}, { cause: err }));
  } finally {
    pool?.close();
    snapshotting = false;
  }
}
