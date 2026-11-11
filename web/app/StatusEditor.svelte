<!--
  The Preferences' status bar (docs/frontend.md "The status bar"): a copy of the bar whose elements are chips
  (StatusChip.svelte), dragged to reorder them (or moved with Alt+←/→ when one has the focus) and dragged out or × to
  remove them; a chip chosen shows its settings under the bar (StatusOptions.svelte: its look, a vCPU element's bars or
  numbers, a `one` element's device). Below, the palette (StatusPalette.svelte): a click adds an element at the bar's
  end, a drag puts it where it's dropped. A mouse drags through HTML5 drag and drop; a finger or a pen through pointer
  events, after a long press (a swipe still scrolls the page): status-drag.svelte.ts. The chips draw what the running
  machine shows, or a made-up machine's numbers (statusbar-sample.ts `SAMPLE`) while none runs; one the running machine
  hasn't (a second disk) is dimmed. Kept in the settings at each change.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Note from './ui/Note.svelte';
  import type { PageNetwork } from './net-live.ts';
  import { remember } from './settings.ts';
  import StatusChip from './StatusChip.svelte';
  import StatusOptions from './StatusOptions.svelte';
  import StatusPalette from './StatusPalette.svelte';
  import { ChipDrag } from './status-drag.svelte.ts';
  import { DEFAULT_ITEMS, lookOf, shows, type Item } from './statusbar.ts';
  import { render } from './statusbar-render.ts';
  import { SAMPLE } from './statusbar-sample.ts';
  import { t } from '../i18n.ts';
  import { liveNow } from './areas/status-live.ts';
  import { status } from './areas/status.svelte.ts';

  type Props = { net: PageNetwork };
  let { net }: Props = $props();

  const items = $derived(status.items);
  let chosen = $state<number | undefined>(undefined);
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
      {#if drag.over === at}<span class="mark" aria-hidden="true"></span>{/if}
      <StatusChip
        item={it}
        {at}
        pieces={render(it, metrics, live)}
        chosen={chosen === at}
        {drag}
        onpick={() => (chosen = chosen === at ? undefined : at)}
        onkey={(e: KeyboardEvent) => key(e, at)}
        onremove={() => removeAt(at)}
      />
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

  <StatusPalette {drag} oninsert={(it: Item) => insert(it)} />
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
</style>
