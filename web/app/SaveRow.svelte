<!--
  Save and Revert of a draft on the Home page: a machine's (MachinePane.svelte's tabs that edit it: machine-edit.svelte.ts)
  and a connection's Settings (ConnectionSettings.svelte). Save says when it restarts the machine; Revert shows while
  there's something to drop.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import { t } from '../i18n.ts';

  /** What the row reads of a draft (a MachineEdit is one). */
  type Draft = {
    readonly dirty: boolean;
    save: () => unknown;
    revert: () => unknown;
    /** Save restarts the machine. */
    readonly restartsToSave?: boolean;
    /** Something typed doesn't hold: Save waits. */
    readonly splitProblem?: unknown;
  };
  type Props = { edit: Draft };
  let { edit }: Props = $props();
</script>

<div class="row">
  <Button variant="primary" onclick={edit.save} data-action="save" disabled={!edit.dirty || !!edit.splitProblem}>
    {edit.restartsToSave ? t('machines:SaveRow.saveRestart') : t('machines:SaveRow.save')}
  </Button>
  {#if edit.dirty}<Button onclick={edit.revert} data-action="revert">{t('machines:SaveRow.revert')}</Button>{/if}
</div>

<style>
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
  }
</style>
