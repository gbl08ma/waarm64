<!--
  A disk's surface (docs/frontend.md "A disk's surface"): a floating window with the disk's map, as a defragmenter draws
  one. In its title bar the overlay laid over the disk ("the disk alone" or one of the disk's overlays: opened from a
  machine's Disks tab it starts on that attachment's); under it the scale ("1 square = 16 MiB"), whether the map is live
  (the machine on this page runs with the disk so) or read from this browser's storage (Refresh), the grid
  (BlockGrid.svelte), the legend (SurfaceLegend.svelte), a line with the numbers of the square pointed at, and the
  square clicked (SurfaceDetails.svelte). The numbers come from web/app/surface-source.ts, asked by
  web/app/surface-poll.svelte.ts; the looks from web/app/surface-look.ts. Mounted by App.svelte while
  `surfaceWindow.open` says (web/app/areas/surface.svelte.ts).
-->
<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import BlockGrid from './ui/BlockGrid.svelte';
  import Button from './ui/Button.svelte';
  import FloatingWindow from './ui/FloatingWindow.svelte';
  import StatusDot from './ui/StatusDot.svelte';
  import SurfaceDetails from './SurfaceDetails.svelte';
  import SurfaceLegend from './SurfaceLegend.svelte';
  import { records } from './areas/records.svelte.ts';
  import { runningHere, surfaceWindow, type SurfaceOpen } from './areas/surface.svelte.ts';
  import { choiceKey, chooseSource, sourceFor } from './surface-source.ts';
  import { SurfacePoll } from './surface-poll.svelte.ts';
  import { cellWords, diskLayer, lookOf, overlayLayer, sizeText, type ViewKind } from './surface-look.ts';
  import { bytesText } from './bytes.ts';
  import { text, t } from '../i18n.ts';

  let { open }: { open: SurfaceOpen } = $props();

  // The overlay chosen in the title bar's picker ('': the disk alone), from the opening's.
  // svelte-ignore state_referenced_locally
  let overlay = $state(open.overlay ?? '');
  const disk = $derived(records.disks.get(open.disk));
  const overlays = $derived(records.overlays.filter((o) => o.disk === open.disk).sort((a, b) => a.created - b.created));
  const chosen = $derived(overlays.find((o) => o.id === overlay));
  const running = $derived(runningHere());
  const target = $derived({ disk: open.disk, ...(overlay === '' ? {} : { overlay }) });
  const choice = $derived(chooseSource(target, disk, chosen, running));

  const poll = new SurfacePoll();
  const runs = new WeakMap<Worker, number>();
  let lastRun = 0;
  function runId(w: Worker) {
    if (!runs.has(w)) runs.set(w, ++lastRun);
    return runs.get(w);
  }
  onDestroy(() => poll.close());
  $effect(() => {
    const [c, r] = [choice, running];
    // A live source is the run's: another run (a restart) is another source.
    const key = `${choiceKey(c)} ${r && c.kind === 'live' ? runId(r.worker) : ''}`;
    untrack(() => poll.use(key, () => sourceFor(c, r)));
  });
  // Not live, the map is read again when the records change (a machine stopped and wrote its overlay's numbers, a merge).
  let seen = false;
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-meaningless-void-operator -- read to track them (the effect's dependencies)
    void [records.disks, records.overlays];
    if (seen) untrack(() => !poll.live && poll.refresh());
    seen = true;
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
  const look = $derived(surface && lookOf(surface));
  const EMPTY = new Uint8Array(0);
  /** The squares' sizes: the room is counted at 10 px (so the scale), and a small disk's few squares grow to 24 px. */
  const SIZES = { min: 10, max: 24, gap: 1 };
  const kind = $derived<ViewKind>({
    disk: disk?.kind === 'ramdisk' ? 'ram' : disk?.kind === 'file' || disk?.kind === 'url' ? 'opaque' : 'counted',
    overlay: !!chosen,
    grown: look?.mark !== undefined,
    live: poll.live,
  });

  let hover = $state<number>();
  /** The square pinned, by its first byte (so it stays where it was when the squares get larger or smaller). */
  let pinnedAt = $state<number>();
  const pinned = $derived(
    surface && pinnedAt !== undefined && pinnedAt < surface.size ? Math.floor(pinnedAt / surface.cellBytes) : undefined,
  );

  /** What the line under the map says: the square pointed at, else what the view holds as a whole. */
  const line = $derived.by(() => {
    if (surface && hover !== undefined && hover < (look?.cells ?? 0))
      return cellWords(surface, hover, kind.disk === 'ram')
        .map(text)
        .join(' ');
    if (!surface) return '';
    const d = diskLayer(surface);
    const o = overlayLayer(surface);
    const nothing = (l: typeof d) => !l || l.held.every((x) => x === 0);
    if (kind.disk === 'opaque') return t(chosen ? 'disks:SurfaceWindow.opaqueOverlay' : 'disks:SurfaceWindow.opaque');
    if (nothing(d) && (!o || (nothing(o) && o.zero.every((x) => x === 0))))
      return t(kind.disk === 'ram' ? 'disks:SurfaceWindow.ramEmpty' : 'disks:SurfaceWindow.empty');
    return t('disks:SurfaceWindow.hint');
  });

  const title = $derived(disk?.name ?? t('disks:SurfaceWindow.untitled'));
  const overlayLabel = (o: (typeof overlays)[number]) =>
    t('disks:SurfaceWindow.overlay', {
      name: o.name,
      held: bytesText(o.bytes),
      size: bytesText(Math.max(disk?.size ?? 0, o.size ?? 0)),
    });

  // The tests' hooks: what the window draws and from where.
  $effect(() => {
    window.__surface = {
      disk: open.disk,
      overlay: target.overlay,
      source: choice.kind,
      live: poll.live,
      surface,
      look,
      pinned,
      answers: () => poll.answers,
    };
  });
  onDestroy(() => (window.__surface = undefined));
</script>

<FloatingWindow
  id="surface-window"
  place="surface"
  {title}
  min={{ w: 360, h: 300 }}
  size={{ w: 720, h: 520 }}
  onclose={() => surfaceWindow.close()}
>
  {#snippet head()}
    <select
      bind:value={overlay}
      onchange={() => (pinnedAt = undefined)}
      data-field="surface-overlay"
      aria-label={t('disks:SurfaceWindow.overlays')}
      title={t('disks:SurfaceWindow.overlays.title')}
    >
      <option value="">{t('disks:SurfaceWindow.alone')}</option>
      {#if disk?.kind !== 'ramdisk'}
        {#each overlays as o (o.id)}<option value={o.id}>{overlayLabel(o)}</option>{/each}
      {/if}
    </select>
  {/snippet}
  <div class="status" data-live={poll.live ? '' : undefined} data-source={choice.kind}>
    {#if surface}<span data-field="surface-scale"
        >{t('disks:SurfaceWindow.scale', { size: sizeText(surface.cellBytes) })}</span
      >{/if}
    <span class="grow"></span>
    {#if poll.live}
      <span class="state" title={t('disks:SurfaceWindow.live.title')}
        ><StatusDot tone="ok" />{t('disks:SurfaceWindow.live')}</span
      >
    {:else if choice.kind === 'offline'}
      <span class="state" title={t('disks:SurfaceWindow.stored.title')}
        ><StatusDot tone="off" />{t('disks:SurfaceWindow.stored')}</span
      >
      <Button
        icon="refresh"
        iconSize={14}
        data-action="surface-refresh"
        title={t('disks:SurfaceWindow.refresh.title')}
        onclick={() => poll.refresh()}>{t('disks:SurfaceWindow.refresh')}</Button
      >
    {/if}
  </div>
  <div class="main">
    <div class="map">
      <BlockGrid
        cells={look?.cells ?? 0}
        sizes={SIZES}
        rim={look?.rim ?? EMPTY}
        core={look?.core ?? EMPTY}
        flash={look?.flash}
        mark={look?.mark}
        {pinned}
        label={t('disks:SurfaceWindow.map', { name: title })}
        onroom={room}
        onhover={(i: number | undefined) => (hover = i)}
        onpick={(i: number) => {
          if (surface) pinnedAt = pinned === i ? undefined : i * surface.cellBytes;
        }}
      />
      {#if !surface && (poll.why !== undefined || poll.asking)}
        <div class="why" data-field="surface-why">
          {poll.why ? text(poll.why) : t('disks:SurfaceWindow.reading')}
        </div>
      {/if}
    </div>
    {#if surface && pinned !== undefined}
      <!-- A new one for another square or another source: its first range, asked again. -->
      {#key `${String(pinned)} ${choiceKey(choice)}`}
        <SurfaceDetails {surface} cell={pinned} {kind} {poll} onclose={() => (pinnedAt = undefined)} />
      {/key}
    {/if}
  </div>
  {#if surface}<SurfaceLegend {kind} />{/if}
  <div class="line" aria-live="polite" data-field="surface-line">{line}</div>
</FloatingWindow>

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
  .main {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: var(--space-4);
  }
  .map {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
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
    min-height: calc(2 * var(--line-height) * var(--text-sm));
    font-size: var(--text-sm);
    color: var(--text-dim);
  }
</style>
