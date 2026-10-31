// What the page does with the files of a folder in the browser (docs/shares.md §2.3): its top level with sizes, files
// added, copies to and from a folder on the computer through a picked directory (which is why there's no archive format),
// and emptying it. Runs on the page, on a folder no machine writes (its lock says so).

export type Entry = { name: string; kind: 'file' | 'directory'; size: number };
type Dir = FileSystemDirectoryHandle & { entries(): AsyncIterable<[string, FileSystemHandle]> };
/** Where a copy is: files done of `total`, bytes copied; `stop` is true once Cancel was pressed. */
export type Copying = { done: number; total: number; bytes: number; stop?: boolean; onChange?: () => void };

async function listOf(d: FileSystemDirectoryHandle) {
  const out: [string, FileSystemHandle][] = [];
  for await (const e of (d as Dir).entries()) out.push(e);
  return out;
}

async function sizeOf(h: FileSystemHandle): Promise<number> {
  if (h.kind === 'file') return (await (h as FileSystemFileHandle).getFile()).size;
  let n = 0;
  for (const [, c] of await listOf(h as FileSystemDirectoryHandle)) n += await sizeOf(c);
  return n;
}

/** The directory's top level, directories first, with their sizes. */
export async function topLevel(d: FileSystemDirectoryHandle): Promise<Entry[]> {
  const list = await Promise.all((await listOf(d)).map(async ([name, h]) => ({ name, kind: h.kind, size: await sizeOf(h) })));
  return list.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

export const folderSize = (d: FileSystemDirectoryHandle) => sizeOf(d);

/** Writes `files` into `d` by name, over what is there. */
export async function addFiles(d: FileSystemDirectoryHandle, files: File[]) {
  for (const f of files) {
    const w = await (await d.getFileHandle(f.name, { create: true })).createWritable();
    await w.write(f);
    await w.close();
  }
}

/** Removes everything in `d`. */
export async function emptyFolder(d: FileSystemDirectoryHandle) {
  for (const [name] of await listOf(d)) await d.removeEntry(name, { recursive: true });
}

async function countFiles(d: FileSystemDirectoryHandle): Promise<number> {
  let n = 0;
  for (const [, h] of await listOf(d)) n += h.kind === 'file' ? 1 : await countFiles(h as FileSystemDirectoryHandle);
  return n;
}

/** Copies `from` into `to`, recursively, over what is there, until done or `c.stop`. */
export async function copyTree(from: FileSystemDirectoryHandle, to: FileSystemDirectoryHandle, c: Copying) {
  c.total ||= await countFiles(from);
  for (const [name, h] of await listOf(from)) {
    if (c.stop) return;
    if (h.kind === 'directory') await copyTree(h as FileSystemDirectoryHandle, await to.getDirectoryHandle(name, { create: true }), c);
    else {
      const file = await (h as FileSystemFileHandle).getFile();
      const w = await (await to.getFileHandle(name, { create: true })).createWritable();
      await w.write(file);
      await w.close();
      c.done++;
      c.bytes += file.size;
      c.onChange?.();
    }
  }
}
