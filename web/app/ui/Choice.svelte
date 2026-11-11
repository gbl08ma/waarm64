<!--
  A big button that picks one of a wizard's ways on (Add a disk's sources, the Network and Folder wizards' choices):
  its name (`label`, with an `icon`), and what it does in a dim line (`children`). `pressed`: the one chosen, where the
  choice stays on the step. Other attributes (`id`, `onclick`, `disabled`, `data-*`) go on the button.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import Icon from './Icon.svelte';
  import type { IconName } from '../icons.ts';

  type Props = {
    label: string;
    icon?: IconName;
    pressed?: boolean;
    class?: string;
    children?: Snippet;
  } & Omit<HTMLButtonAttributes, 'class' | 'children'>;
  let { label, icon, pressed, class: cls, children, ...rest }: Props = $props();
</script>

<button type="button" class={['choice', cls]} aria-pressed={pressed} {...rest}>
  <b
    >{#if icon}<Icon name={icon} size={16} />{/if}{label}</b
  >
  {#if children}<span>{@render children()}</span>{/if}
</button>

<style>
  .choice {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    text-align: start;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }
  .choice:hover:not(:disabled),
  .choice:focus-visible {
    border-color: var(--accent);
    background: var(--surface);
  }
  .choice[aria-pressed='true'] {
    border-color: var(--accent);
    background: var(--pressed-bg);
  }
  b {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    font-weight: var(--weight-bold);
  }
  span {
    color: var(--text-dim);
    font-size: var(--text-sm);
  }
</style>
