<!--
  The Machines page's Shared folders tab (docs/shares.md §4): the machine's switch and its mount in the guest (a draft:
  saved as Settings are), and the attached folders, which change at once, running or not.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Check from './Check.svelte';
  import Icon from './Icon.svelte';
  import type { PageFolders } from './folders-live.ts';
  import { MAX_FOLDERS } from './folders.ts';
  import type { MachineRecord } from './shape.ts';
  import { DEFAULT_SHARES_PATH, sharesPathError } from './shares-mount.ts';
  import { page, ui } from './ui.svelte.ts';

  let { folders, machine, draft = $bindable(), act, changed, children }: {
    folders: PageFolders;
    /** The record as saved: its attachments. */
    machine: MachineRecord;
    /** The settings being edited. */
    draft: MachineRecord | undefined;
    act: (what: string, f: () => Promise<unknown>) => unknown;
    changed: () => void;
    /** The Save row, under the settings. */
    children: Snippet;
  } = $props();

  const all = $derived((void ui.folders.tick, folders.folders));
  const here = $derived(machine.id === ui.current && folders.running);
  const live = $derived((void ui.folders.tick, here ? folders.views() : []));
  const pathError = $derived(sharesPathError(draft?.sharesPath ?? DEFAULT_SHARES_PATH));
</script>

{#if draft}<div class="settings folders-switch" oninput={changed} onchange={changed}>
  <Check bind:checked={draft.shares} field="shares" title="One virtio-9p device through which the guest reaches this machine's folders: the guest sees it, so turning it on or off changes the machine's shape">Shared folders</Check>
  {#if !!draft.shares !== !!machine.shares}<p class="note warn" data-shares-orphans>Turning shared folders {draft.shares ? 'on' : 'off'} changes the machine's shape: the snapshots taken before are orphaned (they stay, marked, until deleted), as a RAM change does.</p>{/if}
  {#if draft.shares}
    <Check checked={draft.sharesMount !== false} onchange={(on) => { draft!.sharesMount = on ? undefined : false; changed(); }} field="shares-mount" title="At every boot the page has the guest's systemd mount the device, at the first access">Mount shared folders in the guest</Check>
    {#if draft.sharesMount !== false}
      <label>Mount point <input value={draft.sharesPath ?? DEFAULT_SHARES_PATH} oninput={(e) => { const v = e.currentTarget.value; draft!.sharesPath = v === DEFAULT_SHARES_PATH ? undefined : v; changed(); }} data-field="shares-path" spellcheck="false"></label>
      {#if pathError}<p class="note warn" data-shares-path-error>{pathError}</p>{/if}
      <p class="note" data-shares-path-note>Mounting over a directory that has files hides them.{machine.id === ui.current && ui.state === 'running' ? ' A new mount point takes effect at the next start.' : ''} On a guest with systemd 256 or newer; nothing is written to its disk.</p>
    {/if}
  {/if}
  {@render children()}
</div>{/if}
{#if machine.shares}
  <ul class="adapters folders-list">
    {#each machine.folders ?? [] as a, i (a.id)}
      {@const f = all.find((x) => x.id === a.id)}
      {@const v = live.find((x) => x.id === a.id)}
      <li data-folder={a.id} data-problem={v?.problem}>
        <Icon name="folder" size={18} />
        <div class="what"><strong>{v?.name ?? f?.name ?? 'A folder gone from this browser'}</strong>
          <span class="meta">{f?.kind === 'host' ? 'on this computer' : 'in the browser'}{f?.readOnly ? ', read-only' : ''}{folders.held.has(a.id) ? ' · held by another machine' : ''}</span>
          {#if v?.problem === 'permission'}<span class="meta warn">No permission in this browser</span>{/if}
          {#if v?.problem === 'held'}<span class="meta warn">In use by {v.holder ?? 'a machine in another tab'}</span>{/if}</div>
        <Check compact checked={a.readOnly} disabled={here && !v?.problem} onchange={(on) => void act('Saving', () => page.folderReadOnly(machine.id, a.id, on))} field="folder-read-only" title="This machine only reads it">Read-only</Check>
        <button disabled={i === 0} onclick={() => act('Moving', () => page.folderMove(machine.id, a.id, -1))} title="Up" aria-label="Up" data-action="folder-up"><Icon name="arrow-up" size={16} /></button>
        <button disabled={i === (machine.folders?.length ?? 0) - 1} onclick={() => act('Moving', () => page.folderMove(machine.id, a.id, 1))} title="Down" aria-label="Down" data-action="folder-down"><Icon name="arrow-down" size={16} /></button>
        {#if v?.problem === 'permission'}<button onclick={() => act('Asking', () => page.folderAllow(a.id))} data-action="allow-folder">Allow…</button>{/if}
        {#if v?.problem === 'held'}<button onclick={() => act('Taking it', () => page.folderUseHere(a.id))} data-action="use-folder">Use it here</button>{/if}
        <button onclick={() => act('Detaching', () => page.folderDetach(machine.id, a.id))} data-action="detach-folder">Detach</button>
      </li>
    {:else}
      <li class="none">No folders attached.</li>
    {/each}
  </ul>
  {#if (machine.folders?.length ?? 0) < MAX_FOLDERS}<div class="row"><button onclick={() => page.folderWizard(machine.id, machine.folders ?? [])} data-action="attach-folder"><Icon name="plus" size={16} />Attach a folder…</button></div>{/if}
  <p class="note">A folder is attached or detached at once, running or not: the guest finds it under the mount point by its name.</p>
{/if}

<style>
  .folders-switch { margin-bottom: 12px; }
  .folders-list { list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .folders-list li { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); }
  .folders-list li.none { color: var(--dim); }
  .what { flex: 1; min-width: 200px; display: flex; flex-direction: column; }
  .warn { color: #ffb36b; }
  .folders-list button { white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 6px; padding: 3px 10px; }
  .row { display: flex; gap: 6px; }
  .note { color: var(--dim); font-size: 12px; margin: 0; }
</style>
