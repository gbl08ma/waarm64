<!--
  The RAM map (docs/frontend.md "RAM's map"): a floating window with the running machine's RAM as a block map, as the
  disk surface window draws a disk (SurfaceWindow.svelte, whose pieces it shares): each square's rim is how many of its
  4 KiB pages hold anything but zeros, its core how many changed since the last look (hollow where pages were only
  cleared). Over the map the scale and how often it looks; under it the legend and a line with the numbers of the square
  pointed at (its guest physical addresses). The square clicked opens in a window of its own beside it
  (RamDetails.svelte). No reads and writes are shown: compiled code touches RAM directly, so the map looks at RAM
  itself, pass after pass (web/ram-scan.ts, in a worker of its own), asked by web/app/surface-poll.svelte.ts through
  web/app/ram-source.ts. Mounted by App.svelte while `ramWindow.open` says (web/app/areas/ram.svelte.ts).
-->
<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import BlockGrid from './ui/BlockGrid.svelte';
  import FloatingWindow from './ui/FloatingWindow.svelte';
  import StatusDot from './ui/StatusDot.svelte';
  import RamDetails from './RamDetails.svelte';
  import SurfaceLegend from './SurfaceLegend.svelte';
  import { ramHost, ramWindow } from './areas/ram.svelte.ts';
  import { SurfacePoll } from './surface-poll.svelte.ts';
  import { ramDelay, ramSourceFor } from './ram-source.ts';
  import { changedLayer, ramCellWords, ramLegend, ramLookOf, ramWholeWords } from './ram-look.ts';
  import { sizeText } from './surface-look.ts';
  import { text, t } from '../i18n.ts';

  const host = $derived(ramHost());
  const poll = new SurfacePoll();
  const runs = new WeakMap<Worker, number>();
  let lastRun = 0;
  function runId(w: Worker) {
    if (!runs.has(w)) runs.set(w, ++lastRun);
    return runs.get(w);
  }
  onDestroy(() => poll.close());
  $effect(() => {
    const h = host;
    // Another run (a restart) is another source; none running, the words why.
    const key = h ? `run ${String(runId(h.worker))}` : 'none';
    untrack(() => poll.use(key, () => ramSourceFor(h)));
  });

  // The grid's room, asked for once it settles (a resize reports many).
  let roomTimer: ReturnType<typeof setTimeout> | undefined;
  let roomed = false;
  function room(n: number) {
    clearTimeout(roomTimer);
    if (!roomed) {
      roomed = true;
      poll.room(n);
    } else roomTimer = setTimeout(() => poll.room(n), 150);
  }
  onDestroy(() => clearTimeout(roomTimer));

  const surface = $derived(poll.surface);
  const layout = $derived(poll.layout ?? []);
  const look = $derived(surface && ramLookOf(surface));
  const changes = $derived(!!surface && !!changedLayer(surface));
  const legend = $derived(ramLegend(changes));
  /** How often the map looks, in whole seconds (the pass's cost stretches it). */
  const every = $derived(surface ? Math.max(1, Math.round(ramDelay(surface.cost) / 1000)) : undefined);
  const EMPTY = new Uint8Array(0);
  /** The squares' sizes: the room is counted at 10 px (so the scale), and a small RAM's few squares grow to 24 px. */
  const SIZES = { min: 10, max: 24, gap: 1 };
  let mapWindow = $state<HTMLElement>();
  /** The pinned square's window opens beside the map's: on its right if there's room, else on its left, else over it. */
  function besideMap(s: { w: number; h: number }) {
    const r = mapWindow?.getBoundingClientRect();
    if (!r) return { x: innerWidth - s.w, y: 0 };
    const GAP = 8;
    const x =
      r.right + GAP + s.w <= innerWidth ? r.right + GAP : r.left - GAP - s.w >= 0 ? r.left - GAP - s.w : r.right - s.w;
    return { x, y: r.top };
  }

  let hover = $state<number>();
  /** The square pinned, by its first byte (so it stays where it was when the squares get larger or smaller). */
  let pinnedAt = $state<number>();
  const pinned = $derived(
    surface && pinnedAt !== undefined && pinnedAt < surface.size ? Math.floor(pinnedAt / surface.cellBytes) : undefined,
  );
  // Another run's RAM: the square pinned goes.
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-meaningless-void-operator -- read to track it (the effect's dependency)
    void host;
    pinnedAt = undefined;
  });

  /** What the line under the map says: the square pointed at, else what RAM holds as a whole. */
  const line = $derived.by(() => {
    if (!surface) return '';
    if (poll.stale) return t('machine:RamWindow.reading');
    const words =
      hover !== undefined && hover < (look?.cells ?? 0) ? ramCellWords(surface, layout, hover) : ramWholeWords(surface);
    return words.map(text).join(' ');
  });

  /** What a screen reader is told: the line as it is when the square pointed at changes, not at each look. */
  let spoken = $state('');
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-meaningless-void-operator -- read to track it (the effect's dependency)
    void hover;
    spoken = untrack(() => line);
  });

  // The tests' hooks: what the window draws.
  $effect(() => {
    window.__ram = { live: poll.live, stale: poll.stale, surface, layout, look, pinned, answers: () => poll.answers };
  });
  onDestroy(() => (window.__ram = undefined));
