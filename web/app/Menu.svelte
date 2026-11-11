<!--
  A toolbar menu: a tool button (an icon, a label where it needs one) that opens a panel under it. It closes on a click
  elsewhere, and opens under its left edge where its right one would put it past the window's.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import type { IconName } from './icons.ts';

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
    /** Which edge the panel lines up with: the toolbar's open under their right edge, a page's under their left. */
    align?: 'left' | 'right';
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
    align = 'right',
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

<details class="menu" {id} bind:open bind:this={el} data-disabled={disabled || undefined} {...rest}>
  <summary
    class="tool"
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
  <div class="items" class:panel bind:this={items}>{@render children()}</div>
</details>
