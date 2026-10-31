// What a directory handle costs (bench/shares/REPORT.md). Every cost a shared folder's server pays, measured on `root`
// through the API it would use, and how the API behaves where the server depends on it (`behaviour`: each a probe that
// says what happened). In a worker, where the device worker's server runs.
type Sync = { read(b: Uint8Array, o: { at: number }): number; write(b: Uint8Array, o: { at: number }): number; truncate(n: number): void; flush(): void; close(): void; getSize(): number };
type SyncFile = FileSystemFileHandle & { createSyncAccessHandle(o?: object): Promise<Sync> };
type Movable = FileSystemHandle & { move(dir: FileSystemDirectoryHandle, name?: string): Promise<void>; move(name: string): Promise<void> };
type Dir = FileSystemDirectoryHandle & { entries(): AsyncIterable<[string, FileSystemHandle]>; queryPermission?(o: object): Promise<string> };

const FILES = 5000;
const MiB = 1 << 20;
const say = (progress: string) => postMessage({ progress });
const timed = async (f: () => Promise<unknown>) => { const t = performance.now(); await f(); return +(performance.now() - t).toFixed(2); };
const perOp = (ms: number, n: number) => ({ ms, usPerOp: +(ms * 1000 / n).toFixed(1) });
const note = async (f: () => Promise<unknown>) => { try { return { ok: await f() ?? true }; } catch (e) { return { error: `${(e as Error).name}: ${(e as Error).message}` }; } };

async function write(f: FileSystemFileHandle, bytes: number, chunk = MiB) {
  const w = await f.createWritable();
  const b = new Uint8Array(chunk).fill(7);
  for (let at = 0; at < bytes; at += chunk) await w.write({ type: 'write', position: at, data: at + chunk > bytes ? b.subarray(0, bytes - at) : b });
  await w.close();
}

async function small(dir: FileSystemDirectoryHandle) {
  const r: Record<string, unknown> = {};
  const names = Array.from({ length: FILES }, (_, k) => `f${k}`);
  const data = new Uint8Array(4096).fill(1);
  r.create4k = perOp(await timed(async () => {
    for (const n of names) {
      const w = await (await dir.getFileHandle(n, { create: true })).createWritable();
      await w.write(data);
      await w.close();
    }
  }), FILES);
  say('created');
  const handles: FileSystemFileHandle[] = [];
  r.lookup = perOp(await timed(async () => { for (const n of names) handles.push(await dir.getFileHandle(n)); }), FILES);
  r.lookupMissing = perOp(await timed(async () => { for (const n of names) await dir.getFileHandle(`${n}x`).catch(() => {}); }), FILES);
  r.lookupDirAsFile = perOp(await timed(async () => { const up = dir; for (let k = 0; k < 500; k++) await up.getFileHandle('sub').catch(() => {}); }), 500);
  r.getFile = perOp(await timed(async () => { for (const h of handles) await h.getFile(); }), FILES);
  r.getFileParallel32 = perOp(await timed(async () => { for (let k = 0; k < FILES; k += 32) await Promise.all(handles.slice(k, k + 32).map((h) => h.getFile())); }), FILES);
  r.entries = perOp(await timed(async () => { let n = 0; for await (const _ of (dir as Dir).entries()) n++; if (n !== FILES + 1) throw new Error(`${n} entries`); }), FILES);
  r.read4k = perOp(await timed(async () => { for (const h of handles.slice(0, 1000)) await (await h.getFile()).arrayBuffer(); }), 1000);
  r.remove = perOp(await timed(async () => { for (const n of names) await dir.removeEntry(n); }), FILES);
  return r;
}

async function big(dir: FileSystemDirectoryHandle, opfs: boolean) {
  const r: Record<string, unknown> = {};
  const f = await dir.getFileHandle('big', { create: true });
  r.cpIn100MiB = await timed(() => write(f, 100 * MiB));
  r.cpOut100MiB = await timed(async () => {
    const file = await f.getFile();
    for (let at = 0; at < file.size; at += MiB) await file.slice(at, at + MiB).arrayBuffer();
  });
  r.cpOverwriteSameFile100MiB = await timed(() => write(f, 100 * MiB));
  for (const size of [100, 1024]) {
    if (size > 100) await write(f, size * MiB);
    say(`session on ${size} MiB`);
    let w!: FileSystemWritableFileStream;
    const open = await timed(async () => { w = await f.createWritable({ keepExistingData: true }); });
    const one = await timed(() => w.write({ type: 'write', position: 4096, data: new Uint8Array(4096) }));
    const close = await timed(() => w.close());
    r[`session${size}MiB`] = { open, one4kWrite: one, close };
    if (size === 100) {
      const emptied = await timed(async () => { const t = await f.createWritable({ keepExistingData: false }); await t.close(); });
      r.sessionNoKeep = emptied;
    }
  }
  if (opfs) {
    const h = dir.getFileHandle('sync', { create: true }) as Promise<SyncFile>;
    const sf = await h;
    let s!: Sync;
    r.syncOpen = await timed(async () => { s = await sf.createSyncAccessHandle(); });
    const b = new Uint8Array(MiB).fill(3);
    r.syncIn100MiB = await timed(async () => { for (let k = 0; k < 100; k++) s.write(b, { at: k * MiB }); s.flush(); });
    r.syncOut100MiB = await timed(async () => { for (let k = 0; k < 100; k++) s.read(b, { at: k * MiB }); });
    r.syncClose = await timed(async () => s.close());
    r.syncOpenClose = perOp(await timed(async () => { for (let k = 0; k < 200; k++) (await sf.createSyncAccessHandle()).close(); }), 200);
    await dir.removeEntry('sync');
  }
  await dir.removeEntry('big');
  return r;
}

