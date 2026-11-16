// Where a disk's surface comes from (the disk surface visualizer, docs/frontend.md "A disk's surface"): the machine that
// runs on this page, when it has the disk attached as the window shows it (its device worker answers from the maps it
// has in memory, through the machine's worker: `inspect`), or else the disk's files, read by a job worker
// (web/app/surface-worker.ts); a ramdisk not running has nothing to show. `chooseSource` decides (pure: Node's tests
// run it), `sourceFor` makes the source; every ask is bounded (a worker that went away never answers).
import { msg, type Msg } from '../msg.ts';
import { mergeLock } from '../overlay.ts';
import type { InspectAnswer, InspectQuery, RangeDetail, Surface } from '../surface.ts';
import type { PageState } from './areas/power.svelte.ts';
import type { FromWorker, ToWorker } from './protocol.ts';
import type { Replies } from './run/replies.ts';
import type { SurfaceJob } from './surface-job.ts';
import type { Attachment, DiskRecord } from './shape.ts';
import { diskDir, overlayDir, type OverlayRecord } from './store.ts';

/** A window's view: a disk, and the overlay laid over it (none: the disk alone). */
export type SurfaceTarget = { disk: string; overlay?: string };

/** The machine that runs on this page, as the choice needs it: its attachments in slot order. */
export type RunningMachine = { attachments: readonly Attachment[] };

/** Where a view's numbers come from. */
export type SourceChoice =
  /** The running machine's `disk`-th disk (slot order); `inPlace`: a stored disk written in place (its store is the disk). */
  | { kind: 'live'; disk: number; inPlace: boolean }
  /** The files, read by a job (`SurfaceJob` without its query; `handle`: an image file's, whose file the job gets where it may be read without asking). */
  | { kind: 'offline'; job: OfflineJob }
  | { kind: 'unavailable'; why: Msg };

/** A job as the choice has it: an image file's by its handle (`jobSource` turns it into the file). */
export type OfflineJob = Omit<SurfaceJob, 'query' | 'file'> & { handle?: FileSystemFileHandle };

/** Whether attachment `a` of disk `d` shows the disk as `t` asks: through overlay `t.overlay`, or the disk itself. */
function shows(t: SurfaceTarget, d: DiskRecord, a: Attachment) {
  if (a.disk !== d.id) return false;
  const ownOverlay = !a.readOnly && !a.inPlace && d.kind !== 'ramdisk';
  if (t.overlay) return ownOverlay && a.overlay === t.overlay;
  // The disk alone: read-only, written in place, or a ramdisk (it has no overlay).
  return a.readOnly || d.kind === 'ramdisk' || (d.kind === 'stored' && !!a.inPlace);
}

/**
 * Where view `t` of disk `d` (its record; `o` the overlay's, when `t` has one) comes from: live when `running` (the
 * machine on this page, from its loading to its stop: `holdsDisks`) has the disk attached that way; else the files,
 * unless that machine holds them (a stored disk it writes in place); a ramdisk only lives in a running machine. A stored disk viewed alone while a machine here writes an overlay over it is read from its files
 * (they're opened read-only, under a shared lock, by the machine too).
 */
export function chooseSource(
  t: SurfaceTarget,
  d: DiskRecord | undefined,
  o: OverlayRecord | undefined,
  running?: RunningMachine,
): SourceChoice {
  if (!d) return { kind: 'unavailable', why: msg('disks:surface-source.diskGone') };
  if (t.overlay && !o) return { kind: 'unavailable', why: msg('disks:surface-source.overlayGone') };
  const list = running?.attachments ?? [];
  const i = list.findIndex((a) => shows(t, d, a));
  if (i >= 0) return { kind: 'live', disk: i, inPlace: d.kind === 'stored' && !!list[i].inPlace && !list[i].readOnly };
  if (d.kind === 'ramdisk') return { kind: 'unavailable', why: msg('disks:surface-source.ramdisk') };
  // The machine here writes the stored disk in place (its store held exclusively): an overlay's view, which a job reads
  // over the store, waits for it in vain. (An overlay the machine writes is always live: `shows`.)
  if (d.kind === 'stored' && list.some((a) => a.disk === d.id && a.inPlace && !a.readOnly))
    return { kind: 'unavailable', why: msg('disks:surface-source.inPlaceHere') };
  return {
    kind: 'offline',
    job: {
      ...offlineBase(d),
      ...(o ? { overlay: overlayDir(o.id), ...(o.size !== undefined ? { overlaySize: o.size } : {}) } : {}),
      size: d.size,
    },
  };
}

