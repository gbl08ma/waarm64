<!--
  A settings grid (a machine's Settings, Preferences, a folder's or a connection's form): each Field is a row, its
  label in the first column, its control in the second, an optional button (`Field`'s `after`) in the third. Whatever
  else it holds (a Note, a Check, a row of buttons, a disclosure) takes a whole row, at the width it's given rather than
  its words' (a long note doesn't widen the labels' column). That's the one rule it sets on what it's given: layout.
  Other attributes (`oninput`, `data-*`) go on the grid.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  type Props = { class?: string; children: Snippet; [attr: string]: unknown };
  let { class: cls, children, ...rest }: Props = $props();
</script>

<div class={['fields', cls]} {...rest}>{@render children()}</div>

<style>
  .fields {
    display: grid;
    grid-template-columns: max-content minmax(0, 320px) 1fr;
    gap: var(--space-4) var(--space-5);
    align-items: center;
    /* Field's label, beside its control: the words' size. */
    --field-name-size: var(--text-base);
  }
  .fields > :global(*) {
    grid-column: 1 / -1;
    contain: inline-size;
  }
</style>
