<!--
  The Preferences' status bar (docs/frontend.md "The status bar"): a copy of the bar whose elements are chips, dragged
  to reorder them (or moved with Alt+←/→ when one has the focus) and dragged out or × to remove them; a chip chosen
  shows its settings under the bar (its look, a vCPU element's bars or numbers, a `one` element's device). Below, the
  palette: a click adds an element at the bar's end, a drag puts it where it's dropped. A mouse drags through HTML5
  drag and drop; a finger or a pen through pointer events, after a long press (a swipe still scrolls the page). The chips draw what the
  running machine shows, or a made-up machine's numbers (statusbar.ts `SAMPLE`) while none runs; one the running
  machine hasn't (a second disk) is dimmed. Kept in the settings at each change.
-->
<script lang="ts">
  import Icon from './ui/Icon.svelte';
  import Button from './ui/Button.svelte';
  import Note from './ui/Note.svelte';
  import type { PageNetwork } from './net-live.ts';
  import { remember } from './settings.ts';
  import { liveNow } from './StatusBar.svelte';
  import StatusOptions from './StatusOptions.svelte';
  import StatusPiece from './StatusPiece.svelte';
  import { ChipDrag } from './status-drag.svelte.ts';
  import {
    aboutOf,
    DEFAULT_ITEMS,
    groupName,
    iconOf,
    lookOf,
    nameOf,
    palette,
    render,
    SAMPLE,
    shows,
    type Item,
  } from './statusbar.ts';
  import { t } from '../i18n.ts';
  import { status } from './areas/status.svelte.ts';

  type Props = { net: PageNetwork };
  let { net }: Props = $props();

  const items = $derived(status.items);
  let chosen = $state<number | undefined>(undefined);
  const groups = palette();
  /** The running machine's numbers, else the sample's. */
  const sample = $derived(!status.metrics);
  const live = $derived.by(() => {
    const l = liveNow(net, Date.now());
    return sample
      ? {
          ...l,
          state: 'running' as const,
          stateText: t('statusbar:StatusEditor.sample.state'),
          disks: SAMPLE.disks,
          nets: SAMPLE.nets,
          gpu: SAMPLE.gpu,
        }
      : l;
  });
  const metrics = $derived(status.metrics ?? SAMPLE.metrics);

  function keep(next: Item[]) {
    status.items = next;
    remember({ statusBar: next });
  }
  const insert = (item: Item, at = items.length) => {
    keep([...items.slice(0, at), { ...item }, ...items.slice(at)]);
    chosen = at;
  };
  function removeAt(at: number) {
    keep(items.filter((_, k) => k !== at));
    chosen = undefined;
  }
  function move(from: number, to: number) {
    if (to < 0 || to > items.length || from === to || from + 1 === to) return;
    const next = [...items];
    const [it] = next.splice(from, 1);
    const at = to > from ? to - 1 : to;
    next.splice(at, 0, it);
    keep(next);
    chosen = at;
  }
  function change(at: number, patch: Partial<Item>) {
    keep(
      items.map((it, k) => {
        if (k !== at) return it;
        const next = { ...it, ...patch };
        if (patch.look === lookOf({ kind: it.kind })) delete next.look; // the kind's own look isn't kept
        if (patch.numbers === false) delete next.numbers;
        return next;
      }),
    );
  }
  function defaults() {
    keep(DEFAULT_ITEMS.map((i) => ({ ...i })));
    remember({ statusBar: undefined });
    chosen = undefined;
  }

  const drag = new ChipDrag({ items: () => items, insert, move, remove: removeAt });
  $effect(() => () => drag.cancel());

  function key(e: KeyboardEvent, at: number) {
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      move(at, e.key === 'ArrowLeft' ? at - 1 : at + 2);
      drag.focus(chosen);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      removeAt(at);
    }
  }
  const sel = $derived(chosen !== undefined ? items[chosen] : undefined);
  const chipTitle = (it: Item, shown: boolean) =>
    shown
      ? t('statusbar:StatusEditor.chip.title', { name: nameOf(it), about: aboutOf(it.kind) })
      : t('statusbar:StatusEditor.chip.title.absent', { name: nameOf(it), about: aboutOf(it.kind) });
  const addKey = (it: Item) => `${it.kind}${it.scope ? `:${it.scope}` : ''}`;
</script>

