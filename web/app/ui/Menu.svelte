<!--
  A toolbar menu: a tool button (an icon, a label where it needs one) that opens a panel under it. It closes on a click
  elsewhere, and opens under its left edge where its right one would put it past the window's. `on` shows the button
  pressed while what it controls is on (`data-on`: the mouse lock, the clipboard's sharing), `attention` frames it in
  the accent (sound waiting for a click). The panel (`panel`: a form of controls; otherwise a list of commands) is a
  column of what it's given, a step apart: its content is the primitives (`Button variant="item"` for a command,
  Field, Check, Radio, Note) and the caller's own markup. The summary is styled here as Button's `tool` is (a summary
  can't be a Button); `variant` `bordered` frames it as a bordered Button (a menu among a pane's or a card's buttons:
  a disk's Export).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import type { IconName } from '../icons.ts';

  type Props = {
    id: string;
    icon: IconName;
    /** The tooltip (and the name for a screen reader when there's no label). */
    title: string;
    label?: string;
    summaryId?: string;
    open?: boolean;
    disabled?: boolean;
    /** The panel's class: `panel` for a form of controls, none for a list of commands. */
    panel?: boolean;
    /** A wider panel (the network's: an adapter's lines). */
    wide?: boolean;
    /** Which edge the panel lines up with: the toolbar's open under their right edge, a page's under their left. */
    align?: 'left' | 'right';
    /** The summary's look: a toolbar's tool button, or a bordered button (in a pane or a card). */
    variant?: 'tool' | 'bordered';
    on?: boolean;
    attention?: boolean;
    children: Snippet;
    badge?: Snippet;
    [attr: string]: unknown;
  };
  let {
    id,
    icon,
    title,
    label,
    summaryId,
    open = $bindable(false),
    disabled = false,
    panel = false,
    wide = false,
    align = 'right',
    variant = 'tool',
    on = false,
    attention = false,
    children,
    badge,
    ...rest
  }: Props = $props();

  let el: HTMLDetailsElement;
  let items = $state<HTMLElement>();
  $effect(() => {
    const away = (e: PointerEvent) => {
      if (open && !el.contains(e.target as Node)) open = false;
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  });
  $effect(() => {
    if (!open || !items) return;
    items.style.right = items.style.left = '';
    if (align === 'left' || items.getBoundingClientRect().left < 0)
      [items.style.left, items.style.right] = ['0', 'auto'];
  });
  $effect(() => {
    if (disabled) open = false;
  });
</script>

<details
  class="menu"
  {id}
  bind:open
  bind:this={el}
  data-disabled={disabled || undefined}
  data-on={on || undefined}
  {...rest}
>
  <summary
    class={[variant, { attention }]}
    id={summaryId}
    {title}
    aria-label={label ? undefined : title}
    aria-disabled={disabled || undefined}
    onclick={(e) => {
      if (disabled) e.preventDefault();
    }}
  >
    <Icon name={icon} />{#if label}<span class="label">{label}</span>{/if}{@render badge?.()}<Icon
      name="chevron-down"
      size={12}
    />
  </summary>
  <div class={['items', { panel, wide }]} bind:this={items}>{@render children()}</div>
</details>

<style>
  .menu {
    position: relative;
  }
  .tool {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    height: var(--tool-h);
    min-width: var(--tool-h);
    padding: 0 var(--space-2);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--text);
    cursor: pointer;
    list-style: none;
    user-select: none;
  }
  .tool::-webkit-details-marker {
    display: none;
  }
  .tool:hover {
    background: var(--hover-bg);
  }
  .menu[open] > .tool,
  .menu[data-on] > .tool {
    background: var(--pressed-bg);
    border-color: var(--pressed-border);
  }
  .bordered {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    min-height: var(--control-h);
    padding: 0 var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    cursor: pointer;
    list-style: none;
    user-select: none;
    white-space: nowrap;
  }
  .bordered::-webkit-details-marker {
    display: none;
  }
  .bordered:hover {
    background: var(--hover-bg);
  }
  .menu[open] > .bordered {
    background: var(--pressed-bg);
    border-color: var(--pressed-border);
  }
  .bordered .label {
    font-size: inherit;
  }
  .tool.attention {
    border-color: var(--accent);
  }
  .tool[aria-disabled='true'],
  .bordered[aria-disabled='true'] {
    opacity: 0.4;
    cursor: default;
    background: transparent;
  }
  .label {
    font-size: var(--text-md);
  }
  .items {
    position: absolute;
    right: 0;
    top: calc(100% + var(--space-2));
    z-index: 2;
    display: flex;
    flex-direction: column;
    min-width: 180px;
    padding: var(--space-2);
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-menu);
  }
  .items.panel {
    width: 260px;
    gap: var(--space-3);
    padding: var(--space-4);
  }
  .items.wide {
    width: 320px;
  }
</style>
