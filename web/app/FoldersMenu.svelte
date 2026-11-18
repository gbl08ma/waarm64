<!--
  The toolbar's Folders menu (docs/shares.md §4): the page's machine's attached folders with their state, Allow access…,
  Use it here, Detach, Attach a folder… (the Folder wizard), and where the guest finds them, with Details…: how the
  guest mounts them and the command to mount them by hand (FoldersMount.svelte, a dialog: the menu is no place for a
  command to copy). Logic is web/app/folders-live.ts's, through `page`.
-->
<script lang="ts">
  import Menu from './ui/Menu.svelte';
  import Button from './ui/Button.svelte';
  import Note from './ui/Note.svelte';
  import StatusDot from './ui/StatusDot.svelte';
  import T from './T.svelte';
  import { Actions } from './actions.svelte.ts';
  import { msg, t, type Msg } from '../i18n.ts';
  import type { PageFolders } from './folders-live.ts';
  import { shares } from './areas/shares.svelte.ts';
  import { current } from './areas/current.svelte.ts';
  import { page } from './page.ts';

  let { folders }: { folders: PageFolders } = $props();

  let open = $state(false);
  const views = $derived(folders.views());
  const waiting = $derived(views.some((v) => v.problem));
  $effect(() =>
    shares.menu.handle(() => {
      open = true;
    }),
  );
  const runner = new Actions();
  const act = (f: () => Promise<unknown>) => runner.run('', f);
  function stateText(v: (typeof views)[number]): Msg {
    switch (v.problem) {
      case 'permission':
        return msg('folders:FoldersMenu.state.permission');
      case 'held':
        return v.holder
          ? msg('folders:FoldersMenu.state.heldBy', { holder: v.holder })
          : msg('folders:FoldersMenu.state.held');
      case 'missing':
        return msg('folders:FoldersMenu.state.missing');
      case 'failed':
        return msg('folders:FoldersMenu.state.failed', { why: v.holder });
      default:
        return v.readOnly ? msg('folders:FoldersMenu.state.readOnly') : msg('folders:FoldersMenu.state.readWrite');
    }
  }
</script>

<!-- The marker's words stand for what the page puts there (the path): the snippet shows it. -->
{#snippet path()}<code>{shares.path}/&lt;name&gt;</code>{/snippet}

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
        <span><b>{v.name}</b> <small class="folder-state"><T m={stateText(v)} /></small></span>
        <span class="buttons">
          {#if v.problem === 'permission'}<Button
              data-action="allow-folder"
              onclick={() => act(() => page.folderAllow(v.id))}
              ><T k="folders:FoldersMenu.allow" params={{ name: v.name }} /></Button
            >{/if}
          {#if v.problem === 'held'}<Button data-action="use-folder" onclick={() => act(() => page.folderUseHere(v.id))}
              >{t('folders:FoldersMenu.useHere')}</Button
            >{/if}
          <Button
            data-action="detach-folder"
            onclick={() => act(() => (current.id ? page.folderDetach(current.id, v.id) : Promise.resolve()))}
            >{t('folders:FoldersMenu.detach')}</Button
          >
        </span>
      </li>
    {:else}
      <li><Note>{t('folders:FoldersMenu.none')}</Note></li>
    {/each}
  </ul>
  <Note tone="error" id="folders-error" hidden={!runner.error}>{runner.error?.text}</Note>
  <div class="buttons">
    <Button
      id="folder-attach"
      onclick={() => {
        open = false;
        shares.openWizard({
          machine: current.id,
          attached: folders.views().map((v) => ({ id: v.id, readOnly: v.readOnly })),
        });
      }}>{t('folders:FoldersMenu.attach')}</Button
    >
  </div>
  <Note id="folders-where">
    {#if shares.path}<T k="folders:FoldersMenu.where" params={{ path: shares.path }} {path} />{:else}{t(
        'folders:FoldersMenu.where.byHand',
      )}{/if}
  </Note>
  <Button
    variant="link"
    id="folders-mount-open"
    title={t('folders:FoldersMenu.mount.title')}
    onclick={() => {
      open = false;
      shares.openMount();
    }}
  >
    {t('folders:FoldersMenu.mount')}
  </Button>
</Menu>

<style>
  .folder-list {
    list-style: none;
    margin: 0 0 var(--space-3);
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
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
  /* A long mount point breaks where it must, in the panel. */
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
