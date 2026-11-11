<!--
  A list of Cards (the panes' and the dialogs' lists of disks, snapshots, adapters, devices, folders, connections), with
  the line it shows when it's empty (`empty`: words; the `li` has the class `none`). `class` and other attributes go on
  the `ul`.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  type Props = { empty?: string; class?: string; children?: Snippet; [attr: string]: unknown };
  let { empty, class: cls, children, ...rest }: Props = $props();
</script>

<ul class={['cards', cls]} {...rest}>
  {@render children?.()}
  {#if empty !== undefined}<li class="none">{empty}</li>{/if}
</ul>

<style>
  .cards {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .none {
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--card-bg, var(--surface-raised));
    color: var(--text-dim);
  }
</style>
