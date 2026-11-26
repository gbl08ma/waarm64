// A file disk's file (web/app/file-access.ts, docs/machines.md §3.2) through stand-in handles, one per answer the
// browser may give or not give: a grant, a refusal, an error, a question never answered, a file moved away (Chromium:
// NotFoundError, its grant still `granted`), one that changed (NotReadableError), another file put at its place (a
// handle is a path: it reads, at another size); a file chosen again checked against the disk; and the record that keeps
// its id, name, identity and overlays with the new handle.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allow, reach, samePick, type FileHandle } from '../web/app/file-access.ts';
import { replaceFileHandle } from '../web/app/disks.ts';
import { attach, createDisk, createMachine } from '../web/app/machines.ts';
import { Store } from '../web/app/store.ts';
import { memoryFiles, memoryRecords } from '../web/app/store-backends.ts';
import { msgOf } from '../web/msg.ts';

const MODIFIED = 1_700_000_000_000;
const fileOf = (bytes: number, o: { name?: string; modified?: number; fill?: number } = {}) =>
  new File([new Uint8Array(bytes).fill(o.fill ?? 7)], o.name ?? 'disk.img', { lastModified: o.modified ?? MODIFIED });
const NEVER = () => new Promise<never>(() => undefined);
const domError = (name: string) => new DOMException(`the browser's ${name}`, name);

/** A stand-in handle: what each of its calls answers (`never`: it doesn't). */
type Answers = {
  query?: PermissionState | 'never' | Error;
  request?: PermissionState | 'never' | Error;
  file?: File | Error;
  /** The file read fails (it changed since the browser handed it out). */
  unreadable?: boolean;
};
function handle(a: Answers) {
  const asked = { query: 0, request: 0 };
  const answer = (v: PermissionState | 'never' | Error | undefined) =>
    v === 'never' ? NEVER() : v instanceof Error ? Promise.reject(v) : Promise.resolve(v ?? 'granted');
  const h: FileHandle = {
    queryPermission: () => (asked.query++, answer(a.query)),
    requestPermission: () => (asked.request++, answer(a.request)),
    getFile: async () => {
      const f = a.file ?? fileOf(4096);
      if (f instanceof Error) throw f;
      if (!a.unreadable) return f;
      return Object.assign(Object.create(f) as File, { size: f.size, slice: () => ({ arrayBuffer: () => Promise.reject(domError('NotReadableError')) }) });
    },
  };
  return { h, asked };
}
const disk = (h: FileHandle | undefined, o: { bytes?: number; size?: number; sha256?: string } = {}) => ({
  name: 'disk.img',
  size: o.size ?? o.bytes ?? 4096,
  identity: { kind: 'file' as const, name: 'disk.img', bytes: o.bytes ?? 4096, modified: MODIFIED },
  handle: h,
  ...(o.sha256 ? { sha256: o.sha256 } : {}),
});
/** The reason's key (the words under "This web app can't read …"). */
const reasonOf = (r: { ok: boolean; error?: Error }) => (r.ok ? 'ok' : msgOf((r.error as Error).cause)?.key);
const MS = 50;

test('file-access: the file now, without asking: each answer the browser gives (or not) is a reason with words', { timeout: 10_000 }, async () => {
  assert.equal((await reach(disk(handle({}).h))).ok, true, 'granted, there, its size: read');
  assert.equal(reasonOf(await reach(disk(undefined))), 'disks:file-access.nohandle');
  assert.equal(reasonOf(await reach(disk(handle({ query: 'prompt' }).h))), 'disks:file-access.prompt');
  assert.equal(reasonOf(await reach(disk(handle({ query: 'denied' }).h))), 'disks:file-access.prompt');
  const t0 = performance.now();
  assert.equal(reasonOf(await reach(disk(handle({ query: 'never' }).h), { ms: MS })), 'disks:file-access.unanswered');
  assert.ok(performance.now() - t0 < 2000, 'not waited for');
  assert.equal(reasonOf(await reach(disk(handle({ query: domError('SecurityError') }).h))), 'disks:file-access.refused');
  // Granted, and the file moved away (Chromium keeps the grant of the path), or changed, or another at its place.
  assert.equal(reasonOf(await reach(disk(handle({ file: domError('NotFoundError') }).h))), 'disks:file-access.missing');
  assert.equal(reasonOf(await reach(disk(handle({ file: domError('NotAllowedError') }).h))), 'disks:file-access.refused');
  assert.equal(reasonOf(await reach(disk(handle({ unreadable: true }).h))), 'disks:file-access.unreadable');
  const other = await reach(disk(handle({ file: fileOf(8192) }).h));
  assert.equal(reasonOf(other), 'disks:file-access.changed');
  assert.deepEqual(msgOf((other as { error: Error }).error.cause)?.params, { size: 8192, bytes: 4096 });
  assert.equal(msgOf((other as { error: Error }).error)?.key, 'disks:file-access.cantRead', 'the headline names the disk');
  // Allowed by a click in this session: not asked again (Chromium may grant, then leave the query unanswered).
  const after = handle({ query: 'never' });
  assert.equal((await reach(disk(after.h), { granted: true, ms: MS })).ok, true);
  assert.equal(after.asked.query, 0);
});

