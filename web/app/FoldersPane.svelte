<!--
  The body of Shared folders on the Machines page (docs/shares.md §2.2, §2.3): the browser's folders, with rename, Read-only, Delete
  (naming the machines that lose it), and for a folder in the browser its top level with sizes, Add files…, copies to
  and from a folder on the computer, Empty. While a machine writes it (its lock is exclusive) those are off.
-->
<script lang="ts">
  import Check from './Check.svelte';
  import Icon from './Icon.svelte';
  import { ask } from './ask.svelte.ts';
  import { bytesText } from './bytes.ts';
  import type { PageFolders } from './folders-live.ts';
  import { addFiles, copyTree, emptyFolder, folderSize, topLevel, type Copying, type Entry } from './folder-files.ts';
  import { deleteFolderOf, editFolderOf, folderDirectory, usersOf, withFolder } from './folders-page.ts';
  import type { Folder } from './folders.ts';
  import type { Store } from './store.ts';
  import { ui } from './ui.svelte.ts';

  let { folders, store, act }: { folders: PageFolders; store: Store; act: (what: string, f: () => Promise<unknown>) => unknown } = $props();

  const all = $derived((void ui.folders.tick, folders.folders));
  let open = $state<string>();
  let entries = $state<Entry[]>([]);
  let users = $state<Record<string, string[]>>({});
  let copying = $state<(Copying & { what: string }) | undefined>();
  let dropping = $state(false);

  $effect(() => {
    void ui.folders.tick;
    void (async () => { users = await usersOf(store, all); })();
  });
  const busy = (f: Folder) => folders.held.has(f.id) || folders.mine(f.id);
  const dirOf = (f: Folder) => folderDirectory(f);
  async function refreshOf(f: Folder) {
    const list = await topLevel(await dirOf(f));
    if (open === f.id) entries = list; // what's open now may be another folder's
  }
  async function show(f: Folder) {
    open = open === f.id ? undefined : f.id;
    entries = [];
    if (open) await refreshOf(f);
  }

  type Picker = { showOpenFilePicker(o: object): Promise<FileSystemFileHandle[]>; showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> };
  const pickers = globalThis as unknown as Picker;
  const cancelled = (e: unknown) => (e as Error).name === 'AbortError';

  const addPicked = (f: Folder) => act('Adding files', async () => {
    const picked = await pickers.showOpenFilePicker({ multiple: true }).catch((e) => { if (cancelled(e)) return []; throw e; });
    await withFolder(f.id, true, async () => addFiles(await dirOf(f), await Promise.all(picked.map((h) => h.getFile()))));
    await refreshOf(f);
  });
  async function copy(what: string, id: string, write: boolean, f: () => Promise<[FileSystemDirectoryHandle, FileSystemDirectoryHandle] | undefined>) {
    await act(what, async () => {
      const pair = await f().catch((e) => { if (cancelled(e)) return undefined; throw e; });
      if (!pair) return;
      const c = $state({ what, done: 0, total: 0, bytes: 0 } as Copying & { what: string });
      copying = c;
      try {
        await withFolder(id, write, () => copyTree(pair[0], pair[1], c));
      } finally {
        copying = undefined;
      }
    });
  }
  const copyOut = (f: Folder) => copy('Copying out', f.id, false, async () => [await dirOf(f), await pickers.showDirectoryPicker({ mode: 'readwrite' })]);
  const copyIn = async (f: Folder) => { await copy('Copying in', f.id, true, async () => [await pickers.showDirectoryPicker({ mode: 'read' }), await dirOf(f)]); await refreshOf(f); };
  async function empty(f: Folder) {
    if (!(await ask.confirm(`Empty ${f.name}? Its files are deleted from this browser.`, { title: 'Empty the folder', ok: 'Empty', danger: true }))) return;
    await act('Emptying', async () => { await withFolder(f.id, true, async () => emptyFolder(await dirOf(f))); await refreshOf(f); });
  }
  async function remove(f: Folder) {
    const lose = users[f.id] ?? [];
    const size = f.kind === 'opfs' ? await folderSize(await dirOf(f)) : 0;
    const what = `${f.kind === 'opfs' ? `Its files (${bytesText(size)}) are deleted from this browser. ` : 'The folder on this computer stays as it is. '}${lose.length ? `${lose.join(', ')} ${lose.length > 1 ? 'lose' : 'loses'} it.` : ''}`;
    if (!(await ask.confirm(`Delete ${f.name}? ${what}`, { title: 'Delete the folder', ok: 'Delete', danger: true }))) return;
    await act('Deleting', () => deleteFolderOf(folders, store, f));
  }
  async function dropped(e: DragEvent, f: Folder) {
    e.preventDefault();
    e.stopPropagation();
    dropping = false;
    if (busy(f)) return;
    const files = [...(e.dataTransfer?.items ?? [])].filter((i) => i.webkitGetAsEntry()?.isFile).map((i) => i.getAsFile()!); // a directory is a file here too
    await act('Adding files', async () => { await withFolder(f.id, true, async () => addFiles(await dirOf(f), files)); await refreshOf(f); });
  }
