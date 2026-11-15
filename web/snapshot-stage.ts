// A snapshot to a file staged through OPFS (docs/frontend.md "Snapshots", SNAPZ's decision 3): during the pause the
// machine worker writes the snapshot to a staging file in `snapshot-staging/` (a sync access handle, several times the
// picked file's stream), the machine resumes, and the file is then copied into the picked file (or downloaded) and
// removed. The page names each staging file and holds its Web Lock until the file is gone, so a file whose lock no one
// holds was left by a page that ended (a crash, a closed tab) and is removed at the next start (`removeStale`).
import { opfsDir, storageNumbers } from './overlay.ts';

/** The OPFS directory of the staging files. */
export const STAGING = 'snapshot-staging';
/** The Web Lock the page holds while staging file `name` is in use. */
export const stagingLock = (name: string) => `waarm64-staging:${name}`;

/**
 * The room a staging file of at most `bound` bytes (web/snapshot-file.ts `snapshotBound`) asks of the storage: the
 * bound, a tenth more and 64 MiB (the guest's own writes go on beside the copy).
 */
export const roomFor = (bound: number) => bound + Math.ceil(bound / 10) + (64 << 20);

/**
 * The storage's free room as `navigator.storage.estimate()` says it (quota less usage), or `room` (bytes: the
 * `?stageroom=` knob, docs/frontend.md "Query parameters"); undefined where the browser says nothing (the file is then
 * staged, and a write refused partway falls back as any is).
 */
export async function freeRoom(room?: number): Promise<number | undefined> {
  if (room !== undefined) return room;
  const n = await storageNumbers();
  return n && n.quota - n.used;
}

/** Whether this context can stage: OPFS and Web Locks. */
export async function canStage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.locks || typeof navigator.storage?.getDirectory !== 'function') return false;
  return navigator.storage.getDirectory().then(() => true, () => false);
}

/** Staging file `name` removed (none is fine). */
export async function removeStaged(name: string) {
  try {
    await (await opfsDir(STAGING)).removeEntry(name);
  } catch (e) {
    if ((e as DOMException).name !== 'NotFoundError') throw e;
  }
}

/** Staging file `name` as a File (closed: its writer is done). */
export async function stagedFile(name: string): Promise<File> {
  return (await (await opfsDir(STAGING)).getFileHandle(name)).getFile();
}

/**
 * A staging name for one save, its lock held (none: this context can't stage). `release` removes the file and lets the
 * lock go; `after`: in that many ms (a download's: the browser reads the file after the page's click).
 */
export async function holdStaging(): Promise<{ name: string; release(after?: number): void } | undefined> {
  if (!(await canStage())) return undefined;
  const name = `${Date.now().toString(36)}-${crypto.randomUUID()}`;
  let free!: () => void;
  const held = new Promise<void>((resolve) => { free = resolve; });
  const got = await new Promise<boolean>((resolve) => {
    navigator.locks
      .request(stagingLock(name), { ifAvailable: true }, (lock) => {
        resolve(!!lock);
        return lock ? held : undefined;
      })
      .catch(() => resolve(false));
  });
  if (!got) return undefined;
  let released = false;
  const end = () => void removeStaged(name).catch(() => undefined).finally(free);
  return {
    name,
    release(after = 0) {
      if (released) return;
      released = true;
      if (after > 0) setTimeout(end, after);
      else end();
    },
  };
}

/**
 * The staging files no one holds (their page ended while one was in use: a crash, a closed tab) removed, at the page's
 * start: how many.
 */
export async function removeStale(): Promise<number> {
  if (!(await canStage())) return 0;
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await opfsDir(STAGING);
  } catch {
    return 0; // none yet
  }
  const names: string[] = [];
  for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
  let removed = 0;
  for (const name of names) {
    await navigator.locks.request(stagingLock(name), { ifAvailable: true }, async (lock) => {
      if (!lock) return; // a save in progress (this page's or another tab's)
      await dir.removeEntry(name).then(() => removed++, () => undefined);
    });
  }
  return removed;
}
