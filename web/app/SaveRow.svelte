<!--
  A machine's Save and Revert (MachinePane.svelte's tabs that edit it: machine-edit.svelte.ts). Save says when it
  restarts the machine; Revert shows while there's something to drop.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import { t } from '../i18n.ts';
  import type { MachineEdit } from './machine-edit.svelte.ts';

  type Props = { edit: MachineEdit };
  let { edit }: Props = $props();
</script>

<div class="row">
  <Button variant="primary" onclick={edit.save} data-action="save" disabled={!edit.dirty || !!edit.splitProblem}>
    {edit.restartsToSave ? t('machines:SaveRow.saveRestart') : t('machines:SaveRow.save')}
  </Button>
  {#if edit.dirty}<Button onclick={edit.revert}>{t('machines:SaveRow.revert')}</Button>{/if}
</div>

<style>
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
  }
</style>