</script>

<ul class="cards">
  {#each all as f (f.id)}
    <li data-folder={f.id} data-kind={f.kind}>
      <div class="line">
        <Icon name="folder" size={18} />
        <div class="what">
          <input class="name" value={f.name} aria-label="Name" data-field="folder-name" onchange={(e) => { const name = e.currentTarget.value; void act('Renaming', () => editFolderOf(folders, store, f, { name })); }}>
          <span class="meta">{f.kind === 'host' ? 'on this computer' : 'in the browser'} · {users[f.id]?.length ? `attached to ${users[f.id].join(', ')}` : 'attached to no machine'}{folders.held.has(f.id) ? ' · a machine in another tab has it' : ''}{folders.mine(f.id) ? ' · this page\'s machine has it' : ''}</span>
        </div>
        <Check compact checked={f.readOnly} onchange={(readOnly) => void act('Saving', () => editFolderOf(folders, store, f, { readOnly }))} field="folder-ro" title="No machine writes it">Read-only</Check>
        {#if f.kind === 'opfs'}<button onclick={() => show(f)} data-action="folder-files">Files</button>{/if}
        <button onclick={() => remove(f)} data-action="delete-folder"><Icon name="trash" size={16} />Delete</button>
      </div>
      {#if open === f.id}
        <div class="files" class:dropping role="region" aria-label="Its files" ondragover={(e) => { e.preventDefault(); dropping = true; }} ondragleave={() => (dropping = false)} ondrop={(e) => dropped(e, f)}>
          <ul data-files>
            {#each entries as x (x.name)}<li>{x.name}{x.kind === 'directory' ? '/' : ''} <span class="meta">{bytesText(x.size)}</span></li>{:else}<li class="meta">Empty</li>{/each}
          </ul>
          {#if busy(f)}<p class="note" data-busy>A machine has this folder: its files change only when it lets it go.</p>{/if}
          <div class="row">
            <button disabled={busy(f)} onclick={() => addPicked(f)} data-action="add-files">Add files…</button>
            <button disabled={folders.held.has(f.id)} onclick={() => copyOut(f)} data-action="copy-out">Copy into a folder on this computer…</button>
            <button disabled={busy(f)} onclick={() => copyIn(f)} data-action="copy-in">Copy from a folder on this computer…</button>
            <button disabled={busy(f)} onclick={() => empty(f)} data-action="empty-folder">Empty</button>
          </div>
          {#if copying}<p class="note" data-copying>{copying.what}: {copying.done} of {copying.total || '…'} files, {bytesText(copying.bytes)} <button onclick={() => { copying!.stop = true; }} data-action="cancel-copy">Cancel</button></p>{/if}
        </div>
      {/if}
    </li>
  {:else}
    <li class="none">No folders yet: make one here, or from a machine's Shared folders tab. A folder dropped on this page becomes one.</li>
  {/each}
</ul>

<style>
  .cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .cards > li { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); }
  .cards > li.none { color: var(--dim); }
  .line { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .what { flex: 1; min-width: 200px; display: flex; flex-direction: column; }
  .meta { color: var(--dim); font-size: 12px; }
  .name { font: inherit; font-weight: 600; color: var(--text); background: transparent; border: 1px solid transparent; border-radius: 4px; padding: 1px 4px; margin-left: -5px; }
  .name:hover, .name:focus { border-color: var(--line); }
  .files { display: flex; flex-direction: column; gap: 6px; }
  .files.dropping { outline: 1px dashed var(--line); }
  .files ul { list-style: none; margin: 0; padding: 0; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; }
  button { white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 6px; padding: 3px 10px; }
  .note { color: var(--dim); font-size: 12px; margin: 0; }
</style>
