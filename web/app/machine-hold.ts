// Changes to a machine's disks that a start mustn't run beside (docs/machines.md §4.4, §5.2): a merge, Delete overlay,
// Import changes, a ramdisk's resize hold the machines they touch off by their machines' Web Locks
// (`waarm64-machine:<id>`), which a start takes, only if free, before it reads the machine's record.
import { MsgError } from '../msg.ts';
import { mergeLock } from '../overlay.ts';
import { machineLock } from './machines.ts';
import type { DiskRecord, MachineRecord } from './shape.ts';
import { diskDir } from './store.ts';

/**
 * Takes the machine locks of `machines`, each only if it's free, so that none of them starts (or restores) while a
 * change to its disks runs: a start takes its machine's lock the same way, before it reads the machine's record, and
 * holds it to the run's end (web/app/run/runner.ts `own`). The release, or (none taken) the machines that hold theirs:
 * they run, or start, in this tab or another.
 */
export async function holdMachines(
  machines: MachineRecord[],
): Promise<{ release: () => void; busy?: undefined } | { release?: undefined; busy: MachineRecord[] }> {
  const releases: (() => void)[] = [];
  const release = () => releases.forEach((r) => r());
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a probe: no Web Locks in some contexts
  if (typeof navigator === 'undefined' || !navigator.locks) return { release };
  const busy: MachineRecord[] = [];
  for (const m of machines) {
    const held = await new Promise<(() => void) | undefined>((got) => {
      navigator.locks
        .request(machineLock(m.id), { ifAvailable: true }, (l) => {
          if (!l) return got(undefined);
          return new Promise<void>((done) => got(done));
        })
        .catch(() => got(undefined));
    });
    if (held) releases.push(held);
    else busy.push(m);
  }
  if (!busy.length) return { release };
  release();
  return { busy };
}

/**
 * Whether a merge into one of `disks` runs now (web/app/merge.ts holds its disk's merge lock to its end, and the
 * machines that attach the disk off): what a start that found its machine's lock held says, rather than that the
 * machine runs in another tab.
 */
export async function mergingInto(disks: Iterable<DiskRecord>) {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a probe: no Web Locks in some contexts
  if (typeof navigator === 'undefined' || !navigator.locks) return false;
  const held = new Set(((await navigator.locks.query()).held ?? []).map((l) => l.name));
  return [...disks].some((d) => held.has(mergeLock(diskDir(d.id))));
}

/** What a start of machine `name` says when a merge into one of its disks holds it off (`mergingInto`). */
export const mergeRuns = (name: string) =>
  new MsgError(
    'machine:worker-errors.diskInUse',
    { machine: name },
    { cause: new MsgError('machine:worker-errors.diskMerging.cause') },
  );
