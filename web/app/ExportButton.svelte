<!--
  A disk's Export (docs/machines.md §4) on a machine's Disks tab: opens the Export wizard (ExportWizard.svelte) for its
  chosen overlay (the changes, or the whole disk) or, a stored disk without one, the whole disk.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import ExportWizard from './ExportWizard.svelte';
  import { t } from '../i18n.ts';
  import type { DiskRecord } from './shape.ts';
  import type { ExportMode } from './export.ts';
  import { inBar, page } from './page.ts';

  /** `changes` offers Changes only (not for a blank disk, nor without an overlay). */
  let { disk, overlay, changes }: { disk: DiskRecord; overlay: string | undefined; changes: boolean } = $props();

  let open = $state(false);
  function save(mode: ExportMode, compress: boolean) {
    inBar(() => page.saveDisk(mode, compress, { disk: $state.snapshot(disk), overlay }));
  }
</script>

<Button icon="download" title={t('disks:ExportButton.title')} data-action="export" onclick={() => (open = true)}
  >{t('disks:ExportButton.label')}</Button
>
{#if open}<ExportWizard name={disk.name} {changes} {save} close={() => (open = false)}
    >{#snippet hint()}{t('disks:ExportButton.hint')}{/snippet}</ExportWizard
  >{/if}