test('file-access: Allow from a click: granted, refused, an error, no answer (and its late answer), granted over a moved file', { timeout: 10_000 }, async () => {
  assert.equal((await allow(disk(handle({ request: 'granted' }).h), MS)).ok, true);
  assert.equal(reasonOf(await allow(disk(handle({ request: 'denied' }).h), MS)), 'disks:file-access.refused');
  assert.equal(reasonOf(await allow(disk(handle({ request: 'prompt' }).h), MS)), 'disks:file-access.refused', 'a prompt dismissed');
  const thrown = await allow(disk(handle({ request: domError('SecurityError') }).h), MS);
  assert.equal(reasonOf(thrown), 'disks:file-access.refused');
  assert.equal(((thrown as { error: Error }).error.cause as Error).cause instanceof DOMException, true, "the browser's error under it");
  assert.equal(reasonOf(await allow(disk(handle({ request: 'granted', file: domError('NotFoundError') }).h), MS)), 'disks:file-access.missing');
  assert.equal(reasonOf(await allow(disk(handle({ request: 'granted', file: fileOf(10) }).h), MS)), 'disks:file-access.changed');
  // The browser never answers: said within the bound; it is asked once, synchronously (the click's activation).
  const never = handle({ request: 'never' });
  const p = allow(disk(never.h), MS);
  assert.equal(never.asked.request, 1, 'asked before any await');
  assert.equal(reasonOf(await p), 'disks:file-access.unansweredAllow');
  // A prompt left open past the bound: its answer comes to `late`.
  let grant!: (s: PermissionState) => void;
  const slow: FileHandle = { ...handle({}).h, requestPermission: () => new Promise((r) => (grant = r)) };
  let late: unknown;
  assert.equal(reasonOf(await allow(disk(slow), MS, (r) => (late = r))), 'disks:file-access.unansweredAllow');
  grant('granted');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((late as { ok: boolean } | undefined)?.ok, true, 'the late grant reaches its caller');
});

test("file-access: a file chosen again is the disk's only by its size and image, then its name and date or its hash", { timeout: 10_000 }, async () => {
  const hashes: string[] = [];
  const hash = (f: File) => (hashes.push(f.name), Promise.resolve(f.size === 4096 && f.name === 'copy.img' ? 'right' : 'wrong'));
  const d = disk(undefined);
  assert.equal(await samePick(d, fileOf(4096), hash), 'same', 'the same name, size and date');
  const bigger = await samePick(d, fileOf(4097), hash);
  assert.ok(bigger instanceof Error);
  assert.equal(msgOf(bigger)?.key, 'disks:file-access.other');
  assert.deepEqual(msgOf(bigger.cause)?.params, { size: 4097, bytes: 4096 });
  assert.equal(await samePick(d, fileOf(4096, { name: 'copy.img' }), hash), 'ask', 'another name, nothing else to tell: asked');
  assert.equal(await samePick(d, fileOf(4096, { modified: 1 }), hash), 'ask', 'another date: asked');
  assert.deepEqual(hashes, [], 'no hash without one kept');
  // With the disk's hash (a definition's): the hash decides.
  const hashed = disk(undefined, { sha256: 'right' });
  assert.equal(await samePick(hashed, fileOf(4096, { name: 'copy.img' }), hash), 'same');
  assert.equal(msgOf((await samePick(hashed, fileOf(4096, { name: 'other.img' }), hash)) as Error)?.key, 'disks:file-access.other');
  // A qcow2 whose header says another disk size than the disk's, at the same file size.
  const head = new Uint8Array(4096);
  const view = new DataView(head.buffer);
  view.setUint32(0, 0x514649fb);
  view.setBigUint64(24, 1n << 30n);
  const qcow2 = new File([head], 'other.qcow2', { lastModified: 5 });
  const image = await samePick(disk(undefined, { bytes: 4096, size: 1 << 20 }), qcow2, hash);
  assert.equal(msgOf((image as Error).cause)?.key, 'disks:file-access.other.image');
  assert.equal(await samePick(disk(undefined, { bytes: 4096, size: 1 << 30 }), qcow2, hash), 'ask', 'the same disk size: asked');
});

test("file-access: the file chosen again replaces the handle only: the disk's id, name, identity, overlays and machines stay", { timeout: 10_000 }, async () => {
  const store = new Store(memoryRecords(), memoryFiles()); // closed after: its channel keeps Node running
  try {
    // Handles as plain objects: the memory store clones records as IndexedDB does.
    const old = { kind: 'file', name: 'disk.img' } as unknown as FileSystemFileHandle;
    const d = await createDisk(store, { kind: 'file', file: fileOf(4096), handle: old, size: 4096 });
    const m = await createMachine(store, { name: 'M' });
    await attach(store, m, d);
    const before = await store.get('machines', m.id);
    const next = { kind: 'file', name: 'moved.img' } as unknown as FileSystemFileHandle;
    const now = await replaceFileHandle(store, d.id, next);
    assert.deepEqual(now?.handle, next);
    const kept = await store.get('disks', d.id);
    assert.deepEqual({ ...kept, handle: undefined }, { ...d, handle: undefined }, 'everything but the handle as it was');
    assert.deepEqual(kept?.handle, next);
    assert.deepEqual(await store.get('machines', m.id), before, 'the machine (its attachments, overlays) untouched');
    assert.equal(await replaceFileHandle(store, 'gone', next), undefined, 'a disk deleted meanwhile');
    const blank = await createDisk(store, { kind: 'blank', size: 1 << 20 });
    assert.equal(await replaceFileHandle(store, blank.id, next), undefined, 'not a file disk');
  } finally {
    store.close();
  }
});
