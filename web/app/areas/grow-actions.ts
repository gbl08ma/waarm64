// A disk grown on the Home page, grown in the guest too (docs/devices.md "A disk grown", docs/machines.md §4.5):
// at each HELLO of a run's agent that says `CAP.GROW`, GROW for each of the run's disks whose overlay or stored disk
// carries a grow mark (web/app/resize.ts `growsOf`, read from the records then: a restore's agent connects again and
// is asked again for what still stands); each GROWN, whichever connection it comes on, against the marks then (a
// duplicate, or one whose mark another answer cleared, says nothing), one at a time. What clears a mark (`answer`):
// a final answer, the disk grown or why it can't be (the user's to do, said once); NOT_FOUND and NOT_YET (the guest
// doesn't have the disk, or not at its new size) keep it silently for the next start; FAILED keeps it once (an error
// may pass: a busy disk, a full journal; a partition written but not told to the kernel is completed by the next GROW)
// and the second clears it, so a failure that lasts is said twice, not at every start; BAD_REQUEST (the agent didn't
// read the GROW: another version's) keeps it and is said once in the page's life. A run that ends before its GROWN
// keeps the mark (the next start asks again; the agent's grow is idempotent: NOTHING where it was done).
import { CAP, GROWN_FS, GROWN_PART, type Grown } from '../../agent-frame.ts';
import { msg, MsgError, type Msg } from '../../msg.ts';
import type { AgentLink } from '../agent-link.ts';
import { clearGrowMark, growFailed, growsOf, type GrowDisk, type ResizeTarget } from '../resize.ts';
import type { Store } from '../store.ts';

/** The message bar (web/app/run/messages.ts `Messages`: an error's notice is a warning, anything else's `info`). */
type Notify = { notify(m: Msg | MsgError, kind?: 'warn'): void };

/** The run's marks (web/app/resize.ts: `growsOf`, `clearGrowMark`, `growFailed` on the store, for the run's machine). */
export type Marks = {
  grows(): Promise<GrowDisk[]>;
  clear(t: ResizeTarget): Promise<void>;
  failed(t: ResizeTarget): Promise<void>;
};

/** Machine `id`'s marks in `store`. */
export const storeMarks = (store: Store, id: string): Marks => ({
  grows: () => growsOf(store, id),
  clear: (t) => clearGrowMark(store, t),
  failed: (t) => growFailed(store, t),
});

/** What a GROWN does to its disk's marks: kept as they are, kept with the failure noted, or cleared; and what's said. */
export type Answer = { action: 'keep' | 'failed' | 'clear'; notice?: Msg | MsgError };

const P = GROWN_PART;
const F = GROWN_FS;

/** The headline of an answer whose grow stopped short: the partition grew (its size) but not its filesystem, or nothing grew. */
const short = (partGrew: boolean, disk: string, size: number, cause: MsgError) =>
  partGrew
    ? new MsgError('machine:grow-actions.partOnly', { disk, size }, { cause })
    : new MsgError('machine:grow-actions.notGrown', { disk }, { cause });

/** Why the filesystem wasn't grown (FS's final statuses), with what the user can do. */
function fsCause(fs: number): MsgError {
  if (fs === F.NOT_MOUNTED) return new MsgError('machine:grow-actions.notMounted');
  if (fs === F.STACKED) return new MsgError('machine:grow-actions.stacked');
  return new MsgError('machine:grow-actions.unsupported');
}

/**
 * What GROWN `g` for disk `disk` (its name) does and says; `failedBefore`: its mark noted a failure already. The size
 * said is the agent's: the partition's (or the whole disk's) size now.
 */
export function answer(g: Grown, disk: string, failedBefore: boolean): Answer {
  const known = (Object.values(P) as number[]).includes(g.part) && (Object.values(F) as number[]).includes(g.fs);
  if (g.part === P.NOT_FOUND || g.part === P.NOT_YET) return { action: 'keep' };
  // The agent didn't read the page's GROW: another version's (a skew, not a failure). Kept for an agent that reads it,
  // said once (`GrowActions`); nothing was done.
  if (g.part === P.BAD_REQUEST) return { action: 'keep', notice: msg('machine:grow-actions.badRequest', { disk }) };
  const why = known && TABLE_CAUSE[g.part];
  if (why) return { action: 'clear', notice: short(false, disk, g.size, why()) };
  // A step failed (or the filesystem's wasn't reached, or a status this page doesn't know).
  if (!known || g.part === P.FAILED || g.fs === F.FAILED || g.fs === F.SKIPPED) {
    const errno = g.errno;
    const cause = failedBefore
      ? new MsgError('machine:grow-actions.failedAgain', { errno })
      : new MsgError('machine:grow-actions.failed', { errno });
    return { action: failedBefore ? 'clear' : 'failed', notice: short(g.part === P.GROWN, disk, g.size, cause) };
  }
  return { action: 'clear', notice: grownNotice(g, disk) };
}

