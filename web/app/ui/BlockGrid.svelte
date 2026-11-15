<!--
  A block map, as a defragmenter draws one: a grid of small squares on a canvas, each a cell of something made of
  equal units (a disk's blocks, later RAM's pages). It knows nothing of what a cell is: its owner gives it looks.
  - `cells`: how many; `rim`, `core`: per cell a look (block-grid.ts `RIM`, `CORE`): the rim is the whole square (the
    layer under), the core a smaller square inset in it (the layer over), so the core sits on the rim and the rim shows
    round it. `flash`: per cell bits (`FLASH.read`, `FLASH.write`), which fade over ~600 ms (with
    `prefers-reduced-motion`, a mark that the next `flash` array replaces). The arrays are taken as they are: a new
    picture is new arrays (their insides aren't watched); a short array leaves the cells past it empty.
  - `mark`: the cell after which a boundary is drawn (the end of the layer under); `pinned`: the cell ringed as chosen.
  - `sizes`: a cell's size range and the gap, CSS pixels (block-grid.ts `CELL_SIZES`: 10 to 14, a 1 px gap); the cells
    take the largest size with which they all fit and grow a little to fill the width (read when it mounts).
  - `onroom(n)`: how many cells of the smallest size its box holds, whenever that changes (its owner asks for that
    many). It fills its box (its parent gives it a height).
  - `onhover(i)`: the cell the pointer or the keyboard's cursor is on, `undefined` off the cells; `onpick(i)`: a click,
    or Enter or Space on the cursor's cell.
  - Keyboard: focusable; the arrows move a cursor (drawn while focused), Home and End go to the first and last cell.
    `label` is its spoken name (its role: an application, its keys its own). A click doesn't focus it by itself: a floating window over
    the machine keeps the screen's focus (FloatingWindow.svelte).
  - Colours are the theme's `--map-*` tokens (theme/tokens.css), read by the canvas.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { cellAt, CELL_SIZES, stepCursor, type CellSizes } from './block-grid.ts';
  import { GridPainter } from './block-painter.ts';

  type Props = {
    cells: number;
    rim: Uint8Array;
    core: Uint8Array;
    flash?: Uint8Array;
    mark?: number;
    pinned?: number;
    sizes?: CellSizes;
    label: string;
    onroom?: (n: number) => void;
    onhover?: (i: number | undefined) => void;
    onpick?: (i: number) => void;
  };
  let { cells, rim, core, flash, mark, pinned, sizes = CELL_SIZES, label, onroom, onhover, onpick }: Props = $props();

  let box = $state<HTMLDivElement>();
  let canvas = $state<HTMLCanvasElement>();
  let painter = $state<GridPainter>();
  /** The layout as last drawn (CSS pixels for the tests' hooks), and the room it reported. */
  let shape = $state({ cols: 1, pitch: 0, size: 0, pad: 0 });
  let room = -1;
  let hover = $state<number>();
  let cursor = $state(0);
  let focused = $state(false);

  function laidOut(p: GridPainter) {
    const l = p.layout;
    shape = { cols: l.cols, pitch: l.pitch / p.dpr, size: l.size / p.dpr, pad: p.pad / p.dpr };
    if (l.room !== room) {
      room = l.room;
      onroom?.(room);
    }
  }

  onMount(() => {
    if (!canvas || !box) return;
    const p = new GridPainter(canvas);
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    const moved = () => (p.reduced = motion.matches);
    const retheme = () => p.retheme();
    moved();
    motion.addEventListener('change', moved);
    scheme.addEventListener('change', retheme);
    const observer = new ResizeObserver(([e]) => {
      const dpr = devicePixelRatio;
      // The device pixels' box where the browser gives it right (Chromium's emulated scale gives CSS pixels there).
      const dev = e.devicePixelContentBoxSize[0] as ResizeObserverSize | undefined;
      const [cw, ch] = [e.contentRect.width * dpr, e.contentRect.height * dpr];
      const exact = dev && Math.abs(dev.inlineSize - cw) < 2 && Math.abs(dev.blockSize - ch) < 2;
      const [w, h] = exact ? [dev.inlineSize, dev.blockSize] : [Math.round(cw), Math.round(ch)];
      p.resize(w, h, dpr, sizes);
      laidOut(p);
    });
    observer.observe(box, { box: 'device-pixel-content-box' });
    painter = p;
    return () => {
      observer.disconnect();
      motion.removeEventListener('change', moved);
      scheme.removeEventListener('change', retheme);
      p.stop();
    };
  });

  $effect(() => {
    if (!painter) return;
    painter.data({ cells, rim, core });
    laidOut(painter);
  });
  $effect(() => painter?.flash(flash));
  $effect(() => painter?.marks({ mark, pinned, hover, cursor: focused ? cursor : undefined }));
  $effect(() => {
    // The cursor stays on the cells when they get fewer.
    if (cursor >= cells) cursor = Math.max(0, cells - 1);
  });

  /** The cell under a pointer, if any. */
  function under(e: PointerEvent | MouseEvent) {
    if (!painter) return undefined;
    const [x, y] = [e.offsetX * painter.dpr - painter.pad, e.offsetY * painter.dpr - painter.pad];
    return cellAt(painter.layout, cells, x, y);
  }
  function point(i: number | undefined) {
    if (i === hover) return;
    hover = i;
    onhover?.(i);
  }
  function click(e: MouseEvent) {
    const i = under(e);
    if (i === undefined) return;
    cursor = i;
    onpick?.(i);
  }
  function key(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (cells > 0) onpick?.(cursor);
      return;
    }
    const to = stepCursor(e.key, cursor, painter?.layout.cols ?? 1, cells);
    if (to === undefined) return;
    e.preventDefault();
    cursor = to;
    point(to);
  }
</script>

<!-- An application: its keys are its own (the arrows move its cursor), which Svelte's checks don't count as interactive. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="grid"
  bind:this={box}
  tabindex="0"
  role="application"
  aria-label={label}
  data-cells={cells}
  data-cols={shape.cols}
  data-pitch={shape.pitch}
  data-size={shape.size}
  data-pad={shape.pad}
  data-cursor={focused ? cursor : undefined}
  onpointermove={(e) => point(under(e))}
  onpointerleave={() => point(undefined)}
  onclick={click}
  onkeydown={key}
  onfocus={() => (focused = true)}
  onblur={() => (focused = false)}
>
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .grid {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    outline: none;
    cursor: pointer;
    touch-action: manipulation;
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }
</style>
