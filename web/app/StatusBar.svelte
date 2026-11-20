<!--
  The status bar (docs/frontend.md "The status bar"): the elements chosen in Preferences (web/app/statusbar.ts), in
  their order, from the last second's numbers. Neighbours are split by a dot; a spacer takes the free room, a divider
  draws a line. RAM is a link to the RAM map while a machine runs here (RamWindow.svelte). No element that shows
  anything: no bar. The bar keeps the last status as `data-status` (for tools),
  and `#state[data-state]` is there even when the power state isn't shown (the tests wait on it).
  An element's pieces are web/app/StatusPiece.svelte's (the Preferences' editor draws them too).
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import StatusPiece from './StatusPiece.svelte';
  import type { PageNetwork } from './net-live.ts';
  import { shows, type Item } from './statusbar.ts';
  import type { Live, Piece } from './statusbar-piece.ts';
  import { render } from './statusbar-render.ts';
  import { power } from './areas/power.svelte.ts';
  import { liveNow } from './areas/status-live.ts';
  import { status } from './areas/status.svelte.ts';
  import { ramHost, ramWindow } from './areas/ram.svelte.ts';
  import { t } from '../i18n.ts';

  let { net }: { net: PageNetwork } = $props();

  // The clock moves without a machine: a tick a second while it's shown.
  let now = $state(Date.now());
  $effect(() => {
    if (!status.items.some((i) => i.kind === 'clock')) return;
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });
  const live: Live = $derived(liveNow(net, now));
  type Entry = { item: Item; at: number; pieces: Piece[] };
  /** Whether a dot goes between entries `a` and `b` (none beside a spacer or a divider). */
  const dotBetween = (a: Item | undefined, b: Item) =>
    !!a && !['spacer', 'divider'].includes(a.kind) && !['spacer', 'divider'].includes(b.kind);
  const entries: Entry[] = $derived(
    status.items
      .map((item, at) => ({ item, at, pieces: render(item, status.metrics, live) }))
      .filter((e) => e.pieces.length),
  );
  const hasState = $derived(entries.some((e) => e.item.kind === 'state'));
</script>

<footer id="status" data-status={status.data || undefined} hidden={!shows(status.items)}>
  {#each entries as e, n (e.at)}
    {#if dotBetween(entries[n - 1]?.item, e.item)}<span class="sep" aria-hidden="true">·</span>{/if}
    {#if e.item.kind === 'spacer'}<span class="spacer"></span>
    {:else if e.item.kind === 'divider'}<span class="divider" role="separator"></span>
    {:else if e.item.kind === 'ram' && ramHost()}
      <!-- RAM opens the RAM map while the machine runs here (a press doesn't take the focus from the screen). -->
      <Button
        variant="link"
        class="ram-map"
        data-action="ram-open"
        onmousedown={(ev: MouseEvent) => ev.preventDefault()}
        onclick={() => ramWindow.show()}
        ><span class="group"
          >{#each e.pieces as p, k (k)}<StatusPiece
              item={e.item}
              p={{ ...p, title: t('statusbar:StatusBar.ramMap', { words: p.title }) }}
            />{/each}</span
        ></Button
      >
    {:else}
      <span class="group"
        >{#each e.pieces as p, k (k)}<StatusPiece
            item={e.item}
            {p}
            state={e.item.kind === 'state' && k === 0}
          />{/each}</span
      >
    {/if}
  {/each}
  {#if !hasState}<span id="state" data-state={power.state} hidden>{power.stateText}</span>{/if}
</footer>

<style>
  /* The status bar: the power state first, then the machine's numbers. Its height is fixed, a whole number of pixels
     whatever its pieces' lines come to: the machine's screen above it fills what's left, and a fraction there would
     blur it. */
  footer {
    --link-size: var(--bar-text-sm);
    --link-align: center;
    display: flex;
    align-items: center;
    height: var(--control-h);
    padding: var(--space-2) var(--space-5);
    border-top: 1px solid var(--border);
    background: var(--surface-bar);
    color: var(--text-dim);
    font-size: var(--bar-text-sm);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
  }
  /* Not under the introduction; it comes in from the window's bottom edge when that's left (view-transition.ts). */
  :global(body[data-page='intro']) footer {
    display: none;
  }
  :global(html[data-vt='intro']) footer {
    view-transition-name: status-bar;
  }
  .group {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }
  .sep {
    padding: 0 var(--space-2);
  }
  .spacer {
    flex: 1;
  }
  /* A line across the bar's height: past its padding. */
  .divider {
    align-self: stretch;
    width: 1px;
    margin: calc(-1 * var(--space-2)) var(--space-5);
    background: var(--border);
  }
</style>
