<!--
  One step of a wizard (the Network wizard's): a column of the step's content, shown while it's the `active` one (the
  others stay in the dialog, hidden, keeping what was typed). `id` (a test's handle) and other attributes go on the
  section.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  type Props = { active: boolean; children: Snippet; [attr: string]: unknown };
  let { active, children, ...rest }: Props = $props();
</script>

<section class="step" hidden={!active} {...rest}>{@render children()}</section>

<style>
  .step {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
</style>
