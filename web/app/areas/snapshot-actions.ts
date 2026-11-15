// Snapshots (docs/frontend.md "Snapshots", docs/machines.md §5.2): the running machine, RAM and disk changes and all,
// saved to a file or kept in the browser, and Suspend (docs/frontend.md "Suspend"). Restoring and loading one is
// web/app/areas/snapshot-restore.ts.
import { msg, t, type Msg } from '../../i18n.ts';
import type { SnapshotDisk } from '../../snapshot.ts';
import type { ToGpuWorker } from '../../gpu-worker.ts';
import { ask } from '../ask.svelte.ts';
import { askPersist } from '../storage-report.ts';
import type { FromWorker, ToWorker } from '../protocol.ts';
import { newId } from '../shape.ts';
import { snapshotPath } from '../store.ts';
import type { Core } from '../run/core.ts';
import { progressText, withNote } from '../run/messages.ts';
import type { Run } from '../run/run.ts';
import type { Replies } from '../run/replies.ts';
import { fromWire } from '../../msg.ts';
import { download, savePicker } from './disk-export.ts';
import { messageBar } from './message-bar.svelte.ts';
import { isLive, power } from './power.svelte.ts';

/** A snapshot's end, as the worker says it. */
type Done = Extract<FromWorker, { type: 'snapshot-done' }>;

/** What `emptyPorts` detached, to attach again after. */
export type Unplugged = Awaited<ReturnType<NonNullable<Run['usb']>['detachAll']>>;
export type SnapshotDeps = Core & {
  /** Snapshot and Suspend need the USB ports empty (web/app/areas/usb-actions.ts). */
  emptyPorts(r: Run, what: 'snapshot' | 'suspend'): Promise<Unplugged | undefined>;
  plugBack(r: Run, was: Unplugged | undefined): Promise<void>;
  /** The bytes a snapshot would hold for the 3D resources (the GPU worker's count). */
  askBytes(r: Run, post: (gpu: Worker, id: number) => void): Promise<number>;
  /** The error a snapshot or a suspend would end with now for a device's reason (the worker's `snapshot-check`), or none. */
  refusal(r: Run, what: 'snapshot' | 'suspend'): Promise<unknown>;
  /**
   * The guest agent (web/app/areas/agent-actions.ts): it sets the guest's clock (a save's pause held it still), and has
   * the guest drop its clean caches right before a save (Preferences' switch: its memory is free for the balloon's hint).
   */
  agent: { syncClock(): void; dropCaches(): Promise<void> };
};

/**
 * `refusal` through the run's worker (`snapshot-check`): its device's reason as an error, or none; unanswered in time,
 * nothing is refused (the save decides).
 */
export const workerRefusal =
  (replies: Replies<FromWorker>): SnapshotDeps['refusal'] =>
  async (r, what) => {
    const post = (id: number) => r.worker.postMessage({ type: 'snapshot-check', id, what } satisfies ToWorker);
    const m = await replies.ask(post, { ms: 3000, fallback: { type: 'snapshot-check', id: 0 } });
    return m.type === 'snapshot-check' && m.refused ? fromWire(m.refused) : undefined;
  };

export const SNAPSHOT_SUFFIX = '.waarm64snap';
/** Past this, a snapshot says how much the 3D state adds to it and asks first (docs/graphics.md "Snapshots with 3D in use"). */
const GRAPHICS_WARN = 64 << 20;

/** The words of a snapshot saved to a file, or kept in the browser. */
const SAVED = { file: 'snapshots:snapshot-actions.saved', kept: 'snapshots:snapshot-actions.kept' } as const;
/** A snapshot file's name: the machine's and the time's. */
function fileName(machine: string, d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  return `${machine}-${stamp}${SNAPSHOT_SUFFIX}`;
}

export class SnapshotActions {
  readonly #d: SnapshotDeps;
  constructor(d: SnapshotDeps) {
    this.#d = d;
  }

