<!--
  The status bar (docs/frontend.md "The status bar"): the elements chosen in Preferences (web/app/statusbar.ts), in
  their order, from the last second's numbers. Neighbours are split by a dot; a spacer takes the free room, a divider
  draws a line. No element that shows anything: no bar. The bar keeps the last status as `data-status` (for tools),
  and `#state[data-state]` is there even when the power state isn't shown (the tests wait on it).
  An element's pieces are web/app/StatusPiece.svelte's (the Preferences' editor draws them too).
-->
<script lang="ts">
  import StatusPiece from './StatusPiece.svelte';
  import type { PageNetwork } from './net-live.ts';
  import { adapterName, render, shows, type Item, type Live, type Piece } from './statusbar.ts';
  import { t } from '../i18n.ts';
  import { ui } from './ui.svelte.ts';

  let { net }: { net: PageNetwork } = $props();

  // The clock moves without a machine: a tick a second while it's shown.
  let now = $state(Date.now());
  $effect(() => {
    if (!ui.statusItems.some((i) => i.kind === 'clock')) return;
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });
  const live: Live = $derived(liveNow(net, now));
  type Entry = { item: Item; at: number; pieces: Piece[] };
  const entries: Entry[] = $derived(ui.statusItems.map((item, at) => ({ item, at, pieces: render(item, ui.status.metrics, live) })).filter((e) => e.pieces.length));
  const hasState = $derived(entries.some((e) => e.item.kind === 'state'));
</script>

<script module lang="ts">
  /** What the page knows besides the statuses, for the elements (reactive: read in a `$derived`). */
  export function liveNow(net: PageNetwork, now: number): Live {
    void ui.net;
    return {
      state: ui.state, stateText: ui.stateText, now,
      mouseLock: ui.mouseLock, mouseLocked: ui.mouseLocked, keyboardLocked: ui.keyboardLocked, keysFocused: ui.keysFocused, mic: ui.mic,
      disks: ui.status.disks,
      gpu: ui.status.gpu?.g,
      nets: net.views().map((a) => ({
        name: adapterName(a.index + 1), phase: a.view.phase,
        text: a.connection ? t('statusbar:StatusBar.link', { connection: a.connection.name, state: a.view.text }) : t('statusbar:StatusBar.link.none', { state: a.view.text }),
      })),
    };
  }
  /** Whether a dot goes between entries `a` and `b` (none beside a spacer or a divider). */
  export const dotBetween = (a: Item | undefined, b: Item) => !!a && !['spacer', 'divider'].includes(a.kind) && !['spacer', 'divider'].includes(b.kind);
</script>

<footer id="status" data-status={ui.status.data || undefined} hidden={!shows(ui.statusItems)}>
  {#each entries as e, n (e.at)}
    {#if dotBetween(entries[n - 1]?.item, e.item)}<span class="sep" aria-hidden="true">·</span>{/if}
    {#if e.item.kind === 'spacer'}<span class="spacer"></span>
    {:else if e.item.kind === 'divider'}<span class="divider" role="separator"></span>
    {:else}
      <span class="group">{#each e.pieces as p, k (k)}<StatusPiece item={e.item} {p} state={e.item.kind === 'state' && k === 0} />{/each}</span>
    {/if}
  {/each}
  {#if !hasState}<span id="state" data-state={ui.state} hidden>{ui.stateText}</span>{/if}
</footer>

<style>
  /* The page's footer rule (index.html) draws it. */
  footer { gap: 0; white-space: nowrap; overflow: hidden; }
  .group { display: inline-flex; align-items: center; gap: 10px; min-width: 0; }
  .sep { padding: 0 6px; }
  .spacer { flex: 1; }
  .divider { align-self: stretch; width: 1px; margin: -5px 16px; background: var(--line); }
</style>
