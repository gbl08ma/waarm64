<!--
  More of a form, folded under a small line (`summary`: a wizard's Advanced, an install's lines): its content a column
  when open. `open` is bindable; `id` and other attributes (`data-*`) go on the `details`.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  type Props = { summary: string; open?: boolean; children: Snippet; [attr: string]: unknown };
  let { summary, open = $bindable(false), children, ...rest }: Props = $props();
</script>

<details bind:open {...rest}>
  <summary>{summary}</summary>
  {@render children()}
</details>

<style>
  summary {
    cursor: pointer;
    color: var(--text-dim);
    font-size: var(--text-sm);
  }
  details[open] {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  /* A details element's children are in its content slot: the gap between them is set there. */
  details[open]::details-content {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
</style>
