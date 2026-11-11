<!--
  The toolbar's Folders menu (docs/shares.md §4): the page's machine's attached folders with their state, Allow access…,
  Use it here, Detach, Attach a folder… (the Folder wizard), and where the guest finds them. Logic is
  web/app/folders-live.ts's, through `page`.
-->
<script lang="ts">
  import Menu from './ui/Menu.svelte';
  import Button from './ui/Button.svelte';
  import Note from './ui/Note.svelte';
  import StatusDot from './ui/StatusDot.svelte';
  import T from './T.svelte';
  import { errorText, t } from '../i18n.ts';
  import type { PageFolders } from './folders-live.ts';
  import { SHARES_BY_HAND } from './shares-mount.ts';
  import { page, ui } from './ui.svelte.ts';

  let { folders }: { folders: PageFolders } = $props();

  let open = $state(false);
  let error = $state('');
  const views = $derived((void ui.folders.tick, folders.views()));
  const waiting = $derived(views.some((v) => v.problem));
  $effect(() => {
    if (ui.folders.wanted) {
      ui.folders.wanted = false;
      open = true;
    }
  });
  async function act(f: () => Promise<unknown>) {
    try {
      await f();
      error = '';
    } catch (e) {
      error = errorText(e);
    }
  }
  function stateText(v: (typeof views)[number]) {
    switch (v.problem) {
      case 'permission':
        return t('folders:FoldersMenu.state.permission');
      case 'held':
        return v.holder
          ? t('folders:FoldersMenu.state.heldBy', { holder: v.holder })
          : t('folders:FoldersMenu.state.held');
      case 'missing':
        return t('folders:FoldersMenu.state.missing');
      case 'failed':
        return t('folders:FoldersMenu.state.failed', { why: v.holder });
      default:
        return v.readOnly ? t('folders:FoldersMenu.state.readOnly') : t('folders:FoldersMenu.state.readWrite');
    }
  }
</script>

<!-- The markers' words stand for what the page puts there (the path and the command): the snippets show those. -->
{#snippet path()}<code>{ui.folders.path}/&lt;name&gt;</code>{/snippet}
{#snippet command()}<code>{SHARES_BY_HAND}</code>{/snippet}

<Menu
  id="folders"
  icon="folder"
  title={t('folders:FoldersMenu.title')}
  bind:open
  panel
  data-waiting={waiting || undefined}
>
  {#snippet badge()}{#if waiting}<StatusDot tone="busy" aria-hidden="true" />{/if}{/snippet}
  <ul class="folder-list">
    {#each views as v (v.id)}
      <li data-folder={v.id} data-problem={v.problem}>
        <span><b>{v.name}</b> <small class="folder-state">{stateText(v)}</small></span>
        <span class="buttons">
          {#if v.problem === 'permission'}<Button
              data-action="allow-folder"
              onclick={() => act(() => page.folderAllow(v.id))}
              >{t('folders:FoldersMenu.allow', { name: v.name })}</Button
            >{/if}
          {#if v.problem === 'held'}<Button data-action="use-folder" onclick={() => act(() => page.folderUseHere(v.id))}
              >{t('folders:FoldersMenu.useHere')}</Button
            >{/if}
          <Button data-action="detach-folder" onclick={() => act(() => page.folderDetach(ui.current!, v.id))}
            >{t('folders:FoldersMenu.detach')}</Button
          >
        </span>
      </li>
    {:else}
      <li><Note>{t('folders:FoldersMenu.none')}</Note></li>
    {/each}
  </ul>
  <Note tone="error" id="folders-error" hidden={!error}>{error}</Note>
  <div class="buttons">
    <Button
      id="folder-attach"
      onclick={() => {
        open = false;
        page.folderWizard(
          ui.current,
          folders.views().map((v) => ({ id: v.id, readOnly: v.readOnly })),
        );
      }}>{t('folders:FoldersMenu.attach')}</Button
    >
  </div>
  <Note id="folders-where">
    {#if ui.folders.path}<T
        k="folders:FoldersMenu.where"
        params={{ path: ui.folders.path }}
        {path}
        {command}
      />{:else}<T k="folders:FoldersMenu.where.byHand" {command} />{/if}
  </Note>
</Menu>

<style>
  .folder-list {
    list-style: none;
    margin: 0 0 var(--space-3);
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 300px;
  }
  .folder-list li {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  small {
    color: var(--text-dim);
    font-size: var(--text-sm);
  }
  /* The mount command is long: it breaks where it must, in the panel. */
  code {
    overflow-wrap: anywhere;
  }
  .folder-state {
    white-space: pre-line;
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
</style>
