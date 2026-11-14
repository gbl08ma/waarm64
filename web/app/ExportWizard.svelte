<!--
  Export (docs/machines.md §4): a wizard over the Machines page, opened by a disk's Export on a machine's Disks tab or
  on the page's machine (PagePane.svelte). Its steps are ExportSteps.svelte's; the last choice saves and closes it.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import ExportSteps from './ExportSteps.svelte';
  import Button from './ui/Button.svelte';
  import Modal from './ui/Modal.svelte';
  import { t } from '../i18n.ts';
  import type { ExportMode, ExportStepsApi } from './export.ts';

  type Props = {
    name: string;
    changes: boolean;
    save: (mode: ExportMode, compress: boolean) => void;
    hint: Snippet;
    close: () => void;
  };
  let { name, changes, save, hint, close }: Props = $props();

  let dialog = $state<{ close: () => void }>();
  let steps = $state<ExportStepsApi>();
  function saved(mode: ExportMode, compress: boolean) {
    save(mode, compress);
    dialog?.close();
  }
  const goBack = () => steps?.back();
</script>

<Modal id="export" bind:this={dialog} title={steps?.title() ?? ''} onclose={close}>
  <ExportSteps bind:this={steps} {name} {changes} save={saved} {hint} />
  {#snippet back()}
    {#if steps?.canBack()}<Button type="button" data-action="export-back" onclick={goBack}
        >{t('disks:ExportWizard.back')}</Button
      >{/if}
  {/snippet}
  {#snippet buttons()}
    <Button type="button" data-action="export-cancel" onclick={() => dialog?.close()}
      >{t('disks:ExportWizard.cancel')}</Button
    >
  {/snippet}
</Modal>
