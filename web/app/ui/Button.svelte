<!--
  The page's button: every button is one of these, so they look alike.
  - `variant`: `plain` (no frame: a list's command, a close), `bordered` (the default: a pane's, a row's, a dialog's
    buttons), `primary` (a form's or a dialog's main action), `danger` (one that destroys), `tool` (a toolbar button:
    `labelled` when it has words beside its icon), `item` (a command in a menu: full width, its words at the start and a
    dim second part at the end), `link` (words that read as a link: a menu's Details…), `inline` (an icon inside a
    field's frame, beside its text: ValueField's Copy and Show).
  - `icon` (and `iconSize`): an icon before the words (alone, the button is a square of a control's height). `align`: `center` for a grid of keys.
    `tone`: `warn` draws its words and icon in the warning colour (the storage bar's mismatch).
  - Everything else (`id`, `title`, `disabled`, `type`, `onclick`, `data-*`, `aria-*`) goes on the element, and `class`
    too (a test's hook; the parent's styles don't reach it: it places its buttons with its own wrapper). `ref` binds the
    element.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import Icon from './Icon.svelte';
  import type { IconName } from '../icons.ts';

  type Variant = 'plain' | 'bordered' | 'primary' | 'danger' | 'tool' | 'item' | 'link' | 'inline';
  type Props = {
    variant?: Variant;
    icon?: IconName;
    iconSize?: number;
    /** A tool button with words beside its icon. */
    labelled?: boolean;
    align?: 'start' | 'center';
    tone?: 'warn';
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
    tone,
    ref = $bindable(),
    class: cls,
    children,
    ...rest
  }: Props = $props();
  const size = $derived(iconSize ?? (variant === 'tool' ? 20 : 16));
  const classes = $derived([
    'button',
    variant,
    { labelled, center: align === 'center', square: !!icon && !children, 'tone-warn': tone === 'warn' },
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
  /* A framed button is a key: raised, its top edge lit. */
  .bordered {
    background: var(--key-bg);
    box-shadow: var(--key-edge);
  }
  .bordered:hover:not(:disabled) {
    background: var(--key-hover-bg);
  }
  .bordered:disabled {
    background: var(--key-bg);
  }
  .primary:not(:disabled) {
    color: var(--primary-fg);
    background: var(--primary-bg);
    border-color: var(--primary-border);
    box-shadow: var(--primary-edge);
    font-weight: var(--weight-bold);
  }
  .danger:not(:disabled) {
    color: var(--danger-fg);
    background: var(--danger-bg);
    border-color: var(--danger-border);
    box-shadow: var(--danger-edge);
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
    font-size: var(--bar-text-md);
  }
  /* A tool that's on: sunk, its legend lit. */
  .tool[aria-pressed='true'] {
    color: var(--accent);
    background: var(--pressed-bg);
    border-color: var(--pressed-border);
    box-shadow: var(--pressed-edge);
    text-shadow: var(--lit-text);
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
  /* Words in the accent, framed by nothing: they read as a link, and act at once (a dialog opens). A bar's link takes
     the bar's size and is centered on its line as the bar's other words are (`--link-size`, `--link-align`: the status
     bar's RAM). */
  .link {
    align-self: var(--link-align, flex-start);
    padding: 0;
    color: var(--accent);
    font-size: var(--link-size, var(--text-sm));
  }
  .link:hover {
    background: transparent;
    text-decoration: underline;
  }
  /* An icon inside a field's frame: the frame's height, dim until pointed at. */
  .inline {
    justify-content: center;
    align-self: stretch;
    padding: 0 var(--space-2);
    color: var(--text-dim);
    border-radius: var(--radius-sm);
  }
  .inline:hover {
    color: var(--text);
  }
  .center {
    justify-content: center;
  }
  /* After the variants, so it wins over theirs (an `inline` icon's dim). */
  .tone-warn,
  .tone-warn:hover {
    color: var(--warn-fg);
  }
  /* An icon alone in a frame: a square of a control's height. */
  .square:is(.plain, .bordered, .primary, .danger) {
    justify-content: center;
    min-width: var(--control-h);
    min-height: var(--control-h);
    padding: 0;
  }
</style>
