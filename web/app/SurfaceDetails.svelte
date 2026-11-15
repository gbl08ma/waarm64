<!--
  A disk surface window's pinned square (SurfaceWindow.svelte): one 4 MiB range of it block by block (its 1,024 blocks of
  4 KiB as a 32 × 32 map: the disk's, the overlay's, zeroed, past the end), a stepper through the ranges when the square
  covers several, what they hold and in how many runs their store keeps them (its fragmentation), and Check contents,
  which reads the range's held blocks (up to 4 MiB) and counts those that are all zeros. Asked of the window's source
  when the range changes (`poll.range`), not polled.
-->
<script lang="ts">
  import BlockGrid from './ui/BlockGrid.svelte';
  import Button from './ui/Button.svelte';
  import Note from './ui/Note.svelte';
  import { detailLook, detailWords, diskLayer, rangesOfCell, type ViewKind } from './surface-look.ts';
  import type { SurfacePoll } from './surface-poll.svelte.ts';
  import type { RangeDetail, Surface } from '../surface.ts';
  import { text, t, type Msg } from '../i18n.ts';

  type Props = { surface: Surface; cell: number; kind: ViewKind; poll: SurfacePoll; onclose: () => void };
  let { surface, cell, kind, poll, onclose }: Props = $props();

  /** A block is 5 px with a 1 px gap: 32 of them in a row. */
  const SIZES = { min: 5, max: 5, gap: 1 };
  const ranges = $derived(rangesOfCell(surface, cell));
  /** Which of the square's ranges is shown (another square, or another source, is a new component: SurfaceWindow keys it). */
  let step = $state(0);
  const range = $derived(ranges.first + Math.min(step, Math.max(0, ranges.count - 1)));
  let detail = $state.raw<RangeDetail>();
  let why = $state.raw<Msg>();
  let checking = $state(false);
  let asked = 0;

  async function ask(r: number, content: boolean) {
    const n = ++asked;
    if (content) checking = true;
    const got = await poll.range(r, content);
    if (n !== asked) return;
    checking = false;
    if (got && 'blocks' in got) [detail, why] = [got, undefined];
    else [detail, why] = [undefined, got];
  }
  $effect(() => {
    detail = undefined;
    void ask(range, false);
  });
  const look = $derived(detail && detailLook(detail, kind.disk === 'opaque'));
  const lines = $derived(detail ? detailWords(detail, kind, diskLayer(surface)?.size).map(text) : []);
  const held = $derived(detail ? detail.blocks.some((b) => b === 1 || b === 2) : false);
</script>

<section class="details" data-range={range} data-loaded={detail ? '' : undefined}>
  <div class="bar">
    <strong>{t('disks:SurfaceDetails.title')}</strong>
    <span class="grow"></span>
    <Button
      variant="plain"
      icon="x"
      iconSize={14}
      data-action="surface-unpin"
      aria-label={t('disks:SurfaceDetails.close')}
      title={t('disks:SurfaceDetails.close')}
      onclick={onclose}
    />
  </div>
  {#if ranges.count > 1}
    <div class="stepper">
      <Button
        variant="plain"
        icon="arrow-left"
        iconSize={14}
        disabled={step <= 0}
        data-action="surface-range-prev"
        aria-label={t('disks:SurfaceDetails.prev')}
        title={t('disks:SurfaceDetails.prev')}
        onclick={() => (step = Math.max(0, step - 1))}
      />
      <span data-field="surface-range-step"
        >{t('disks:SurfaceDetails.step', { at: step + 1, count: ranges.count })}</span
      >
      <Button
        variant="plain"
        icon="arrow-right"
        iconSize={14}
        disabled={step >= ranges.count - 1}
        data-action="surface-range-next"
        aria-label={t('disks:SurfaceDetails.next')}
        title={t('disks:SurfaceDetails.next')}
        onclick={() => (step = Math.min(ranges.count - 1, step + 1))}
      />
    </div>
  {/if}
  <div class="blocks">
    {#if look}
      <BlockGrid
        cells={look.cells}
        rim={look.rim}
        core={look.core}
        sizes={SIZES}
        label={t('disks:SurfaceDetails.blocks')}
      />
    {/if}
  </div>
  {#if detail}
    <div class="words" data-field="surface-range-words">
      {#each lines as l, i (i)}<p>{l}</p>{/each}
    </div>
    {#if held}
      <Button
        data-action="surface-check"
        disabled={checking}
        title={t('disks:SurfaceDetails.check.title')}
        onclick={() => ask(range, true)}
        >{checking ? t('disks:SurfaceDetails.checking') : t('disks:SurfaceDetails.check')}</Button
      >
    {/if}
  {:else if why}
    <Note>{text(why)}</Note>
  {/if}
</section>

<style>
  .details {
    flex: none;
    width: 204px;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-height: 0;
    overflow-y: auto;
    font-size: var(--text-sm);
  }
  .bar,
  .stepper {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .bar strong {
    font-size: var(--text-sm);
  }
  .grow {
    flex: 1;
  }
  .stepper {
    color: var(--text-dim);
  }
  /* 32 blocks of 5 px, 31 gaps of 1 px, the grid's 2 px margin each side, and a pixel to spare (a box measured a hair
     short would fit one block fewer). */
  .blocks {
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
