<!--
  A machine's attached folders on the Machines page (docs/shares.md §4), which change at once, running or not. The
  switch and the mount in the guest are the Machines page's (they are settings, saved as a draft).
-->
<script lang="ts">
  import type { Act } from './actions.svelte.ts';
  import Check from './ui/Check.svelte';
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import CardList from './ui/CardList.svelte';
  import Icon from './ui/Icon.svelte';
  import Note from './ui/Note.svelte';
  import MoveButtons from './MoveButtons.svelte';
  import { msg, t } from '../i18n.ts';
  import type { PageFolders } from './folders-live.ts';
  import { MAX_FOLDERS } from './folders.ts';
  import type { MachineRecord } from './shape.ts';
  import { shares } from './areas/shares.svelte.ts';
  import { current } from './areas/current.svelte.ts';
  import { page } from './page.ts';

  let {
    folders,
    machine,
    act,
  }: {
    folders: PageFolders;
    /** The record as saved: its attachments. */
    machine: MachineRecord;
    act: Act;
  } = $props();

  const all = $derived(folders.folders);
  const here = $derived(machine.id === current.id && folders.running);
  const live = $derived(here ? folders.views() : []);
  /** Where the folder is kept, and whether it is read-only (for every machine). */
  const kindText = (f: { kind: string; readOnly: boolean }) => {
    const kind = f.kind === 'host' ? msg('folders:Folders.kind.host') : msg('folders:Folders.kind.opfs');
    return f.readOnly ? t('folders:Folders.kind.readOnly', { kind }) : t(kind.key);
  };
</script>

{#if machine.shares}
  <div class="folders">
    <CardList class="folders-list" empty={machine.folders?.length ? undefined : t('folders:Folders.none')}>
      {#each machine.folders ?? [] as a, i (a.id)}
        {@const f = all.find((x) => x.id === a.id)}
        {@const v = live.find((x) => x.id === a.id)}
        <Card data-folder={a.id} data-problem={v?.problem}>
          <div class="named">
            <Icon name="folder" size={18} />
            <div class="lines">
              <strong>{v?.name ?? f?.name ?? t('folders:Folders.gone')}</strong>
              <Note inline class="meta"
                >{kindText({ kind: f?.kind ?? 'opfs', readOnly: !!f?.readOnly })}{#if folders.held.has(a.id)}
                  · {t('folders:Folders.held')}{/if}</Note
              >
              {#if v?.problem === 'permission'}<Note inline tone="warn" class="meta"
                  >{t('folders:Folders.noPermission')}</Note
                >{/if}
              {#if v?.problem === 'held'}<Note inline tone="warn" class="meta"
                  >{v.holder ? t('folders:Folders.inUseBy', { holder: v.holder }) : t('folders:Folders.inUse')}</Note
                >{/if}
            </div>
          </div>
          {#snippet actions()}
            <Check
              compact
              checked={a.readOnly}
              disabled={here && !v?.problem}
              onchange={(on: boolean) =>
                void act(t('folders:Folders.busy.saving'), () => page.folderReadOnly(machine.id, a.id, on))}
              field="folder-read-only"
              title={t('folders:Folders.readOnly.title')}>{t('folders:Folders.readOnly')}</Check
            >
            <MoveButtons
              index={i}
              count={machine.folders?.length ?? 0}
              onmove={(by: -1 | 1) =>
                act(t('folders:Folders.busy.moving'), () => page.folderMove(machine.id, a.id, by))}
              action="folder"
            />
            {#if v?.problem === 'permission'}<Button
                onclick={() => act(t('folders:Folders.busy.asking'), () => page.folderAllow(a.id))}
                data-action="allow-folder">{t('folders:Folders.allow')}</Button
              >{/if}
            {#if v?.problem === 'held'}<Button
                onclick={() => act(t('folders:Folders.busy.taking'), () => page.folderUseHere(a.id))}
                data-action="use-folder">{t('folders:Folders.useHere')}</Button
              >{/if}
            <Button
              onclick={() => act(t('folders:Folders.busy.detaching'), () => page.folderDetach(machine.id, a.id))}
              data-action="detach-folder">{t('folders:Folders.detach')}</Button
            >
          {/snippet}
        </Card>
      {/each}
    </CardList>
    {#if (machine.folders?.length ?? 0) < MAX_FOLDERS}<div class="row">
        <Button
          icon="plus"
          onclick={() => shares.openWizard({ machine: machine.id, attached: machine.folders ?? [] })}
          data-action="attach-folder">{t('folders:Folders.attach')}</Button
        >
      </div>{/if}
    <Note>{t('folders:Folders.note')}</Note>
  </div>
{/if}

<style>
  .folders {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  /* A row's icon beside its name and lines. */
  .named {
    display: flex;
    align-items: center;
    gap: var(--space-4);
  }
  .lines {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
</style>
