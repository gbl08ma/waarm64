<!--
  The RAM map's pinned square, in a window of its own beside the map (RamWindow.svelte): one 4 MiB range of it page by
  page (its 1,024 pages of 4 KiB as a 32 × 32 map: zero, data, changed or cleared since the last look, past RAM's end),
  a stepper through the ranges when the square covers several, and what they hold in words with their guest physical
  addresses. Asked of the window's source when the range changes, and again after each look (`surface`: a new one is
  a new pass).
-->
<script lang="ts">
  import BlockGrid from './ui/BlockGrid.svelte';
  import Button from './ui/Button.svelte';
  import Note from './ui/Note.svelte';
  import { rangesOfCell } from './surface-look.ts';
  import { changedLayer, ramDetailLook, ramDetailWords } from './ram-look.ts';
  import type { SurfacePoll } from './surface-poll.svelte.ts';
  import type { RamPlace, RangeDetail, Surface } from '../surface.ts';
  import { text, t, type Msg } from '../i18n.ts';

  type Props = { surface: Surface; layout: RamPlace[]; cell: number; poll: SurfacePoll };
  let { surface, layout, cell, poll }: Props = $props();

  /** A page is 5 px with a 1 px gap: 32 of them in a row. */
  const SIZES = { min: 5, max: 5, gap: 1 };
  const ranges = $derived(rangesOfCell(surface, cell));
  /** Which of the square's ranges is shown (another square is a new component: RamWindow keys it). */
  let step = $state(0);
  const range = $derived(ranges.first + Math.min(step, Math.max(0, ranges.count - 1)));
  let detail = $state.raw<RangeDetail>();
  let why = $state.raw<Msg>();
  let asked = 0;

  async function ask(r: number) {
    const n = ++asked;
    const got = await poll.range(r, false);
    if (n !== asked) return;
    if (got && 'blocks' in got) [detail, why] = [got, undefined];
    else [detail, why] = [undefined, got];
  }
  let shown = -1;
  $effect(() => {
    // Asked again after each look (a new surface), its last picture kept meanwhile; another range starts afresh.
    // eslint-disable-next-line @typescript-eslint/no-meaningless-void-operator -- read to track it (the effect's dependency)
    void surface;
    if (range !== shown) detail = undefined;
    shown = range;
    void ask(range);
  });
  const look = $derived(detail && ramDetailLook(detail));
  const lines = $derived(detail ? ramDetailWords(detail, layout, surface.size, !!changedLayer(surface)).map(text) : []);
</script>

<section class="details" data-range={range} data-loaded={detail ? '' : undefined}>
  {#if ranges.count > 1}
    <div class="stepper">
      <Button
        variant="plain"
        icon="arrow-left"
        iconSize={14}
        disabled={step <= 0}
        data-action="ram-range-prev"
        aria-label={t('machine:RamDetails.prev')}
        title={t('machine:RamDetails.prev')}
        onclick={() => (step = Math.max(0, step - 1))}
      />
      <span data-field="ram-range-step">{t('machine:RamDetails.step', { at: step + 1, count: ranges.count })}</span>
      <Button
        variant="plain"
        icon="arrow-right"
        iconSize={14}
        disabled={step >= ranges.count - 1}
        data-action="ram-range-next"
        aria-label={t('machine:RamDetails.next')}
        title={t('machine:RamDetails.next')}
        onclick={() => (step = Math.min(ranges.count - 1, step + 1))}
      />
    </div>
  {/if}
  <div class="pages">
    {#if look}
      <BlockGrid
        cells={look.cells}
        rim={look.rim}
        core={look.core}
        sizes={SIZES}
        label={t('machine:RamDetails.pages')}
      />
    {/if}
  </div>
  <div class="side">
    {#if detail}
      <div class="words" data-field="ram-range-words">
        {#each lines as l, i (i)}<p>{l}</p>{/each}
      </div>
    {:else if why}
      <Note>{text(why)}</Note>
    {/if}
  </div>
</section>

<style>
  /* As wide as the page map: its window takes its size from it, and the words wrap to the map's width. */
  .details {
    width: 196px;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    font-size: var(--text-sm);
  }
  /* A browser window too short for the column: the words beside the map (as a disk's pinned square's). */
  @media (max-height: 540px) {
    .details {
      width: auto;
      display: grid;
      grid-template-columns: 196px 196px;
      align-items: start;
      column-gap: var(--space-4);
    }
    .stepper,
    .pages {
      grid-column: 1;
    }
    .side {
      grid-column: 2;
      grid-row: 1 / span 2;
    }
  }
  .stepper {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--text-dim);
  }
  /* 32 pages of 5 px, 31 gaps of 1 px, the grid's 2 px margin each side, and a pixel to spare. */
  .pages {
    flex: none;
    width: 196px;
    height: 196px;
  }
  .words {
    color: var(--text-dim);
  }
  .words p {
    margin: 0 0 var(--space-1);
  }
  .words p:first-child {
    color: var(--text);
  }
</style>
