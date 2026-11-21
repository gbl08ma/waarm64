<!--
  A machine's RAM split, set by hand (its Settings tab, while "Set a custom split" beside the RAM slider is ticked;
  docs/spill-memories.md): rows of the settings grid under the RAM slider, memory 0's size, then one per NUMA node past
  it with its "remove" link, an "add a node" link, and the split's note. A valid split sets the RAM to its sum; one
  that doesn't hold says why, and Save waits.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Field from './ui/Field.svelte';
  import Note from './ui/Note.svelte';
  import { t, text } from '../i18n.ts';
  import { MAX_SPILL } from '../ram.ts';
  import type { Editing } from './machine-edit.svelte.ts';
  import { MEMORY0_MIB, ramSplitError } from './machine.ts';

  type Props = { edit: Editing };
  let { edit }: Props = $props();

  /** A node's size when it's added, MiB: one that every split may add (Vulkan's first node included). */
  const NEW_NODE_MIB = 1024;

  /**
   * The sizes as typed, memory 0 first (NaN: a field left empty): the draft's split, until a change that doesn't hold
   * overrides them (the draft keeps its last valid split meanwhile).
   */
  let sizes = $derived(edit.draft.ramSplit ? [...edit.draft.ramSplit] : []);

  /** Takes the sizes as typed: a valid split sets the RAM to its sum, else says what's wrong. */
  function take(next: number[]) {
    sizes = next;
    const d = edit.draft;
    edit.splitProblem = ramSplitError(next, !!d.vulkan);
    if (!edit.splitProblem) [d.ramSplit, d.ramMiB] = [[...next], next.reduce((a, b) => a + b, 0)];
    edit.touch();
  }
  const typed = (i: number) => (e: Event & { currentTarget: HTMLInputElement }) =>
    take(sizes.with(i, e.currentTarget.valueAsNumber));
</script>

{#if edit.draft.ramSplit}
  <Field label={t('machines:RamSplit.memory0')}>
    <input
      type="number"
      min="64"
      step="1"
      value={Number.isNaN(sizes[0]) ? '' : sizes[0]}
      onchange={typed(0)}
      data-field="ram0"
    />
  </Field>
  {#each sizes.slice(1) as mib, i (i)}
    <Field label={t('machines:RamSplit.node', { n: i + 1 })}>
      {#snippet after()}
        <Button variant="link" data-action="ram-node-remove" onclick={() => take(sizes.toSpliced(i + 1, 1))}
          >{t('machines:RamSplit.node.remove')}</Button
        >
      {/snippet}
      <input
        type="number"
        min="1"
        step="1"
        value={Number.isNaN(mib) ? '' : mib}
        onchange={typed(i + 1)}
        data-field="ram-node"
      />
    </Field>
  {/each}
  {#if sizes.length - 1 < MAX_SPILL}
    <div class="add">
      <span
        ><Button variant="link" data-action="ram-node-add" onclick={() => take([...sizes, NEW_NODE_MIB])}
          >{t('machines:RamSplit.node.add')}</Button
        ></span
      >
    </div>
  {/if}
  {#if edit.splitProblem}<Note tone="warn" data-split-problem>{text(edit.splitProblem)}</Note>{/if}
  <Note>{t('machines:RamSplit.note', { max: MEMORY0_MIB })}</Note>
{/if}

<style>
  /* The "add a node" link sits in the controls' column, under the nodes' fields. */
  .add {
    display: grid;
    grid-template-columns: subgrid;
  }
  .add > span {
    grid-column: 2;
    display: flex;
  }
</style>
