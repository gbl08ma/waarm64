<!--
  The toolbar's Folders menu (docs/shares.md §4): the page's machine's attached folders with their state, Allow access…,
  Use it here, Detach, Attach a folder… (the Folder wizard), and where the guest finds them. Logic is
  web/app/folders-live.ts's, through `page`.
-->
<script lang="ts">
  import Menu from './Menu.svelte';
  import type { PageFolders } from './folders-live.ts';
  import { SHARES_BY_HAND } from './shares-mount.ts';
  import { page, ui } from './ui.svelte.ts';

  let { folders }: { folders: PageFolders } = $props();

  let open = $state(false);
  let error = $state('');
  const views = $derived((void ui.folders.tick, folders.views()));
  const waiting = $derived(views.some((v) => v.problem));
  $effect(() => {
    if (ui.folders.wanted) { ui.folders.wanted = false; open = true; }
  });
  async function act(f: () => Promise<unknown>) {
    try {
      await f();
      error = '';
    } catch (e) {
      error = String((e as Error).message ?? e);
    }
  }
  const stateText = (v: (typeof views)[number]) => (v.problem === 'permission' ? 'needs your permission' : v.problem === 'held' ? `in use by ${v.holder ?? 'a machine in another tab'}` : v.problem === 'missing' ? 'not in this browser any more' : v.problem === 'failed' ? `can't be used: ${v.holder}` : v.readOnly ? 'read-only' : 'read and write');
</script>

<Menu id="folders" icon="folder" title="The machine's shared folders" bind:open panel data-waiting={waiting || undefined}>
  {#snippet badge()}{#if waiting}<span class="dot" aria-hidden="true"></span>{/if}{/snippet}
  <ul class="folder-list">
    {#each views as v (v.id)}
      <li data-folder={v.id} data-problem={v.problem}>
        <span><b>{v.name}</b> <small>{stateText(v)}</small></span>
        <span class="net-row">
          {#if v.problem === 'permission'}<button data-action="allow-folder" onclick={() => act(() => page.folderAllow(v.id))}>Allow access to {v.name}</button>{/if}
          {#if v.problem === 'held'}<button data-action="use-folder" onclick={() => act(() => page.folderUseHere(v.id))}>Use it here</button>{/if}
          <button data-action="detach-folder" onclick={() => act(() => page.folderDetach(ui.current!, v.id))}>Detach</button>
        </span>
      </li>
    {:else}
      <li class="net-note">No folders attached.</li>
    {/each}
  </ul>
  <p id="folders-error" class="net-note net-menu-error" hidden={!error}>{error}</p>
  <div class="net-actions"><button id="folder-attach" onclick={() => { open = false; page.folderWizard(ui.current, folders.views().map((v) => ({ id: v.id, readOnly: v.readOnly }))); }}>Attach a folder…</button></div>
  <p class="net-note" id="folders-where">{#if ui.folders.path}In the guest: <code>{ui.folders.path}/&lt;name&gt;</code>. {/if}A guest without systemd 256 mounts them by hand: <code>{SHARES_BY_HAND}</code></p>
</Menu>

<style>
  .folder-list { list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-direction: column; gap: 6px; min-width: 300px; }
  .folder-list li { display: flex; flex-direction: column; gap: 4px; }
  small { color: var(--dim); }
</style>
