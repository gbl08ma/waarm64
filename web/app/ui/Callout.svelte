<!--
  A framed box in a column that says something went wrong (`tone` `error`), asks or warns (`warn`) or was done (`info`),
  where it happened: a pane's failed action, a warning to accept before going on, a menu's offer. ErrorBanner's tones
  (the same tokens, its buttons taking the box's color the same way), but in its place in the column rather than across
  the page or floating, and with no close button or movement: it stays while what it says holds. An optional `title`
  (a heading's words), its words (`children`: paragraphs, whose margins it takes off, or Notes), and its buttons under
  them (`actions`). `class` and other attributes
  (`role`, `data-*`) go on the box.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  type Props = {
    tone?: 'error' | 'warn' | 'info';
    title?: string;
    class?: string;
    children: Snippet;
    actions?: Snippet;
    [attr: string]: unknown;
  };
  let { tone = 'error', title, class: cls, children, actions, ...rest }: Props = $props();
</script>

<div class={['callout', tone, cls]} {...rest}>
  {#if title}<h3>{title}</h3>{/if}
  {@render children()}
  {#if actions}<div class="actions">{@render actions()}</div>{/if}
</div>

<style>
  .callout {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border: 1px solid;
    border-radius: var(--radius);
  }
  /* An error's words and buttons take its color (as ErrorBanner's do); a warning's and a notice's stay the page's. */
  .error {
    color: var(--error-bar-fg);
    background: var(--error-bg);
    border-color: var(--error-border);
    --text: currentColor;
  }
  .warn {
    background: var(--warn-bg);
    border-color: var(--warn-border);
  }
  .info {
    background: var(--ok-bg);
    border-color: var(--ok-border);
  }
  h3 {
    margin: 0;
    font-size: var(--text-base);
  }
  .callout :global(p) {
    margin: 0;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
</style>
