<!--
  The Folder wizard (docs/shares.md §4), a dialog opened through `ui.folderWizard`: attach one of the browser's folders to
  a machine (those in use marked with their machine), or make a new one: its kind, each explained, then its settings
  (for a folder on this computer, numbered steps that end at Pick the folder…).
  Without a `machine` it only makes a folder (Shared folders, on the Machines page). web/app/main.ts attaches.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import Check from './Check.svelte';
  import { errorText, msg, t } from '../i18n.ts';
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
  /** A folder to pick: who has it, or where it is kept; and whether it is read-only. */
  function stateOf(f: Folder) {
    const state = folders.held.has(f.id) ? (holders[f.id] ? msg('folders:FolderWizard.state.heldBy', { holder: holders[f.id] }) : msg('folders:FolderWizard.state.held')) : f.kind === 'host' ? msg('folders:FolderWizard.state.host') : msg('folders:FolderWizard.state.opfs');
    return f.readOnly ? t('folders:FolderWizard.state.readOnly', { state }) : t(state.key, state.params);
  }

  async function act(f: () => Promise<void>) {
    if (working) return;
    working = true;
    formError = '';
    try {
      await f();
    } catch (e) {
      if ((e as Error).name !== 'AbortError') formError = errorText(e); // the picker's Cancel isn't an error
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
    if (step === 'opfs') void act(async () => { await done(await page.folderCreate({ kind: 'opfs', name: name.trim() || t('folders:folders.defaultName'), readOnly })); });
    else if (step === 'pick') {
      const f = choices.find((x) => x.id === picked);
      if (f) void act(() => done(f));
    }
  };
  const title = $derived(step === 'pick' ? t('folders:FolderWizard.title.pick') : t('folders:FolderWizard.title.new'));
  const hasPicker = 'showDirectoryPicker' in globalThis;
</script>

<dialog id="folder-wizard" aria-labelledby="folder-title" bind:this={wizard} onclose={() => { ui.folderWizard = undefined; }}>
  <form id="folder-form" onsubmit={makeOpfs}>
    <h2 id="folder-title">{title}</h2>
    {#if step === 'pick'}
      <section class="net-step">
        <p class="net-note">{t('folders:FolderWizard.pick.note')}</p>
        <button type="button" class="net-choice" id="folder-pick-new" onclick={() => (step = 'kind')}><b>{t('folders:FolderWizard.pick.new')}</b><span>{t('folders:FolderWizard.pick.new.text')}</span></button>
        {#each choices as f (f.id)}
          <button type="button" class="net-choice" data-folder={f.id} aria-pressed={picked === f.id} onclick={() => (picked = f.id)}><b>{f.name}</b><span>{stateOf(f)}</span></button>
        {/each}
        <Check id="folder-attach-ro" bind:checked={readOnly}>{t('folders:FolderWizard.pick.readOnly')}</Check>
      </section>
    {:else if step === 'kind'}
      <section class="net-step">
        <p class="net-note">{t('folders:FolderWizard.kind')}</p>
        <button type="button" class="net-choice" id="folder-kind-host" disabled={!hasPicker} onclick={() => (step = 'host')}><b>{t('folders:FolderWizard.kind.host')}</b><span>{t('folders:FolderWizard.kind.host.text')}</span></button>
        <button type="button" class="net-choice" id="folder-kind-opfs" onclick={() => (step = 'opfs')}><b>{t('folders:FolderWizard.kind.opfs')}</b><span>{t('folders:FolderWizard.kind.opfs.text')}</span></button>
      </section>
    {:else if step === 'host'}
      <section class="net-step">
        <ol class="steps">
          <li>{t('folders:FolderWizard.host.readOnly')}<Check id="folder-host-ro" bind:checked={readOnly}>{t('folders:FolderWizard.readOnly')}</Check></li>
          <li>{readOnly ? t('folders:FolderWizard.host.read') : t('folders:FolderWizard.host.readWrite')}</li>
        </ol>
        <p class="net-note">{t('folders:FolderWizard.host.refused')}</p>
      </section>
    {:else}
      <section class="net-step">
        <label>{t('folders:FolderWizard.name')}<input id="folder-name" bind:value={name} placeholder={t('folders:folders.defaultName')} autocomplete="off" spellcheck="false"></label>
        <Check id="folder-opfs-ro" bind:checked={readOnly}>{t('folders:FolderWizard.readOnly')}</Check>
      </section>
    {/if}
    <p id="folder-error" class="net-note" hidden={!formError}>{formError}</p>
    <div class="net-buttons">
      <button type="button" id="folder-back" hidden={step === 'pick' || (step === 'kind' && !(machine && choices.length))} onclick={() => (step = step === 'kind' ? 'pick' : 'kind')}>{t('folders:FolderWizard.back')}</button><span class="grow"></span>
      <button type="button" id="folder-cancel" onclick={close}>{t('folders:FolderWizard.cancel')}</button>
      {#if step === 'host'}<button type="button" id="folder-choose" disabled={working} onclick={pickHost}>{t('folders:FolderWizard.choose')}</button>{/if}
      {#if step === 'opfs' || step === 'pick'}<button type="submit" id="folder-ok" disabled={working || (step === 'pick' && !picked)}>{machine ? t('folders:FolderWizard.attach') : t('folders:FolderWizard.create')}</button>{/if}
    </div>
  </form>
</dialog>

<style>
  .steps { display: flex; flex-direction: column; gap: 8px; margin: 0; padding-left: 20px; }
  .steps li > :global(*) { margin-top: 6px; }
</style>
