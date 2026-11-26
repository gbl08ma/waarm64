// What stops a machine from starting or running (docs/frontend.md "Errors"), as the machine worker (web/app/worker.ts)
// tells the page: a `Problem` and an error a user can act on.
import { msgOf, MsgError, type Msg } from '../msg.ts';
import { SnapshotError } from '../snapshot-file.ts';
import type { Machine } from './machine.ts';
import type { Problem } from './protocol.ts';

/** An error with the problem it means for the user: `m` says it, `cause` (if any) is its details. */
export const failure = (problem: Problem, m: Msg, cause?: unknown) =>
  Object.assign(new MsgError(m.key, m.params, { cause }), { problem });

/** Whether `err` or one of its causes is `test`'s (an overlay's error crosses from the device worker as its cause or itself). */
function among(err: unknown, test: (e: Error & { problem?: string }) => boolean) {
  for (let e = err, i = 0; e instanceof Error && i < 8; e = e.cause, i++) if (test(e)) return true;
  return false;
}

/** What the start had reached when it failed: `restoring`, `bootVm` had the snapshot; the RAM it asked for, MiB. */
export type Reached = { restoring: boolean; ramMiB: number };

/** Whether a restore's failure came once its fill had emptied an overlay of the disk's own changes (web/snapshot.ts). */
const emptiedBy = (err: unknown) => !!(err as { emptied?: unknown } | null | undefined)?.emptied;

/**
 * A snapshot refused (a SnapshotError has a `problem` of its own: why the file was refused), or a restore refused by
 * anything else once its fill had emptied an overlay (`emptied`: the storage full, a disk that didn't open after it).
 */
function refused(err: Error, machine: Machine, restoring: boolean): Error {
  // From `readSnapshot` nothing was touched; once `bootVm` has the file, a disk may hold part of it (a new fork's,
  // which the page puts back, or one whose own changes the fill deleted: `emptied`, web/snapshot.ts).
  const cause = emptiedBy(err)
    ? 'snapshots:worker-errors.notRestored.emptied'
    : 'snapshots:worker-errors.notRestored.cause';
  return restoring
    ? new MsgError('snapshots:worker-errors.notRestored', undefined, {
        cause: new MsgError(cause, { machine: machine.title }, { cause: err }),
      })
    : new MsgError('snapshots:worker-errors.notLoaded', undefined, {
        cause: new MsgError('snapshots:worker-errors.notLoaded.cause', { machine: machine.title }, { cause: err }),
      });
}

/** An overlay another tab holds (web/overlay.ts `problem`, or the browser's lock on its files), a stored disk a merge holds, or an overlay written over another image. */
function overlayProblem(err: unknown, machine: Machine): [Problem, Error] | undefined {
  // A merge into one of its stored disks under way (web/stored.ts `holdAgainstMerges`): Retry once it's done.
  if (among(err, (e) => e.problem === 'disk-merging'))
    return [
      'disk-in-use',
      new MsgError(
        'machine:worker-errors.diskInUse',
        { machine: machine.title },
        { cause: new MsgError('machine:worker-errors.diskMerging.cause', undefined, { cause: err }) },
      ),
    ];
  if (among(err, (e) => e.problem === 'overlay-in-use' || e.name === 'NoModificationAllowedError'))
    return [
      'disk-in-use',
      new MsgError(
        'machine:worker-errors.diskInUse',
        { machine: machine.title },
        { cause: new MsgError('machine:worker-errors.diskInUse.cause', undefined, { cause: err }) },
      ),
    ];
  if (among(err, (e) => e.problem === 'overlay-mismatch'))
    return [
      'disk-mismatch',
      new MsgError(
        'machine:worker-errors.diskMismatch',
        { machine: machine.title },
        { cause: new MsgError('machine:worker-errors.diskMismatch.cause', undefined, { cause: err }) },
      ),
    ];
  return undefined;
}

/** An error nothing else explains: the emulator's, with its stack as the details (V8's starts with the message; Firefox's is only the frames). */
function emulatorError(err: unknown): Error {
  const text = String((err as { message?: unknown } | null | undefined)?.message ?? err);
  const stack =
    err instanceof Error && err.stack ? (err.stack.includes(text) ? err.stack : `${text}\n${err.stack}`.trim()) : text;
  const cause = err instanceof Error && err.cause !== undefined ? { cause: err.cause } : undefined;
  return new MsgError('machine:worker-errors.emulator', {}, { cause: new Error(stack, cause) });
}

/** An error from starting or running a machine as `[problem, error]` for the page: the error says it, its cause is the details. */
export function explain(err: unknown, machine: Machine, at: Reached): [Problem, Error] {
  // A SnapshotError's problem is checked before the worker's.
  if (err instanceof SnapshotError) return ['snapshot', refused(err, machine, at.restoring)];
  // A restore refused by anything else once its fill had emptied an overlay the user had it replace (the storage full,
  // a disk that didn't open after the fill): a snapshot that didn't restore, whose words say those changes are gone
  // (Start boots normally; a template's first start boots instead), what refused it in its own words under them.
  if (at.restoring && emptiedBy(err)) {
    const why = overlayProblem(err, machine)?.[1] ?? (msgOf(err) ? (err as Error) : emulatorError(err));
    return ['snapshot', refused(Object.assign(why, { emptied: true }), machine, true)];
  }
  const overlay = overlayProblem(err, machine);
  if (overlay) return overlay;
  const problem = (err as { problem?: Problem } | null | undefined)?.problem;
  if (problem && msgOf(err)) return [problem, err as Error];
  // An error that says what went wrong in the catalog's words (a refused file, a full storage): those words are its
  // details, not its stack (which goes to the console).
  if (msgOf(err)) {
    console.error(err);
    return ['emulator', new MsgError('machine:worker-errors.emulator', {}, { cause: err })];
  }
  if (err instanceof RangeError && /memory/i.test(err.message))
    return [
      'memory',
      new MsgError('machine:worker-errors.memory', undefined, {
        cause: new MsgError('machine:worker-errors.memory.cause', { ram: at.ramMiB }, { cause: err }),
      }),
    ];
  return ['emulator', emulatorError(err)];
}
