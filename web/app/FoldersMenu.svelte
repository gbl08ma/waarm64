<!--
  The toolbar's Folders menu (docs/shares.md §4): the page's machine's attached folders with their state, Allow access…,
  Use it here, Detach, Attach a folder… (the Folder wizard), and where the guest finds them. Logic is
  web/app/folders-live.ts's, through `page`.
-->
<script lang="ts">
  import Menu from './Menu.svelte';
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

<Menu
  id="folders"
  icon="folder"
  title={t('folders:FoldersMenu.title')}
  bind:open
  panel
  data-waiting={waiting || undefined}
>
  {#snippet badge()}{#if waiting}<span class="dot" aria-hidden="true"></span>{/if}{/snippet}
  <ul class="folder-list">
    {#each views as v (v.id)}
      <li data-folder={v.id} data-problem={v.problem}>
        <span><b>{v.name}</b> <small class="folder-state">{stateText(v)}</small></span>
        <span class="net-row">
          {#if v.problem === 'permission'}<button
              data-action="allow-folder"
              onclick={() => act(() => page.folderAllow(v.id))}
              >{t('folders:FoldersMenu.allow', { name: v.name })}</button
            >{/if}
          {#if v.problem === 'held'}<button data-action="use-folder" onclick={() => act(() => page.folderUseHere(v.id))}
              >{t('folders:FoldersMenu.useHere')}</button
            >{/if}
          <button data-action="detach-folder" onclick={() => act(() => page.folderDetach(ui.current!, v.id))}
            >{t('folders:FoldersMenu.detach')}</button
          >
        </span>
      </li>
    {:else}
      <li class="net-note">{t('folders:FoldersMenu.none')}</li>
    {/each}
  </ul>
  <p id="folders-error" class="net-note net-menu-error" hidden={!error}>{error}</p>
  <div class="net-actions">
    <button
      id="folder-attach"
      onclick={() => {
        open = false;
        page.folderWizard(
          ui.current,
          folders.views().map((v) => ({ id: v.id, readOnly: v.readOnly })),
        );
      }}>{t('folders:FoldersMenu.attach')}</button
    >
  </div>
  <!-- The markers' words stand for what the page puts there (the path and the command): the snippets show those. -->
  <p class="net-note" id="folders-where">
    {#snippet path()}<code>{ui.folders.path}/&lt;name&gt;</code>{/snippet}
    {#snippet command()}<code>{SHARES_BY_HAND}</code>{/snippet}
    {#if ui.folders.path}<T
        k="folders:FoldersMenu.where"
        params={{ path: ui.folders.path }}
        {path}
        {command}
      />{:else}<T k="folders:FoldersMenu.where.byHand" {command} />{/if}
  </p>
</Menu>

<style>
  .folder-list {
    list-style: none;
    margin: 0 0 8px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 300px;
  }
  .folder-list li {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  small {
    color: var(--dim);
  }
  .folder-state {
    white-space: pre-line;
  }
</style>
