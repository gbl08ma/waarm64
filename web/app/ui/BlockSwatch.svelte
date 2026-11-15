<!--
  A block map's legend entry: one cell drawn as BlockGrid.svelte draws it (block-draw.ts, the same code and tokens, so
  the legend and the grid never disagree), the words beside it (`children`). `rim`, `core`, `flash`: the cell's looks
  (block-grid.ts `RIM`, `CORE`, `FLASH`); `size`: the cell's size, CSS pixels.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { drawCell, drawFlash, readPalette } from './block-draw.ts';
  import { CELL_SIZES } from './block-grid.ts';

  type Props = { rim?: number; core?: number; flash?: number; size?: number; children: Snippet };
  let { rim = 0, core = 0, flash = 0, size = CELL_SIZES.max, children }: Props = $props();

  const px = (n: number) => `${String(n)}px`;
  let canvas = $state<HTMLCanvasElement>();
  $effect(() => {
    if (!canvas) return;
    const s = Math.round(size * devicePixelRatio);
    [canvas.width, canvas.height] = [s, s];
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const p = readPalette(canvas);
    drawCell(ctx, 0, 0, s, rim, core, p);
    drawFlash(ctx, 0, 0, s, flash, 1, p);
  });
</script>

<span class="swatch">
  <canvas bind:this={canvas} style:width={px(size)} style:height={px(size)} aria-hidden="true"></canvas>
  <span>{@render children()}</span>
</span>

<style>
  .swatch {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-dim);
    white-space: nowrap;
  }
  canvas {
    flex: none;
    display: block;
  }
</style>
