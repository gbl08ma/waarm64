<!--
  Numbered steps for the user to follow (a wizard's: install, run, paste), each a `<li>` of the parent's, the last
  often ending at its field: a column at the dialog's size, the fields' labels too (`--field-name-size`).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  type Props = { children: Snippet };
  let { children }: Props = $props();
</script>

<ol class="steps">{@render children()}</ol>

<style>
  .steps {
    --field-name-size: var(--text-base);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin: 0;
    padding-left: var(--space-6);
  }
</style>
