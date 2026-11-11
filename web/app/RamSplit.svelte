<!--
  A machine's RAM split, set by hand (its Settings tab's advanced section; docs/spill-memories.md): memory 0, then the
  NUMA nodes past it, MiB. A valid split sets the RAM to its sum; one that doesn't hold says why, and Save waits.
-->
<script lang="ts">
  import Check from './ui/Check.svelte';
  import Note from './ui/Note.svelte';
  import { t, text } from '../i18n.ts';
  import type { Editing } from './machine-edit.svelte.ts';
  import { MEMORY0_MIB, ramSplitError, ramSplitMiB } from './machine.ts';

  type Props = { edit: Editing };
  let { edit }: Props = $props();

  let ram0Input = $state<HTMLInputElement>();
  let nodesInput = $state<HTMLInputElement>();

  function custom(on: boolean) {
    const d = edit.draft;
    d.ramSplit = on ? ramSplitMiB(d.ramMiB, undefined, !!d.vulkan) : undefined;
    edit.splitProblem = undefined;
    edit.touch();
  }
  /** Takes the two fields: a valid split sets the RAM to its sum, else says what's wrong. */
  function change() {
    const nodes = (nodesInput?.value ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .map(Number);
    const split = [Number(ram0Input?.value), ...nodes];
    const d = edit.draft;
    edit.splitProblem = ramSplitError(split, !!d.vulkan);
    if (!edit.splitProblem) [d.ramSplit, d.ramMiB] = [split, split.reduce((a, b) => a + b, 0)];
    edit.touch();
  }
</script>

<details class="advanced" data-ram-split open={!!edit.draft.ramSplit}>
  <summary>{t('machines:RamSplit.split')}</summary>
  <Check checked={!!edit.draft.ramSplit} onchange={custom} field="custom-split">
    {t('machines:RamSplit.split.custom')}
  </Check>
  {#if edit.draft.ramSplit}
    <div class="split">
      <label>
        {t('machines:RamSplit.split.memory0')}
        <input
          bind:this={ram0Input}
          type="number"
          min="64"
          step="1"
          value={edit.draft.ramSplit[0]}
          onchange={change}
          data-field="ram0"
        />
      </label>
      <label>
        {t('machines:RamSplit.split.nodes')}
        <input
          bind:this={nodesInput}
          value={edit.draft.ramSplit.slice(1).join(', ')}
          placeholder={t('machines:RamSplit.split.nodes.placeholder')}
          onchange={change}
          data-field="ram-nodes"
        />
      </label>
    </div>
    {#if edit.splitProblem}<Note tone="warn" data-split-problem>{text(edit.splitProblem)}</Note>{/if}
  {/if}
  <Note>{t('machines:RamSplit.split.note', { max: MEMORY0_MIB })}</Note>
</details>

<style>
  .advanced {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  summary {
    color: var(--text-dim);
    cursor: pointer;
  }
  .split {
    display: grid;
    grid-template-columns: max-content minmax(0, 200px);
    gap: var(--space-3) var(--space-5);
    align-items: center;
  }
  label {
    display: contents;
    color: var(--text-dim);
  }
</style>
