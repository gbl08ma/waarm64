<!--
  The Home page's pane of the page's own machine, a transient one (a test's `?machine=`): its disk (export its
  changes or the whole disk through the Export wizard, import changes, reset it) and its snapshots. Logic is the areas' (disk-*.ts, snapshot-*.ts), through `page`.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Icon from './ui/Icon.svelte';
  import Note from './ui/Note.svelte';
  import Pane from './ui/Pane.svelte';
  import ExportWizard from './ExportWizard.svelte';
  import Snapshots from './Snapshots.svelte';
  import T from './T.svelte';
  import { PAGE } from './machines-panes.ts';
  import type { Act } from './actions.svelte.ts';
  import { openPicker } from './file-pickers.ts';
  import { t } from '../i18n.ts';
  import type { Store } from './store.ts';
  import type { ExportMode } from './export.ts';
  import { machinesNav, type MachinesTab } from './areas/machines-nav.svelte.ts';
  import { current } from './areas/current.svelte.ts';
  import { power } from './areas/power.svelte.ts';
  import { inBar, page } from './page.ts';

  type Props = { store: Store; act: Act; label: string; disk: string };
  let { store, act, label, disk }: Props = $props();

  const tabs = [
    { id: 'disks', icon: 'database', label: t('machines:PagePane.tab.disks') },
    { id: 'snapshots', icon: 'history', label: t('machines:MachinePane.tab.snapshots') },
  ] as const;
  const tab = $derived(machinesNav.tab === 'snapshots' ? 'snapshots' : 'disks');

  /** The Export wizard is open. */
  let exporting = $state(false);
  const save = (mode: ExportMode, compress: boolean) => inBar(() => page.saveDisk(mode, compress));
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
        {#if current.hasOverlay}<Note inline class="meta">{t('machines:PagePane.transient.overlay')}</Note>{/if}
      </div>
      {#if current.hasOverlay}
        <div class="row">
          <Button
            icon="download"
            id="save"
            data-action="export"
            title={t('machines:PagePane.export.title')}
            onclick={() => (exporting = true)}
          >
            {t('machines:PagePane.export')}
          </Button>
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
            disabled={power.busy}
            onclick={() => inBar(() => page.resetDisk())}
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
{#if exporting}<ExportWizard name={disk} changes {save} close={() => (exporting = false)}>
    {#snippet hint()}<T k="machines:PagePane.export.hint"
        >{#snippet code(words: string)}<code>{words}</code>{/snippet}</T
      >{/snippet}
  </ExportWizard>{/if}

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
