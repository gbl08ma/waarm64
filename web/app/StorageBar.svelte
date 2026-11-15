<!--
  The Machines page's foot: the browser's storage, used and its quota (persisted or not: ask for it), what clears the
  remote disks' cache and the shaders', what has the running guest hand back the space it freed. The icon after the
  line opens what holds the bytes (StorageDetails.svelte); while the browser's count is short of the files listed there
  (`behind`), the line gives the files' sum alone, and the icon is a warning.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import StorageDetails from './StorageDetails.svelte';
  import type { Act } from './actions.svelte.ts';
  import { clearCaches } from '../diskcache.ts';
  import { t } from '../i18n.ts';
  import { askPersist, type storageReport } from './storage-report.ts';
  import { clearShaderStore } from '../venus-cache.ts';
  import { page } from './page.ts';
  import { current } from './areas/current.svelte.ts';

  type Props = { storage: Awaited<ReturnType<typeof storageReport>>; act: Act };
  let { storage, act }: Props = $props();

  const used = $derived(
    storage.behind
      ? storage.persisted
        ? t('machines:StorageBar.storage.counted.persisted', { used: storage.counted })
        : t('machines:StorageBar.storage.counted', { used: storage.counted })
      : storage.persisted
        ? t('machines:StorageBar.storage.persisted', { used: storage.usage, quota: storage.quota })
        : t('machines:StorageBar.storage', { used: storage.usage, quota: storage.quota }),
  );
  const detailsTitle = $derived(
    storage.behind ? t('machines:StorageBar.details.behind.title') : t('machines:StorageBar.details.title'),
  );
  let details = $state(false);
</script>

<footer class="storage">
  <span class="used"
    >{used}<Button
      variant="plain"
      icon={storage.behind ? 'alert-triangle' : 'info-circle'}
      tone={storage.behind ? 'warn' : undefined}
      data-action="storage-details"
      title={detailsTitle}
      aria-label={detailsTitle}
      onclick={() => (details = true)}
    /></span
  >
  {#if !storage.persisted}
    <Button
      variant="plain"
      title={t('machines:StorageBar.storage.persist.title')}
      onclick={() => act(t('machines:StorageBar.busy.asking'), askPersist)}
    >
      {t('machines:StorageBar.storage.persist')}
    </Button>
  {/if}
  {#if storage.remote > 0}
    <Button
      variant="plain"
      data-action="clear-remote-cache"
      title={t('machines:StorageBar.storage.clear.title')}
      onclick={() => act(t('machines:StorageBar.busy.clearing'), clearCaches)}
    >
      {t('machines:StorageBar.storage.clear', { size: storage.remote })}
    </Button>
  {/if}
  {#if storage.shaders > 0}
    <Button
      variant="plain"
      data-action="clear-shaders"
      title={t('machines:StorageBar.storage.clearShaders.title')}
      onclick={() => act(t('machines:StorageBar.busy.clearing'), clearShaderStore)}
    >
      {t('machines:StorageBar.storage.clearShaders', { size: storage.shaders })}
    </Button>
  {/if}
  {#if current.canTrim}
    <Button
      variant="plain"
      data-action="trim-disks"
      title={t('machines:StorageBar.storage.trim.title')}
      onclick={() => act(t('machines:StorageBar.busy.trimming'), () => page.trimDisks())}
    >
      {t('machines:StorageBar.storage.trim')}
    </Button>
  {/if}
</footer>
{#if details}<StorageDetails {storage} close={() => (details = false)} />{/if}

<style>
  .storage {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3) var(--space-5);
    padding: var(--space-2) var(--space-5);
    border-top: 1px solid var(--border);
    background: var(--surface-raised);
    font-size: var(--text-sm);
    color: var(--text-dim);
  }
  .used {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }
</style>
