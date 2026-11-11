<!--
  The Machines page's pane of the page's own machine, a transient one (a test's `?machine=`): its disk (export its
  changes or the whole disk, import changes, reset it) and its snapshots. Logic is main.ts's, through `page`.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Check from './ui/Check.svelte';
  import Icon from './ui/Icon.svelte';
  import Menu from './ui/Menu.svelte';
  import Note from './ui/Note.svelte';
  import Pane from './ui/Pane.svelte';
  import Snapshots from './Snapshots.svelte';
  import T from './T.svelte';
  import { PAGE } from './machines-panes.ts';
  import type { Act } from './actions.svelte.ts';
  import { openPicker } from './file-pickers.ts';
  import { t } from '../i18n.ts';
  import { remember, settings } from './settings.ts';
  import type { Store } from './store.ts';
  import { machinesNav, type MachinesTab } from './areas/machines-nav.svelte.ts';
  import { page, ui } from './ui.svelte.ts';

  type Props = { store: Store; act: Act; label: string; disk: string };
  let { store, act, label, disk }: Props = $props();

  const tabs = [
    { id: 'disks', icon: 'database', label: t('machines:PagePane.tab.disks') },
    { id: 'snapshots', icon: 'history', label: t('machines:MachinePane.tab.snapshots') },
  ] as const;
  const tab = $derived(machinesNav.tab === 'snapshots' ? 'snapshots' : 'disks');

  // Its export's options.
  let compress = $state(settings().compress ?? true);
  let exportOpen = $state(false);
  const save = (mode: 'changes' | 'qcow2' | 'raw') => {
    exportOpen = false;
    page.saveDisk(mode, mode !== 'raw' && compress);
  };
</script>

<Pane
  id={PAGE}
  title={label}
  meta={t('machines:PagePane.transient.meta')}
  tabs={[...tabs]}
  {tab}
  ontab={(x) => (machinesNav.tab = x as MachinesTab)}
>
  {#if tab === 'disks'}
    <div class="disk" data-attachment={PAGE}>
      <div class="row">
        <Icon name="database" size={18} /><strong>{disk}</strong>
        {#if ui.hasOverlay}<Note inline class="meta">{t('machines:PagePane.transient.overlay')}</Note>{/if}
      </div>
      {#if ui.hasOverlay}
        <div class="row">
          <Menu
            id="save"
            icon="download"
            title={t('machines:PagePane.export.title')}
            label={t('machines:PagePane.export')}
            bind:open={exportOpen}
            align="left"
            variant="bordered"
          >
            <Button
              variant="item"
              data-save="changes"
              title={t('machines:PagePane.export.changes.title')}
              onclick={() => save('changes')}
            >
              {t('machines:PagePane.export.changes')}
            </Button>
            <Button
              variant="item"
              data-save="qcow2"
              title={t('machines:PagePane.export.qcow2.title')}
              onclick={() => save('qcow2')}
            >
              {t('machines:PagePane.export.qcow2')}
            </Button>
            <Button
              variant="item"
              data-save="raw"
              title={t('machines:PagePane.export.raw.title')}
              onclick={() => save('raw')}
            >
              {t('machines:PagePane.export.raw')}
            </Button>
            <Check
              id="save-compress"
              bind:checked={compress}
              onchange={() => remember({ compress })}
              title={t('machines:PagePane.export.compress.title')}
            >
              {t('machines:PagePane.export.compress')}
            </Check>
            <Note>
              <T k="machines:PagePane.export.hint">{#snippet code(words: string)}<code>{words}</code>{/snippet}</T>
            </Note>
          </Menu>
          <Button
            icon="upload"
            onclick={() => openPicker('changes')}
            title={t('machines:PagePane.importChanges.title')}
          >
            {t('machines:PagePane.importChanges')}
          </Button>
          <Button
            icon="trash"
            id="reset-disk"
            disabled={ui.busy}
            onclick={() => page.resetDisk()}
            title={t('machines:PagePane.resetDisk.title')}
          >
            {t('machines:PagePane.resetDisk')}
          </Button>
        </div>
      {/if}
    </div>
  {:else}
    <Snapshots {store} {act} />
  {/if}
</Pane>

<style>
  .disk {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
  }
</style>