/** What a disk not running here is to a job: its store, nothing, or an image (a file's examined where its handle may be read without asking; a URL's only while its machine runs here). */
function offlineBase(d: DiskRecord): Pick<OfflineJob, 'baseKind' | 'stored' | 'handle' | 'why'> {
  if (d.kind === 'stored') return { baseKind: 'stored', stored: diskDir(d.id) };
  if (d.kind === 'blank') return { baseKind: 'blank' };
  if (d.kind === 'file')
    return d.handle ? { baseKind: 'image', handle: d.handle } : { baseKind: 'opaque', why: 'permission' };
  return { baseKind: 'opaque', why: 'remote' };
}

/**
 * Whether the machine on this page, in state `s`, has its disks' files open or about to be (so a view of them is its,
 * live): from its loading (the device worker opens them) to its stop, a reboot's restart included.
 */
export const holdsDisks = (s: PageState) => s === 'loading' || s === 'booting' || s === 'running' || s === 'rebooting';

/**
 * A key that changes with the choice (the window makes a new source when it does): of disk `d` (its id and identity:
 * another file picked for a file disk is another key), never its handle (an object read back anew at every records
 * read, which serializes as nothing).
 */
export const choiceKey = (c: SourceChoice, d: DiskRecord | undefined) =>
  JSON.stringify([d?.id, d?.identity, c], (k, v: unknown) => (k === 'handle' ? undefined : v));

/** A source of a view's surface and its ranges' details. `live`: it follows the running guest (the window polls it). */
export type SurfaceSource = {
  readonly live: boolean;
  surface(cells: number): Promise<InspectAnswer>;
  range(range: number, content: boolean): Promise<InspectAnswer>;
  close(): void;
};

/** How long a live ask may take (the device worker answers from memory; a content check reads up to 4 MiB). */
export const LIVE_MS = 5_000;
export const LIVE_CONTENT_MS = 20_000;
/** How long a job may take (it waits a second for a lock another tab holds, then reads a map). */
export const JOB_MS = 30_000;
/** The live poll's interval (ms), and its stretch: an answer's cost stays under 2% of the time between two. */
export const POLL_MS = 500;
export const POLL_STRETCH = 50;
/** The next poll's delay after an answer that took `cost` ms to make. */
export const pollDelay = (cost = 0) => Math.max(POLL_MS, POLL_STRETCH * cost);

const noAnswer = (): InspectAnswer => ({ kind: 'none', why: msg('disks:surface-source.noAnswer') });

/**
 * A stored disk written in place answers live as a blank disk with an overlay that is its store: the store is shown as
 * the disk (the rims), with no overlay.
 */
export function asInPlace(a: InspectAnswer): InspectAnswer {
  if (a.kind === 'disk-surface') {
    const store = a.surface.layers.find((l) => l.id === 'overlay');
    if (!store) return a;
    const surface: Surface = {
      ...a.surface,
      layers: [{ ...store, id: 'disk', zero: new Uint32Array(store.zero.length) }],
    };
    return { kind: 'disk-surface', surface };
  }
  if (a.kind === 'disk-range') {
    // The store's blocks are the disk's (2 → 1); its zeroed ones read as nothing (3 → 0).
    const blocks = a.detail.blocks.map((b) => (b === 2 ? 1 : b === 3 ? 0 : b));
    const detail: RangeDetail = {
      ...a.detail,
      blocks,
      runs: { disk: 'overlay' in a.detail.runs ? a.detail.runs.overlay : 0 },
    };
    return { kind: 'disk-range', detail };
  }
  return a;
}

/** The running machine's disk `disk` (slot order), asked through its worker. */
export function liveSource(
  worker: Worker,
  replies: Replies<FromWorker>,
  disk: number,
  inPlace: boolean,
): SurfaceSource {
  const ask = async (query: InspectQuery, ms: number) => {
    const post = (id: number) => worker.postMessage({ type: 'inspect', id, query } satisfies ToWorker);
    const m = await replies.ask(post, { ms, fallback: { type: 'inspected', id: 0, answer: noAnswer() } });
    const answer = m.type === 'inspected' ? m.answer : noAnswer();
    return inPlace ? asInPlace(answer) : answer;
  };
  return {
    live: true,
    surface: (cells) => ask({ kind: 'disk-surface', disk, cells, activity: true }, LIVE_MS),
    range: (range, content) => ask({ kind: 'disk-range', disk, range, content }, content ? LIVE_CONTENT_MS : LIVE_MS),
    close: () => undefined, // the activity wrapper goes by itself once no query asks for it (~3 s)
  };
}