<div class="status-edit" onclickcapture={drag.guard}>
  <div
    class="bar"
    bind:this={drag.bar}
    role="list"
    aria-label={t('statusbar:StatusEditor.bar')}
    ondragover={drag.overEnd}
    ondrop={drag.drop}
    data-field="status-bar"
  >
    {#each items as it, at (at)}
      {@const pieces = render(it, metrics, live)}
      {#if drag.over === at}<span class="mark" aria-hidden="true"></span>{/if}
      <div
        role="listitem"
        class="chip"
        class:spacer={it.kind === 'spacer'}
        class:chosen={chosen === at}
        class:absent={!pieces.length}
        class:lifted={drag.lifted === at}
        draggable="true"
        onpointerdown={(e) => drag.press(e, { from: at })}
        ondragstart={(e) => drag.start(e, { from: at })}
        ondragend={drag.end}
        ondragover={(e) => drag.overChip(e, at)}
        data-at={at}
        data-kind={it.kind}
        {@attach drag.chip(at)}
      >
        <button
          class="pick"
          onclick={() => (chosen = chosen === at ? undefined : at)}
          onkeydown={(e) => key(e, at)}
          aria-pressed={chosen === at}
          title={chipTitle(it, pieces.length > 0)}
          {@attach drag.pick(at)}
        >
          {#if it.kind === 'spacer'}
            <span class="gap"><Icon name="arrows-horizontal" size={14} />{t('statusbar:StatusEditor.spacer')}</span>
          {:else if it.kind === 'divider'}
            <span class="line"></span>
          {:else if pieces.length}
            {#each pieces as p, k (k)}<StatusPiece item={it} {p} />{/each}
          {:else}
            <span>{nameOf(it)}</span>
          {/if}
        </button>
        <button
          class="x"
          onclick={() => removeAt(at)}
          title={t('statusbar:StatusEditor.remove.title')}
          aria-label={t('statusbar:StatusEditor.remove.label', { name: nameOf(it) })}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
    {/each}
    {#if drag.over === items.length}<span class="mark" aria-hidden="true"></span>{/if}
    {#if !items.length}<span class="empty">{t('statusbar:StatusEditor.empty')}</span>{/if}
  </div>
  <div class="row">
    <Note inline>
      {sample ? t('statusbar:StatusEditor.sample') : t('statusbar:StatusEditor.running')}
      {shows(items) ? '' : t('statusbar:StatusEditor.nothing')}
    </Note>
    <span class="grow"></span>
    <Button icon="refresh" iconSize={14} onclick={defaults} data-action="status-defaults">
      {t('statusbar:StatusEditor.defaults')}
    </Button>
  </div>

  {#if sel && chosen !== undefined}
    {@const at = chosen}
    <StatusOptions
      item={sel}
      {at}
      count={items.length}
      onchange={(patch: Partial<Item>) => change(at, patch)}
      onmove={(to: number) => move(at, to)}
      onremove={() => removeAt(at)}
    />
  {/if}

  <div
    class="palette"
    class:leaving={drag.leaving}
    bind:this={drag.palette}
    role="group"
    aria-label={t('statusbar:StatusEditor.palette')}
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
            onclick={() => insert(it)}
            title={t('statusbar:StatusEditor.add.title', { about: aboutOf(it.kind) })}
            data-add={addKey(it)}
          >
            {#if icon}<Icon name={icon} size={14} />{/if}{nameOf(it, true)}
          </button>
        {/each}
      </div>
    {/each}
  </div>
</div>

<style>
  .status-edit {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  /* The bar as it will be: its chips, in the status bar's look. */
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: stretch;
    gap: var(--space-2);
    padding: var(--space-3);
    min-height: 40px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-bar);
    color: var(--text-dim);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    cursor: grab;
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
  /* A finger's long press picks a chip up: no selection or callout under it. */
  .chip,
  .add {
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
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
  .mark {
    width: 2px;
    align-self: stretch;
    background: var(--accent);
    border-radius: 1px;
  }
  .empty {
    color: var(--text-dim);
    padding: var(--space-2);
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .grow {
    flex: 1;
  }
  .palette.leaving {
    outline: 2px dashed var(--accent);
    outline-offset: 4px;
    border-radius: var(--radius);
  }
  .palette {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--space-3) var(--space-5);
    align-items: baseline;
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
  }
</style>
