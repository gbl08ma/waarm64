<!--
  The Machines page's foot: the browser's storage, used and its quota (persisted or not: ask for it), what clears the
  remote disks' cache and the shaders', and what holds the bytes.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import type { Act } from './actions.svelte.ts';
  import { clearCaches } from '../diskcache.ts';
  import { t } from '../i18n.ts';
  import { askPersist, type storageReport } from './storage-report.ts';
  import { clearShaderStore } from '../venus-cache.ts';

  type Props = { storage: Awaited<ReturnType<typeof storageReport>>; act: Act };
  let { storage, act }: Props = $props();

  const used = $derived(
    storage.persisted
      ? t('machines:StorageBar.storage.persisted', { used: storage.usage, quota: storage.quota })
      : t('machines:StorageBar.storage', { used: storage.usage, quota: storage.quota }),
  );
  const items = $derived(storage.items.filter((x) => x.bytes > 0));
</script>

<footer class="storage">
  <span>{used}</span>
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
  <details>
    <summary>{t('machines:StorageBar.storage.items')}</summary>
    <ul>
      {#each items as it (it)}
        <li>{t('machines:StorageBar.storage.item', { what: it.what, size: it.bytes })}</li>
      {/each}
    </ul>
  </details>
</footer>

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
  ul {
    margin: var(--space-2) 0;
  }
</style>
