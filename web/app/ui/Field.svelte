<!--
  A labelled control: its words (`label`), a link beside them (`labelAfter`: the RAM's "visualize"), the control
  (`children`: an input, a select), a button beside it (`after`) and a note under it (`note`: words, or a snippet of
  Notes). In a Fields grid the label, the control and the button
  are the grid's three columns; elsewhere (a dialog, a menu's panel) the label is a small line over the control.
  `title` and other attributes (`data-*`, `id`) go on the label. With `labelAfter`, the label holds only the words (a
  link inside it would take the words' clicks), so it names its control by `for` (the control's `id`).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Note from './Note.svelte';

  type Props = {
    label: string;
    labelAfter?: Snippet;
    after?: Snippet;
    note?: string | Snippet;
    class?: string;
    children: Snippet;
    [attr: string]: unknown;
  };
  let { label, labelAfter, after, note, class: cls, children, ...rest }: Props = $props();
</script>

<div class={['field', cls]}>
  {#if labelAfter}
    <span class="name"><label {...rest}>{label}</label> {@render labelAfter()}</span>{@render children()}
  {:else}
    <label {...rest}><span class="name">{label}</span>{@render children()}</label>
  {/if}
  {#if after}<span class="after">{@render after()}</span>{/if}
  {#if typeof note === 'string'}<span class="note"><Note>{note}</Note></span>{:else if note}<span class="note"
      >{@render note()}</span
    >{/if}
</div>

<style>
  /* In a grid (Fields) the rows line up: the label and the control are two of its columns. Elsewhere `subgrid` is
     `none`: one column, the label over the control. */
  div.field {
    display: grid;
    grid-template-columns: subgrid;
    gap: var(--space-2) var(--space-5);
    align-items: center;
    contain: none;
  }
  label {
    display: contents;
  }
  .name {
    color: var(--text-dim);
    font-size: var(--field-name-size, var(--text-sm));
  }
  .after {
    justify-self: start;
  }
  .note {
    grid-column: 1 / -1;
    contain: inline-size;
  }
</style>
