<!--
  A disk's Export menu (docs/machines.md §4): the changes of one overlay as a qcow2 backed by the image, or the whole disk as
  qcow2 or raw, compressed or not. On a machine's Disks tab (its chosen overlay) and in a disk's Overlays dialog (each one).
-->
<script lang="ts">
  import Check from './Check.svelte';
  import Menu from './Menu.svelte';
  import { t } from '../i18n.ts';
  import type { DiskRecord } from './shape.ts';
  import type { ExportMode } from './export.ts';
  import { remember, settings } from './settings.ts';
  import { page } from './ui.svelte.ts';

  /** `id` names the menu (`export-<id>`); `changes` offers Changes only (not for a blank disk, nor without an overlay). */
  let { id, disk, overlay, changes }: { id: string; disk: DiskRecord; overlay: string | undefined; changes: boolean } = $props();

  let compress = $state(settings().compress ?? true);
  let open = $state(false);
  function save(mode: ExportMode) {
    open = false;
    page.saveDisk(mode, mode !== 'raw' && compress, { disk: $state.snapshot(disk) as DiskRecord, overlay });
  }
</script>

<Menu id={`export-${id}`} icon="download" title={t('disks:ExportMenu.title')} label={t('disks:ExportMenu.label')} bind:open align="left">
  {#if changes}<button data-save="changes" title={t('disks:ExportMenu.changes.title')} onclick={() => save('changes')}>{t('disks:ExportMenu.changes')}</button>{/if}
  <button data-save="qcow2" title={t('disks:ExportMenu.qcow2.title')} onclick={() => save('qcow2')}>{t('disks:ExportMenu.qcow2')}</button>
  <button data-save="raw" title={t('disks:ExportMenu.raw.title')} onclick={() => save('raw')}>{t('disks:ExportMenu.raw')}</button>
  <Check bind:checked={compress} onchange={() => remember({ compress })} title={t('disks:ExportMenu.compress.title')}>{t('disks:ExportMenu.compress')}</Check>
  <p class="hint">{t('disks:ExportMenu.hint')}</p>
</Menu>

<style>
  .hint { color: var(--dim); font-size: 12px; margin: 4px 8px; max-width: 260px; }
</style>
