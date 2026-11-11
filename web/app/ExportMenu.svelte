<!--
  A disk's Export menu (docs/machines.md §4): the changes of one overlay as a qcow2 backed by the image, or the whole disk as
  qcow2 or raw, compressed or not. On a machine's Disks tab (its chosen overlay) and in a disk's Overlays dialog (each one).
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Check from './ui/Check.svelte';
  import Note from './ui/Note.svelte';
  import Menu from './ui/Menu.svelte';
  import { t } from '../i18n.ts';
  import type { DiskRecord } from './shape.ts';
  import type { ExportMode } from './export.ts';
  import { remember, settings } from './settings.ts';
  import { inBar, page } from './page.ts';

  /** `id` names the menu (`export-<id>`); `changes` offers Changes only (not for a blank disk, nor without an overlay). */
  let { id, disk, overlay, changes }: { id: string; disk: DiskRecord; overlay: string | undefined; changes: boolean } =
    $props();

  let compress = $state(settings().compress ?? true);
  let open = $state(false);
  function save(mode: ExportMode) {
    open = false;
    inBar(() => page.saveDisk(mode, mode !== 'raw' && compress, { disk: $state.snapshot(disk), overlay }));
  }
</script>

<Menu
  id={`export-${id}`}
  icon="download"
  title={t('disks:ExportMenu.title')}
  label={t('disks:ExportMenu.label')}
  bind:open
  align="left"
  variant="bordered"
>
  {#if changes}<Button
      variant="item"
      data-save="changes"
      title={t('disks:ExportMenu.changes.title')}
      onclick={() => save('changes')}>{t('disks:ExportMenu.changes')}</Button
    >{/if}
  <Button variant="item" data-save="qcow2" title={t('disks:ExportMenu.qcow2.title')} onclick={() => save('qcow2')}
    >{t('disks:ExportMenu.qcow2')}</Button
  >
  <Button variant="item" data-save="raw" title={t('disks:ExportMenu.raw.title')} onclick={() => save('raw')}
    >{t('disks:ExportMenu.raw')}</Button
  >
  <Check bind:checked={compress} onchange={() => remember({ compress })} title={t('disks:ExportMenu.compress.title')}
    >{t('disks:ExportMenu.compress')}</Check
  >
  <div class="hint"><Note>{t('disks:ExportMenu.hint')}</Note></div>
</Menu>

<style>
  .hint {
    max-width: 260px;
    padding: var(--space-2) var(--space-4);
  }
</style>
