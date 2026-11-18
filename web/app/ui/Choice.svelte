<!--
  A big button that picks one of a wizard's ways on (Add a disk's sources, the Network and Folder wizards' choices):
  its name (`label`, with an `icon`), and what it does in a dim line (`children`). `pressed`: the one chosen, where the
  choice stays on the step. Other attributes (`id`, `onclick`, `disabled`, `data-*`) go on the button. `after`: controls
  of its own (a connection's Edit…), drawn inside its frame at the end, beside the words; they're not part of the button
  (a button can't hold another), so the frame is the button's and they sit over its end, which leaves them room.
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
    after?: Snippet;
  } & Omit<HTMLButtonAttributes, 'class' | 'children'>;
  let { label, icon, pressed, class: cls, children, after, ...rest }: Props = $props();
  /** The width of `after`'s controls: the button's words stop short of them. */
  let afterWidth = $state(0);
  const px = (n: number) => `${String(n)}px`;
</script>

{#snippet button()}
  <button type="button" class={['choice', cls]} aria-pressed={pressed} {...rest}>
    <!-- No space between the name and its line: the button's text is the two run together, as the tests read it. -->
    <b
      >{#if icon}<Icon name={icon} size={16} />{/if}{label}</b
    >{#if children}<span>{@render children()}</span>{/if}
  </button>
{/snippet}

{#if after}
  <div class="with-after" style:--after-width={px(afterWidth)}>
    {@render button()}
    <div class="after" bind:offsetWidth={afterWidth}>{@render after()}</div>
  </div>
{:else}
  {@render button()}
{/if}

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
  /* The button and its controls in one cell: the controls over the button's end, centred on its height. */
  .with-after {
    display: grid;
  }
  .with-after > * {
    grid-area: 1 / 1;
  }
  .with-after > .choice {
    padding-inline-end: calc(var(--after-width) + 2 * var(--space-4));
  }
  .after {
    justify-self: end;
    align-self: center;
    display: flex;
    gap: var(--space-3);
    margin-inline-end: var(--space-4);
  }
</style>
