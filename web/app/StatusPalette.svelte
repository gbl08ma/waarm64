<!--
  The Preferences' status bar editor's palette (StatusEditor.svelte): every element, by group, in each of its scopes. A
  click adds one at the bar's end (`oninsert`), a drag puts it where it's dropped; a chip dragged from the bar and
  dropped here is removed (`drag`: status-drag.svelte.ts).
-->
<script lang="ts">
  import Icon from './ui/Icon.svelte';
  import type { ChipDrag } from './status-drag.svelte.ts';
  import { aboutOf, groupName, iconOf, nameOf, palette, type Item } from './statusbar.ts';
  import { t } from '../i18n.ts';

  type Props = { drag: ChipDrag; oninsert: (item: Item) => void };
  let { drag, oninsert }: Props = $props();

  const groups = palette();
  const addKey = (it: Item) => `${it.kind}${it.scope ? `:${it.scope}` : ''}`;
</script>

<div
  class="palette"
  class:leaving={drag.leaving}
  bind:this={drag.palette}
  role="group"
  aria-label={t('statusbar:StatusPalette.label')}
  ondragover={(e) => {
    if (drag.fromChip) e.preventDefault();
  }}
  ondrop={drag.dropOut}
>
  {#each groups as g (g.group)}
    <span class="group">{groupName(g.group)}</span>
    <div class="chips">
      {#each g.items as it (addKey(it))}
        {@const icon = iconOf(it.kind)}
        <button
          class="add"
          draggable="true"
          onpointerdown={(e) => drag.press(e, { add: it })}
          ondragstart={(e) => drag.start(e, { add: it })}
          ondragend={drag.end}
          onclick={() => oninsert(it)}
          title={t('statusbar:StatusPalette.add.title', { about: aboutOf(it.kind) })}
          data-add={addKey(it)}
        >
          {#if icon}<Icon name={icon} size={14} />{/if}{nameOf(it, true)}
        </button>
      {/each}
    </div>
  {/each}
</div>

<style>
  .palette {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--space-3) var(--space-5);
    align-items: baseline;
  }
  .palette.leaving {
    outline: 2px dashed var(--accent);
    outline-offset: 4px;
    border-radius: var(--radius);
  }
  .group {
    color: var(--text-dim);
    font-size: var(--text-sm);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
  /* A palette's element: a chip to drag onto the bar, or click. */
  .add {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: var(--text-sm);
    padding: var(--space-1) var(--space-3);
    cursor: grab;
    /* A finger's long press picks it up: no selection or callout under it. */
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
</style>
