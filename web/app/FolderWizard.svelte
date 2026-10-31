<!--
  The Folder wizard (docs/shares.md §4), a dialog opened through `ui.folderWizard`: attach one of the browser's folders to
  a machine (those in use marked with their machine), or make a new one: its kind, each explained, then its settings.
  Without a `machine` it only makes a folder (Shared folders, on the Machines page). web/app/main.ts attaches.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import Check from './Check.svelte';
  import { preselect, type Folder } from './folders.ts';
  import type { PageFolders } from './folders-live.ts';
  import type { FolderAttachment } from './shape.ts';
  import { page, ui } from './ui.svelte.ts';

  let { folders }: { folders: PageFolders } = $props();

  type Step = 'pick' | 'kind' | 'host' | 'opfs';
  let wizard: HTMLDialogElement;
  let step = $state<Step>('kind');
  let attached = $state<FolderAttachment[]>([]);
  let picked = $state<string>();
  let readOnly = $state(false);
  let name = $state('');
  let formError = $state('');
  let working = $state(false);
  let holders = $state<Record<string, string>>({});
  const machine = $derived(ui.folderWizard?.machine);
  const all = $derived((void ui.folders.tick, folders.folders));
  const choices = $derived(all.filter((f) => !attached.some((a) => a.id === f.id)));

  $effect(() => {
    const o = ui.folderWizard;
    if (!o) return;
    void o.tick;
    untrack(() => void begin(o));
  });

  async function begin(o: NonNullable<typeof ui.folderWizard>) {
    await folders.refresh();
    attached = o.attached ?? [];
    formError = '';
    name = '';
    readOnly = false;
    holders = {};
    picked = preselect(all, attached);
    if (!wizard.open) wizard.showModal();
    step = o.machine && choices.length ? 'pick' : 'kind';
    for (const id of folders.held) void folders.locks.holder(`webpc-folder:${id}`).then((who) => { if (who) holders = { ...holders, [id]: who }; });
  }
  const close = () => { wizard.close(); ui.folderWizard = undefined; };
  const stateOf = (f: Folder) => (folders.held.has(f.id) ? `in use by ${holders[f.id] ?? 'a machine in another tab'}` : f.kind === 'host' ? 'a folder on this computer' : 'a folder in the browser');

  async function act(f: () => Promise<void>) {
    if (working) return;
    working = true;
    formError = '';
    try {
      await f();
    } catch (e) {
      if ((e as Error).name !== 'AbortError') formError = String((e as Error).message ?? e); // the picker's Cancel isn't an error
    } finally {
      working = false;
    }
  }
  /** Attaches `f` to the wizard's machine, if it has one. */
  async function done(f: Folder) {
    if (machine) await page.folderAttach(machine, f, readOnly);
    close();
  }
  const pickHost = () => act(async () => { await done(await page.folderPick(readOnly)); });
  const makeOpfs = (e: SubmitEvent) => {
    e.preventDefault();
    if (step === 'opfs') void act(async () => { await done(await page.folderCreate({ kind: 'opfs', name: name.trim() || 'Shared folder', readOnly })); });
    else if (step === 'pick') {
      const f = choices.find((x) => x.id === picked);
      if (f) void act(() => done(f));
    }
  };
  const title = $derived(step === 'pick' ? 'Attach a folder' : 'A new folder');
  const hasPicker = 'showDirectoryPicker' in globalThis;
</script>

<dialog id="folder-wizard" aria-labelledby="folder-title" bind:this={wizard} onclose={() => { ui.folderWizard = undefined; }}>
  <form onsubmit={makeOpfs}>
    <h2 id="folder-title">{title}</h2>
    {#if step === 'pick'}
      <section class="net-step">
        <p class="net-note">A folder is kept by this browser, for any of its machines. Several machines can read one; one that writes has it alone.</p>
        <button type="button" class="net-choice" id="folder-pick-new" onclick={() => (step = 'kind')}><b>New folder…</b><span>On this computer, or in the browser.</span></button>
        {#each choices as f (f.id)}
          <button type="button" class="net-choice" data-folder={f.id} aria-pressed={picked === f.id} onclick={() => (picked = f.id)}><b>{f.name}</b><span>{stateOf(f)}{f.readOnly ? ', read-only' : ''}</span></button>
        {/each}
        <Check id="folder-attach-ro" bind:checked={readOnly}>Read-only for this machine</Check>
      </section>
    {:else if step === 'kind'}
      <section class="net-step">
        <p class="net-note">Which kind of folder?</p>
        <button type="button" class="net-choice" id="folder-kind-host" disabled={!hasPicker} onclick={() => (step = 'host')}><b>A folder on this computer</b><span>You pick it; the machine reads and writes the files themselves. Writing into a big file is slow: each session copies it (SQLite databases and disk images belong in the browser's kind, or on a disk).</span></button>
        <button type="button" class="net-choice" id="folder-kind-opfs" onclick={() => (step = 'opfs')}><b>A new folder in the browser</b><span>Kept by this browser beside its disks, fast for any kind of writing. Files go in and out through its card, under Shared folders on the Machines page.</span></button>
      </section>
    {:else if step === 'host'}
      <section class="net-step">
        <Check id="folder-host-ro" bind:checked={readOnly}>Read-only</Check>
        <p class="net-note">Pick the folder next: the browser asks whether this page may {readOnly ? 'read' : 'read and write'} it, and refuses a few (your home directory itself, system ones).</p>
      </section>
    {:else}
      <section class="net-step">
        <label>Name<input id="folder-name" bind:value={name} placeholder="Shared folder" autocomplete="off" spellcheck="false"></label>
        <Check id="folder-opfs-ro" bind:checked={readOnly}>Read-only</Check>
      </section>
    {/if}
    <p id="folder-error" class="net-note" hidden={!formError}>{formError}</p>
    <div class="net-buttons">
      <button type="button" id="folder-back" hidden={step === 'pick' || (step === 'kind' && !(machine && choices.length))} onclick={() => (step = step === 'kind' ? 'pick' : 'kind')}>Back</button><span class="grow"></span>
      <button type="button" id="folder-cancel" onclick={close}>Cancel</button>
      {#if step === 'host'}<button type="button" id="folder-choose" disabled={working} onclick={pickHost}>Pick the folder…</button>{/if}
      {#if step === 'opfs' || step === 'pick'}<button type="submit" id="folder-ok" disabled={working || (step === 'pick' && !picked)}>{machine ? 'Attach' : 'Create'}</button>{/if}
    </div>
  </form>
</dialog>
