<!--
  A machine's attached folders on the Machines page (docs/shares.md §4), which change at once, running or not. The
  switch and the mount in the guest are the Machines page's (they are settings, saved as a draft).
-->
<script lang="ts">
  import Check from './Check.svelte';
  import Icon from './Icon.svelte';
  import MoveButtons from './MoveButtons.svelte';
  import { msg, t } from '../i18n.ts';
  import type { PageFolders } from './folders-live.ts';
  import { MAX_FOLDERS } from './folders.ts';
  import type { MachineRecord } from './shape.ts';
  import { page, ui } from './ui.svelte.ts';

  let {
    folders,
    machine,
    act,
  }: {
    folders: PageFolders;
    /** The record as saved: its attachments. */
    machine: MachineRecord;
    act: (what: string, f: () => Promise<unknown>) => unknown;
  } = $props();

  const all = $derived((void ui.folders.tick, folders.folders));
  const here = $derived(machine.id === ui.current && folders.running);
  const live = $derived((void ui.folders.tick, here ? folders.views() : []));
  /** Where the folder is kept, and whether it is read-only (for every machine). */
  const kindText = (f: { kind: string; readOnly: boolean }) => {
    const kind = f.kind === 'host' ? msg('folders:Folders.kind.host') : msg('folders:Folders.kind.opfs');
    return f.readOnly ? t('folders:Folders.kind.readOnly', { kind }) : t(kind.key);
  };
</script>

{#if machine.shares}
  <div class="folders">
    <ul class="folders-list">
      {#each machine.folders ?? [] as a, i (a.id)}
        {@const f = all.find((x) => x.id === a.id)}
        {@const v = live.find((x) => x.id === a.id)}
        <li data-folder={a.id} data-problem={v?.problem}>
          <Icon name="folder" size={18} />
          <div class="what">
            <strong>{v?.name ?? f?.name ?? t('folders:Folders.gone')}</strong>
            <span class="meta"
              >{kindText({ kind: f?.kind ?? 'opfs', readOnly: !!f?.readOnly })}{#if folders.held.has(a.id)}
                · {t('folders:Folders.held')}{/if}</span
            >
            {#if v?.problem === 'permission'}<span class="meta warn">{t('folders:Folders.noPermission')}</span>{/if}
            {#if v?.problem === 'held'}<span class="meta warn"
                >{v.holder ? t('folders:Folders.inUseBy', { holder: v.holder }) : t('folders:Folders.inUse')}</span
              >{/if}
          </div>
          <Check
            compact
            checked={a.readOnly}
            disabled={here && !v?.problem}
            onchange={(on) =>
              void act(t('folders:Folders.busy.saving'), () => page.folderReadOnly(machine.id, a.id, on))}
            field="folder-read-only"
            title={t('folders:Folders.readOnly.title')}>{t('folders:Folders.readOnly')}</Check
          >
          <MoveButtons
            index={i}
            count={machine.folders?.length ?? 0}
            onmove={(by) => act(t('folders:Folders.busy.moving'), () => page.folderMove(machine.id, a.id, by))}
            action="folder"
          />
          {#if v?.problem === 'permission'}<button
              onclick={() => act(t('folders:Folders.busy.asking'), () => page.folderAllow(a.id))}
              data-action="allow-folder">{t('folders:Folders.allow')}</button
            >{/if}
          {#if v?.problem === 'held'}<button
              onclick={() => act(t('folders:Folders.busy.taking'), () => page.folderUseHere(a.id))}
              data-action="use-folder">{t('folders:Folders.useHere')}</button
            >{/if}
          <button
            onclick={() => act(t('folders:Folders.busy.detaching'), () => page.folderDetach(machine.id, a.id))}
            data-action="detach-folder">{t('folders:Folders.detach')}</button
          >
        </li>
      {:else}
        <li class="none">{t('folders:Folders.none')}</li>
      {/each}
    </ul>
    {#if (machine.folders?.length ?? 0) < MAX_FOLDERS}<div class="row">
        <button onclick={() => page.folderWizard(machine.id, machine.folders ?? [])} data-action="attach-folder"
          ><Icon name="plus" size={16} />{t('folders:Folders.attach')}</button
        >
      </div>{/if}
    <p class="note">{t('folders:Folders.note')}</p>
  </div>
{/if}

<style>
  .folders {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .folders-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .folders-list li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--panel);
  }
  .folders-list li.none {
    color: var(--dim);
  }
  .what {
    flex: 1;
    min-width: 200px;
    display: flex;
    flex-direction: column;
  }
  .meta {
    color: var(--dim);
    font-size: 12px;
  }
  .warn {
    color: #ffb36b;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  button {
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 3px 10px;
  }
  .note {
    color: var(--dim);
    font-size: 12px;
    margin: 0;
  }
</style>
