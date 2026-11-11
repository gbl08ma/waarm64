<!--
  The page's button: every button is one of these, so they look alike.
  - `variant`: `plain` (no frame: a list's command, a close), `bordered` (the default: a pane's, a row's, a dialog's
    buttons), `primary` (a form's or a dialog's main action), `danger` (one that destroys), `tool` (a toolbar button:
    `labelled` when it has words beside its icon), `item` (a command in a menu: full width, its words at the start and a
    dim second part at the end).
  - `icon` (and `iconSize`): an icon before the words (alone, the button is a square of a control's height). `align`: `center` for a grid of keys.
  - Everything else (`id`, `title`, `disabled`, `type`, `onclick`, `data-*`, `aria-*`) goes on the element, and `class`
    too (a test's hook; the parent's styles don't reach it: it places its buttons with its own wrapper). `ref` binds the
    element.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import Icon from './Icon.svelte';
  import type { IconName } from '../icons.ts';

  type Variant = 'plain' | 'bordered' | 'primary' | 'danger' | 'tool' | 'item';
  type Props = {
    variant?: Variant;
    icon?: IconName;
    iconSize?: number;
    /** A tool button with words beside its icon. */
    labelled?: boolean;
    align?: 'start' | 'center';
    ref?: HTMLButtonElement;
    class?: string;
    children?: Snippet;
  } & Omit<HTMLButtonAttributes, 'class' | 'children'>;
  let {
    variant = 'bordered',
    icon,
    iconSize,
    labelled = false,
    align,
    ref = $bindable(),
    class: cls,
    children,
    ...rest
  }: Props = $props();
  const size = $derived(iconSize ?? (variant === 'tool' ? 20 : 16));
  const classes = $derived([
    'button',
    variant,
    { labelled, center: align === 'center', square: !!icon && !children },
    cls,
  ]);
</script>

<button bind:this={ref} class={classes} {...rest}
  >{#if icon}<Icon name={icon} {size} />{/if}{@render children?.()}</button
>

<style>
  .button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    flex: none;
    font: inherit;
    color: var(--text);
    white-space: nowrap;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius);
    padding: 0 var(--space-4);
    cursor: pointer;
  }
  .button:hover {
    background: var(--hover-bg);
  }
  .button:disabled {
    opacity: 0.45;
    cursor: default;
    background: transparent;
  }
  .plain {
    padding: var(--space-2) var(--space-4);
  }
  .bordered,
  .primary,
  .danger {
    justify-content: center;
    min-height: var(--control-h);
    border-color: var(--border);
  }
  .primary:not(:disabled) {
    color: var(--primary-fg);
    background: var(--primary-bg);
    border-color: var(--primary-border);
  }
  .danger:not(:disabled) {
    color: var(--danger-fg);
    background: var(--danger-bg);
    border-color: var(--danger-border);
  }
  .primary:not(:disabled):hover,
  .danger:not(:disabled):hover {
    filter: brightness(1.15);
  }
  .tool {
    justify-content: center;
    height: var(--tool-h);
    min-width: var(--tool-h);
    gap: var(--space-2);
    padding: 0 var(--space-2);
    border-radius: var(--radius-sm);
  }
  .tool.labelled {
    gap: var(--space-3);
    padding: 0 var(--space-4) 0 var(--space-3);
    font-size: var(--text-md);
  }
  .tool[aria-pressed='true'] {
    background: var(--pressed-bg);
    border-color: var(--pressed-border);
  }
  .item {
    justify-content: space-between;
    gap: var(--space-4);
    width: 100%;
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-sm);
    text-align: start;
  }
  .item[aria-pressed='true'] {
    color: var(--accent);
  }
  .center {
    justify-content: center;
  }
  /* An icon alone in a frame: a square of a control's height. */
  .square:is(.plain, .bordered, .primary, .danger) {
    min-width: var(--control-h);
    min-height: var(--control-h);
    padding: 0;
  }
</style>
