// A file save staged through OPFS in the machine worker (web/app/worker-snapshot.ts `saveSnapshot`; docs/frontend.md
// "Snapshots", SNAPZ's decision 3): the staging file written during the pause while the storage has room, then, after
// the resume, copied into the picked file's stream or handed to the page for its download. The page names the file and
// holds its lock (web/snapshot-stage.ts).
import { msg, MsgError } from '../msg.ts';
import { fileWriter } from '../overlay.ts';
import type { Sink } from '../snapshot-file.ts';
import { removeStaged, roomFor, STAGING, stagedFile } from '../snapshot-stage.ts';
import { progress, throttled } from './worker-post.ts';

/** A staging file's write refused (the storage full, or any failure): the snapshot is written again directly. */
export class StageRefused extends Error {}

/**
 * Where a file save's snapshot goes during the pause: the staging file `name` in OPFS while it has room (`free`: the
 * storage's room, checked against the file's bound once the save knows it), else `direct` (the picked file's stream,
 * or the page's chunks). A staging write refused partway (thrown as {@link StageRefused}) switches it to direct for
 * the save's second try. `how`: what came of it.
 */
export async function staging(name: string, free: Promise<number | undefined>, direct: Sink) {
  const file = await fileWriter(`${STAGING}/${name}`); // no room made for it: a refusal falls back
  let open = true;
  let how: 'staged' | 'room' | 'refused' = 'staged';
  const abort = async () => {
    if (open) await file.abort().catch(() => undefined);
    open = false;
  };
  return {
    name,
    get how() {
      return how;
    },
    get staged() {
      return how === 'staged';
    },
    sink: (async (chunk) => {
      if (how !== 'staged') return direct(chunk);
      try {
        await file.write(chunk);
      } catch (e) {
        throw new StageRefused("the staging file's write was refused", { cause: e });
      }
    }) satisfies Sink,
    /** The file's largest size known: staged only with room for it. */
    async sized(bound: number) {
      const room = await free;
      if (how === 'staged' && room !== undefined && room < roomFor(bound)) {
        how = 'room';
        await abort();
      }
    },
    /** A staging write was refused: what is written from here goes direct. */
    async refused() {
      how = 'refused';
      await abort();
    },
    /** The staging file written and closed. */
    close() {
      if (open) file.close();
      open = false;
    },
    /** The staging file dropped, written or not (the save failed, or its copy is done). */
    async discard() {
      await abort();
      await removeStaged(name).catch(() => undefined);
    },
  };
}
export type Staging = Awaited<ReturnType<typeof staging>>;

/**
 * `file` written to `out` in 64 MiB slices, its progress posted. A slice is written as a Blob: the browser copies it
 * from file to file, none of it in this worker (~0.7 s against 4 MiB pieces read in here's ~1.3 s for the desktop's
 * 680 MB, and no garbage: bench/boot/REPORT.md "SNAPZ loop 4").
 */
async function copyInto(file: Blob, out: FileSystemWritableFileStream, id: number) {
  const SLICE = 64 << 20;
  const said = throttled(id, msg('snapshots:worker-stage.phase.copying'));
  for (let at = 0; at < file.size; at += SLICE) {
    await out.write(file.slice(at, Math.min(at + SLICE, file.size)));
    said(Math.min(at + SLICE, file.size), file.size);
  }
}

/**
 * After the resume, a staged save's file (none: not staged, nothing to do): copied into the picked file's stream (`writable`, the file named `name`)
 * and removed, or (a download) handed back as `file` for the page, which removes it. `copy`: how long it took, ms.
 */
export async function finishStaged(
  st: Staging | undefined,
  id: number,
  writable?: FileSystemWritableFileStream,
  name = '',
) {
  if (!st?.staged) return { copy: 0, file: undefined };
  st.close();
  const t = performance.now();
  if (!writable) return { copy: performance.now() - t, file: await stagedFile(st.name) };
  progress(id, msg('snapshots:worker-stage.phase.copying'), 0);
  try {
    await copyInto(await stagedFile(st.name), writable, id);
  } catch (err) {
    throw new MsgError('snapshots:worker-stage.notCopied', { name }, { cause: err });
  }
  await st.discard();
  return { copy: performance.now() - t, file: undefined };
}
