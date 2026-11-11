<!--
  A bar across the page that says something went wrong (`tone` `error`) or needs a look (`warn`): the message bar, the
  Machines page's error. Its words (`children`) take the room, centered on its buttons while they're a line or two and
  from the top when taller; its buttons (`actions`) and its close button (with `ondismiss`, named `dismissLabel`) stay
  at the top, one height. `bodyId`, `actionsId` and `dismissId` name its parts (the tests' handles); `class` and other
  attributes (`id`, `role`, `hidden`, `data-*`) go on the bar.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Button from './Button.svelte';

  type Props = {
    tone?: 'error' | 'warn';
    ondismiss?: () => void;
    dismissLabel?: string;
    bodyId?: string;
    actionsId?: string;
    dismissId?: string;
    class?: string;
    children: Snippet;
    actions?: Snippet;
    [attr: string]: unknown;
  };
  let {
    tone = 'error',
    ondismiss,
    dismissLabel,
    bodyId,
    actionsId,
    dismissId,
    class: cls,
    children,
    actions,
    ...rest
  }: Props = $props();
</script>

<div class={['banner', tone, cls]} {...rest}>
  <div class="body" id={bodyId}>{@render children()}</div>
  {#if actions}<div class="actions" id={actionsId}>{@render actions()}</div>{/if}
  {#if ondismiss}
    <span class="dismiss-at">
      <Button
        variant="plain"
        class="dismiss close"
        id={dismissId}
        icon="x"
        aria-label={dismissLabel}
        title={dismissLabel}
        onclick={ondismiss}
      />
    </span>
  {/if}
</div>

<style>
  .banner {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: var(--space-3) var(--space-5);
    padding: var(--space-3) var(--space-5);
    border-bottom: 1px solid;
    /* Its buttons take the bar's color: the frame of a bordered one too. */
    --text: currentColor;
    --border: currentColor;
  }
  .error {
    color: var(--error-bar-fg);
    background: var(--error-bg);
    border-color: var(--error-border);
  }
  .warn {
    color: var(--warn-bar-fg);
    background: var(--warn-bg);
    border-color: var(--warn-border);
  }
  .body {
    align-self: center;
    flex: 1 1 480px;
    min-width: 0;
    max-height: 30vh;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
  /* The close button, at the end. */
  .dismiss-at {
    display: flex;
    margin-left: auto;
  }
</style>
