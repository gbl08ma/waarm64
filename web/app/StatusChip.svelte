<!--
  One element of the Preferences' status bar editor's bar (StatusEditor.svelte): a chip that draws what the element
  shows (dimmed when the running machine hasn't it), chosen with a click, dragged along the bar or out of it
  (`drag`: status-drag.svelte.ts), moved with Alt+←/→ and removed with Delete or its ×.
-->
<script lang="ts">
  import Icon from './ui/Icon.svelte';
  import StatusPiece from './StatusPiece.svelte';
  import type { ChipDrag } from './status-drag.svelte.ts';
  import { aboutOf, nameOf, type Item, type Piece } from './statusbar.ts';
  import { t } from '../i18n.ts';

  type Props = {
    item: Item;
    /** Its place on the bar. */
    at: number;
    /** What it draws now (none: the running machine hasn't it). */
    pieces: Piece[];
    chosen: boolean;
    drag: ChipDrag;
    onpick: () => void;
    onkey: (e: KeyboardEvent) => void;
    onremove: () => void;
  };
  let { item, at, pieces, chosen, drag, onpick, onkey, onremove }: Props = $props();

  const words = $derived({ name: nameOf(item), about: aboutOf(item.kind) });
  const title = $derived(
    pieces.length ? t('statusbar:StatusChip.title', words) : t('statusbar:StatusChip.title.absent', words),
  );
</script>

<div
  role="listitem"
  class="chip"
  class:spacer={item.kind === 'spacer'}
  class:chosen
  class:absent={!pieces.length}
  class:lifted={drag.lifted === at}
  draggable="true"
  onpointerdown={(e) => drag.press(e, { from: at })}
  ondragstart={(e) => drag.start(e, { from: at })}
  ondragend={drag.end}
  ondragover={(e) => drag.overChip(e, at)}
  data-at={at}
  data-kind={item.kind}
  {@attach drag.chip(at)}
>
  <button class="pick" onclick={onpick} onkeydown={onkey} aria-pressed={chosen} {title} {@attach drag.pick(at)}>
    {#if item.kind === 'spacer'}
      <span class="gap"><Icon name="arrows-horizontal" size={14} />{t('statusbar:StatusChip.spacer')}</span>
    {:else if item.kind === 'divider'}
      <span class="line"></span>
    {:else if pieces.length}
      {#each pieces as p, k (k)}<StatusPiece {item} {p} />{/each}
    {:else}
      <span>{words.name}</span>
    {/if}
  </button>
  <button
    class="x"
    onclick={onremove}
    title={t('statusbar:StatusChip.remove.title')}
    aria-label={t('statusbar:StatusChip.remove.label', { name: words.name })}
  >
    <Icon name="x" size={12} />
  </button>
</div>

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    cursor: grab;
    /* A finger's long press picks a chip up: no selection or callout under it. */
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .chip.spacer {
    flex: 1;
    justify-content: space-between;
  }
  .chip.spacer .pick {
    flex: 1;
    justify-content: center;
  }
  .chip.chosen {
    border-color: var(--accent);
  }
  .chip.absent {
    opacity: 0.5;
    border-style: dashed;
  }
  .chip.lifted {
    opacity: 0.5;
    border-color: var(--accent);
  }
  .pick {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-1) var(--space-2) var(--space-1) var(--space-3);
    color: inherit;
  }
  .x {
    padding: var(--space-1) var(--space-2);
    color: var(--text-dim);
  }
  .x:hover {
    color: var(--text);
  }
  .gap {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--text-dim);
  }
  .line {
    width: 1px;
    height: 14px;
    background: var(--border);
  }
</style>
