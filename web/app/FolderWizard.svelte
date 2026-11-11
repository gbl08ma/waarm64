<!--
  The Folder wizard (docs/shares.md §4), a dialog opened through `ui.folderWizard`: attach one of the browser's folders to
  a machine (those in use marked with their machine), or make a new one: its kind, each explained, then its settings
  (for a folder on this computer, numbered steps that end at Pick the folder…).
  Without a `machine` it only makes a folder (Shared folders, on the Machines page). web/app/main.ts attaches.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import Button from './ui/Button.svelte';
  import Choice from './ui/Choice.svelte';
  import Field from './ui/Field.svelte';
  import Modal from './ui/Modal.svelte';
  import Note from './ui/Note.svelte';
  import Check from './ui/Check.svelte';
  import { errorText, msg, t } from '../i18n.ts';
  import { preselect, type Folder } from './folders.ts';
  import type { PageFolders } from './folders-live.ts';
  import type { FolderAttachment } from './shape.ts';
  import { page, ui } from './ui.svelte.ts';

  let { folders }: { folders: PageFolders } = $props();

  type Step = 'pick' | 'kind' | 'host' | 'opfs';
  let wizard: Modal;
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
    wizard.open();
    step = o.machine && choices.length ? 'pick' : 'kind';
    for (const id of folders.held)
      void folders.locks.holder(`webpc-folder:${id}`).then((who) => {
        if (who) holders = { ...holders, [id]: who };
      });
  }
  const close = () => {
    wizard.close();
    ui.folderWizard = undefined;
  };
  /** A folder to pick: who has it, or where it is kept; and whether it is read-only. */
  function stateOf(f: Folder) {
    const state = folders.held.has(f.id)
      ? holders[f.id]
        ? msg('folders:FolderWizard.state.heldBy', { holder: holders[f.id] })
        : msg('folders:FolderWizard.state.held')
      : f.kind === 'host'
        ? msg('folders:FolderWizard.state.host')
        : msg('folders:FolderWizard.state.opfs');
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
  const pickHost = () =>
    act(async () => {
      await done(await page.folderPick(readOnly));
    });
  const makeOpfs = (e: SubmitEvent) => {
    e.preventDefault();
    if (step === 'opfs')
      void act(async () => {
        await done(
          await page.folderCreate({ kind: 'opfs', name: name.trim() || t('folders:folders.defaultName'), readOnly }),
        );
      });
    else if (step === 'pick') {
      const f = choices.find((x) => x.id === picked);
      if (f) void act(() => done(f));
    }
  };
  const title = $derived(step === 'pick' ? t('folders:FolderWizard.title.pick') : t('folders:FolderWizard.title.new'));
  const hasPicker = 'showDirectoryPicker' in globalThis;
</script>

<Modal
  id="folder-wizard"
  bodyId="folder-form"
  bind:this={wizard}
  {title}
  auto={false}
  onclose={() => {
    ui.folderWizard = undefined;
  }}
  onsubmit={makeOpfs}
>
  {#if step === 'pick'}
    <section class="step">
      <Note size="md">{t('folders:FolderWizard.pick.note')}</Note>
      <Choice id="folder-pick-new" label={t('folders:FolderWizard.pick.new')} onclick={() => (step = 'kind')}
        >{t('folders:FolderWizard.pick.new.text')}</Choice
      >
      {#each choices as f (f.id)}
        <Choice label={f.name} data-folder={f.id} pressed={picked === f.id} onclick={() => (picked = f.id)}
          >{stateOf(f)}</Choice
        >
      {/each}
      <Check id="folder-attach-ro" bind:checked={readOnly}>{t('folders:FolderWizard.pick.readOnly')}</Check>
    </section>
  {:else if step === 'kind'}
    <section class="step">
      <Note size="md">{t('folders:FolderWizard.kind')}</Note>
      <Choice
        id="folder-kind-host"
        label={t('folders:FolderWizard.kind.host')}
        disabled={!hasPicker}
        onclick={() => (step = 'host')}>{t('folders:FolderWizard.kind.host.text')}</Choice
      >
      <Choice id="folder-kind-opfs" label={t('folders:FolderWizard.kind.opfs')} onclick={() => (step = 'opfs')}
        >{t('folders:FolderWizard.kind.opfs.text')}</Choice
      >
    </section>
  {:else if step === 'host'}
    <section class="step">
      <ol class="steps">
        <li>
          {t('folders:FolderWizard.host.readOnly')}
          <div class="in-step">
            <Check id="folder-host-ro" bind:checked={readOnly}>{t('folders:FolderWizard.readOnly')}</Check>
          </div>
        </li>
        <li>{readOnly ? t('folders:FolderWizard.host.read') : t('folders:FolderWizard.host.readWrite')}</li>
      </ol>
      <Note size="md">{t('folders:FolderWizard.host.refused')}</Note>
    </section>
  {:else}
    <section class="step">
      <Field label={t('folders:FolderWizard.name')}
        ><input
          id="folder-name"
          bind:value={name}
          placeholder={t('folders:folders.defaultName')}
          autocomplete="off"
          spellcheck="false"
        /></Field
      >
      <Check id="folder-opfs-ro" bind:checked={readOnly}>{t('folders:FolderWizard.readOnly')}</Check>
    </section>
  {/if}
  <Note tone="error" size="md" id="folder-error" class="error" hidden={!formError}>{formError}</Note>
  {#snippet back()}
    <Button
      type="button"
      id="folder-back"
      hidden={step === 'pick' || (step === 'kind' && !(machine && choices.length))}
      onclick={() => (step = step === 'kind' ? 'pick' : 'kind')}>{t('folders:FolderWizard.back')}</Button
    >
  {/snippet}
  {#snippet buttons()}
    <Button type="button" id="folder-cancel" onclick={close}>{t('folders:FolderWizard.cancel')}</Button>
    {#if step === 'host'}<Button
        type="button"
        variant="primary"
        id="folder-choose"
        disabled={working}
        onclick={pickHost}>{t('folders:FolderWizard.choose')}</Button
      >{/if}
    {#if step === 'opfs' || step === 'pick'}<Button
        type="submit"
        variant="primary"
        id="folder-ok"
        disabled={working || (step === 'pick' && !picked)}
        >{machine ? t('folders:FolderWizard.attach') : t('folders:FolderWizard.create')}</Button
      >{/if}
  {/snippet}
</Modal>

<style>
  .step {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .steps {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin: 0;
    padding-left: var(--space-6);
  }
  .in-step {
    margin-top: var(--space-3);
  }
</style>
