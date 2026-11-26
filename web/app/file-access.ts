// A file disk's file (docs/machines.md §3.2): whether this web app can read it now, what the browser said when the
// user allowed it, and whether a file chosen again is the disk's. Every answer the browser may give, or not give, is
// one with words: Chromium can leave a stored handle's `queryPermission` and `requestPermission` unanswered (seen on
// Linux after the computer restarted, while its settings listed the file as allowed), and a handle is a path to it,
// so a file moved away reads as NotFoundError and another file put at its place reads as that one.
import { MsgError } from '../msg.ts';
import { GRANT_WAIT_MS, granted, within } from './grants.ts';
import type { DiskRecord } from './shape.ts';

/**
 * Why a file disk's file can't be read now: no handle (it is chosen again in each session), no grant in this session
 * (`prompt`: Allow asks for it), the browser didn't answer (`unanswered`), the browser refused (`refused`), the file isn't
 * at its place (`missing`), it can't be read (`unreadable`), or the file at its place isn't the disk's (`changed`).
 */
export type Unreachable = 'nohandle' | 'prompt' | 'unanswered' | 'refused' | 'missing' | 'unreadable' | 'changed';
/** Why a file can't be read that Allow may help with (the browser's grant); the rest need the file chosen again. */
export const allowHelps = (why: Unreachable) => why === 'prompt' || why === 'unanswered' || why === 'refused';
/** A file disk's file as this web app can reach it: the file, or why not and the words that say so. */
export type Reach = { ok: true; file: File } | { ok: false; why: Unreachable; error: MsgError };

/** The handle as the page uses it (a stand-in in the tests). */
export type FileHandle = Pick<FileSystemFileHandle, 'getFile'> &
  Pick<FileSystemHandle, 'queryPermission' | 'requestPermission'>;
type FileDisk = Pick<DiskRecord, 'name' | 'size' | 'identity' | 'sha256'> & { handle?: FileHandle };

const WORDS: Record<Unreachable, string> = {
  nohandle: 'disks:file-access.nohandle',
  prompt: 'disks:file-access.prompt',
  unanswered: 'disks:file-access.unanswered',
  refused: 'disks:file-access.refused',
  missing: 'disks:file-access.missing',
  unreadable: 'disks:file-access.unreadable',
  changed: 'disks:file-access.changed',
};

/**
 * Disk `d`'s file can't be read, for reason `why` (`cause`: the browser's error, its details' last line), in the words
 * of `key` (by default the reason's).
 */
export function unreachable(
  d: FileDisk,
  why: Unreachable,
  cause?: unknown,
  params: Record<string, number> = {},
  key = WORDS[why],
): Reach & { ok: false } {
  const reason = new MsgError(key, params, cause === undefined ? undefined : { cause });
  return { ok: false, why, error: new MsgError('disks:file-access.cantRead', { name: d.name }, { cause: reason }) };
}

/** The file size disk `d` was made from (its identity's), if it keeps one. */
const madeBytes = (d: FileDisk) => (d.identity.kind === 'file' ? d.identity.bytes : undefined);

/**
 * Disk `d`'s file through its handle, which the browser lets this web app read: the file read (a byte of it), and of
 * the size it was made from, else why not. A file moved away is NotFoundError; one changed since is NotReadableError.
 */
export async function readable(d: FileDisk, h: FileHandle): Promise<Reach> {
  let file: File;
  try {
    file = await h.getFile();
    await file.slice(0, 1).arrayBuffer();
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    if (name === 'NotFoundError') return unreachable(d, 'missing', e);
    if (name === 'NotAllowedError' || name === 'SecurityError') return unreachable(d, 'refused', e);
    return unreachable(d, 'unreadable', e);
  }
  const bytes = madeBytes(d);
  if (bytes !== undefined && file.size !== bytes)
    return unreachable(d, 'changed', undefined, { size: file.size, bytes });
  return { ok: true, file };
}

/**
 * Disk `d`'s file now, without asking the user: its handle's grant asked with a bound (`granted`: given by a click in
 * this session already, so not asked again: Chromium may grant at the click and then leave the question unanswered).
 */
export async function reach(d: FileDisk, o: { granted?: boolean; ms?: number } = {}): Promise<Reach> {
  const h = d.handle;
  if (!h) return unreachable(d, 'nohandle');
  if (!o.granted) {
    let g: boolean | undefined;
    try {
      g = await granted(h, 'read', o.ms ?? GRANT_WAIT_MS);
    } catch (e) {
      return unreachable(d, 'refused', e);
    }
    if (g === undefined) return unreachable(d, 'unanswered');
    if (!g) return unreachable(d, 'prompt');
  }
  return readable(d, h);
}

/**
 * The user's click on Allow for disk `d`: the browser asked for read permission on its handle (called before any
 * await, so the click's activation is there), and the file then read. A refusal and an error are said; an answer
 * that doesn't come within `ms` is `unanswered` (a prompt may still be open: `late` gets the answer when it comes).
 */
export async function allow(d: FileDisk, ms = GRANT_WAIT_MS, late?: (r: Reach) => void): Promise<Reach> {
  const h = d.handle;
  if (!h?.requestPermission) return h ? readable(d, h) : unreachable(d, 'nohandle');
  const answer = async (p: Promise<PermissionState>): Promise<Reach> => {
    try {
      return (await p) === 'granted' ? await readable(d, h) : unreachable(d, 'refused');
    } catch (e) {
      return unreachable(d, 'refused', e);
    }
  };
  let asked: Promise<PermissionState>;
  try {
    asked = h.requestPermission({ mode: 'read' });
  } catch (e) {
    return unreachable(d, 'refused', e);
  }
  const settled = answer(asked);
  const r = await within(settled, ms);
  if (r) return r;
  if (late) void settled.then(late);
  return unreachable(d, 'unanswered', undefined, {}, 'disks:file-access.unansweredAllow');
}

/** Whether a file's head says qcow2, and its virtual size then. */
export async function qcow2Size(file: Blob) {
  const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const view = new DataView(head.buffer);
  return head.length >= 32 && view.getUint32(0) === 0x514649fb ? Number(view.getBigUint64(24)) : undefined;
}

/**
 * Whether `file`, chosen again for disk `d`, is its file (the disk's overlays hold changes made on top of that one,
 * which read as garbage on top of another): `same`; a different file, with the words that say how (`MsgError`); or
 * `ask`, when nothing the disk keeps tells (the same size and image, another name or date, and no hash). Checked, in
 * order: the file's size (its identity's), its name and date with it (the same: as `knownDisk` takes it), the hash where
 * the disk has one (`hash`: the whole file read), and the size of the disk the image holds (a qcow2's header, else the
 * file's size).
 */
export async function samePick(
  d: FileDisk,
  file: File,
  hash: (f: File) => Promise<string>,
): Promise<'same' | 'ask' | MsgError> {
  const other = (key: string, params: Record<string, number>) =>
    new MsgError('disks:file-access.other', { file: file.name, name: d.name }, { cause: new MsgError(key, params) });
  const i = d.identity;
  const bytes = madeBytes(d);
  if (bytes !== undefined && file.size !== bytes)
    return other('disks:file-access.other.size', { size: file.size, bytes });
  if (i.kind === 'file' && file.name === i.name && file.lastModified === i.modified) return 'same';
  if (d.sha256) return (await hash(file)) === d.sha256 ? 'same' : other('disks:file-access.other.hash', {});
  const size = (await qcow2Size(file)) ?? file.size;
  if (size !== d.size) return other('disks:file-access.other.image', { size, want: d.size });
  return 'ask';
}
