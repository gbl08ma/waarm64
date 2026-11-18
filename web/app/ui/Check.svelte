<!--
  A checkbox and its words, with the fine print under them when there is some (`note`: words, or markup as a snippet):
  the Home page's settings, Preferences, the disks', adapters' and USB devices' rows, the dialogs. One element
  either way (`.check`, or `.check-field` around it and the note), for the parent's layout to place. `compact`: the
  13 px of a list's row, on one line. `onchange` gets the new state (`checked` is bindable too); `ref` binds the box.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  // No fallback for `checked`: Svelte refuses `bind:checked={undefined}` on a prop with one (a record without the field).
  let {
    checked = $bindable(),
    disabled = false,
    title,
    id,
    field,
    compact = false,
    onchange,
    note,
    ref = $bindable(),
    children,
  }: {
    checked?: boolean;
    disabled?: boolean;
    title?: string;
    id?: string;
    /** `data-field` on the input (the tests' handle). */
    field?: string;
    compact?: boolean;
    onchange?: (checked: boolean) => void;
    note?: string | Snippet;
    /** Binds the checkbox (to focus it). */
    ref?: HTMLInputElement;
    children: Snippet;
  } = $props();
</script>

{#snippet box()}
  <label class="check" class:compact {title}
    ><input
      bind:this={ref}
      type="checkbox"
      {id}
      bind:checked
      {disabled}
      data-field={field}
      onchange={(e) => onchange?.(e.currentTarget.checked)}
    />
    {@render children()}</label
  >
{/snippet}

{#if note}
  <div class="check-field">
    {@render box()}
    <p class="note">
      {#if typeof note === 'string'}{note}{:else}{@render note()}{/if}
    </p>
  </div>
{:else}
  {@render box()}
{/if}

<style>
  .check {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .check.compact {
    font-size: var(--text-md);
    white-space: nowrap;
  }
  .check-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  /* A long note takes the width it's given rather than widening a grid's column; it starts under the words, past the
     box (13 px and its margins, 3 px and 4 px: 20 px) and the gap. */
  .note {
    contain: inline-size;
    margin: 0;
    padding-left: calc(20px + var(--space-3));
    color: var(--text-dim);
    font-size: var(--text-sm);
  }
</style>