  /** The run `r`, still the page's, running and not busy: a snapshot can be taken of it. */
  #ready(r: Run) {
    return r.live() && !power.busy && isLive(power.state);
  }
  /**
   * Right before a save: the guest's input is held until it ends (`#over`; web/input.ts `hold`): input during the pause
   * would only complete into a guest that can't run.
   */
  #holdInput(r: Run) {
    r.input.hold(true);
  }
  /** Right before a save (input held): the guest's caches dropped, under Preferences' switch, said as the save's first phase. */
  async #dropCaches() {
    this.#progress(msg('snapshots:worker-snapshot.phase.freeing'), 0);
    await this.#d.agent.dropCaches();
  }
  /** A save's phase in the state's words: with how far it is while that's known. */
  readonly #progress = (phase: Msg, f: number) =>
    this.#d.messages.stateText(f > 0 && f < 1 ? progressText(phase, f) : phase);

  /**
   * Whether a device refuses the snapshot or the suspend (`what`) now (Vulkan in use, a video decoding): then it is
   * said as the save's failure would be, before anything touches the machine (its USB ports, its input).
   */
  async #refused(r: Run, what: 'snapshot' | 'suspend', runsOn: string) {
    const e = await this.#d.refusal(r, what);
    if (!e) return false;
    if (r.live()) this.#d.messages.notify(withNote(e, runsOn), 'error');
    return true;
  }

  /** Whether to take the snapshot: yes, unless the 3D state is large and the user says no. */
  async #graphicsOk(r: Run) {
    const bytes = await this.#d.askBytes(r, (gpu, id) =>
      gpu.postMessage({ type: 'snapshotBytes', id } satisfies ToGpuWorker),
    );
    return (
      bytes < GRAPHICS_WARN ||
      ask.confirm(t('snapshots:snapshot-actions.large.confirm', { size: bytes }), {
        title: t('snapshots:snapshot-actions.large.title'),
        ok: t('snapshots:snapshot-actions.large.ok'),
      })
    );
  }

  /** The snapshot written by the worker: its messages (`chunk`: the file's bytes, without a handle or a keep) until it's done. */
  #write(
    r: Run,
    send: Omit<Extract<ToWorker, { type: 'snapshot' }>, 'id'>,
    chunk: (data: Uint8Array) => void = () => undefined,
  ) {
    return new Promise<Done>((resolve, reject) => {
      r.save(send, { progress: this.#progress, chunk, done: (m) => resolve(m as Done), error: reject });
    });
  }
  /** The save is over (it worked or not): the devices go back on, and the guest's clock, held during the pause, is set. */
  #over(r: Run, unplugged: Unplugged) {
    power.saving = false;
    r.input.hold(false);
    if (r.live()) this.#d.agent.syncClock();
    void this.#d.plugBack(r, unplugged);
  }
  /** Says a snapshot was saved, if the machine runs on. */
  #saved(r: Run, how: 'file' | 'kept', name: string, done: Done) {
    if (!r.live() || !isLive(power.state)) return;
    this.#d.messages.setState(power.state);
    const words = { name, size: done.bytes, seconds: (done.pausedMs / 1000).toFixed(1) };
    this.#d.messages.notify(msg(SAVED[how], words));
  }
  /** Says the save failed, if the machine runs on (`what`: what the page did about it). */
  #failed(r: Run, e: unknown, what: string) {
    if (!r.live()) return;
    this.#d.messages.setState(power.state);
    this.#d.messages.notify(withNote(e, what), 'error');
  }

  /**
   * Saves a snapshot of the running machine: to a file (the picker, or a download), or, for a stored machine by
   * default, kept in the browser under a name (docs/machines.md §5.2). `whole`: a disk written in place goes into the
   * file whole (§4.4; a kept snapshot pins its generation instead).
   */
  async save(o: { toFile?: boolean; whole?: boolean } = {}) {
    const m = this.#d.machine;
    const r = m.run;
    if (!r || power.busy || !isLive(power.state)) return;
    const d = new Date();
    const s = m.stored;
    // A stored machine's is kept at once, named by the time (Snapshot is the toolbar's panic button: renamed later, on the Machines page).
    if (s && !o.toFile) return this.keep(d.toLocaleString());
    const suggestedName = fileName(s ? s.record.name.replace(/[^\w.-]+/g, '-') : m.name, d);
    if (await this.#refused(r, 'snapshot', t('snapshots:snapshot-actions.runsOn.noFile'))) return;
    const ready = await this.#toFile(r, suggestedName);
    if (ready) await this.#saveFile(r, o.whole, suggestedName, ready);
  }

  /** Asked first, a large 3D state; then the picker (a cancel: none); then the USB ports emptied. */
  async #toFile(r: Run, suggestedName: string) {
    // A large 3D state is asked about first (its OK is a click: the picker after it has its user activation).
    if (!(await this.#graphicsOk(r)) || !this.#ready(r)) return undefined;
    // The picker next, as a disk's Export does. The machine isn't stopped, so nothing is asked.
    const type = {
      description: t('snapshots:snapshot-actions.fileType'),
      accept: { 'application/octet-stream': [SNAPSHOT_SUFFIX] },
    };
    const handle = await savePicker(suggestedName, type);
    if (handle === false || !this.#ready(r)) return undefined; // cancelled, or the machine moved on while the picker was open
    const unplugged = await this.#d.emptyPorts(r, 'snapshot');
    if (!unplugged || !this.#ready(r)) return undefined;
    return { handle, unplugged };
  }

  async #saveFile(
    r: Run,
    whole: boolean | undefined,
    suggestedName: string,
    { handle, unplugged }: { handle: FileSystemFileHandle | undefined; unplugged: Unplugged },
  ) {
    const o = { whole };
    power.saving = true;
    const parts: Blob[] = [];
    try {
      this.#holdInput(r);
      await this.#dropCaches();
      const done = await this.#write(r, { type: 'snapshot', handle, whole: o.whole }, (data) => {
        parts.push(new Blob([data as Uint8Array<ArrayBuffer>]));
      });
      if (!handle) download(new Blob(parts), suggestedName);
      parts.length = 0;
      const { bytes, pausedMs, stateMs, blobBytes, hintMs, hinted, phases } = done;
      // For tools: the file's bytes, the pause's ms (and the devices' state's), the 3D contents' bytes, the balloon's
      // hint, where the time went (protocol.ts `SaveTimes`).
      messageBar.snapshot = JSON.stringify({
        kind: 'file',
        bytes,
        pausedMs,
        stateMs,
        blobBytes,
        hintMs,
        hinted,
        phases,
      });
      this.#saved(r, 'file', handle?.name ?? suggestedName, done);
    } catch (e) {
      this.#failed(r, e, t('snapshots:snapshot-actions.runsOn.noFile'));
    } finally {
      this.#over(r, unplugged);
    }
  }

  /** Keeps a snapshot of the running stored machine in the browser (its file in OPFS first, then its record). */
  async keep(name: string) {
    const m = this.#d.machine;
    const r = m.run;
    const s = m.stored;
    if (!r || !s || power.busy || !isLive(power.state)) return;
    if (await this.#refused(r, 'snapshot', t('snapshots:snapshot-actions.runsOn.nothingKept'))) return;
    if (!(await this.#graphicsOk(r)) || !this.#ready(r)) return;
    const unplugged = await this.#d.emptyPorts(r, 'snapshot');
    if (!unplugged || !this.#ready(r)) return;
    power.saving = true;
    const id = newId();
    try {
      const about = r.about ?? (await m.about());
      if (!about) throw new Error('no stored machine');
      await askPersist();
      const done = await m.store.writing(async () => {
        this.#holdInput(r);
        await this.#dropCaches();
        const done = await this.#write(r, { type: 'snapshot', keep: snapshotPath(s.record.id, id) });
        const pins = done.pins.map(({ slot, overlay, generation, blocks, ram }: SnapshotDisk) => ({
          slot,
          overlay,
          generation,
          blocks,
          ram,
        }));
        const { shape, shapeHash, urls } = about;
        await m.store.put('snapshots', {
          id,
          machine: s.record.id,
          name,
          created: Date.now(),
          bytes: done.bytes,
          shape,
          shapeHash,
          urls,
          pins,
        });
        return done;
      });
      const { bytes, pausedMs, stateMs, blobBytes, hintMs, hinted, phases } = done;
      messageBar.snapshot = JSON.stringify({
        kind: 'kept',
        bytes,
        pausedMs,
        stateMs,
        blobBytes,
        hintMs,
        hinted,
        id,
        phases,
      });
      this.#saved(r, 'kept', name, done);
    } catch (e) {
      this.#failed(r, e, t('snapshots:snapshot-actions.runsOn.nothingKept'));
    } finally {
      this.#over(r, unplugged);
    }
  }

  // Suspend: the machine stops with its memory kept beside its disk in this browser; the next start (this page opened
  // again, Start) resumes it. Nothing is asked: nothing is lost.
  async suspend() {
    const { machine: m, messages } = this.#d;
    const r = m.run;
    if (!r || power.busy || !isLive(power.state)) return;
    if (await this.#refused(r, 'suspend', t('machine:snapshot-actions.runsOn'))) return;
    // Its devices are unplugged first; the next start attaches the ones attached at start (docs/usb.md "The page").
    const unplugged = await this.#d.emptyPorts(r, 'suspend');
    if (!unplugged || !this.#ready(r)) return;
    power.saving = true;
    this.#holdInput(r);
    await this.#dropCaches();
    if (!r.live()) {
      power.saving = false;
      return;
    }
    r.save(
      { type: 'suspend' },
      {
        progress: this.#progress,
        chunk: () => undefined,
        // The `suspended` state that follows ends it (web/app/run/worker-messages.ts); for tools, its numbers.
        done: (m) => {
          if (m.type === 'suspend-done') {
            const { bytes, pausedMs, phases } = m;
            messageBar.snapshot = JSON.stringify({ kind: 'suspend', bytes, pausedMs, phases });
          }
        },
        // It runs on.
        error: (e) => {
          power.saving = false;
          r.input.hold(false);
          if (r.live()) {
            messages.setState(power.state);
            messages.notify(withNote(e, t('machine:snapshot-actions.runsOn')), 'error');
          }
          void this.#d.plugBack(r, unplugged);
        },
      },
    );
  }
}
