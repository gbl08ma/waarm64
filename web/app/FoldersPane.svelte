<!--
  The body of Shared folders on the Machines page (docs/shares.md §2.2, §2.3): the browser's folders, with rename, Read-only, Delete
  (naming the machines that lose it), and for a folder in the browser its top level with sizes, Add files…, copies to
  and from a folder on the computer, Empty. While a machine writes it (its lock is exclusive) those are off.
-->
<script lang="ts">
  import type { Act } from './actions.svelte.ts';
  import Check from './ui/Check.svelte';
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import CardList from './ui/CardList.svelte';
  import Icon from './ui/Icon.svelte';
  import NameInput from './ui/NameInput.svelte';
  import Note from './ui/Note.svelte';
  import { ask } from './ask.svelte.ts';
  import { t } from '../i18n.ts';
  import { bytesText } from './bytes.ts';
  import type { PageFolders } from './folders-live.ts';
  import { addFiles, copyTree, emptyFolder, folderSize, topLevel, type Copying, type Entry } from './folder-files.ts';
  import { deleteFolderOf, editFolderOf, folderDirectory, usersOf, withFolder } from './folders-page.ts';
  import type { Folder } from './folders.ts';
  import type { Store } from './store.ts';
  import { ui } from './ui.svelte.ts';

  let { folders, store, act }: { folders: PageFolders; store: Store; act: Act } = $props();

  const all = $derived((void ui.folders.tick, folders.folders));
  let open = $state<string>();
  let entries = $state<Entry[]>([]);
  let users = $state<Record<string, string[]>>({});
  let copying = $state<(Copying & { what: string }) | undefined>();
  let dropping = $state(false);

  $effect(() => {
    void ui.folders.tick;
    void (async () => {
      users = await usersOf(store, all);
    })();
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

  type Picker = {
    showOpenFilePicker(o: object): Promise<FileSystemFileHandle[]>;
    showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle>;
  };
  const pickers = globalThis as unknown as Picker;
  const cancelled = (e: unknown) => (e as Error).name === 'AbortError';

  const addPicked = (f: Folder) =>
    act(t('folders:FoldersPane.busy.adding'), async () => {
      const picked = await pickers.showOpenFilePicker({ multiple: true }).catch((e) => {
        if (cancelled(e)) return [];
        throw e;
      });
      await withFolder(f.id, true, async () =>
        addFiles(await dirOf(f), await Promise.all(picked.map((h) => h.getFile()))),
      );
      await refreshOf(f);
    });
  async function copy(
    what: string,
    id: string,
    write: boolean,
    f: () => Promise<[FileSystemDirectoryHandle, FileSystemDirectoryHandle] | undefined>,
  ) {
    await act(what, async () => {
      const pair = await f().catch((e) => {
        if (cancelled(e)) return undefined;
        throw e;
      });
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
  const copyOut = (f: Folder) =>
    copy(t('folders:FoldersPane.busy.copyingOut'), f.id, false, async () => [
      await dirOf(f),
      await pickers.showDirectoryPicker({ mode: 'readwrite' }),
    ]);
  const copyIn = async (f: Folder) => {
    await copy(t('folders:FoldersPane.busy.copyingIn'), f.id, true, async () => [
      await pickers.showDirectoryPicker({ mode: 'read' }),
      await dirOf(f),
    ]);
    await refreshOf(f);
  };
  async function empty(f: Folder) {
    if (
      !(await ask.confirm(t('folders:FoldersPane.empty.question', { name: f.name }), {
        title: t('folders:FoldersPane.empty.title'),
        ok: t('folders:FoldersPane.empty.ok'),
        danger: true,
      }))
    )
      return;
    await act(t('folders:FoldersPane.busy.emptying'), async () => {
      await withFolder(f.id, true, async () => emptyFolder(await dirOf(f)));
      await refreshOf(f);
    });
  }
  async function remove(f: Folder) {
    const lose = users[f.id] ?? [];
    const size = f.kind === 'opfs' ? await folderSize(await dirOf(f)) : 0;
    const [name, count, machines] = [f.name, lose.length, lose];
    const question =
      f.kind === 'opfs'
        ? count
          ? t('folders:FoldersPane.delete.opfs.lose', { name, size, count, machines })
          : t('folders:FoldersPane.delete.opfs', { name, size })
        : count
          ? t('folders:FoldersPane.delete.host.lose', { name, count, machines })
          : t('folders:FoldersPane.delete.host', { name });
    if (
      !(await ask.confirm(question, {
        title: t('folders:FoldersPane.delete.title'),
        ok: t('folders:FoldersPane.delete.ok'),
        danger: true,
      }))
    )
      return;
    await act(t('folders:FoldersPane.busy.deleting'), () => deleteFolderOf(folders, store, f));
  }
  async function dropped(e: DragEvent, f: Folder) {
    e.preventDefault();
    e.stopPropagation();
    dropping = false;
    if (busy(f)) return;
    const files = [...(e.dataTransfer?.items ?? [])]
      .filter((i) => i.webkitGetAsEntry()?.isFile)
      .map((i) => i.getAsFile()!); // a directory is a file here too
    await act(t('folders:FoldersPane.busy.adding'), async () => {
      await withFolder(f.id, true, async () => addFiles(await dirOf(f), files));
      await refreshOf(f);
    });
  }
</script>

<CardList empty={all.length ? undefined : t('folders:FoldersPane.none')}>
  {#each all as f (f.id)}
    <Card data-folder={f.id} data-kind={f.kind}>
      <div class="line">
        <Icon name="folder" size={18} />
        <div class="what">
          <NameInput
            class="name"
            value={f.name}
            aria-label={t('folders:FoldersPane.name')}
            data-field="folder-name"
            onchange={(name: string) =>
              void act(t('folders:FoldersPane.busy.renaming'), () => editFolderOf(folders, store, f, { name }))}
          />
          <Note inline
            >{f.kind === 'host' ? t('folders:FoldersPane.kind.host') : t('folders:FoldersPane.kind.opfs')} · {users[
              f.id
            ]?.length
              ? t('folders:FoldersPane.attachedTo', { machines: users[f.id] })
              : t('folders:FoldersPane.attachedToNone')}{#if folders.held.has(f.id)}
              · {t('folders:FoldersPane.heldElsewhere')}{/if}{#if folders.mine(f.id)}
              · {t('folders:FoldersPane.heldHere')}{/if}</Note
          >
        </div>
        <Check
          compact
          checked={f.readOnly}
          onchange={(readOnly) =>
            void act(t('folders:FoldersPane.busy.saving'), () => editFolderOf(folders, store, f, { readOnly }))}
          field="folder-ro"
          title={t('folders:FoldersPane.readOnly.title')}>{t('folders:FoldersPane.readOnly')}</Check
        >
        {#if f.kind === 'opfs'}<Button onclick={() => show(f)} data-action="folder-files"
            >{t('folders:FoldersPane.files')}</Button
          >{/if}
        <Button icon="trash" onclick={() => remove(f)} data-action="delete-folder"
          >{t('folders:FoldersPane.delete')}</Button
        >
      </div>
      {#if open === f.id}
        <div
          class="files"
          class:dropping
          role="region"
          aria-label={t('folders:FoldersPane.files.label')}
          ondragover={(e) => {
            e.preventDefault();
            dropping = true;
          }}
          ondragleave={() => (dropping = false)}
          ondrop={(e) => dropped(e, f)}
        >
          <ul data-files>
            {#each entries as x (x.name)}<li>
                {x.name}{x.kind === 'directory' ? '/' : ''} <span class="meta">{bytesText(x.size)}</span>
              </li>{:else}<li class="meta">{t('folders:FoldersPane.files.empty')}</li>{/each}
          </ul>
          {#if busy(f)}<Note data-busy>{t('folders:FoldersPane.busyNote')}</Note>{/if}
          <div class="row">
            <Button disabled={busy(f)} onclick={() => addPicked(f)} data-action="add-files"
              >{t('folders:FoldersPane.add')}</Button
            >
            <Button disabled={folders.held.has(f.id)} onclick={() => copyOut(f)} data-action="copy-out"
              >{t('folders:FoldersPane.copyOut')}</Button
            >
            <Button disabled={busy(f)} onclick={() => copyIn(f)} data-action="copy-in"
              >{t('folders:FoldersPane.copyIn')}</Button
            >
            <Button disabled={busy(f)} onclick={() => empty(f)} data-action="empty-folder"
              >{t('folders:FoldersPane.empty')}</Button
            >
          </div>
          {#if copying}<p class="copying" data-copying>
              {t('folders:FoldersPane.copying', {
                what: copying.what,
                done: copying.done,
                total: copying.total || '…',
                bytes: copying.bytes,
              })}
              <Button
                onclick={() => {
                  copying!.stop = true;
                }}
                data-action="cancel-copy">{t('folders:FoldersPane.copying.cancel')}</Button
              >
            </p>{/if}
        </div>
      {/if}
    </Card>
  {/each}
</CardList>

<style>
  .line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3) var(--space-4);
  }
  .what {
    flex: 1;
    min-width: 200px;
    display: flex;
    flex-direction: column;
  }
  /* The name, edited in place: a field that looks like the row's title until it's pointed at. */
  .files {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-top: var(--space-3);
  }
  .files.dropping {
    outline: 1px dashed var(--border);
  }
  .files ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .meta {
    color: var(--text-dim);
    font-size: var(--text-sm);
  }
  .copying {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
    margin: 0;
    color: var(--text-dim);
    font-size: var(--text-sm);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
</style>