/** A worker that answers one job (web/app/surface-worker.ts). */
export type JobWorker = Pick<Worker, 'postMessage' | 'terminate'> & {
  onmessage: ((e: MessageEvent<InspectAnswer>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
};
const jobWorker = (): JobWorker => new Worker(new URL('./surface-worker.ts', import.meta.url), { type: 'module' });

/**
 * The job of `job` as the worker takes it: an image file's handle turned into its file where its read permission is
 * granted (`queryPermission`: never `requestPermission`, which would ask the user), else an image not examined.
 */
export async function jobOf(job: OfflineJob): Promise<Omit<SurfaceJob, 'query'>> {
  const { handle, ...rest } = job;
  if (rest.baseKind !== 'image') return rest;
  const denied = { ...rest, baseKind: 'opaque' as const, why: 'permission' as const };
  try {
    if (!handle || (handle.queryPermission && (await handle.queryPermission({ mode: 'read' })) !== 'granted'))
      return denied;
    return { ...rest, file: await handle.getFile() };
  } catch {
    return denied; // the file went away, or can't be read now
  }
}

/**
 * Waits for a merge into stored disk `stored` that runs now (web/overlay.ts `mergeLock`), if any, so that a job doesn't
 * read the disk half merged (nor tell its lock is in use); resolves at once without one, or when `signal` aborts.
 */
async function noMerge(stored: string | undefined, signal: AbortSignal) {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a probe: no Web Locks in some contexts
  if (!stored || typeof navigator === 'undefined' || !navigator.locks) return;
  await navigator.locks.request(mergeLock(stored), { mode: 'shared', signal }, () => undefined).catch(() => undefined);
}

/**
 * The disk's files, read by a job worker per ask (`make`: the worker; tests give their own). One job of each kind (the
 * map, a range) is in flight: a newer ask of that kind ends the one before (its worker terminated, its answer `none`),
 * as `close` ends them all. A merge into the disk that runs is waited for first, outside the job's time.
 */
export function jobSource(job: OfflineJob, make: () => JobWorker = jobWorker, ms = JOB_MS): SurfaceSource {
  const running = new Map<InspectQuery['kind'], () => void>();
  const ask = (query: InspectQuery) =>
    new Promise<InspectAnswer>((resolve) => {
      running.get(query.kind)?.();
      let w: JobWorker | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = new AbortController();
      let done = false;
      const end = (a: InspectAnswer) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        abort.abort();
        if (running.get(query.kind) === stop) running.delete(query.kind);
        w?.terminate();
        resolve(a);
      };
      const stop = () => end({ kind: 'none' });
      running.set(query.kind, stop);
      const start = () => {
        if (done) return;
        const worker = (w = make());
        timer = setTimeout(() => end(noAnswer()), ms);
        worker.onmessage = (e) => end(e.data);
        worker.onerror = () => end({ kind: 'none', why: msg('disks:surface-job.unreadable') });
        // An image file's handle checked first (it may have gone meanwhile: the ask ended, the worker with it).
        void jobOf(job).then((prepared) => done || worker.postMessage({ ...prepared, query } satisfies SurfaceJob));
      };
      if (job.stored) void noMerge(job.stored, abort.signal).then(start);
      else start();
    });
  return {
    live: false,
    surface: (cells) => ask({ kind: 'disk-surface', disk: 0, cells }),
    range: (range, content) => ask({ kind: 'disk-range', disk: 0, range, content }),
    close: () => [...running.values()].forEach((s) => s()),
  };
}

/** A view with nothing to show: every answer says why. */
export function noSource(why: Msg): SurfaceSource {
  const none = () => Promise.resolve<InspectAnswer>({ kind: 'none', why });
  return { live: false, surface: none, range: none, close: () => undefined };
}

/** The running machine's worker and the page's replies by id, for a live source. */
export type LiveHost = { worker: Worker; replies: Replies<FromWorker> };

/** The source of choice `c` (`host`: the running machine's, for a live one). */
export function sourceFor(c: SourceChoice, host: LiveHost | undefined): SurfaceSource {
  if (c.kind === 'live')
    return host
      ? liveSource(host.worker, host.replies, c.disk, c.inPlace)
      : noSource(msg('disks:surface-source.noAnswer'));
  if (c.kind === 'offline') return jobSource(c.job);
  return noSource(c.why);
}