/** What the server depends on: each probe's outcome. */
async function behaviour(dir: FileSystemDirectoryHandle, opfs: boolean) {
  const r: Record<string, unknown> = {};
  const file = async (name: string, text = 'x') => { const h = await dir.getFileHandle(name, { create: true }); const w = await h.createWritable(); await w.write(text); await w.close(); return h; };
  r.hasMove = typeof (FileSystemFileHandle.prototype as unknown as Movable).move === 'function';
  r.moveFileRename = await note(async () => { const h = await file('m1'); await (h as unknown as Movable).move('m2'); return [h.name, (await h.getFile()).size]; });
  const sub = await dir.getDirectoryHandle('sub', { create: true });
  // `move(dir, name)` is the server's call; a real folder refuses `move(name)`, so each probe makes its own file.
  r.moveFileRenameInDir = await note(async () => { const h = await file('m4'); await (h as unknown as Movable).move(dir, 'm5'); return [h.name, (await h.getFile()).size]; });
  r.moveFileNewExtension = await note(async () => { const h = await file('m6.txt'); await (h as unknown as Movable).move(dir, 'm6.sh'); return h.name; });
  r.moveFileAcross = await note(async () => { const h = await file('m7'); await (h as unknown as Movable).move(sub, 'm3'); return h.name; });
  r.moveFileOverExisting = await note(async () => { const a = await file('o1', 'aa'); await file('o2', 'bbb'); await (a as unknown as Movable).move(dir, 'o2'); return (await a.getFile()).size; });
  r.moveDirRename = await note(async () => { const d = await dir.getDirectoryHandle('d1', { create: true }); await (d as unknown as Movable).move('d2'); return d.name; });
  r.moveDirAcross = await note(async () => { const d = await dir.getDirectoryHandle('d3', { create: true }); await (d as unknown as Movable).move(sub, 'd4'); return d.name; });
  r.moveWithSessionOpen = await note(async () => { const h = await file('s1'); const w = await h.createWritable({ keepExistingData: true }); try { await (h as unknown as Movable).move(dir, 's2'); } finally { await w.abort(); } });
  r.removeWithSessionOpen = await note(async () => { const h = await file('s3'); const w = await h.createWritable({ keepExistingData: true }); try { await dir.removeEntry('s3'); await w.write('y'); await w.close(); return (await h.getFile().catch((e) => e.name)); } finally { await w.abort().catch(() => {}); } });
  r.readOldFileAfterChange = await note(async () => { const h = await file('r1', 'aaaa'); const old = await h.getFile(); await new Promise((f) => setTimeout(f, 20)); await file('r1', 'bbbbbb'); return old.slice(0, 2).text(); });
  r.readOldFileAfterRemove = await note(async () => { const h = await file('r2', 'aaaa'); const old = await h.getFile(); await dir.removeEntry('r2'); return old.slice(0, 2).text(); });
  r.twoSessions = await note(async () => { const h = await file('t1'); const a = await h.createWritable({ keepExistingData: true }); const b = await h.createWritable({ keepExistingData: true }); await a.abort(); await b.abort(); });
  // On a real folder a session's swap file takes the name's `.crswap`: the handle alone, then a session.
  r.longNames = {};
  for (const k of [240, 248, 249, 255, 256]) (r.longNames as Record<string, unknown>)[k] = await note(async () => { const n = 'b'.repeat(k); const h = await dir.getFileHandle(n, { create: true }); const session = await h.createWritable().then((w) => w.close().then(() => 'ok'), (e) => e.name); await dir.removeEntry(n); return session; });
  r.badNames = {};
  for (const n of ['a/b', 'a\\b', '..', 'nul', 'a:b', 'trailing.', 'trailing ', 'CON', 'x.lnk', 'x.url', 'x.crswap', '.DS_Store', 'desktop.ini', 'é', 'a'.repeat(255), 'a'.repeat(300), 'ctrl\x01']) (r.badNames as Record<string, unknown>)[n.length > 20 ? `a×${n.length}` : n] = await note(async () => { const h = await file(n); await dir.removeEntry(h.name); });
  r.caseFold = await note(async () => { await file('CaSe'); const other = await dir.getFileHandle('case').then(() => 'same file', (e) => e.name); await dir.removeEntry('CaSe'); return other; });
  r.createDirOverFile = await note(async () => { await file('e1'); return dir.getDirectoryHandle('e1', { create: true }); });
  await sub.getFileHandle('kept', { create: true });
  r.removeNonEmptyDir = await note(async () => dir.removeEntry('sub'));
  r.lastModified = await note(async () => { const h = await file('t2'); const f = await h.getFile(); return [f.lastModified, Date.now()]; });
  if (opfs) {
    const sync = async (name: string) => (await file(name) as unknown as SyncFile).createSyncAccessHandle();
    r.syncGetFile = await note(async () => { const s = await sync('y1'); try { s.write(new Uint8Array(9), { at: 0 }); const f = await (await dir.getFileHandle('y1')).getFile(); return [f.size, await f.arrayBuffer().then((b) => b.byteLength, (e) => e.name)]; } finally { s.close(); } });
    r.syncMove = await note(async () => { const s = await sync('y2'); try { await ((await dir.getFileHandle('y2')) as unknown as Movable).move('y3'); } finally { s.close(); } });
    r.syncRemove = await note(async () => { const s = await sync('y4'); try { await dir.removeEntry('y4'); s.write(new Uint8Array(1), { at: 0 }); return 'wrote after remove'; } finally { s.close(); } });
    r.syncTwoReadOnly = await note(async () => { const h = await file('y5') as unknown as SyncFile; const a = await h.createSyncAccessHandle({ mode: 'read-only' }); const b = await h.createSyncAccessHandle({ mode: 'read-only' }); a.close(); b.close(); });
    r.syncCreateWritable = await note(async () => { const s = await sync('y6'); try { const w = await (await dir.getFileHandle('y6')).createWritable(); await w.abort(); } finally { s.close(); } });
  }
  r.queryPermissionInWorker = await note(async () => (dir as Dir).queryPermission?.({ mode: 'readwrite' }));
  r.requestPermissionInWorker = typeof (dir as Dir & { requestPermission?: unknown }).requestPermission;
  r.estimateInWorker = await note(async () => navigator.storage.estimate());
  return r;
}

