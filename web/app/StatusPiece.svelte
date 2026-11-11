<!-- One piece of a status bar element (web/app/statusbar.ts `Piece`): its words, or its icon and short value (the words for screen readers), a dot, bars. The bar and the Preferences' editor draw them. -->
<script lang="ts">
  import Icon from './ui/Icon.svelte';
  import StatusDot from './ui/StatusDot.svelte';
  import { lookOf, type Item, type Piece } from './statusbar.ts';
  import { ui } from './ui.svelte.ts';

  /** `state`: the power state's piece in the bar, `#state[data-state]` (the tests wait on it). */
  let { item, p, state = false }: { item: Item; p: Piece; state?: boolean } = $props();
  const look = $derived(p.icon || p.dot ? lookOf(item) : 'text');
  /** The dot's light: the piece's tone (a dim one's is busy). */
  const dotTone = $derived(p.tone && p.tone !== 'dim' ? p.tone : 'busy');
</script>

<span
  class="el"
  id={state ? 'state' : undefined}
  data-state={state ? ui.state : undefined}
  data-kind={item.kind}
  data-tone={p.tone}
  title={p.title}
>
  {#if p.dot}<StatusDot tone={dotTone} />{/if}
  {#if p.icon && look !== 'text'}<Icon name={p.icon} size={16} />{/if}
  {#if p.parts}
    <span class="sr">{p.text}</span>
    {#if look !== 'icon' && p.label}<span aria-hidden="true">{p.label}</span>{/if}
    {#each p.parts as part, n (n)}<span class="part" aria-hidden="true"
        ><Icon name={part.icon} size={14} />{part.text}</span
      >{/each}
  {:else if look === 'icon'}{#if p.short && !p.bars}<span>{p.short}</span>{/if}<span class="sr">{p.text}</span
    >{:else}<span>{p.text}</span>{/if}
  {#if p.bars}<span class="bars"
      >{#each p.bars as b, n (n)}<span
          // i18n-ignore-next: a CSS length
          style:height="{Math.max(1, Math.round(b * 14))}px"
        ></span>{/each}</span
    >{/if}
</span>

<style>
  .el {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }
  .part {
    display: inline-flex;
    align-items: center;
  }
  [data-tone='ok'] {
    color: var(--status-ok);
  }
  [data-tone='busy'] {
    color: var(--status-busy);
  }
  [data-tone='bad'] {
    color: var(--status-bad);
  }
  [data-tone='off'] {
    color: var(--status-off);
  }
  /* The power state's tone is its dot's. */
  [data-kind='state'] {
    color: var(--text);
  }
  .bars {
    display: inline-flex;
    align-items: flex-end;
    gap: 1px;
    height: 14px;
  }
  .bars span {
    width: 4px;
    background: currentColor;
    opacity: 0.8;
    border-radius: 1px 1px 0 0;
  }
</style>