/** Why a table wasn't grown (PART's final statuses short of the filesystem's step), with what the user can do. */
const TABLE_CAUSE: Record<number, (() => MsgError) | undefined> = {
  [P.BAD_TABLE]: () => new MsgError('machine:grow-actions.badTable'),
  [P.NOT_LAST]: () => new MsgError('machine:grow-actions.notLast'),
};

/** The notice for a partition grown, at the disk's end already, or absent (no table), by its filesystem's status. */
function grownNotice(g: Grown, disk: string): Msg | MsgError {
  const size = g.size;
  const partGrew = g.part === P.GROWN;
  if (g.fs === F.GROWN || (g.fs === F.NOTHING && partGrew))
    return g.part === P.NO_TABLE
      ? msg('machine:grow-actions.grownWhole', { disk, size })
      : msg('machine:grow-actions.grown', { disk, size });
  if (g.fs === F.NOTHING) return msg('machine:grow-actions.already', { disk, size });
  return short(partGrew, disk, size, fsCause(g.fs));
}

/** A run's agent and marks, while it runs. */
type Run = { link: AgentLink; marks: Marks; chain: Promise<void> };

export class GrowActions {
  readonly #messages: Notify;
  /** The run's machine's marks (none: a transient machine, which has no records). */
  readonly #marks: () => Marks | undefined;
  #run: Run | undefined;
  /** The disks whose kept answer was said (a version skew, BAD_REQUEST): once in the page's life, not at every start. */
  readonly #said = new Set<string>();

  /**
   * The message bar, where each answer is said once; the store and the page's stored machine (`id`, none for a
   * transient one), or the marks themselves (the tests').
   */
  constructor(messages: Notify, store: Store | (() => Marks | undefined), id?: () => string | undefined) {
    this.#messages = messages;
    this.#marks =
      typeof store === 'function'
        ? store
        : () => {
            const m = id?.();
            return m ? storeMarks(store, m) : undefined;
          };
  }

  /** A run's link (web/app/areas/agent-actions.ts: each run's, from its start to its end). */
  follow(link: AgentLink) {
    this.#run = undefined;
    const marks = this.#marks();
    if (!marks) return;
    const run: Run = { link, marks, chain: Promise.resolve() };
    this.#run = run;
    link.onHello.push((h) => {
      if (h.caps & CAP.GROW) this.#queue(run, () => this.#send(run));
    });
    link.onGrown.push((g) => this.#queue(run, () => this.#grown(run, g)));
  }

  /** The run ended: nothing more is sent for it (a GROWN that came before its end is still taken). */
  end() {
    this.#run = undefined;
  }

  /** Runs `f` after what the run has queued: GROWs and GROWNs one at a time, so that a mark is read after the last change to it. */
  #queue(run: Run, f: () => Promise<void>) {
    run.chain = run.chain.then(f).catch((e: unknown) => console.warn('a disk grown in the guest:', e));
  }

  async #send(run: Run) {
    const grows = await run.marks.grows();
    if (this.#run !== run) return; // the run ended meanwhile
    for (const g of grows) run.link.grow(g.serial, g.size);
  }

  async #grown(run: Run, g: Grown) {
    // The agent compares a serial's first 20 bytes (virtio-blk's); the page's serials are no longer.
    const disk = (await run.marks.grows()).find((x) => x.serial === g.serial.slice(0, 20));
    if (!disk) return; // its mark is gone: an answer that came twice, or another's disk
    const a = answer(
      g,
      disk.name,
      disk.marks.some((m) => m.mark.failed),
    );
    if (typeof window !== 'undefined') (window.__grown ??= []).push({ ...g, action: a.action }); // the tests' hook
    if (a.action === 'keep') {
      if (a.notice && !this.#said.has(disk.serial)) {
        this.#said.add(disk.serial);
        this.#messages.notify(a.notice, 'warn'); // nothing was done
      }
      return;
    }
    for (const m of disk.marks) await (a.action === 'clear' ? run.marks.clear(m.target) : run.marks.failed(m.target));
    if (a.notice) this.#messages.notify(a.notice);
  }
}
