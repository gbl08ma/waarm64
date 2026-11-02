<!-- One piece of a status bar element (web/app/statusbar.ts `Piece`): its words, or its icon and short value (the words for screen readers), a dot, bars. The bar and the Preferences' editor draw them. -->
<script lang="ts">
  import Icon from './Icon.svelte';
  import { lookOf, type Item, type Piece } from './statusbar.ts';
  import { ui } from './ui.svelte.ts';

  /** `state`: the power state's piece in the bar, `#state[data-state]` (the tests wait on it). */
  let { item, p, state = false }: { item: Item; p: Piece; state?: boolean } = $props();
  const look = $derived(p.icon || p.dot ? lookOf(item) : 'text');
</script>

<span class="el" id={state ? 'state' : undefined} data-state={state ? ui.state : undefined} data-kind={item.kind} data-tone={p.tone} title={p.title}>
  {#if p.dot}<span class="dot"></span>{/if}
  {#if p.icon && look !== 'text'}<Icon name={p.icon} size={16} />{/if}
  {#if p.parts}
    <span class="sr">{p.text}</span>
    {#if look !== 'icon' && p.label}<span aria-hidden="true">{p.label}</span>{/if}
    {#each p.parts as part, n (n)}<span class="part" aria-hidden="true"><Icon name={part.icon} size={14} />{part.text}</span>{/each}
  {:else if look === 'icon'}{#if p.short && !p.bars}<span>{p.short}</span>{/if}<span class="sr">{p.text}</span>{:else}<span>{p.text}</span>{/if}
  <!-- i18n-ignore-next: a CSS length -->
  {#if p.bars}<span class="bars">{#each p.bars as b, n (n)}<span style:height="{Math.max(1, Math.round(b * 14))}px"></span>{/each}</span>{/if}
</span>

<style>
  .el { display: inline-flex; align-items: center; gap: 4px; }
  .part { display: inline-flex; align-items: center; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--busy); margin-right: 2px; }
  [data-tone=ok] { color: var(--ok); }
  [data-tone=busy] { color: var(--busy); }
  [data-tone=bad] { color: var(--bad); }
  [data-tone=off] { color: var(--off); }
  /* The power state's tone is its dot's. */
  [data-kind=state] { color: var(--text); }
  [data-tone=ok] .dot { background: var(--ok); }
  [data-tone=off] .dot { background: var(--off); }
  [data-tone=bad] .dot { background: var(--bad); }
  .bars { display: inline-flex; align-items: flex-end; gap: 1px; height: 14px; }
  .bars span { width: 4px; background: currentColor; opacity: 0.8; border-radius: 1px 1px 0 0; }
</style>