/** A dropped folder (read permission only, run.ts made its files): what reading costs. */
async function reading(root: FileSystemDirectoryHandle) {
  const r: Record<string, unknown> = {};
  const dir = await root.getDirectoryHandle('small');
  const names = Array.from({ length: FILES }, (_, k) => `f${k}`);
  const handles: FileSystemFileHandle[] = [];
  r.lookup = perOp(await timed(async () => { for (const n of names) handles.push(await dir.getFileHandle(n)); }), FILES);
  r.lookupMissing = perOp(await timed(async () => { for (const n of names) await dir.getFileHandle(`${n}x`).catch(() => {}); }), FILES);
  r.getFile = perOp(await timed(async () => { for (const h of handles) await h.getFile(); }), FILES);
  r.getFileParallel32 = perOp(await timed(async () => { for (let k = 0; k < FILES; k += 32) await Promise.all(handles.slice(k, k + 32).map((h) => h.getFile())); }), FILES);
  r.entries = perOp(await timed(async () => { let n = 0; for await (const _ of (dir as Dir).entries()) n++; if (n !== FILES) throw new Error(`${n} entries`); }), FILES);
  r.read4k = perOp(await timed(async () => { for (const h of handles.slice(0, 1000)) await (await h.getFile()).arrayBuffer(); }), 1000);
  const big = await (await root.getFileHandle('big')).getFile();
  r.cpOut100MiB = await timed(async () => { for (let at = 0; at < big.size; at += MiB) await big.slice(at, at + MiB).arrayBuffer(); });
  r.hasWrite = await note(async () => (root as Dir).queryPermission?.({ mode: 'readwrite' }));
  return r;
}

onmessage = async (e: MessageEvent<{ root: FileSystemDirectoryHandle | 'opfs'; kind: string }>) => {
  const { kind } = e.data;
  if (kind === 'host-read') { postMessage({ result: { kind, reading: await reading(e.data.root as FileSystemDirectoryHandle) } }); return; }
  const opfs = e.data.root === 'opfs';
  const base = e.data.root === 'opfs' ? await navigator.storage.getDirectory() : e.data.root;
  try {
    const work = await base.getDirectoryHandle('webpc-shares-bench', { create: true });
    const sdir = await work.getDirectoryHandle('small', { create: true });
    await sdir.getDirectoryHandle('sub', { create: true });
    const result: Record<string, unknown> = { kind, cores: navigator.hardwareConcurrency };
    say('behaviour');
    result.behaviour = await behaviour(await work.getDirectoryHandle('probes', { create: true }), opfs);
    say('small files');
    result.small = await small(sdir);
    say('big files');
    result.big = await big(await work.getDirectoryHandle('bigs', { create: true }), opfs);
    await base.removeEntry('webpc-shares-bench', { recursive: true });
    postMessage({ result });
  } catch (err) {
    await base.removeEntry('webpc-shares-bench', { recursive: true }).catch(() => {});
    postMessage({ error: `${(err as Error).name}: ${(err as Error).message}\n${(err as Error).stack}` });
  }
};