</script>

<FloatingWindow
  id="ram-window"
  place="ram"
  title={t('machine:RamWindow.title')}
  min={{ w: 360, h: 300 }}
  size={{ w: 640, h: 480 }}
  onclose={() => ramWindow.close()}
  bind:ref={mapWindow}
>
  <div class="status" data-live={poll.live ? '' : undefined}>
    {#if surface}<span data-field="ram-scale"
        >{t('machine:RamWindow.scale', { size: sizeText(surface.cellBytes) })}</span
      >{/if}
    <span class="grow"></span>
    {#if poll.live && every !== undefined}
      <span class="state" title={t('machine:RamWindow.live.title')} data-field="ram-every"
        ><StatusDot tone="ok" />{t('machine:RamWindow.live', { count: every })}</span
      >
    {/if}
  </div>
  <div class="map" data-stale={poll.stale ? '' : undefined}>
    <BlockGrid
      cells={look?.cells ?? 0}
      sizes={SIZES}
      rim={look?.rim ?? EMPTY}
      core={look?.core ?? EMPTY}
      {pinned}
      label={t('machine:RamWindow.map')}
      onroom={room}
      onhover={(i: number | undefined) => (hover = i)}
      onpick={(i: number) => {
        if (surface) pinnedAt = pinned === i ? undefined : i * surface.cellBytes;
      }}
    />
    {#if !surface && (poll.why !== undefined || poll.asking)}
      <div class="why" data-field="ram-why">
        {poll.why ? text(poll.why) : t('machine:RamWindow.reading')}
      </div>
    {/if}
  </div>
  {#if surface}<SurfaceLegend entries={legend} />{/if}
  <div class="line" data-field="ram-line">{line}</div>
  <div class="sr" aria-live="polite">{spoken}</div>
</FloatingWindow>
{#if surface && pinned !== undefined && !poll.stale}
  <FloatingWindow
    id="ram-square"
    title={t('machine:RamWindow.pinned')}
    fit
    size={{ w: 230, h: 420 }}
    at={besideMap}
    onclose={() => (pinnedAt = undefined)}
  >
    {#key pinned}<RamDetails {surface} {layout} cell={pinned} {poll} />{/key}
  </FloatingWindow>
{/if}

<style>
  .status {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: var(--control-h);
    font-size: var(--text-sm);
    color: var(--text-dim);
  }
  .grow {
    flex: 1;
  }
  .state {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }
  .map {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .map[data-stale] {
    opacity: 0.35;
  }
  .why {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-5);
    text-align: center;
    color: var(--text-dim);
    font-size: var(--text-sm);
    pointer-events: none;
  }
  .line {
    min-height: calc(3 * var(--line-height) * var(--text-sm));
    font-size: var(--text-sm);
    color: var(--text-dim);
  }
</style>
