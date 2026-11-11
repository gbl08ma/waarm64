<!--
  One bordered row of a list (a CardList's item): a disk, a snapshot, an adapter, a USB device, a folder, a connection.
  Its main column (`children`: a name, its small lines as `<Note inline>`) takes the room; `actions` (its buttons,
  selects, switches) go beside it, under it when the row is narrow. The row's background contrasts with what it's on:
  the raised surface on a pane, the page's in a dialog (`--card-bg`, which Modal sets). `class` and other attributes
  (`data-*`) go on the `li`.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  type Props = { class?: string; children: Snippet; actions?: Snippet; [attr: string]: unknown };
  let { class: cls, children, actions, ...rest }: Props = $props();
</script>

<li class={['card', cls]} {...rest}>
  <div class="what">{@render children()}</div>
  {#if actions}<div class="actions">{@render actions()}</div>{/if}
</li>

<style>
  .card {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3) var(--space-4);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--card-bg, var(--surface-raised));
  }
  .what {
    flex: 1;
    min-width: 200px;
    display: flex;
    flex-direction: column;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
  }
</style>
