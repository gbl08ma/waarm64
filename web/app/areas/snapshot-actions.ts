// Snapshots (docs/frontend.md "Snapshots", docs/machines.md §5.2): the running machine, RAM and disk changes and all,
// saved to a file or kept in the browser, and Suspend (docs/frontend.md "Suspend"). Restoring and loading one is
// web/app/areas/snapshot-restore.ts.
import { msg, t, type Msg } from '../../i18n.ts';
import type { SnapshotDisk } from '../../snapshot.ts';
import type { ToGpuWorker } from '../../gpu-worker.ts';
import { ask } from '../ask.svelte.ts';
import { askPersist } from '../machines.ts';
import type { FromWorker, ToWorker } from '../protocol.ts';
import { clockSync } from '../settings.ts';
import { newId } from '../shape.ts';
import { snapshotPath } from '../store.ts';
import type { Core } from '../run/core.ts';
import { progressText, withNote } from '../run/messages.ts';
import type { Run } from '../run/run.ts';
import { download, savePicker } from './disk-export.ts';
import { messageBar } from './message-bar.svelte.ts';
import { isLive, power } from './power.svelte.ts';

/** A snapshot's end, as the worker says it. */
type Done = Extract<FromWorker, { type: 'snapshot-done' }>;
/** The save in progress: the worker's messages for it (web/app/run/worker-messages.ts forwards them). */
export type SnapshotJob = {
  progress(phase: Msg, fraction: number): void;
  chunk(data: Uint8Array): void;
  done(m: Done): void;
  error(e: unknown): void;
};

/** What `emptyPorts` detached, to attach again after. */
export type Unplugged = Awaited<ReturnType<NonNullable<Run['usb']>['detachAll']>>;
export type SnapshotDeps = Core & {
  /** Snapshot and Suspend need the USB ports empty (web/app/areas/usb-actions.ts). */
  emptyPorts(r: Run, what: 'snapshot' | 'suspend'): Promise<Unplugged | undefined>;
  plugBack(r: Run, was: Unplugged | undefined): Promise<void>;
  /** The bytes a snapshot would hold for the 3D resources (the GPU worker's count). */
  askBytes(r: Run, post: (gpu: Worker, id: number) => void): Promise<number>;
};

export const SNAPSHOT_SUFFIX = '.webpcsnap';
/** Past this, a snapshot says how much the 3D state adds to it and asks first (docs/graphics.md "Snapshots with 3D in use"). */
const GRAPHICS_WARN = 64 << 20;

/** What a saved snapshot's message adds under the clock catch-up: whether the guest slept for it (undefined: not asked). */
const sleptAs = (slept?: boolean) => (slept === undefined || !clockSync() ? undefined : slept ? 'slept' : 'awake');
/** The words of a snapshot saved to a file, or kept in the browser, with whether the guest slept for it. */
const SAVED = {
  file: {
    slept: 'snapshots:snapshot-actions.saved.slept',
    awake: 'snapshots:snapshot-actions.saved.awake',
    plain: 'snapshots:snapshot-actions.saved',
  },
  kept: {
    slept: 'snapshots:snapshot-actions.kept.slept',
    awake: 'snapshots:snapshot-actions.kept.awake',
    plain: 'snapshots:snapshot-actions.kept',
  },
} as const;
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
  /** The clock catch-up (Preferences, `?clocksync=`; docs/frontend.md "The guest's clock"): the guest's sleep key is pressed first, so it suspends itself and its own resume counts the time the file sat. Whether it was. */
  #sleepFirst(r: Run) {
    if (!clockSync()) return false;
    r.input.chord('Sleep');
    return true;
  }
  /** A save's phase in the state's words: with how far it is while that's known. */
  readonly #progress = (phase: Msg, f: number) =>
    this.#d.messages.stateText(f > 0 && f < 1 ? progressText(phase, f) : phase);

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
  #write(r: Run, send: ToWorker, chunk: (data: Uint8Array) => void = () => undefined) {
    return new Promise<Done>((resolve, reject) => {
      this.#d.runner.job = { progress: this.#progress, chunk, done: resolve, error: reject };
      r.worker.postMessage(send);
    });
  }
  /** The save is over (it worked or not): the devices go back on. */
  #over(r: Run, unplugged: Unplugged) {
    power.saving = false;
    this.#d.runner.job = undefined;
    void this.#d.plugBack(r, unplugged);
  }
  /** Says a snapshot was saved, if the machine runs on. */
  #saved(r: Run, how: 'file' | 'kept', name: string, done: Done) {
    if (!r.live() || !isLive(power.state)) return;
    this.#d.messages.setState(power.state);
    const words = { name, size: done.bytes, seconds: (done.pausedMs / 1000).toFixed(1) };
    this.#d.messages.notify(msg(SAVED[how][sleptAs(done.slept) ?? 'plain'], words));
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
      const sleep = this.#sleepFirst(r);
      const done = await this.#write(r, { type: 'snapshot', handle, whole: o.whole, sleep }, (data) => {
        parts.push(new Blob([data as Uint8Array<ArrayBuffer>]));
      });
      if (!handle) download(new Blob(parts), suggestedName);
      parts.length = 0;
      const { bytes, pausedMs, stateMs, blobBytes, slept } = done;
      // For tools: the file's bytes, the pause's ms (and the devices' state's), the 3D contents' bytes.
      messageBar.snapshot = JSON.stringify({ bytes, pausedMs, stateMs, blobBytes, slept });
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
        const done = await this.#write(r, {
          type: 'snapshot',
          keep: snapshotPath(s.record.id, id),
          sleep: this.#sleepFirst(r),
        });
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
      const { bytes, pausedMs, stateMs, blobBytes } = done;
      messageBar.snapshot = JSON.stringify({ bytes, pausedMs, stateMs, blobBytes, id });
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
    const { machine: m, runner, messages } = this.#d;
    const r = m.run;
    if (!r || power.busy || !isLive(power.state)) return;
    // Its devices are unplugged first; the next start attaches the ones attached at start (docs/usb.md "The page").
    const unplugged = await this.#d.emptyPorts(r, 'suspend');
    if (!unplugged || !this.#ready(r)) return;
    power.saving = true;
    runner.job = {
      progress: this.#progress,
      chunk: () => undefined,
      done: () => undefined,
      // It runs on; the `suspended` state ends a suspend that worked (web/app/run/worker-messages.ts).
      error: (e) => {
        power.saving = false;
        runner.job = undefined;
        if (r.live()) {
          messages.setState(power.state);
          messages.notify(withNote(e, t('machine:snapshot-actions.runsOn')), 'error');
        }
        void this.#d.plugBack(r, unplugged);
      },
    };
    r.worker.postMessage({ type: 'suspend', sleep: this.#sleepFirst(r) } satisfies ToWorker);
  }
}
