<!--
  A line of fine print: a field's or a row's note, a dialog's explanation, a menu's hint, why something can't be done.
  `tone`: `dim` (the default), `warn`, `error`, `ok`; `size`: `sm` (12 px, the default) or `md` (13 px: a dialog's
  explanation, which is read rather than glanced at). `inline` makes it a `span` (a row's small line, inside its
  column); otherwise a paragraph. Line breaks in its words are kept. `class` (a test's hook) and other attributes
  (`id`, `data-*`) go on the element.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  type Props = {
    tone?: 'dim' | 'warn' | 'error' | 'ok';
    size?: 'sm' | 'md';
    inline?: boolean;
    class?: string;
    children: Snippet;
    [attr: string]: unknown;
  };
  let { tone = 'dim', size = 'sm', inline = false, class: cls, children, ...rest }: Props = $props();
  const classes = $derived(['note', tone, size, cls]);
</script>

{#if inline}
  <span class={classes} {...rest}>{@render children()}</span>
{:else}
  <p class={classes} {...rest}>{@render children()}</p>
{/if}

<style>
  .note {
    margin: 0;
    white-space: pre-line;
  }
  span.note {
    display: block;
  }
  .sm {
    font-size: var(--text-sm);
  }
  .md {
    font-size: var(--text-md);
  }
  .dim {
    color: var(--text-dim);
  }
  .warn {
    color: var(--warn-fg);
  }
  .error {
    color: var(--error-fg);
  }
  .ok {
    color: var(--ok-fg);
  }
</style>
