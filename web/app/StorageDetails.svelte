<!--
  The storage bar's details (docs/machines.md "Storage"): a dialog over the Home page, opened from the icon after
  the storage line. What this web app uses of what the browser allows, or, when the browser's count is short of the
  files the page lists (`behind`), the three numbers apart; then what uses the space.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Modal from './ui/Modal.svelte';
  import type { Dialog } from './ui/dialog.ts';
  import Note from './ui/Note.svelte';
  import T from './T.svelte';
  import { t } from '../i18n.ts';
  import type { storageReport } from './storage-report.ts';

  type Props = { storage: Awaited<ReturnType<typeof storageReport>>; close: () => void };
  let { storage, close }: Props = $props();

  let dialog: Dialog;
  const items = $derived(storage.items.filter((x) => x.bytes > 0));
</script>

<Modal id="storage-details" bind:this={dialog} title={t('machines:StorageDetails.title')} onclose={close}>
  {#if storage.behind}
    <Note size="md" tone="warn" data-behind>{t('machines:StorageDetails.behind')}</Note>
    <ul class="numbers">
      <li data-number="counted">{t('machines:StorageDetails.behind.counted', { size: storage.counted })}</li>
      <li data-number="usage">{t('machines:StorageDetails.behind.usage', { size: storage.usage })}</li>
      <li data-number="quota">{t('machines:StorageDetails.behind.quota', { size: storage.quota })}</li>
    </ul>
  {:else}
    <Note size="md" data-summary
      >{t('machines:StorageDetails.summary', {
        used: storage.usage,
        quota: storage.quota,
        free: Math.max(0, storage.quota - storage.usage),
      })}</Note
    >
  {/if}
  <h3>{t('machines:StorageDetails.items')}</h3>
  <ul data-items>
    {#each items as it (it)}
      <li><T k="machines:StorageDetails.item" params={{ what: it.what, size: it.bytes }} /></li>
    {/each}
  </ul>
  {#snippet buttons()}<Button onclick={() => dialog.close()}>{t('machines:StorageDetails.close')}</Button>{/snippet}
</Modal>

<style>
  h3 {
    margin: 0;
    font-size: var(--text-base);
    font-weight: var(--weight-bold);
  }
  ul {
    margin: 0;
    font-size: var(--text-md);
  }
</style>
